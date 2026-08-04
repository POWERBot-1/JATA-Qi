// @jataqi/game-architect — NOVA AI Game Creation (sections 2 & 19). Public API.

export { GameArchitect, fingerprint } from './architect.js';
export type { DesignLlm } from './architect.js';
export { parsePrompt } from './prompt.js';
export { designGame } from './design.js';
export { GameDirector, WorldBuilder, CharacterDesigner, Programmer, Tester, AGENTS } from './agents.js';
export type {
  GameConcept, GameDesignDocument, Genre, Perspective, GameFeature, MultiplayerKind,
  Platform, ArtStyle, Character, Mission, EconomyDesign, UiSpec, SoundDesign,
  CodeModule, TestScenario, Milestone, BuildTarget, GameProject, BuildManifest,
} from './types.js';
