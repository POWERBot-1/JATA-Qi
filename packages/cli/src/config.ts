// Config loader: reads from environment, supports .env files (simple KEY=VAL parser).

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EnvConfig {
  LOG_LEVEL?: string;
  STORAGE_DRIVER?: 'memory' | 'filesystem';
  STORAGE_FS_ROOT?: string;
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
    JATAQI_ADMIN_USERNAME: process.env.JATAQI_ADMIN_USERNAME,
    JATAQI_ADMIN_PASSWORD: process.env.JATAQI_ADMIN_PASSWORD,
    JATAQI_GATEWAY_PORT: process.env.JATAQI_GATEWAY_PORT ? Number(process.env.JATAQI_GATEWAY_PORT) : undefined,
    JATAQI_GATEWAY_HOST: process.env.JATAQI_GATEWAY_HOST,
  };
}
