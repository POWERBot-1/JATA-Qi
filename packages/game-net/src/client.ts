// NetClient — client-side network model with local prediction and server
// reconciliation. The client mirrors the authoritative world, applies its own
// inputs immediately (prediction) for responsiveness, and converges to the
// server's snapshots. Pending (un-acked) inputs are replayed on reconciliation.

import type { World, EntityId } from '@jataqi/game-engine';
import type { NetTransport } from './transport.js';
import type { InputHandler } from './room.js';
import type { NetMessage, SnapshotData } from './protocol.js';

interface PendingInput { seq: number; payload: unknown; }

export class NetClient {
  private entity: EntityId | null = null;
  private seq = 0;
  private pending: PendingInput[] = [];
  private lastServerSeq = 0;
  private handler: ((msg: NetMessage) => void) | null = null;

  constructor(
    private world: World,
    private transport: NetTransport,
    private inputHandler: InputHandler,
    private replicate: string[],
  ) {
    this.transport.onMessage((from, msg) => this.handleMessage(from, msg));
  }

  /** Request to join the match. */
  join(name?: string): void { this.transport.send('server', { t: 'join', peer: this.transport.peerId, ...(name ? { name } : {}) }); }
  leave(): void { this.transport.send('server', { t: 'leave', peer: this.transport.peerId }); }

  get ownEntity(): EntityId | null { return this.entity; }
  get lastAcknowledgedSeq(): number { return this.lastServerSeq; }

  /** Send a local input, predicting its effect immediately. */
  sendInput(payload: unknown): number {
    this.seq++;
    if (this.entity !== null) {
      this.inputHandler(this.world, this.entity, payload); // prediction
      this.pending.push({ seq: this.seq, payload });
    }
    this.transport.send('server', { t: 'input', peer: this.transport.peerId, seq: this.seq, payload });
    return this.seq;
  }

  /** Observe arbitrary server messages (for the host application). */
  onMessage(handler: (msg: NetMessage) => void): void { this.handler = handler; }

  private handleMessage(_from: string, msg: NetMessage): void {
    switch (msg.t) {
      case 'joined':
        this.entity = msg.entity;
        if (!this.world.hasEntity(msg.entity)) this.world.createEntity();
        break;
      case 'ack':
        // Drop acked inputs from the pending buffer.
        this.pending = this.pending.filter((p) => p.seq > msg.seq);
        this.lastServerSeq = msg.seq;
        break;
      case 'snapshot':
        this.applyState(msg.state, /* full */ true);
        this.lastServerSeq = msg.seq;
        break;
      case 'delta':
        this.applyState(msg.changes, /* full */ false);
        this.lastServerSeq = msg.seq;
        break;
      default:
        break;
    }
    this.handler?.(msg);
  }

  /** Apply server state, reconciling the local (own) entity by replaying inputs. */
  private applyState(state: SnapshotData, full: boolean): void {
    for (const [idStr, comps] of Object.entries(state)) {
      const id = Number(idStr);
      if (!this.world.hasEntity(id)) this.world.createEntity();
      for (const [comp, value] of Object.entries(comps)) {
        if (this.replicate.includes(comp)) this.world.add(id, comp, value);
      }
      // Reconcile the own entity: re-apply pending inputs on top of server truth.
      if (id === this.entity) {
        for (const p of this.pending) this.inputHandler(this.world, id, p.payload);
      }
    }
    if (full) {
      // Remove entities no longer present in a full snapshot.
      const present = new Set(Object.keys(state));
      for (const e of this.world.entities()) if (!present.has(String(e))) this.world.destroyEntity(e);
    }
  }
}
