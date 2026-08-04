// @jataqi/game-esports — NOVA Esports & Competition System (section 13). Public API.

export { expectedScore, updateRatings, tierFor, RANK_TIERS } from './rating.js';
export type { RankTier } from './rating.js';
export { Leaderboard, tierList } from './leaderboard.js';
export type { PlayerRecord, Season } from './leaderboard.js';
export { SingleEliminationTournament, SwissTournament } from './tournament.js';
export type { Match, Standing } from './tournament.js';
export { ReplayRecorder, Playback, fingerprint, verifyReplay } from './replay.js';
export type { Replay, ReplayMeta, MatchResult } from './replay.js';
export { EsportsModule, LiveMatch, EsportsEvents } from './esports.js';
export type { EsportsConfig, TournamentFormat, Tournament } from './esports.js';
