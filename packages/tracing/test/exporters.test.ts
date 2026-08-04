// Exporters: in-memory + OTLP/HTTP against a local mock collector.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemorySpanExporter, OTLPHTTPExporter, toOTLP } from '../src/index.js';
import type { ReadableSpan } from '../src/index.js';

function sampleSpan(): ReadableSpan {
  return {
    name: 'op', kind: 'internal',
    context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0x01 },
    resource: { 'service.name': 'jataqi' }, instrumentationScope: 'jataqi',
    startUnixNano: '1', endUnixNano: '2', attributes: { k: 'v' }, events: [], links: [],
    status: { code: 'ok' },
  };
}

describe('InMemorySpanExporter', () => {
  it('collects and resets spans', async () => {
    const ex = new InMemorySpanExporter();
    await ex.export([sampleSpan(), sampleSpan()]);
    assert.equal(ex.spans.length, 2);
    ex.reset();
    assert.equal(ex.spans.length, 0);
  });
});

describe('OTLPHTTPExporter', () => {
  let server: http.Server;
  let endpoint: string;
  const received: { status: number; body: unknown; contentType?: string }[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        received.push({ status: 200, contentType: req.headers['content-type'], body: JSON.parse(buf) });
        res.writeHead(200); res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('POSTs OTLP JSON to the collector and swallows collector errors', async () => {
    const ex = new OTLPHTTPExporter({ endpoint, headers: { authorization: 'Bearer x' }, maxRetries: 0 });
    await ex.export([sampleSpan()]);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.contentType, 'application/json');
    const doc = received[0]!.body as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] };
    assert.equal(doc.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name, 'op');

    // An unreachable endpoint must not throw (tracing never breaks the app).
    const bad = new OTLPHTTPExporter({ endpoint: 'http://127.0.0.1:1/v1/traces', maxRetries: 0, timeoutMs: 100 });
    await assert.doesNotReject(() => bad.export([sampleSpan()]));
  });
});

describe('toOTLP is valid JSON-serializable', () => {
  it('round-trips through JSON.stringify/parse', () => {
    const s = JSON.stringify(toOTLP([sampleSpan()]));
    assert.ok(s.includes('resourceSpans'));
    assert.ok(s.includes('service.name'));
  });
});
