// WebSocket — a connection wrapper over a raw Duplex (net.Socket after upgrade).
// Handles the frame-level protocol: fragmentation reassembly, ping→pong,
// close handshake, and message dispatch.

import type { Socket } from 'node:net';
import { encodeFrame, decodeFrames, Opcode, type WsFrame } from './ws-codec.js';

export type MessageHandler = (data: string | Buffer, isBinary: boolean) => void;
export type CloseHandler = (code: number, reason: string) => void;

export class WebSocket {
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;
  private fragments: Buffer[] = [];
  private fragOpcode = 0;
  readonly remoteAddress?: string;

  constructor(
    private readonly socket: Socket,
    private readonly onMessage?: MessageHandler,
    private readonly onClose?: CloseHandler,
    private readonly onPing?: () => void,
  ) {
    this.remoteAddress = socket.remoteAddress;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => { if (!this.closed) this.doClose(1011, 'internal error'); });
    socket.on('close', () => { if (!this.closed) this.doClose(1006, 'abnormal closure'); });
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    const { frames, rest } = decodeFrames(this.buf);
    this.buf = rest;
    for (const frame of frames) this.onFrame(frame);
  }

  private onFrame(frame: WsFrame): void {
    // Control frames (never fragmented).
    if (frame.opcode === Opcode.PING) { this.raw(Opcode.PONG, frame.payload); this.onPing?.(); return; }
    if (frame.opcode === Opcode.PONG) return;
    if (frame.opcode === Opcode.CLOSE) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
      const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
      this.raw(Opcode.CLOSE, frame.payload.length >= 2 ? frame.payload : Buffer.from([0x03, 0xe8]));
      this.doClose(code, reason);
      return;
    }
    // Data frames.
    if (frame.opcode === Opcode.TEXT || frame.opcode === Opcode.BINARY) {
      if (frame.fin) {
        this.dispatch(frame.opcode, frame.payload);
      } else {
        this.fragments = [frame.payload];
        this.fragOpcode = frame.opcode;
      }
    } else if (frame.opcode === Opcode.CONTINUATION) {
      this.fragments.push(frame.payload);
      if (frame.fin) { this.dispatch(this.fragOpcode, Buffer.concat(this.fragments)); this.fragments = []; }
    }
  }

  private dispatch(opcode: number, data: Buffer): void {
    this.onMessage?.(opcode === Opcode.TEXT ? data.toString('utf8') : data, opcode === Opcode.BINARY);
  }

  /** Send a text or binary message. */
  send(data: string | Buffer): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(typeof data === 'string' ? Opcode.TEXT : Opcode.BINARY, Buffer.isBuffer(data) ? data : Buffer.from(data)));
  }

  ping(data?: string): void { this.raw(Opcode.PING, data ? Buffer.from(data) : Buffer.alloc(0)); }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.raw(Opcode.CLOSE, payload);
    this.doClose(code, reason);
  }

  private raw(opcode: number, payload: Buffer): void {
    if (!this.closed) this.socket.write(encodeFrame(opcode, payload));
  }

  private doClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose?.(code, reason);
  }

  get isClosed(): boolean { return this.closed; }
}
