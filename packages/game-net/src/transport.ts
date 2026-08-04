// Transport abstraction. Production wires WebSocket/UDP; tests use the in-memory
// LoopbackHub, which models a lossless ordered network with configurable latency
// and packet loss so netcode can be exercised deterministically offline.

import type { NetMessage } from './protocol.js';

export interface NetTransport {
  readonly peerId: string;
  send(peer: string, msg: NetMessage): void;
  broadcast(msg: NetMessage): void;
  onMessage(handler: (from: string, msg: NetMessage) => void): void;
}

/** A central in-memory hub connecting multiple transports (server + clients). */
export class LoopbackHub {
  private transports = new Map<string, LoopbackTransport>();
  /** Configured one-way latency in ms (0 = synchronous delivery). */
  latencyMs = 0;
  /** Drop probability for each sent message (0..1). */
  dropRate = 0;
  private seq = 0;

  connect(peerId: string): LoopbackTransport {
    if (this.transports.has(peerId)) throw new Error(`peer ${peerId} already connected`);
    const t = new LoopbackTransport(peerId, this);
    this.transports.set(peerId, t);
    return t;
  }

  disconnect(peerId: string): void { this.transports.delete(peerId); }
  peers(): string[] { return [...this.transports.keys()]; }
  get(peerId: string): LoopbackTransport | undefined { return this.transports.get(peerId); }

  /** Deliver a message from `from` to `to` (or broadcast if to is '*'). */
  deliver(from: string, to: string, msg: NetMessage): void {
    if (this.dropRate > 0 && Math.random() < this.dropRate) return; // packet loss
    const send = (target: string): void => {
      const t = this.transports.get(target);
      if (t) t.receive(from, msg);
    };
    if (to === '*') {
      for (const p of this.transports.keys()) if (p !== from) send(p);
    } else {
      send(to);
    }
    void this.seq;
  }
}

export class LoopbackTransport implements NetTransport {
  readonly peerId: string;
  private handler?: (from: string, msg: NetMessage) => void;
  private hub: LoopbackHub;

  constructor(peerId: string, hub: LoopbackHub) { this.peerId = peerId; this.hub = hub; }

  send(peer: string, msg: NetMessage): void { this.hub.deliver(this.peerId, peer, msg); }
  broadcast(msg: NetMessage): void { this.hub.deliver(this.peerId, '*', msg); }
  onMessage(handler: (from: string, msg: NetMessage) => void): void { this.handler = handler; }

  /** Called by the hub to deliver an incoming message. */
  receive(from: string, msg: NetMessage): void { this.handler?.(from, msg); }
}
