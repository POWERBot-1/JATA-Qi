// JATA Qi Mobile Reference App — key/value storage abstraction.
//
// The controller persists only tiny session/device/outbox records, so the
// storage surface is a minimal async KV API that every platform can satisfy:
//
//   - MemoryStorage        — in-memory (tests, previews)
//   - JsonFileStorage      — Node.js file-backed (CLI demos)
//   - AsyncStorageAdapter  — React Native (@react-native-async-storage/
//     async-storage) lives in the reference app example and wraps AsyncStorage
//     with this same interface.
//
// All values are stored JSON-encoded so callers can store plain objects.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MobileAppStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory KV store (default for tests and ephemeral previews). */
export class MemoryStorage implements MobileAppStorage {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Exposed for tests: full snapshot of stored keys. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/**
 * JSON file-backed KV store for Node.js runtimes (CLI demos, tests, desktop).
 * Writes are atomic (temp file + rename) so a crash never corrupts the store.
 */
export class JsonFileStorage implements MobileAppStorage {
  private readonly file: string;
  private cache: Record<string, string> | null = null;

  constructor(filePath: string) {
    this.file = filePath;
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8');
      this.cache = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async flush(data: Record<string, string>): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, this.file);
  }

  async get(key: string): Promise<string | null> {
    const data = await this.load();
    return data[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.flush(data);
  }

  async remove(key: string): Promise<void> {
    const data = await this.load();
    if (key in data) {
      delete data[key];
      await this.flush(data);
    }
  }
}

/** Read/write a JSON-encoded value through any MobileAppStorage. */
export async function storageGet<T>(storage: MobileAppStorage, key: string): Promise<T | undefined> {
  const raw = await storage.get(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function storageSet(storage: MobileAppStorage, key: string, value: unknown): Promise<void> {
  await storage.set(key, JSON.stringify(value));
}
