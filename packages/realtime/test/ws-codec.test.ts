// WebSocket frame codec tests — RFC 6455 framing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrames, encodeMaskedFrame, Opcode } from '../src/index.js';

describe('ws codec — encode/decode round-trips', () => {
  it('text frame (short payload)', () => {
    const f = encodeFrame(Opcode.TEXT, Buffer.from('hello'));
    const { frames, rest } = decodeFrames(f);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.fin, true);
    assert.equal(frames[0]!.opcode, Opcode.TEXT);
    assert.equal(frames[0]!.payload.toString(), 'hello');
    assert.equal(rest.length, 0);
  });

  it('binary frame', () => {
    const data = Buffer.from([0, 1, 2, 255, 254]);
    const f = encodeFrame(Opcode.BINARY, data);
    const { frames } = decodeFrames(f);
    assert.deepEqual([...frames[0]!.payload], [...data]);
  });

  it('medium payload (126 → 16-bit length)', () => {
    const data = Buffer.alloc(200, 0x42);
    const f = encodeFrame(Opcode.BINARY, data);
    const { frames } = decodeFrames(f);
    assert.equal(frames[0]!.payload.length, 200);
  });

  it('large payload (127 → 64-bit length)', () => {
    const data = Buffer.alloc(70_000, 0x01);
    const f = encodeFrame(Opcode.BINARY, data);
    const { frames } = decodeFrames(f);
    assert.equal(frames[0]!.payload.length, 70_000);
  });

  it('masked client frame (encodeMaskedFrame → decodeFrames unmasks)', () => {
    const data = Buffer.from('masked hello');
    const f = encodeMaskedFrame(Opcode.TEXT, data);
    const { frames } = decodeFrames(f);
    assert.equal(frames[0]!.payload.toString(), 'masked hello');
  });

  it('control frames (ping/pong/close)', () => {
    const ping = encodeFrame(Opcode.PING, Buffer.from('heartbeat'));
    const { frames } = decodeFrames(ping);
    assert.equal(frames[0]!.opcode, Opcode.PING);
    assert.equal(frames[0]!.payload.toString(), 'heartbeat');
  });

  it('fragmented frames (fin=false + continuation)', () => {
    const f1 = encodeFrame(Opcode.TEXT, Buffer.from('hel'), false);
    const f2 = encodeFrame(Opcode.CONTINUATION, Buffer.from('lo'), true);
    const { frames } = decodeFrames(Buffer.concat([f1, f2]));
    assert.equal(frames.length, 2);
    assert.equal(frames[0]!.fin, false);
    assert.equal(frames[1]!.fin, true);
    assert.equal(frames[1]!.opcode, Opcode.CONTINUATION);
  });

  it('partial frame: returns leftover, no frames', () => {
    const f = encodeFrame(Opcode.TEXT, Buffer.from('hello'));
    const { frames, rest } = decodeFrames(f.subarray(0, 3));
    assert.equal(frames.length, 0);
    assert.equal(rest.length, 3);
  });

  it('multiple frames in one buffer', () => {
    const batch = Buffer.concat([
      encodeFrame(Opcode.TEXT, Buffer.from('a')),
      encodeFrame(Opcode.TEXT, Buffer.from('b')),
      encodeFrame(Opcode.PING, Buffer.alloc(0)),
    ]);
    const { frames, rest } = decodeFrames(batch);
    assert.equal(frames.length, 3);
    assert.equal(frames[0]!.payload.toString(), 'a');
    assert.equal(frames[1]!.payload.toString(), 'b');
    assert.equal(frames[2]!.opcode, Opcode.PING);
    assert.equal(rest.length, 0);
  });
});
