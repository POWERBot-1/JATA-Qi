// Replay system (§13). A replay is an ordered sequence of game-state frames
// captured during a match, plus metadata. Frames are arbitrary JSON-serializable
// snapshots (e.g. a serialized game-engine World), so the recorder works with
// any game. Playback yields frames deterministically at the recorded tick rate.

import { createHash } from 'node:crypto';
import type { World } from '@jataqi/game-engine';

export interface ReplayMeta {
  gameId: string;
  mode?: string;
  players: string[];
  tickRate: number;
  startedAt: number;
  durationSec?: number;
}

export interface Replay {
  id: string;
  meta: ReplayMeta;
  frames: unknown[];
  /** SHA-256 fingerprint of the frame stream (tamper-evident). */
  fingerprint: string;
}

/** Records frames during a live match into a Replay. */
export class ReplayRecorder {
  private frames: unknown[] = [];
  private startTick = 0;

  constructor(private meta: ReplayMeta) {}

  /** Capture a frame (a plain snapshot object). */
  capture(frame: unknown): void { this.frames.push(frame); }

  /** Convenience: capture a serialized ECS world snapshot. */
  captureWorld(world: World): void { this.frames.push(world.serialize()); }

  /** Number of frames recorded so far. */
  get frameCount(): number { return this.frames.length; }

  /** Finalize the replay. */
  finish(now = Date.now()): Replay {
    const durationSec = this.meta.tickRate > 0 ? this.frames.length / this.meta.tickRate : 0;
    const replay: Replay = {
      id: `replay-${this.meta.gameId}-${now}`,
      meta: { ...this.meta, durationSec },
      frames: this.frames,
      fingerprint: fingerprint(this.frames),
    };
    return replay;
  }
}

/** Deterministic SHA-256 fingerprint over a frame stream. */
export function fingerprint(frames: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(frames)).digest('hex');
}

/** Verify a replay's frames match its fingerprint (tamper detection). */
export function verifyReplay(replay: Replay): boolean {
  return fingerprint(replay.frames) === replay.fingerprint;
}

/** Plays back a replay, yielding frames at the recorded cadence. */
export class Playback {
  private index = 0;
  constructor(private replay: Replay) {}

  get frameCount(): number { return this.replay.frames.length; }
  get isComplete(): boolean { return this.index >= this.replay.frames.length; }
  get progress(): number { return this.replay.frames.length === 0 ? 1 : this.index / this.replay.frames.length; }

  /** Advance one frame; returns the frame or undefined at the end. */
  nextFrame(): unknown | undefined {
    if (this.index >= this.replay.frames.length) return undefined;
    return this.replay.frames[this.index++]!;
  }

  /** Seek to a frame index. */
  seek(index: number): void { this.index = Math.max(0, Math.min(index, this.replay.frames.length)); }

  /** Iterate all frames (optionally up to a limit). */
  *iterate(limit?: number): IterableIterator<unknown> {
    const max = limit !== undefined ? Math.min(limit, this.replay.frames.length) : this.replay.frames.length;
    for (let i = 0; i < max; i++) yield this.replay.frames[i]!;
  }
}

/** A completed competitive match result, optionally linked to a replay. */
export interface MatchResult {
  id: string;
  players: string[];
  /** playerId -> score. */
  scores: Record<string, number>;
  winner: string | null; // null = draw
  replayId?: string;
  playedAt: number;
}
