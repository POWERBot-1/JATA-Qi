// EsportsModule — the competition control plane (§13): leaderboards, tournament
// registry, replay vault, match-result recording, and a live-match spectator
// bus. Integrates with the kernel event bus for analytics/notifications.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { Leaderboard } from './leaderboard.js';
import { SingleEliminationTournament, SwissTournament } from './tournament.js';
import type { Match } from './tournament.js';
import { ReplayRecorder, type Replay } from './replay.js';
import type { MatchResult } from './replay.js';

export const EsportsEvents = Object.freeze({
  MatchRecorded: 'esports.match.recorded',
  TournamentComplete: 'esports.tournament.complete',
  SpectatorFrame: 'esports.spectator.frame',
} as const);

export type TournamentFormat = 'single-elim' | 'swiss';
export type Tournament = SingleEliminationTournament | SwissTournament;

/** A live, spectatable match that broadcasts each captured frame to subscribers. */
export class LiveMatch {
  readonly recorder: ReplayRecorder;
  private spectators = new Set<(frame: unknown) => void>();
  constructor(readonly id: string, meta: ConstructorParameters<typeof ReplayRecorder>[0]) {
    this.recorder = new ReplayRecorder(meta);
  }
  broadcast(frame: unknown): void {
    this.recorder.capture(frame);
    for (const s of this.spectators) s(frame);
  }
  subscribe(fn: (frame: unknown) => void): () => void {
    this.spectators.add(fn);
    return () => this.spectators.delete(fn);
  }
  get spectatorCount(): number { return this.spectators.size; }
}

export interface EsportsConfig { kFactor?: number; startingRating?: number }

export class EsportsModule implements IModule {
  readonly id = 'game-esports';
  readonly tags = ['core', 'game'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly leaderboard: Leaderboard;
  private tournaments = new Map<string, Tournament>();
  private replayVault = new Map<string, Replay>();
  private liveMatches = new Map<string, LiveMatch>();
  private results: MatchResult[] = [];

  constructor(cfg: EsportsConfig = {}) {
    this.leaderboard = new Leaderboard({ kFactor: cfg.kFactor, startingRating: cfg.startingRating });
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('game-esports', this);
    kernel.logger.info('game-esports initialized');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- tournaments -------------------------------------------------------

  createTournament(format: TournamentFormat, players: string[], opts: { rounds?: number; seeds?: string[] } = {}): Tournament {
    const t: Tournament = format === 'swiss'
      ? new SwissTournament(players, opts.rounds)
      : new SingleEliminationTournament(players);
    const id = randomUUID();
    (t as { _novaId?: string })._novaId = id;
    this.tournaments.set(id, t);
    if (format === 'single-elim') (t as SingleEliminationTournament).start(opts.seeds);
    else (t as SwissTournament).start();
    return t;
  }

  /** Report a tournament match; auto-detects the tournament's report shape. */
  reportTournamentMatch(t: Tournament, match: Match, winner: string | null): Match {
    if (t instanceof SwissTournament) return t.reportResult(match.id, winner);
    if (winner === null) throw new Error('single-elim cannot draw');
    return t.reportResult(match.id, winner);
  }

  /** Mark a tournament complete and emit an event with its winner. */
  finalizeTournament(t: Tournament): string | undefined {
    const winner = t.winner();
    if (winner !== undefined) void this.api.bus.emit(EsportsEvents.TournamentComplete, { winner });
    return winner;
  }

  // ---- match results + replays ------------------------------------------

  /** Record a finished match: updates the leaderboard and stores the result. */
  recordMatchResult(result: Omit<MatchResult, 'id' | 'playedAt'> & { id?: string; playedAt?: number }): MatchResult {
    const full: MatchResult = { id: result.id ?? randomUUID(), playedAt: result.playedAt ?? Date.now(), ...result };
    this.results.push(full);
    // Update the 1v1 leaderboard when exactly two players are present.
    const ps = full.players;
    if (ps.length === 2) {
      const [a, b] = ps;
      const scoreA = full.winner === null ? 0.5 : full.winner === a ? 1 : 0;
      this.leaderboard.recordMatch(a!, b!, scoreA);
    }
    void this.api.bus.emit(EsportsEvents.MatchRecorded, { id: full.id, winner: full.winner });
    return full;
  }

  storeReplay(replay: Replay): Replay { this.replayVault.set(replay.id, replay); return replay; }
  getReplay(id: string): Replay | undefined { return this.replayVault.get(id); }
  resultsList(): MatchResult[] { return [...this.results]; }

  // ---- live spectator matches -------------------------------------------

  startLiveMatch(meta: ConstructorParameters<typeof ReplayRecorder>[0]): LiveMatch {
    const lm = new LiveMatch(randomUUID(), meta);
    this.liveMatches.set(lm.id, lm);
    lm.subscribe((frame) => void this.api.bus.emit(EsportsEvents.SpectatorFrame, { match: lm.id }));
    return lm;
  }
  getLiveMatch(id: string): LiveMatch | undefined { return this.liveMatches.get(id); }
}

export { Leaderboard, SingleEliminationTournament, SwissTournament, ReplayRecorder };
export type { Match, Replay, MatchResult };
