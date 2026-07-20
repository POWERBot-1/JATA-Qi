import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv, readConfig, loadEnv } from '../src/config.js';

describe('config', () => {
  it('parses KEY=VALUE lines and strips quotes/comments', () => {
    const sample = `
# a comment
LOG_LEVEL=debug
STORAGE_DRIVER=filesystem
QUOTED="hello world"
SINGLE='abc'
`;
    const r = parseDotenv(sample);
    assert.equal(r.LOG_LEVEL, 'debug');
    assert.equal(r.STORAGE_DRIVER, 'filesystem');
    assert.equal(r.QUOTED, 'hello world');
    assert.equal(r.SINGLE, 'abc');
  });

  it('loads into process.env without overwriting existing values', () => {
    process.env.TEST_KEY_X = 'already-set';
    const parsed = parseDotenv('TEST_KEY_X=new-value\nTEST_KEY_Y=yyy');
    for (const [k,v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
    assert.equal(process.env.TEST_KEY_X, 'already-set');
    assert.equal(process.env.TEST_KEY_Y, 'yyy');
    delete process.env.TEST_KEY_X; delete process.env.TEST_KEY_Y;
  });

  it('readConfig coerces numeric fields', () => {
    process.env.VECTOR_HASH_DIM = '256';
    process.env.STORAGE_DRIVER = 'memory';
    const cfg = readConfig();
    assert.equal(cfg.VECTOR_HASH_DIM, 256);
    assert.equal(cfg.STORAGE_DRIVER, 'memory');
    delete process.env.VECTOR_HASH_DIM; delete process.env.STORAGE_DRIVER;
  });

  it('loadEnv silently returns {} when no .env exists', () => {
    const r = loadEnv('/nonexistent/path/.env');
    assert.deepEqual(r, {});
  });
});
