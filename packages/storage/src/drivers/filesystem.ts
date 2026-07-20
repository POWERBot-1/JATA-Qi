// Filesystem-backed storage driver. Namespaces are directories; entries are JSON files.
// Collections are single JSONL files for easy inspection. Blobs are raw files.

import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
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

async function safeStat(p: string): Promise<Stats | null> {
  try {
    return await fs.stat(p);
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function readJson<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

async function writeJson(p: string, value: unknown): Promise<void> {
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

export class FsNamespace implements INamespace {
  constructor(public readonly name: string, private readonly dir: string) {}
  private keyPath(key: string): string {
    return path.join(this.dir, safeKey(key) + '.json');
  }
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const e = await this.getEntry<T>(key);
    return e?.value;
  }
  async getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined> {
    const p = this.keyPath(key);
    try {
      const raw = await readJson<{ value: T; meta: EntryMeta }>(p);
      return raw;
    } catch (e: any) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async set<T = unknown>(key: string, value: T): Promise<EntryMeta> {
    const existing = await this.getEntry(key);
    const now = Date.now();
    const meta: EntryMeta = {
      key,
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
      etag: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    };
    await writeJson(this.keyPath(key), { value, meta });
    const st2 = await safeStat(this.keyPath(key));
    return { ...meta, size: st2?.size };
  }
  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.keyPath(key));
      return true;
    } catch (e: any) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }
  async has(key: string): Promise<boolean> {
    return (await safeStat(this.keyPath(key))) !== null;
  }
  async list<T = unknown>(opts: ListOptions = {}): Promise<ListResult<T>> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch (e: any) {
      if (e.code === 'ENOENT') return { items: [] };
      throw e;
    }
    const entries: Entry<T>[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const key = decodeKey(f);
      if (opts.prefix && !key.startsWith(opts.prefix)) continue;
      const raw = await readJson<Entry<T>>(path.join(this.dir, f));
      entries.push(raw);
    }
    entries.sort((a, b) => (a.meta.key < b.meta.key ? -1 : 1));
    const limit = opts.limit ?? entries.length;
    const start = opts.cursor ? entries.findIndex((e) => e.meta.key === opts.cursor) + 1 : 0;
    const slice = entries.slice(start, start + limit);
    const nextCursor =
      start + limit < entries.length ? slice[slice.length - 1]!.meta.key : undefined;
    return { items: slice, nextCursor };
  }
  async clear(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
    await fs.mkdir(this.dir, { recursive: true });
  }
  async size(): Promise<number> {
    try {
      const files = await fs.readdir(this.dir);
      return files.filter((f) => f.endsWith('.json')).length;
    } catch (e: any) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }
  }
}

interface DocEnvelope<T> {
  doc: T;
}

export class FsCollection<T extends { id: string }> implements ICollection<T> {
  private cache = new Map<string, T>();
  private loaded = false;
  constructor(public readonly name: string, private readonly file: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const env = JSON.parse(line) as DocEnvelope<T>;
        this.cache.set((env.doc as any).id, env.doc);
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const lines: string[] = [];
    for (const doc of this.cache.values()) lines.push(JSON.stringify({ doc }));
    const tmp = this.file + '.tmp-' + process.pid + '-' + Date.now();
    await fs.writeFile(tmp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    await fs.rename(tmp, this.file);
  }

  async put(doc: T): Promise<T> {
    await this.load();
    if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
    this.cache.set(doc.id, doc);
    await this.flush();
    return doc;
  }
  async get(id: string): Promise<T | undefined> {
    await this.load();
    return this.cache.get(id);
  }
  async delete(id: string): Promise<boolean> {
    await this.load();
    const had = this.cache.delete(id);
    if (had) await this.flush();
    return had;
  }
  async has(id: string): Promise<boolean> {
    await this.load();
    return this.cache.has(id);
  }
  async query(opts: QueryOptions<T> = {}): Promise<T[]> {
    await this.load();
    let items = [...this.cache.values()];
    if (opts.where) {
      const w = opts.where;
      items = items.filter((d) => w(d));
    }
    if (opts.orderBy) {
      const k = opts.orderBy as string;
      const dir = opts.order === 'desc' ? -1 : 1;
      items.sort((a, b) => {
        const av = (a as any)[k];
        const bv = (b as any)[k];
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
      });
    }
    if (opts.offset) items = items.slice(opts.offset);
    if (opts.limit) items = items.slice(0, opts.limit);
    return items;
  }
  async all(): Promise<T[]> {
    await this.load();
    return [...this.cache.values()];
  }
  async count(): Promise<number> {
    await this.load();
    return this.cache.size;
  }
  async clear(): Promise<void> {
    this.cache.clear();
    this.loaded = true;
    await this.flush();
  }
}

export class FsBlobStore implements IBlobStore {
  private metaDir: string;
  private dataDir: string;
  constructor(public readonly name: string, root: string) {
    this.dataDir = path.join(root, 'blobs', name);
    this.metaDir = path.join(root, 'blobs', name + '.__meta__');
  }
  private dataPath(key: string) { return path.join(this.dataDir, safeKey(key)); }
  private metaPath(key: string) { return path.join(this.metaDir, safeKey(key) + '.json'); }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.metaDir, { recursive: true });
  }

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const tmp = this.dataPath(key) + '.tmp-' + process.pid + '-' + Date.now();
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, this.dataPath(key));
    const st = await fs.stat(this.dataPath(key));
    const existing = await this.getMeta(key);
    const now = Date.now();
    const meta: EntryMeta = {
      key,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      size: st.size,
      etag: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    };
    await writeJson(this.metaPath(key), { meta, contentType });
    return meta;
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile(this.dataPath(key));
    } catch (e: any) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async getAsText(key: string): Promise<string | undefined> {
    const b = await this.get(key);
    if (!b) return undefined;
    return new TextDecoder().decode(b);
  }
  async getMeta(key: string): Promise<EntryMeta | undefined> {
    try {
      const raw = await readJson<{ meta: EntryMeta }>(this.metaPath(key));
      return raw.meta;
    } catch (e: any) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async delete(key: string): Promise<boolean> {
    let had = false;
    try { await fs.unlink(this.dataPath(key)); had = true; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    try { await fs.unlink(this.metaPath(key)); } catch (_) { /* ignore */ }
    return had;
  }
  async has(key: string): Promise<boolean> {
    return (await safeStat(this.dataPath(key))) !== null;
  }
  async list(opts: ListOptions = {}): Promise<ListResult<Uint8Array>> {
    let files: string[];
    try {
      files = await fs.readdir(this.metaDir);
    } catch (e: any) {
      if (e.code === 'ENOENT') return { items: [] };
      throw e;
    }
    const items: Entry<Uint8Array>[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const key = decodeKey(f);
      if (opts.prefix && !key.startsWith(opts.prefix)) continue;
      const meta = (await readJson<{ meta: EntryMeta }>(path.join(this.metaDir, f))).meta;
      const data = await fs.readFile(this.dataPath(key));
      items.push({ value: data, meta });
    }
    items.sort((a, b) => (a.meta.key < b.meta.key ? -1 : 1));
    const limit = opts.limit ?? items.length;
    const start = opts.cursor ? items.findIndex((e) => e.meta.key === opts.cursor) + 1 : 0;
    const slice = items.slice(start, start + limit);
    const nextCursor = start + limit < items.length ? slice[slice.length - 1]!.meta.key : undefined;
    return { items: slice, nextCursor };
  }
  async clear(): Promise<void> {
    await fs.rm(this.dataDir, { recursive: true, force: true });
    await fs.rm(this.metaDir, { recursive: true, force: true });
    await this.init();
  }
}

export interface FsDriverOptions {
  /** Root directory for all storage. Defaults to `.jataqi/storage`. */
  root?: string;
}

export class FsDriver implements IStorageDriver {
  readonly id = 'filesystem';
  private readonly root: string;
  constructor(opts: FsDriverOptions = {}) {
    this.root = path.resolve(opts.root ?? '.jataqi/storage');
  }
  async openNamespace(name: string): Promise<INamespace> {
    const ns = new FsNamespace(sanitizeSegment(name), path.join(this.root, 'ns', sanitizeSegment(name)));
    await ns.init();
    return ns;
  }
  async openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    await fs.mkdir(path.join(this.root, 'collections'), { recursive: true });
    return new FsCollection<T>(
      sanitizeSegment(name),
      path.join(this.root, 'collections', sanitizeSegment(name) + '.jsonl'),
    );
  }
  async openBlobStore(name: string): Promise<IBlobStore> {
    const bs = new FsBlobStore(sanitizeSegment(name), this.root);
    await bs.init();
    return bs;
  }
  async close(): Promise<void> {
    // Files are opened/closed per-op; nothing to release, but ensure dir exists.
  }
}
