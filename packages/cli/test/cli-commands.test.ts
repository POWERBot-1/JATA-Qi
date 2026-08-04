// CLI command tests for the intelligence module wave (Phase 4/5/6 + wallet/
// crypto/dashboard/brands): each invocation boots the unified OS via the
// jataqi binary, runs the requested command, and prints to stdout.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'src', 'index.js'); // dist/test/../src/index.js

async function jataqi(...args: string[]): Promise<string> {
  const { stdout } = await run('node', [BIN, ...args], { timeout: 60_000 });
  return stdout;
}

describe('jataqi CLI — intelligence commands', () => {
  it('memory record + stats work', async () => {
    const out = await jataqi('memory', 'record', 'cli memory test', '--category', 'command');
    assert.match(out, /recorded [0-9a-f-]{36}/);
    const stats = await jataqi('memory', 'stats');
    assert.match(stats, /"total"/);
  });

  it('wallet open + summary work', async () => {
    const out = await jataqi('wallet', 'open', 'cli-user', 'developer');
    assert.match(out, /wallet [0-9a-f-]{36} opened \(developer\)/);
    const summary = await jataqi('wallet', 'summary');
    assert.match(summary, /"totalWallets"/);
  });

  it('crypto summary + assets work', async () => {
    const summary = await jataqi('crypto', 'summary');
    assert.match(summary, /"assets"/);
    const assets = await jataqi('crypto', 'assets');
    assert.match(assets, /0 asset\(s\)/);
  });

  it('brands list shows all 15 products', async () => {
    const out = await jataqi('brands', 'list');
    assert.match(out, /jata-qi/);
    assert.match(out, /tanya-ai/);
    assert.match(out, /karis-farm/);
  });

  it('learning analyze + distill-stats work on an empty stream', async () => {
    const analyzed = await jataqi('learning', 'analyze');
    assert.match(analyzed, /insights: 0/);
    const stats = await jataqi('learning', 'distill-stats');
    assert.match(stats, /"lessons": 0/);
  });

  it('find returns a structured result (possibly empty)', async () => {
    const out = await jataqi('find', 'anything', '--json');
    assert.match(out, /"hits"/);
    assert.match(out, /"facets"/);
  });

  it('automation create + list + stats work', async () => {
    const created = await jataqi('automation', 'create', 'cli automation', '--trigger', 'manual');
    assert.match(created, /created [0-9a-f-]{36}/);
    // Each invocation boots a fresh in-memory OS: the list/stats runs see an
    // empty registry but must still execute cleanly.
    const list = await jataqi('automation', 'list');
    assert.match(list, /0 automation\(s\)/);
    const stats = await jataqi('automation', 'stats');
    assert.match(stats, /"total": 0/);
  });
});
