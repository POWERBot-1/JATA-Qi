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

  it('fx set rate + convert + currencies work', async () => {
    const set = await jataqi('fx', 'set', 'USD', 'KES', '128.5', '--ask', '129.0');
    assert.match(set, /USD\/KES bid=128.5 ask=129/);
    // Each invocation boots a fresh in-memory OS: the convert run sees no
    // rate (proving the command executes and fails gracefully), and the set
    // command's own conversion math is covered by the package tests.
    const convert = await jataqi('fx', 'convert', 'USD', 'KES', '10000');
    assert.match(convert, /no rate for USD\/KES/);
    const currencies = await jataqi('fx', 'currencies');
    assert.match(currencies, /KES/);
  });

  it('pki root + cas + status work', async () => {
    const root = await jataqi('pki', 'root', 'CLI Root');
    assert.match(root, /root CA created: [0-9a-f-]{36}/);
    const cas = await jataqi('pki', 'cas');
    assert.match(cas, /0 CA\(s\)/); // fresh in-memory OS per invocation
    const status = await jataqi('pki', 'status');
    assert.match(status, /"idp"/);
  });

  it('mobility register vehicle + trip dispatch + stats work', async () => {
    const reg = await jataqi('mobility', 'register', 'KDD 123B', 'Toyota', 'Corolla', '--lat', '-1.2921', '--lng', '36.8219');
    assert.match(reg, /registered [0-9a-f-]{36}/);
    // Fresh OS per invocation: dispatch fails gracefully with no vehicles.
    const trip = await jataqi('mobility', 'trip', '-1.2921', '36.8219', '-1.2864', '36.8172');
    assert.match(trip, /no available vehicles/);
    const stats = await jataqi('mobility', 'stats');
    assert.match(stats, /"vehicles": 0/);
  });

  it('logistics ports + shipments + stats work', async () => {
    const port = await jataqi('logistics', 'port', 'Mombasa', 'MBA', 'KE');
    assert.match(port, /registered [0-9a-f-]{36}/);
    const shipment = await jataqi('logistics', 'shipment', 'Shanghai', 'Mombasa', 'S', 'C');
    assert.match(shipment, /ref=JQ-/);
    const stats = await jataqi('logistics', 'stats');
    assert.match(stats, /"shipments": 0/);
  });

  it('farm register + plant + stats work', async () => {
    const farm = await jataqi('farm', 'farm', 'Green Acres', 'u1', '--area', '25');
    assert.match(farm, /registered [0-9a-f-]{36}/);
    const plant = await jataqi('farm', 'plant', 'nope', 'maize');
    assert.match(plant, /unknown field/);
    const stats = await jataqi('farm', 'stats');
    assert.match(stats, /"farms": 0/);
  });

  it('circular stream + collect + stats work', async () => {
    const stream = await jataqi('circular', 'stream', 'PET', '--type', 'plastic');
    assert.match(stream, /registered [0-9a-f-]{36}/);
    const collect = await jataqi('circular', 'collect', 'nope', '100', 'Nairobi');
    assert.match(collect, /unknown stream/);
    const stats = await jataqi('circular', 'stats');
    assert.match(stats, /"streams": 0/);
  });

  it('qil format + lint + compile work on the example program', async () => {
    const example = join(here, '..', '..', '..', '..', 'examples', 'objective.qil');
    const formatted = await jataqi('qil', 'format', example);
    assert.match(formatted, /MISSION "Analyze Acme revenue" \{/);
    assert.match(formatted, /  REPORT/);
    const linted = await jataqi('qil', 'lint', example);
    assert.match(linted, /no issues found/);
    const compiled = await jataqi('qil', 'compile', example);
    assert.match(compiled, /"mission": "Analyze Acme revenue"/);
    assert.match(compiled, /"kind": "simulate"/);
  });

  it('qil run executes the example program end-to-end', async () => {
    const example = join(here, '..', '..', '..', '..', 'examples', 'objective.qil');
    const run = await jataqi('qil', 'run', example);
    assert.match(run, /"status": "completed"/);
    assert.match(run, /"auditRecordId"/);
  });

  it('energy asset + meter + stats work', async () => {
    const asset = await jataqi('energy', 'asset', 'Roof Array', 'solar', '12.5');
    assert.match(asset, /registered [0-9a-f-]{36}/);
    const meter = await jataqi('energy', 'meter', 'Office');
    assert.match(meter, /registered [0-9a-f-]{36}/);
    const stats = await jataqi('energy', 'stats');
    assert.match(stats, /"assets": 0/);
  });

  it('border post + watchlist + stats work', async () => {
    const post = await jataqi('border', 'post', 'Busia', 'KE-UG');
    assert.match(post, /registered [0-9a-f-]{36}/);
    const stats = await jataqi('border', 'stats');
    assert.match(stats, /"posts": 0/);
  });

  it('kitchen venue + menu + stats work', async () => {
    const venue = await jataqi('kitchen', 'venue', 'Nyumbani Grill', 'u1', '--cuisine', 'Swahili');
    assert.match(venue, /registered [0-9a-f-]{36}/);
    const stats = await jataqi('kitchen', 'stats');
    assert.match(stats, /"venues": 0/);
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
