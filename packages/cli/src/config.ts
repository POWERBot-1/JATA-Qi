// Config loader: reads from environment, supports .env files (simple KEY=VAL parser).

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EnvConfig {
  LOG_LEVEL?: string;
  STORAGE_DRIVER?: 'memory' | 'filesystem' | 'sqlite' | 'postgres' | 'postgresql';
  STORAGE_FS_ROOT?: string;
  /** PostgreSQL connection (multi-writer horizontal scaling, PR8). */
  PGHOST?: string;
  PGPORT?: number;
  PGUSER?: string;
  PGPASSWORD?: string;
  PGDATABASE?: string;
  PGSSLMODE?: 'disable' | 'prefer' | 'require';
  /** Base64/hex/passphrase AES-256-GCM key for encryption at rest (PR7). */
  STORAGE_ENCRYPTION_KEY?: string;
  /** Default per-namespace/collection byte quota (PR7). */
  STORAGE_DEFAULT_QUOTA_BYTES?: number;
  /** JSON map of per-name byte quotas, e.g. {"security.audit":10485760} (PR7). */
  STORAGE_QUOTAS?: string;
  VECTOR_MODEL?: 'hash' | 'openai';
  VECTOR_HASH_DIM?: number;
  VECTOR_METRIC?: 'cosine' | 'euclidean' | 'dot';
  OPENAI_API_KEY?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  AGENT_LLM?: 'echo' | 'openai';
  OPENAI_CHAT_MODEL?: string;
  JATAQI_ADMIN_USERNAME?: string;
  JATAQI_ADMIN_PASSWORD?: string;
  JATAQI_GATEWAY_PORT?: number;
  JATAQI_GATEWAY_HOST?: string;
  // --- Security hardening (PR4) ---
  /** Comma-separated allowed CORS origins, or '*'. Empty disables CORS. */
  CORS_ORIGINS?: string;
  /** Allow cookies/credentials in CORS (true/false). */
  CORS_CREDENTIALS?: boolean;
  /** API version segment (default 'v1'). Set to 'false' to disable. */
  API_VERSION?: string;
  /** Path to a PEM TLS certificate file. Enables HTTPS when paired with TLS_KEY_PATH. */
  TLS_CERT_PATH?: string;
  /** Path to a PEM TLS private key file. */
  TLS_KEY_PATH?: string;
  /** Path to a PEM CA bundle (for mutual TLS). */
  TLS_CA_PATH?: string;
  /** Minimum TLS version (default 'TLSv1.2'). */
  TLS_MIN_VERSION?: string;
  /** Whether to persist auth sessions to durable storage (default true). */
  SECURITY_PERSIST_SESSIONS?: boolean;
  // --- Scheduled backups (PR4 — automated DR) ---
  /** Comma-separated storage namespaces to back up on a schedule. */
  BACKUP_NAMESPACES?: string;
  /** Backup interval in ms (default 6h). */
  BACKUP_INTERVAL_MS?: number;
  /** Snapshots to retain per namespace (default 10). */
  BACKUP_RETENTION?: number;
}

/** Parse a .env file into an object (KEY=VALUE lines, ignores comments/blanks). */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** Load a .env file (if present) and merge into process.env. Returns the parsed config. */
export function loadEnv(filePath = '.env'): Record<string, string> {
  try {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) return {};
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = parseDotenv(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return parsed;
  } catch {
    return {};
  }
}

export function readConfig(): EnvConfig {
  const bool = (v: string | undefined): boolean | undefined => {
    if (v === undefined) return undefined;
    return /^(1|true|yes|on)$/i.test(v);
  };
  return {
    LOG_LEVEL: process.env.LOG_LEVEL,
    STORAGE_DRIVER: process.env.STORAGE_DRIVER as EnvConfig['STORAGE_DRIVER'],
    STORAGE_FS_ROOT: process.env.STORAGE_FS_ROOT,
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    PGUSER: process.env.PGUSER,
    PGPASSWORD: process.env.PGPASSWORD,
    PGDATABASE: process.env.PGDATABASE,
    PGSSLMODE: process.env.PGSSLMODE as EnvConfig['PGSSLMODE'],
    STORAGE_ENCRYPTION_KEY: process.env.STORAGE_ENCRYPTION_KEY,
    STORAGE_DEFAULT_QUOTA_BYTES: process.env.STORAGE_DEFAULT_QUOTA_BYTES ? Number(process.env.STORAGE_DEFAULT_QUOTA_BYTES) : undefined,
    STORAGE_QUOTAS: process.env.STORAGE_QUOTAS,
    VECTOR_MODEL: process.env.VECTOR_MODEL as EnvConfig['VECTOR_MODEL'],
    VECTOR_HASH_DIM: process.env.VECTOR_HASH_DIM ? Number(process.env.VECTOR_HASH_DIM) : undefined,
    VECTOR_METRIC: process.env.VECTOR_METRIC as EnvConfig['VECTOR_METRIC'],
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
    AGENT_LLM: process.env.AGENT_LLM as EnvConfig['AGENT_LLM'],
    OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL,
    JATAQI_ADMIN_USERNAME: process.env.JATAQI_ADMIN_USERNAME,
    JATAQI_ADMIN_PASSWORD: process.env.JATAQI_ADMIN_PASSWORD,
    JATAQI_GATEWAY_PORT: process.env.JATAQI_GATEWAY_PORT ? Number(process.env.JATAQI_GATEWAY_PORT) : undefined,
    JATAQI_GATEWAY_HOST: process.env.JATAQI_GATEWAY_HOST,
    CORS_ORIGINS: process.env.CORS_ORIGINS,
    CORS_CREDENTIALS: bool(process.env.CORS_CREDENTIALS),
    API_VERSION: process.env.API_VERSION,
    TLS_CERT_PATH: process.env.TLS_CERT_PATH,
    TLS_KEY_PATH: process.env.TLS_KEY_PATH,
    TLS_CA_PATH: process.env.TLS_CA_PATH,
    TLS_MIN_VERSION: process.env.TLS_MIN_VERSION,
    SECURITY_PERSIST_SESSIONS: bool(process.env.SECURITY_PERSIST_SESSIONS),
    BACKUP_NAMESPACES: process.env.BACKUP_NAMESPACES,
    BACKUP_INTERVAL_MS: process.env.BACKUP_INTERVAL_MS ? Number(process.env.BACKUP_INTERVAL_MS) : undefined,
    BACKUP_RETENTION: process.env.BACKUP_RETENTION ? Number(process.env.BACKUP_RETENTION) : undefined,
  };
}
