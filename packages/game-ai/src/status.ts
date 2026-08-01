// NOVA NPC AI — shared status type, blackboard contract, and decision context.

/** Result of evaluating a decision node for one tick. */
export enum Status {
  Success = 'success',
  Failure = 'failure',
  Running = 'running',
}

/** Per-agent working memory contract. */
export interface Blackboard {
  get<T = unknown>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  keys(): string[];
  /** Snapshot the blackboard as a plain object (for save/inspect). */
  toJSON(): Record<string, unknown>;
}

/** Context handed to every decision node on each tick. */
export interface AiContext {
  /** Per-agent working memory. */
  blackboard: Blackboard;
  /** Optional ECS world the agent lives in. */
  world?: unknown;
  /** The entity this agent controls (when running over the ECS). */
  entity?: number;
  /** Seconds since the last tick. */
  dt?: number;
  /** Wall-clock time (ms). */
  now?: number;
}
