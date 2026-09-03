/**
 * Development-only filesystem storage driver.
 *
 * This driver is deliberately limited to one process per storage root. It is
 * useful for local development, demos, and deterministic tests; it is not a
 * transactional, multi-process, multi-host, or production persistence layer.
 * See docs/PERSISTENCE_ARCHITECTURE.md for the authoritative production design.
 *
 * Namespaces are directories; entries are JSON files. Collections are JSONL
 * snapshots; blobs are raw files plus JSON metadata.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import {
  Entry,
  EntryMeta,
  IBlobStore,
  ICollection,
  INamespace,
  IStorageDriver,
  ListOptions,
  ListResult,
  QueryOptions,
} from '../types.js';

const ROOT_LOCK_FILE = '.jataqi-fs.lock';
const TEMP_DIRECTORY = '.jataqi-tmp';
const TEMP_MARKER = '.tmp-';

/**
 * Raised instead of silently allowing lost updates when another process owns
 * the same development filesystem root.
 */
export class FsSingleProcessStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsSingleProcessStorageError';
  }
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const resourceLocks = new Map<string, AsyncMutex>();

function lockFor(resource: string): AsyncMutex {
  const key = path.resolve(resource);
  let lock = resourceLocks.get(key);
  if (!lock) {
    lock = new AsyncMutex();
    resourceLocks.set(key, lock);
  }
  return lock;
}

function sanitizeSegment(name: string): string {
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid storage segment: "${name}"`);
  }
  return name;
}

function safeKey(key: string): string {
  // Replace filesystem-unsafe chars with percent encoding so any string key is usable.
  return key.replace(/[\\/:*?"<>|%]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function decodeKey(filename: string): string {
  if (!filename.endsWith('.json')) return filename;
  const stem = filename.slice(0, -5);
  return stem.replace(/%([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

async function safeStat(p: string): Promise<Stats | null> {
  try {
    return await fs.stat(p);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function readJson<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

function temporaryPath(target: string): string {
  // A reserved sibling staging directory avoids mistaking a user-provided key
  // containing ".tmp-" for a stale write artifact during startup recovery.
  return path.join(
    path.dirname(target),
    TEMP_DIRECTORY,
    `${path.basename(target)}${TEMP_MARKER}${process.pid}-${randomUUID()}`,
  );
}

/**
 * Atomically replace one file within a filesystem. The file is synced before
 * rename and the parent directory is synced where the host filesystem allows
 * it. This is best-effort crash durability for local development—not a WAL or
 * a transaction across files.
 */
async function writeAtomically(target: string, value: string | Uint8Array): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(target);
  await fs.mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the original write error.
    }
    try {
      await fs.rm(temporary, { force: true });
    } catch {
      // A process crash can leave a stale temp file; startup cleanup handles it.
    }
    throw error;
  }
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await writeAtomically(target, JSON.stringify(value, null, 2));
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Directory fsync is not available on every platform/filesystem. File data
    // has still been synced; this driver remains development-only either way.
    if (!isNodeError(error, 'EINVAL') && !isNodeError(error, 'ENOTSUP') && !isNodeError(error, 'EOPNOTSUPP') && !isNodeError(error, 'EPERM') && !isNodeError(error, 'EISDIR')) {
      throw error;
    }
  } finally {
    try {
      await handle?.close();
    } catch {
      // Nothing useful can be done during best-effort directory sync cleanup.
    }
  }
}

/** Remove reserved staging directories left between temp creation and rename. */
async function removeStaleTemporaryFiles(directory: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }

  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === TEMP_DIRECTORY) {
      await fs.rm(child, { recursive: true, force: true });
    } else {
      await removeStaleTemporaryFiles(child);
    }
  }
}

interface RootLockRecord {
  version: 1;
  pid: number;
  token: string;
  createdAt: number;
}

interface FsRootState {
  readonly root: string;
  readonly lockPath: string;
  readonly token: string;
  references: number;
  readonly namespaces: Map<string, FsNamespace>;
  readonly collections: Map<string, FsCollection<any>>;
  readonly blobs: Map<string, FsBlobStore>;
}

const roots = new Map<string, FsRootState>();
const rootLifecycleLocks = new Map<string, AsyncMutex>();

function rootLifecycleLock(root: string): AsyncMutex {
  let lock = rootLifecycleLocks.get(root);
  if (!lock) {
    lock = new AsyncMutex();
    rootLifecycleLocks.set(root, lock);
  }
  return lock;
}

async function readLockRecord(lockPath: string): Promise<RootLockRecord | undefined> {
  try {
    const parsed = await readJson<Partial<RootLockRecord>>(lockPath);
    if (parsed.version !== 1 || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.token !== 'string') return undefined;
    return {
      version: 1,
      pid: parsed.pid,
      token: parsed.token,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    // A partial/malformed lock is stale after a process interruption. It is
    // quarantined rather than trusted as an active owner.
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the OS can see the process but this user may not signal it.
    return isNodeError(error, 'EPERM');
  }
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
  const onDisk = await readLockRecord(lockPath);
  if (onDisk?.token === token) await fs.rm(lockPath, { force: true });
}

async function quarantineStaleLock(lockPath: string): Promise<void> {
  const quarantined = `${lockPath}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantined);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  await fs.rm(quarantined, { force: true });
}

/** Remove candidates abandoned before they could atomically claim the lock. */
async function removeStaleLockCandidates(root: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }

  const prefix = `${ROOT_LOCK_FILE}.candidate-`;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const pid = Number(entry.name.slice(prefix.length).split('-', 1)[0]);
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
      await fs.rm(path.join(root, entry.name), { force: true });
    }
  }
}

async function createRootLock(lockPath: string, record: RootLockRecord): Promise<void> {
  // Do not expose a partially written canonical lock. Write a private candidate
  // first, sync it, then atomically hard-link it into the canonical name. The
  // link operation is the compare-and-create point: concurrent contenders get
  // EEXIST without being able to mistake another process's in-progress lock for
  // a stale one.
  // This deliberately does not use TEMP_MARKER: startup temporary-file cleanup
  // must never remove a live contender's candidate during lock acquisition.
  const candidate = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(candidate, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(candidate, lockPath);
  } finally {
    try {
      await handle?.close();
    } finally {
      await fs.rm(candidate, { force: true });
    }
  }
}

async function acquireFilesystemRoot(root: string): Promise<FsRootState> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, ROOT_LOCK_FILE);
  const token = randomUUID();

  // A stale lock can be left by an abrupt process exit. Rename-before-delete
  // avoids deleting a newly acquired lock from a racing process.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await createRootLock(lockPath, { version: 1, pid: process.pid, token, createdAt: Date.now() });
      await syncDirectory(root);
      await removeStaleTemporaryFiles(root);
      await removeStaleLockCandidates(root);
      return {
        root,
        lockPath,
        token,
        references: 1,
        namespaces: new Map(),
        collections: new Map(),
        blobs: new Map(),
      };
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        await removeOwnedLock(lockPath, token);
        throw error;
      }
      const owner = await readLockRecord(lockPath);
      if (owner && isProcessAlive(owner.pid)) {
        throw new FsSingleProcessStorageError(
          `Filesystem storage root "${root}" is already in use by process ${owner.pid}. ` +
          'Filesystem storage is development-only and supports one process per root.',
        );
      }
      await quarantineStaleLock(lockPath);
    }
  }

  throw new FsSingleProcessStorageError(
    `Unable to acquire the development filesystem storage root "${root}" after recovering a stale lock.`,
  );
}

async function acquireRoot(root: string): Promise<FsRootState> {
  return rootLifecycleLock(root).run(async () => {
    const active = roots.get(root);
    if (active) {
      active.references++;
      return active;
    }

    // acquireFilesystemRoot creates the first reference for this driver before
    // the state becomes visible to any other same-process driver.
    const state = await acquireFilesystemRoot(root);
    roots.set(root, state);
    return state;
  });
}

async function releaseRoot(state: FsRootState): Promise<void> {
  await rootLifecycleLock(state.root).run(async () => {
    // A close can race an in-progress open. Only release the root state that is
    // still registered, so an old driver's finalizer cannot release a newer
    // owner or leave a newly acquired sibling without its lock.
    if (roots.get(state.root) !== state) return;
    state.references--;
    if (state.references > 0) return;

    roots.delete(state.root);
    state.namespaces.clear();
    state.collections.clear();
    state.blobs.clear();

    const onDisk = await readLockRecord(state.lockPath);
    if (onDisk?.token === state.token) {
      await removeOwnedLock(state.lockPath, state.token);
      await syncDirectory(state.root);
    }
  });
}

export class FsNamespace implements INamespace {
  private readonly lock: AsyncMutex;

  constructor(public readonly name: string, private readonly dir: string) {
    this.lock = lockFor(dir);
  }

  private keyPath(key: string): string {
    return path.join(this.dir, safeKey(key) + '.json');
  }

  private async initializeUnlocked(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private async getEntryUnlocked<T = unknown>(key: string): Promise<Entry<T> | undefined> {
    try {
      return await readJson<Entry<T>>(this.keyPath(key));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async init(): Promise<void> {
    await this.lock.run(async () => this.initializeUnlocked());
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.lock.run(async () => (await this.getEntryUnlocked<T>(key))?.value);
  }

  async getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined> {
    return this.lock.run(async () => this.getEntryUnlocked<T>(key));
  }

  async set<T = unknown>(key: string, value: T): Promise<EntryMeta> {
    return this.lock.run(async () => {
      await this.initializeUnlocked();
      const existing = await this.getEntryUnlocked(key);
      const now = Date.now();
      const meta: EntryMeta = {
        key,
        createdAt: existing?.meta.createdAt ?? now,
        updatedAt: now,
        etag: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      };
      const target = this.keyPath(key);
      await writeJson(target, { value, meta });
      const stat = await safeStat(target);
      return { ...meta, size: stat?.size };
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.lock.run(async () => {
      try {
        await fs.unlink(this.keyPath(key));
        return true;
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return false;
        throw error;
      }
    });
  }

  async has(key: string): Promise<boolean> {
    return this.lock.run(async () => (await safeStat(this.keyPath(key))) !== null);
  }

  async list<T = unknown>(opts: ListOptions = {}): Promise<ListResult<T>> {
    return this.lock.run(async () => {
      let files: string[];
      try {
        files = await fs.readdir(this.dir);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return { items: [] };
        throw error;
      }
      const entries: Entry<T>[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const key = decodeKey(file);
        if (opts.prefix && !key.startsWith(opts.prefix)) continue;
        entries.push(await readJson<Entry<T>>(path.join(this.dir, file)));
      }
      entries.sort((a, b) => (a.meta.key < b.meta.key ? -1 : a.meta.key > b.meta.key ? 1 : 0));
      const limit = opts.limit ?? entries.length;
      const start = opts.cursor ? entries.findIndex((entry) => entry.meta.key === opts.cursor) + 1 : 0;
      const slice = entries.slice(start, start + limit);
      const nextCursor = start + limit < entries.length ? slice[slice.length - 1]!.meta.key : undefined;
      return { items: slice, nextCursor };
    });
  }

  async clear(): Promise<void> {
    await this.lock.run(async () => {
      await fs.rm(this.dir, { recursive: true, force: true });
      await this.initializeUnlocked();
    });
  }

  async size(): Promise<number> {
    return this.lock.run(async () => {
      try {
        const files = await fs.readdir(this.dir);
        return files.filter((file) => file.endsWith('.json')).length;
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return 0;
        throw error;
      }
    });
  }
}

interface DocEnvelope<T> {
  doc: T;
}

export class FsCollection<T extends { id: string }> implements ICollection<T> {
  private cache = new Map<string, T>();
  private loaded = false;
  private readonly lock: AsyncMutex;

  constructor(public readonly name: string, private readonly file: string) {
    this.lock = lockFor(file);
  }

  private async loadUnlocked(refresh = false): Promise<void> {
    // The driver normally shares one collection instance per root, but direct
    // collection handles can also point at the same file. Reloading while the
    // shared resource lock is held prevents an older local cache from writing
    // over another same-process handle's snapshot.
    if (this.loaded && !refresh) return;
    const next = new Map<string, T>();
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const envelope = JSON.parse(line) as DocEnvelope<T>;
        if (!envelope.doc || typeof envelope.doc.id !== 'string' || !envelope.doc.id) {
          throw new Error(`Collection "${this.name}" contains a document without an id.`);
        }
        next.set(envelope.doc.id, envelope.doc);
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    this.cache = next;
    this.loaded = true;
  }

  private async writeSnapshotUnlocked(snapshot: ReadonlyMap<string, T>): Promise<void> {
    const lines: string[] = [];
    for (const doc of snapshot.values()) lines.push(JSON.stringify({ doc }));
    await writeAtomically(this.file, lines.length ? `${lines.join('\n')}\n` : '');
  }

  private snapshotFrom(docs: readonly T[]): Map<string, T> {
    const snapshot = new Map<string, T>();
    for (const doc of docs) {
      if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
      if (snapshot.has(doc.id)) throw new Error(`Collection "${this.name}": duplicate document id "${doc.id}" in replacement snapshot`);
      snapshot.set(doc.id, doc);
    }
    return snapshot;
  }

  async put(doc: T): Promise<T> {
    return this.lock.run(async () => {
      await this.loadUnlocked(true);
      if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
      const next = new Map(this.cache);
      next.set(doc.id, doc);
      await this.writeSnapshotUnlocked(next);
      this.cache = next;
      return doc;
    });
  }

  async get(id: string): Promise<T | undefined> {
    return this.lock.run(async () => {
      await this.loadUnlocked(true);
      return this.cache.get(id);
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.lock.run(async () => {
      await this.loadUnlocked(true);
      if (!this.cache.has(id)) return false;
      const next = new Map(this.cache);
      next.delete(id);
      await this.writeSnapshotUnlocked(next);
      this.cache = next;
      return true;
    });
  }

  async has(id: string): Promise<boolean> {
    return this.lock.run(async () => {
      await this.loadUnlocked(true);
      return this.cache.has(id);
    });
  }

  async query(opts: QueryOptions<T> = {}): Promise<T[]> {
    return this.lock.run(async () => {
      await this.loadUnlocked(true);
      let items = [...this.cache.values()];
      if (opts.where) items = items.filter(opts.where);
      if (opts.orderBy) {
        const key = opts.orderBy as string;
        const direction = opts.order === 'desc' ? -1 : 1;
        items.sort((a, b) => {
          const aValue = (a as Record<string, unknown>)[key];
          const bValue = (b as Record<string, unknown>)[key];
          if (aValue === bValue) return 0;
          return aValue! > bValue! ? direction : -direction;
        });
      }
      if (opts.offset) items = items.slice(opts.offset);
      if (opts.limit) items = items.slice(0, opts.limit);
      return items;
    });
  }

  async all(): Promise<T[]> {
    return this.lock.run(async () => {
      await this.loadUnlocked(true);
      return [...this.cache.values()];
    });
  }

  async count(): Promise<number> {
    return this.lock.run(async () => {
      await this.loadUnlocked(true);
      return this.cache.size;
    });
  }

  /** Atomically replace the local collection snapshot in one file rewrite. */
  async replaceAll(docs: readonly T[]): Promise<void> {
    await this.lock.run(async () => {
      const next = this.snapshotFrom(docs);
      await this.writeSnapshotUnlocked(next);
      this.cache = next;
      this.loaded = true;
    });
  }

  async clear(): Promise<void> {
    await this.replaceAll([]);
  }
}

export class FsBlobStore implements IBlobStore {
  private readonly metaDir: string;
  private readonly dataDir: string;
  private readonly lock: AsyncMutex;

  constructor(public readonly name: string, root: string) {
    this.dataDir = path.join(root, 'blobs', name);
    this.metaDir = path.join(root, 'blobs', name + '.__meta__');
    this.lock = lockFor(path.join(root, 'blobs', name));
  }

  private dataPath(key: string): string {
    return path.join(this.dataDir, safeKey(key));
  }

  private metaPath(key: string): string {
    return path.join(this.metaDir, safeKey(key) + '.json');
  }

  private async initializeUnlocked(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.metaDir, { recursive: true, mode: 0o700 });
  }

  private async getUnlocked(key: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile(this.dataPath(key));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async getMetaUnlocked(key: string): Promise<EntryMeta | undefined> {
    try {
      return (await readJson<{ meta: EntryMeta }>(this.metaPath(key))).meta;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async init(): Promise<void> {
    await this.lock.run(async () => this.initializeUnlocked());
  }

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta> {
    return this.lock.run(async () => {
      await this.initializeUnlocked();
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const existing = await this.getMetaUnlocked(key);
      const dataPath = this.dataPath(key);
      await writeAtomically(dataPath, bytes);
      const stat = await fs.stat(dataPath);
      const now = Date.now();
      const meta: EntryMeta = {
        key,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        size: stat.size,
        etag: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      };
      // Blob bytes and metadata are separate files, so this remains a
      // development-only best-effort operation rather than a transaction.
      await writeJson(this.metaPath(key), { meta, contentType });
      return meta;
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.lock.run(async () => this.getUnlocked(key));
  }

  async getAsText(key: string): Promise<string | undefined> {
    return this.lock.run(async () => {
      const bytes = await this.getUnlocked(key);
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    });
  }

  async getMeta(key: string): Promise<EntryMeta | undefined> {
    return this.lock.run(async () => this.getMetaUnlocked(key));
  }

  async delete(key: string): Promise<boolean> {
    return this.lock.run(async () => {
      let had = false;
      try {
        await fs.unlink(this.dataPath(key));
        had = true;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      try {
        await fs.unlink(this.metaPath(key));
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      return had;
    });
  }

  async has(key: string): Promise<boolean> {
    return this.lock.run(async () => (await safeStat(this.dataPath(key))) !== null);
  }

  async list(opts: ListOptions = {}): Promise<ListResult<Uint8Array>> {
    return this.lock.run(async () => {
      let files: string[];
      try {
        files = await fs.readdir(this.metaDir);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return { items: [] };
        throw error;
      }
      const items: Entry<Uint8Array>[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const key = decodeKey(file);
        if (opts.prefix && !key.startsWith(opts.prefix)) continue;
        const meta = (await readJson<{ meta: EntryMeta }>(path.join(this.metaDir, file))).meta;
        const data = await fs.readFile(this.dataPath(key));
        items.push({ value: data, meta });
      }
      items.sort((a, b) => (a.meta.key < b.meta.key ? -1 : a.meta.key > b.meta.key ? 1 : 0));
      const limit = opts.limit ?? items.length;
      const start = opts.cursor ? items.findIndex((entry) => entry.meta.key === opts.cursor) + 1 : 0;
      const slice = items.slice(start, start + limit);
      const nextCursor = start + limit < items.length ? slice[slice.length - 1]!.meta.key : undefined;
      return { items: slice, nextCursor };
    });
  }

  async clear(): Promise<void> {
    await this.lock.run(async () => {
      await fs.rm(this.dataDir, { recursive: true, force: true });
      await fs.rm(this.metaDir, { recursive: true, force: true });
      await this.initializeUnlocked();
    });
  }
}

export interface FsDriverOptions {
  /**
   * Development-only root directory for local, single-process storage.
   * Defaults to `.jataqi/storage`; never use this driver as production state.
   */
  root?: string;
}

export class FsDriver implements IStorageDriver {
  readonly id = 'filesystem';
  private readonly root: string;
  private state?: FsRootState;
  private ready?: Promise<FsRootState>;
  private closed = false;
  private released = false;

  constructor(opts: FsDriverOptions = {}) {
    this.root = path.resolve(opts.root ?? '.jataqi/storage');
  }

  private async ensureReady(): Promise<FsRootState> {
    if (this.closed) throw new Error('Filesystem storage driver is closed.');
    if (this.state) return this.state;
    if (!this.ready) {
      this.ready = acquireRoot(this.root)
        .then((state) => {
          this.state = state;
          return state;
        })
        .catch((error) => {
          this.ready = undefined;
          throw error;
        });
    }
    return this.ready;
  }

  async openNamespace(name: string): Promise<INamespace> {
    const state = await this.ensureReady();
    const safeName = sanitizeSegment(name);
    let namespace = state.namespaces.get(safeName);
    if (!namespace) {
      namespace = new FsNamespace(safeName, path.join(this.root, 'ns', safeName));
      await namespace.init();
      state.namespaces.set(safeName, namespace);
    }
    return namespace;
  }

  async openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    const state = await this.ensureReady();
    const safeName = sanitizeSegment(name);
    let collection = state.collections.get(safeName) as FsCollection<T> | undefined;
    if (!collection) {
      collection = new FsCollection<T>(safeName, path.join(this.root, 'collections', safeName + '.jsonl'));
      state.collections.set(safeName, collection);
    }
    return collection;
  }

  async openBlobStore(name: string): Promise<IBlobStore> {
    const state = await this.ensureReady();
    const safeName = sanitizeSegment(name);
    let blobStore = state.blobs.get(safeName);
    if (!blobStore) {
      blobStore = new FsBlobStore(safeName, this.root);
      await blobStore.init();
      state.blobs.set(safeName, blobStore);
    }
    return blobStore;
  }

  async close(): Promise<void> {
    if (this.released) return;
    this.closed = true;
    let state = this.state;
    if (!state && this.ready) {
      try {
        state = await this.ready;
      } catch {
        this.released = true;
        return;
      }
    }
    if (state) await releaseRoot(state);
    this.released = true;
  }
}
