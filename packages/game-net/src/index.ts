// @jataqi/game-net — NOVA Multiplayer Network Engine (section 9). Public API.

export { LoopbackHub, LoopbackTransport } from './transport.js';
export type { NetTransport } from './transport.js';
export { diffSnapshots } from './protocol.js';
export type { NetMessage, SnapshotData } from './protocol.js';
export { Room } from './room.js';
export type { RoomConfig, InputHandler } from './room.js';
export { NetClient } from './client.js';
export { Matchmaker } from './matchmaker.js';
export type { MatchRequest, FormedMatch } from './matchmaker.js';
export { AntiCheat, RateLimitValidator, MagnitudeValidator, ShapeValidator } from './antichat.js';
export type { InputValidator, ValidationResult, ValidationContext } from './antichat.js';
