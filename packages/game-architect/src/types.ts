// NOVA Game Architect — types. Turns a natural-language game idea into a full,
// structured Game Design Document and orchestrates the five AI development
// agents (Director, World Builder, Character, Programmer, Tester).

/** The high-level concept extracted from a user prompt. */
export interface GameConcept {
  title: string;
  genre: Genre[];
  perspective: Perspective;
  themes: string[];
  setting: string;
  features: GameFeature[];
  multiplayer: MultiplayerKind;
  platforms: Platform[];
  artStyle: ArtStyle;
  audience: string;
  /** The original prompt (normalized). */
  prompt: string;
}

export type Genre =
  | 'racing' | 'fps' | 'shooter' | 'rpg' | 'platformer' | 'puzzle' | 'strategy'
  | 'card' | 'sandbox' | 'survival' | 'adventure' | 'simulation' | 'fighting'
  | 'open-world' | 'stealth' | 'rhythm';

export type Perspective = 'first-person' | 'third-person' | 'top-down' | 'side-scrolling' | 'isometric' | 'vr';
export type GameFeature = 'multiplayer' | 'open-world' | 'story-driven' | 'procedural' | 'crafting' | 'economy' | 'combat' | 'vehicles' | 'pvp' | 'pve' | 'day-night' | 'weather' | 'permadeath';
export type MultiplayerKind = 'single-player' | 'co-op' | 'pvp' | 'mmo' | 'local-multiplayer';
export type Platform = 'web' | 'mobile' | 'pc' | 'console' | 'vr';
export type ArtStyle = 'realistic' | 'stylized' | 'low-poly' | 'pixel-art' | 'cel-shaded' | 'voxel' | 'hand-drawn';

export interface Character {
  id: string;
  name: string;
  role: 'protagonist' | 'ally' | 'antagonist' | 'mentor' | 'npc';
  archetype: string;
  description: string;
  abilities: string[];
  personality: string[];
}

export interface Mission {
  id: string;
  title: string;
  kind: 'tutorial' | 'main' | 'side' | 'repeatable' | 'event';
  summary: string;
  objectives: string[];
  rewards: string[];
}

export interface EconomyDesign {
  currencies: Array<{ name: string; earn: string; spend: string }>;
  sinks: string[];
  sources: string[];
}

export interface UiSpec { hud: string[]; menus: string[]; }
export interface SoundDesign { music: string[]; sfx: string[]; voice: string[]; }

export interface GameDesignDocument {
  concept: GameConcept;
  logline: string;
  story: { premise: string; acts: string[]; stakes: string };
  characters: Character[];
  missions: Mission[];
  rules: { win: string[]; lose: string[]; scoring: string };
  physicsProfile: string[];
  economy: EconomyDesign;
  ui: UiSpec;
  sound: SoundDesign;
}

/** A code module the Programming AI plans for the build. */
export interface CodeModule {
  id: string;
  name: string;
  responsibility: string;
  /** Declarative systems this module contributes to the ECS. */
  systems: string[];
  /** Other modules it depends on. */
  dependsOn: string[];
  /** A short, human-readable contract. */
  contract: string;
}

export interface TestScenario {
  id: string;
  title: string;
  steps: string[];
  expectedOutcome: string;
  category: 'smoke' | 'balance' | 'edge-case' | 'performance';
}

export interface Milestone {
  id: string;
  name: string;
  status: 'planned' | 'in-progress' | 'done';
  deliverables: string[];
}

export interface BuildTarget {
  platform: Platform;
  status: 'pending' | 'building' | 'ready' | 'failed';
  artifact?: string;
}

export interface GameProject {
  id: string;
  title: string;
  createdAt: number;
  concept: GameConcept;
  design: GameDesignDocument;
  characters: Character[];
  modules: CodeModule[];
  tests: TestScenario[];
  milestones: Milestone[];
  roadmap: string[];
  seed: string;
}

export interface BuildManifest {
  projectId: string;
  version: string;
  channel: 'dev' | 'beta' | 'stable';
  targets: BuildTarget[];
  createdAt: number;
  /** SHA-256 fingerprint of the build contents (deterministic). */
  fingerprint: string;
  releaseNotes: string[];
}
