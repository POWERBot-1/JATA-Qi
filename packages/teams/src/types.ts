// JATA Qi Teams — multi-agent coordination types.
//
// The Multi-Agent Intelligence Framework (spec Step 6 MAIF) coordinates
// specialized agents that divide an objective into tasks, share context, and
// return consolidated results. This package implements the "Mission Coordinator"
// collaboration modes: parallel fan-out, sequential pipeline, and consensus.

export type CollaborationMode = 'parallel' | 'sequential' | 'consensus';

/** Declaration of a team of agents and how they collaborate. */
export interface TeamConfig {
  readonly name: string;
  /** Member agent names (must exist or be auto-created). */
  readonly members: string[];
  readonly mode?: CollaborationMode;
  /** Agent that merges member contributions (parallel mode). Default 'main'. */
  readonly synthesizer?: string;
  readonly description?: string;
}

/** A single member's contribution to a team run. */
export interface Contribution {
  readonly agent: string;
  readonly output: string;
  /** True when this member agreed with the consensus answer. */
  readonly agrees?: boolean;
}

/** The result of coordinating a team on an objective. */
export interface TeamResult {
  readonly objective: string;
  readonly team: string;
  readonly mode: CollaborationMode;
  readonly contributions: Contribution[];
  /** Merged/consolidated answer. */
  readonly synthesis: string;
}

export const TeamEvents = Object.freeze({
  TeamRegistered: 'teams.team.registered',
  TeamRunStarted: 'teams.run.started',
  TeamRunCompleted: 'teams.run.completed',
} as const);
