// Hierarchical, typed configuration with layered sources and schema-ish validation.

export interface ConfigSource {
  /** Return the value at a dotted path, or undefined if absent. */
  get(path: string): unknown;
}

/** A source that reads from a plain JS object (e.g. loaded JSON). */
export class ObjectConfigSource implements ConfigSource {
  constructor(private readonly data: Record<string, unknown>) {}
  get(path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = this.data;
    for (const p of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  }
}

/** A source that maps `${VAR}` references to process.env. */
export class EnvConfigSource implements ConfigSource {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  get(path: string): unknown {
    // Treat ENV as a flat namespace keyed by UPPER_SNAKE_CASE -> dotted.path
    const key = path.toUpperCase().replace(/\./g, '_');
    const v = this.env[key];
    if (v !== undefined) return coerce(v);
    return undefined;
  }
}

function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

export class Config {
  private readonly sources: ConfigSource[] = [];

  /** Prepend a source so it wins over previously added sources. */
  addSourceFirst(source: ConfigSource): this {
    this.sources.unshift(source);
    return this;
  }
  addSourceLast(source: ConfigSource): this {
    this.sources.push(source);
    return this;
  }

  /** Read a value at a dotted path; returns `fallback` when missing. */
  get<T = unknown>(path: string, fallback?: T): T {
    for (const s of this.sources) {
      const v = s.get(path);
      if (v !== undefined) return v as T;
    }
    return fallback as T;
  }

  /** Read a required value; throws if absent. */
  getRequired<T = unknown>(path: string): T {
    const v = this.get<T>(path);
    if (v === undefined) throw new Error(`Config: missing required key "${path}"`);
    return v as T;
  }

  /** Read and assert a string. */
  getString(path: string, fallback?: string): string {
    const v = this.get<unknown>(path, fallback);
    if (typeof v !== 'string') throw new Error(`Config: expected string at "${path}"`);
    return v;
  }

  getNumber(path: string, fallback?: number): number {
    const v = this.get<unknown>(path, fallback);
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new Error(`Config: expected number at "${path}"`);
    }
    return v;
  }

  getBoolean(path: string, fallback?: boolean): boolean {
    const v = this.get<unknown>(path, fallback);
    if (typeof v !== 'boolean') throw new Error(`Config: expected boolean at "${path}"`);
    return v;
  }
}
