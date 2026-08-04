// Esports tests — Elo, leaderboards, single-elim + Swiss tournaments, replays,
// and the module's match recording + spectator flow.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  expectedScore, updateRatings, tierFor,
  Leaderboard, SingleEliminationTournament, SwissTournament,
  ReplayRecorder, Playback, fingerprint, verifyReplay,
  EsportsModule, EsportsEvents,
} from '../src/index.js';

describe('rating — Elo', () => {
  it('expected score is 0.5 for equal ratings', () => {
    assert.ok(Math.abs(expectedScore(1500, 1500) - 0.5) < 1e-9);
  });

  it('a win raises the winner and lowers the loser', () => {
    const r = updateRatings(1500, 1500, 1);
    assert.ok(r.a > 1500);
    assert.ok(r.b < 1500);
    assert.ok(Math.abs(r.deltaA + r.deltaB) < 1e-9); // zero-sum
  });

  it('assigns rank tiers', () => {
    assert.equal(tierFor(1000).name, 'Bronze');
    assert.equal(tierFor(1450).name, 'Gold');
    assert.equal(tierFor(2100).name, 'Master');
  });
});

describe('Leaderboard', () => {
  it('records matches and ranks players', () => {
    const lb = new Leaderboard({ startingRating: 1200 });
    lb.recordMatch('a', 'b', 1); // a beats b
    lb.recordMatch('a', 'c', 1); // a beats c
    const ranking = lb.ranking();
    assert.equal(ranking[0]!.playerId, 'a');
    assert.equal(lb.rank('a'), 1);
    assert.ok(lb.top(2).length === 2);
  });

  it('rotates seasons', () => {
    const lb = new Leaderboard();
    lb.recordMatch('a', 'b', 1);
    const s = lb.newSeason({ resetRatings: true });
    assert.equal(s.id, 2);
    assert.equal(lb.get('a')!.rating, 1200);
  });

  it('reports a tier distribution', () => {
    const lb = new Leaderboard();
    lb.register('a', 2100);
    const dist = lb.tierDistribution();
    assert.ok(dist.Master >= 1);
  });
});

describe('SingleEliminationTournament', () => {
  it('runs a 4-player bracket to a champion', () => {
    const t = new SingleEliminationTournament(['p1', 'p2', 'p3', 'p4']);
    t.start(['p1', 'p2', 'p3', 'p4']);
    // Round 1: two matches.
    const r1 = t.pendingMatches();
    assert.equal(r1.length, 2);
    t.reportResult(r1[0]!.id, r1[0]!.players[0]!);
    t.reportResult(r1[1]!.id, r1[1]!.players[0]!);
    // Final.
    const final = t.pendingMatches();
    assert.equal(final.length, 1);
    t.reportResult(final[0]!.id, final[0]!.players[0]!);
    assert.equal(t.isComplete, true);
    assert.ok(t.champion());
  });

  it('awards byes for non-power-of-2 fields', () => {
    const t = new SingleEliminationTournament(['a', 'b', 'c']);
    t.start(['a', 'b', 'c']);
    // 3 players -> one bye in round 1, one real match.
    assert.ok(t.allMatches().length >= 1);
  });
});

describe('SwissTournament', () => {
  it('pairs without rematches and ranks by score + Buchholz', () => {
    const players = ['a', 'b', 'c', 'd', 'e', 'f'];
    const t = new SwissTournament(players, 3);
    t.start();
    // Play all rounds, always favoring the first-listed player.
    for (let r = 0; r < 3; r++) {
      for (const m of t.pendingMatches()) t.reportResult(m.id, m.players[0]!);
    }
    assert.equal(t.isComplete, true);
    const standings = t.standings();
    assert.equal(standings.length, players.length);
    // No pair repeated across the tournament.
    const pairs = new Set<string>();
    let rematch = false;
    for (const m of t.allMatches()) {
      const key = [m.players[0], m.players[1]].sort().join('|');
      if (pairs.has(key)) rematch = true;
      pairs.add(key);
    }
    assert.equal(rematch, false);
    assert.ok(t.winner());
  });
});

describe('Replay', () => {
  it('records, fingerprints, and plays back frames', () => {
    const rec = new ReplayRecorder({ gameId: 'g1', players: ['a', 'b'], tickRate: 10, startedAt: 0 });
    for (let i = 0; i < 10; i++) rec.capture({ tick: i, pos: [i, 0, 0] });
    const replay = rec.finish();
    assert.equal(replay.frames.length, 10);
    assert.equal(verifyReplay(replay), true);
    // Tamper detection.
    const tampered = { ...replay, frames: [...replay.frames, { extra: true }] };
    assert.equal(verifyReplay(tampered), false);
    const pb = new Playback(replay);
    let count = 0;
    for (const _f of pb.iterate()) count++;
    assert.equal(count, 10);
    void fingerprint;
  });
});

describe('EsportsModule — integration', () => {
  let kernel: Kernel;
  let mod: EsportsModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new EsportsModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('records a match result and updates the leaderboard', () => {
    const before = mod.leaderboard.get('alice')?.rating ?? 1200;
    mod.recordMatchResult({ players: ['alice', 'bob'], scores: { alice: 3, bob: 1 }, winner: 'alice' });
    const after = mod.leaderboard.get('alice')!.rating;
    assert.ok(after > before);
  });

  it('runs a tournament through the module', () => {
    const t = mod.createTournament('single-elim', ['x', 'y', 'z', 'w']);
    for (const m of t.pendingMatches()) mod.reportTournamentMatch(t, m, m.players[0]!);
    for (const m of t.pendingMatches()) mod.reportTournamentMatch(t, m, m.players[0]!);
    assert.equal(t.isComplete, true);
    assert.ok(mod.finalizeTournament(t));
  });

  it('broadcasts live frames to spectators', () => {
    const seen: unknown[] = [];
    const lm = mod.startLiveMatch({ gameId: 'live', players: ['a', 'b'], tickRate: 10, startedAt: Date.now() });
    lm.subscribe((f) => seen.push(f));
    lm.broadcast({ tick: 0 });
    lm.broadcast({ tick: 1 });
    assert.equal(seen.length, 2);
    assert.equal(lm.recorder.frameCount, 2);
  });

  it('emits match-recorded events', async () => {
    let fired = false;
    kernel.bus.on(EsportsEvents.MatchRecorded, () => { fired = true; });
    mod.recordMatchResult({ players: ['s', 't'], scores: { s: 1, t: 0 }, winner: 's' });
    await new Promise((r) => setImmediate(r));
    assert.equal(fired, true);
  });
});
