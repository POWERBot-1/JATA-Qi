// Config loader: reads from environment, supports .env files (simple KEY=VAL parser).

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EnvConfig {
  LOG_LEVEL?: string;
  /** 'memory' | 'filesystem' (development-only) | 'postgres' (R-01 durable). */
  STORAGE_DRIVER?: 'memory' | 'filesystem' | 'postgres';
  STORAGE_FS_ROOT?: string;
  VECTOR_MODEL?: 'hash' | 'openai';
  VECTOR_HASH_DIM?: number;
  VECTOR_METRIC?: 'cosine' | 'euclidean' | 'dot';
  OPENAI_API_KEY?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  AGENT_LLM?: 'echo' | 'openai';
  OPENAI_CHAT_MODEL?: string;
  /**
   * T-03 authentication posture for the composition root.
   * `none` (default) registers no authenticator, so every authenticated
   * ingress request fails closed.
   */
  JATAQI_AUTH_MODE?: 'none' | 'static-token' | 'test-only';
  /** T-03: path to a JSON array of principal records for the configured mode. */
  JATAQI_AUTH_PRINCIPALS?: string;
  /**
   * T-03: second, redundant opt-in required before DETERMINISTIC_TEST
   * authority can be admitted. Must be exactly `true` in test-only mode.
   */
  JATAQI_ALLOW_TEST_AUTH?: string;
  /** T-03: T-02 principal-snapshot freshness horizon (ms) for the host. */
  JATAQI_MAX_PRINCIPAL_AGE_MS?: number;
  /**
   * T-03: credential material presented by `jataqi host:enqueue`. Read from
   * the environment (never argv) so it does not appear in process listings or
   * shell history.
   */
  JATAQI_AUTH_TOKEN?: string;
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
  return {
    LOG_LEVEL: process.env.LOG_LEVEL,
    STORAGE_DRIVER: process.env.STORAGE_DRIVER as EnvConfig['STORAGE_DRIVER'],
    STORAGE_FS_ROOT: process.env.STORAGE_FS_ROOT,
    VECTOR_MODEL: process.env.VECTOR_MODEL as EnvConfig['VECTOR_MODEL'],
    VECTOR_HASH_DIM: process.env.VECTOR_HASH_DIM ? Number(process.env.VECTOR_HASH_DIM) : undefined,
    VECTOR_METRIC: process.env.VECTOR_METRIC as EnvConfig['VECTOR_METRIC'],
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
    AGENT_LLM: process.env.AGENT_LLM as EnvConfig['AGENT_LLM'],
    OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL,
    JATAQI_AUTH_MODE: process.env.JATAQI_AUTH_MODE as EnvConfig['JATAQI_AUTH_MODE'],
    JATAQI_AUTH_PRINCIPALS: process.env.JATAQI_AUTH_PRINCIPALS,
    JATAQI_ALLOW_TEST_AUTH: process.env.JATAQI_ALLOW_TEST_AUTH,
    JATAQI_MAX_PRINCIPAL_AGE_MS: process.env.JATAQI_MAX_PRINCIPAL_AGE_MS
      ? Number(process.env.JATAQI_MAX_PRINCIPAL_AGE_MS)
      : undefined,
    JATAQI_AUTH_TOKEN: process.env.JATAQI_AUTH_TOKEN,
  };
}
