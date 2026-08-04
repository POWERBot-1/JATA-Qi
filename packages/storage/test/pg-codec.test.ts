// PR8 — PostgreSQL wire-protocol codec unit tests (pure, no server).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeStartup, enc, decodeBackend } from '../src/drivers/pg/codec.js';

describe('pg codec — frontend encoders', () => {
  it('encodeStartup frames the protocol version + params', () => {
    const b = encodeStartup({ user: 'alice', database: 'app' });
    const len = b.readInt32BE(0);
    assert.equal(len, b.length); // length includes itself
    assert.equal(b.readInt32BE(4), 196608); // protocol 3.0
    assert.ok(b.includes('user=alice'));
    assert.ok(b.includes('database=app'));
    assert.equal(b[b.length - 1], 0); // trailing null
  });

  it('enc.query / parse / bind / sync / terminate produce typed framed messages', () => {
    const q = enc.query('SELECT 1');
    assert.equal(q.toString('ascii', 0, 1), 'Q');
    assert.equal(q.readInt32BE(1), q.length - 1); // length field excludes the type byte

    const p = enc.parse('', 'SELECT $1::int', []);
    assert.equal(p.toString('ascii', 0, 1), 'P');
    assert.ok(p.includes('SELECT $1::int'));

    const b = enc.bind('', '', ['x', null]);
    assert.equal(b.toString('ascii', 0, 1), 'B');
    // params: 'x' then NULL (-1 length)
    assert.ok(b.includes(Buffer.from('x')));

    assert.equal(enc.sync().toString('ascii', 0, 1), 'S');
    assert.equal(enc.sync().length, 5); // type + int32
    assert.equal(enc.terminate().toString('ascii', 0, 1), 'X');
  });

  it('enc.saslInitialResponse encodes mechanism + initial response', () => {
    const m = enc.saslInitialResponse('SCRAM-SHA-256', Buffer.from('n,,n=u,r=abc'));
    assert.equal(m.toString('ascii', 0, 1), 'p');
    assert.ok(m.includes('SCRAM-SHA-256'));
  });
});

describe('pg codec — backend decoders', () => {
  it('decodes AuthenticationOk + ReadyForQuery', () => {
    const authOk = msg('R', i32(0));
    const ready = msg('Z', Buffer.from('I'));
    const { messages, rest } = decodeBackend(Buffer.concat([authOk, ready]));
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.type, 'R');
    assert.equal((messages[0] as { code: number }).code, 0);
    assert.equal(messages[1]!.type, 'Z');
    assert.equal(rest.length, 0);
  });

  it('decodes RowDescription + DataRow', () => {
    const field = Buffer.concat([cstr('value'), i32(0), i16(0), i32(25), i16(-1), i32(-1), i16(0)]);
    const rowdesc = msg('T', Buffer.concat([i16(1), field]));
    const dataRow = msg('D', Buffer.concat([i16(1), i32(5), Buffer.from('hello')]));
    const { messages } = decodeBackend(Buffer.concat([rowdesc, dataRow]));
    assert.equal(messages[0]!.type, 'T');
    assert.equal((messages[0] as { fields: { name: string }[] }).fields[0]!.name, 'value');
    assert.equal(messages[1]!.type, 'D');
    assert.deepEqual((messages[1] as { values: (string | null)[] }).values, ['hello']);
  });

  it('decodes ErrorResponse fields', () => {
    const payload = Buffer.concat([byte('S'), cstr('ERROR'), byte('C'), cstr('42P01'), byte('M'), cstr('relation does not exist'), Buffer.from([0])]);
    const { messages } = decodeBackend(msg('E', payload));
    const e = messages[0] as { type: string; severity: string; code: string; message: string };
    assert.equal(e.type, 'E');
    assert.equal(e.severity, 'ERROR');
    assert.equal(e.code, '42P01');
    assert.equal(e.message, 'relation does not exist');
  });

  it('holds back incomplete messages and returns the leftover', () => {
    const full = msg('Z', Buffer.from('I'));
    const { messages, rest } = decodeBackend(full.subarray(0, 3)); // partial
    assert.equal(messages.length, 0);
    assert.equal(rest.length, 3);
  });
});

// --- helpers to build backend message bytes ----------------------------------

function i32(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; }
function i16(n: number): Buffer { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; }
function byte(s: string): Buffer { return Buffer.from(s, 'ascii'); }
function cstr(s: string): Buffer { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); }
function msg(type: string, payload: Buffer): Buffer {
  return Buffer.concat([byte(type), i32(payload.length + 4), payload]);
}
