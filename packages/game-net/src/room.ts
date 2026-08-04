// Room — an authoritative multiplayer match. The server owns the canonical
// game world (a game-engine ECS World), applies client inputs through a
// game-defined handler, ticks deterministically, and broadcasts full snapshots
// and compressed deltas. Inputs pass the anti-cheat before being applied.

import type { World, EntityId } from '@jataqi/game-engine';
import type { NetTransport } from './transport.js';
import { diffSnapshots, type NetMessage, type SnapshotData } from './protocol.js';
import type { AntiCheat } from './antichat.js';
import type { ValidationContext } from './antichat.js';

/** Applies a client input to the authoritative world for an entity. */
export type InputHandler = (world: World, entity: EntityId, payload: unknown) => void;

export interface RoomConfig {
  /** Components replicated to clients (by name). */
  replicate: string[];
  inputHandler: InputHandler;
  /** Fixed simulation step (seconds). */
  fixedDt?: number;
  /** Broadcast a snapshot every N ticks (delta otherwise). */
  snapshotEvery?: number;
  antiCheat?: AntiCheat;
  /** Max retained snapshots for delta baselines. */
  history?: number;
  /** Sets up a freshly created player entity (add Transform, etc.). */
  onJoin?: (world: World, entity: EntityId, peer: string) => void;
  /** Server peer id that admits join/leave messages (default 'server'). */
  serverPeer?: string;
}

interface Player { peer: string; entity: EntityId; lastInputSeq: number; }
interface QueuedInput { peer: string; entity: EntityId; seq: number; payload: unknown; }

export class Room {
  private players = new Map<string, Player>();
  private queue: QueuedInput[] = [];
  private snapshots: Array<{ seq: number; state: SnapshotData }> = [];
  private lastBroadcastSeq = 0;
  private seq = 0;
  private tickCount = 0;
  private nextEntity = 1;
  private readonly cfg: Required<Omit<RoomConfig, 'antiCheat' | 'onJoin' | 'serverPeer'>> & {
    antiCheat?: AntiCheat;
    onJoin?: (world: World, entity: EntityId, peer: string) => void;
    serverPeer?: string;
  };
  private readonly peerState = new Map<string, unknown>();

  constructor(
    private world: World,
    private transport: NetTransport,
    cfg: RoomConfig,
  ) {
    this.cfg = {
      replicate: cfg.replicate,
      inputHandler: cfg.inputHandler,
      fixedDt: cfg.fixedDt ?? 1 / 30,
      snapshotEvery: cfg.snapshotEvery ?? 20,
      history: cfg.history ?? 30,
      ...(cfg.antiCheat ? { antiCheat: cfg.antiCheat } : {}),
      ...(cfg.onJoin ? { onJoin: cfg.onJoin } : {}),
      ...(cfg.serverPeer ? { serverPeer: cfg.serverPeer } : {}),
    };
    this.transport.onMessage((from, msg) => this.onMessage(from, msg));
  }

  get tick(): number { return this.tickCount; }
  get playerCount(): number { return this.players.size; }
  playersOf(): string[] { return [...this.players.keys()]; }

  /** Admit a player, create their entity, and notify them. */
  join(peer: string, name?: string): EntityId {
    if (this.players.has(peer)) return this.players.get(peer)!.entity;
    const entity = this.nextEntity++;
    // Ensure the entity exists in the authoritative world.
    if (!this.world.hasEntity(entity)) this.world.createEntity();
    this.cfg.onJoin?.(this.world, entity, peer);
    this.players.set(peer, { peer, entity, lastInputSeq: 0 });
    this.transport.send(peer, { t: 'joined', peer, entity, seq: this.seq });
    this.transport.broadcast({ t: 'join', peer, ...(name ? { name } : {}) });
    return entity;
  }

  /** Remove a player and destroy their entity. */
  leave(peer: string): boolean {
    const p = this.players.get(peer);
    if (!p) return false;
    this.world.destroyEntity(p.entity);
    this.players.delete(peer);
    this.transport.broadcast({ t: 'leave', peer });
    return true;
  }

  /** Process an inbound message from a peer. */
  private onMessage(from: string, msg: NetMessage): void {
    switch (msg.t) {
      case 'join':
        this.join(from, msg.name);
        break;
      case 'leave':
        this.leave(from);
        break;
      case 'input': {
        const player = this.players.get(from);
        if (!player || msg.seq <= player.lastInputSeq) return;
        const ctx: ValidationContext = { peer: from, now: Date.now(), state: this.peerState as Map<string, unknown> };
        if (this.cfg.antiCheat) {
          const r = this.cfg.antiCheat.validate(msg.payload, ctx);
          if (!r.ok) return; // drop cheating input
        }
        player.lastInputSeq = msg.seq;
        this.queue.push({ peer: from, entity: player.entity, seq: msg.seq, payload: msg.payload });
        this.transport.send(from, { t: 'ack', peer: from, seq: msg.seq });
        break;
      }
      default:
        break; // other messages handled by the host application
    }
  }

  /** Advance the authoritative simulation by one fixed step. */
  step(): void {
    // Apply queued inputs (drain).
    const inputs = this.queue;
    this.queue = [];
    for (const i of inputs) this.cfg.inputHandler(this.world, i.entity, i.payload);
    this.world.step(this.cfg.fixedDt);
    this.tickCount++;

    if (this.tickCount % this.cfg.snapshotEvery === 0) {
      this.broadcastSnapshot();
    }
  }

  /** Capture the replicated state for all entities. */
  snapshot(): SnapshotData {
    const state: SnapshotData = {};
    for (const id of this.world.entities()) {
      const comps: Record<string, unknown> = {};
      for (const c of this.cfg.replicate) {
        if (this.world.has(id, c)) comps[c] = this.world.get(id, c);
      }
      if (Object.keys(comps).length > 0) state[String(id)] = comps;
    }
    return state;
  }

  /** Broadcast a snapshot or delta (delta against the last broadcast). */
  private broadcastSnapshot(): void {
    const seq = ++this.seq;
    const state = this.snapshot();
    this.snapshots.push({ seq, state });
    if (this.snapshots.length > this.cfg.history) this.snapshots.shift();
    if (this.lastBroadcastSeq === 0) {
      this.transport.broadcast({ t: 'snapshot', seq, tick: this.tickCount, state });
    } else {
      const base = this.snapshots.find((s) => s.seq === this.lastBroadcastSeq)?.state ?? {};
      const { changes, removed } = diffSnapshots(base, state);
      this.transport.broadcast({ t: 'delta', seq, base: this.lastBroadcastSeq, tick: this.tickCount, changes, removed });
    }
    this.lastBroadcastSeq = seq;
  }

  /** Force a full snapshot broadcast (e.g. on a new client join). */
  forceSnapshot(): void { this.lastBroadcastSeq = 0; this.broadcastSnapshot(); }
}
