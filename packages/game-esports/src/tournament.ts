// Tournaments (§13). Single-elimination brackets (seeded, with byes) and Swiss
// pairing (score-bucketed, no rematches, Buchholz tiebreak). Both are pure data
// structures driven by reported results, so they're fully testable offline.

import { randomUUID } from 'node:crypto';

export interface Match {
  id: string;
  round: number;
  /** [playerA, playerB]; a bye is represented as null. */
  players: [string | null, string | null];
  winner?: string | null; // null = draw/bye-advance
  reported: boolean;
}

export interface Standing { player: string; score: number; wins: number; losses: number; draws: number; buchholz: number }

/** Single-elimination bracket. Seeds (highest first) get byes in round 1. */
export class SingleEliminationTournament {
  readonly format = 'single-elim';
  private players: string[] = [];
  private currentRound: string[] = []; // players advancing into the next round
  private matches: Match[] = [];
  private round = 0;
  private started = false;

  constructor(players: string[] = []) { this.players = [...players]; }

  get isStarted(): boolean { return this.started; }
  get isComplete(): boolean { return this.started && this.currentRound.length <= 1; }
  get currentRoundNumber(): number { return this.round; }
  allMatches(): Match[] { return [...this.matches]; }

  /** Start the bracket; seeds may be ordered strongest-first. */
  start(seeds?: string[]): void {
    if (this.started) throw new Error('tournament already started');
    this.started = true;
    this.currentRound = seeds && seeds.length === this.players.length ? [...seeds] : this.shuffle(this.players);
    this.nextRound();
  }

  /** Build the matches for the current round. */
  private nextRound(): void {
    this.round++;
    const field = this.currentRound;
    this.matches = [];
    for (let i = 0; i < field.length; i += 2) {
      const a = field[i] ?? null;
      const b = field[i + 1] ?? null;
      const match: Match = { id: randomUUID(), round: this.round, players: [a, b], reported: false };
      // Auto-advance a bye.
      if (a === null || b === null) { match.winner = a ?? b; match.reported = true; }
      this.matches.push(match);
    }
    // Advance byes immediately.
    this.currentRound = this.matches.filter((m) => m.reported).map((m) => m.winner) as string[];
    // If all matches are byes, keep going until matches remain or we have a champ.
    if (this.currentRound.length > 1 && this.matches.every((m) => m.reported)) this.nextRound();
  }

  /** The matches still awaiting a result this round. */
  pendingMatches(): Match[] { return this.matches.filter((m) => !m.reported); }

  /** Report a result; advances the bracket when the round completes. */
  reportResult(matchId: string, winner: string): Match {
    const m = this.matches.find((x) => x.id === matchId);
    if (!m) throw new Error(`match ${matchId} not found`);
    if (m.reported) throw new Error('match already reported');
    if (!m.players.includes(winner)) throw new Error(`${winner} not in this match`);
    m.winner = winner; m.reported = true;
    if (this.matches.every((x) => x.reported)) {
      this.currentRound = this.matches.map((x) => x.winner) as string[];
      if (this.currentRound.length > 1) this.nextRound();
    }
    return m;
  }

  /** The champion, once complete. */
  champion(): string | undefined {
    return this.isComplete ? (this.currentRound[0] ?? undefined) : undefined;
  }

  /** Unified winner accessor (matches SwissTournament). */
  winner(): string | undefined { return this.champion(); }

  private shuffle(arr: string[]): string[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
    return a;
  }
}

/** Swiss tournament — score-bucketed pairing, no rematches, Buchholz tiebreak. */
export class SwissTournament {
  readonly format = 'swiss';
  private players: string[] = [];
  private roundsPlanned: number;
  private round = 0;
  private matches: Match[] = [];
  private scores = new Map<string, number>();
  private opponents = new Map<string, Set<string>>();
  private started = false;

  constructor(players: string[] = [], rounds?: number) {
    this.players = [...players];
    // Default: ceil(log2(n)) rounds, at least 3.
    this.roundsPlanned = rounds ?? Math.max(3, Math.ceil(Math.log2(Math.max(2, players.length))));
  }

  get isStarted(): boolean { return this.started; }
  get isComplete(): boolean { return this.started && this.round >= this.roundsPlanned && this.matches.every((m) => m.reported); }
  allMatches(): Match[] { return [...this.matches]; }
  pendingMatches(): Match[] { return this.matches.filter((m) => !m.reported); }
  get currentRoundNumber(): number { return this.round; }

  start(): void {
    if (this.started || this.players.length < 2) throw new Error('need >= 2 players');
    this.started = true;
    for (const p of this.players) { this.scores.set(p, 0); this.opponents.set(p, new Set()); }
    this.pairRound();
  }

  /** Pair players into score buckets, avoiding rematches. */
  private pairRound(): void {
    this.round++;
    this.matches = [];
    // Sort by score desc, then random within tier.
    const order = [...this.players].sort((a, b) => (this.scores.get(b)! - this.scores.get(a)!) || Math.random() - 0.5);
    const paired = new Set<string>();
    for (let i = 0; i < order.length; i++) {
      const a = order[i]!;
      if (paired.has(a)) continue;
      let partner: string | null = null;
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j]!;
        if (paired.has(b)) continue;
        if (!this.opponents.get(a)!.has(b)) { partner = b; break; }
      }
      if (partner === null) continue; // leave unpaired (rare with odd + rematch constraints)
      paired.add(a); paired.add(partner);
      this.matches.push({ id: randomUUID(), round: this.round, players: [a, partner], reported: false });
    }
  }

  reportResult(matchId: string, winner: string | null): Match {
    const m = this.matches.find((x) => x.id === matchId);
    if (!m || m.reported) throw new Error('invalid match');
    if (winner !== null && !m.players.includes(winner)) throw new Error(`${winner} not in this match`);
    m.winner = winner; m.reported = true;
    const [a, b] = m.players;
    this.opponents.get(a!)!.add(b!);
    this.opponents.get(b!)!.add(a!);
    if (winner === null) { this.scores.set(a!, this.scores.get(a!)! + 1); this.scores.set(b!, this.scores.get(b!)! + 1); }
    else { this.scores.set(winner, this.scores.get(winner)! + 1); }
    if (this.matches.every((x) => x.reported) && this.round < this.roundsPlanned) this.pairRound();
    return m;
  }

  /** Final standings (score then Buchholz = sum of opponents' scores). */
  standings(): Standing[] {
    const list: Standing[] = this.players.map((p) => {
      let buchholz = 0;
      for (const opp of this.opponents.get(p)!) buchholz += this.scores.get(opp) ?? 0;
      const played = [...this.allMatches()].filter((m) => m.players.includes(p) && m.reported);
      const wins = played.filter((m) => m.winner === p).length;
      const draws = played.filter((m) => m.winner === null).length;
      const losses = played.filter((m) => m.winner && m.winner !== p).length;
      return { player: p, score: this.scores.get(p)!, wins, losses, draws, buchholz };
    });
    return list.sort((a, b) => b.score - a.score || b.buchholz - a.buchholz);
  }

  winner(): string | undefined {
    if (!this.isComplete) return undefined;
    return this.standings()[0]?.player;
  }
}
