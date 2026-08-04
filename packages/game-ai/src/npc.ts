// NPC agent + ECS system. An NpcAgent bundles a blackboard (memory), a decision
// driver (behavior tree / utility / FSM / planner), personality, emotion, and
// relationships, and is ticked each step. The NpcSystem runs all NPC agents in a
// game-engine World, advancing the agents that carry an Npc component.

import type { World } from '@jataqi/game-engine';
import { Blackboard } from './blackboard.js';
import { BehaviorTree, type BtNode } from './bt.js';
import { Status, type AiContext } from './status.js';
import { UtilityAi } from './utility.js';
import { FiniteStateMachine } from './fsm.js';
import { plan, type GoapAction, type WorldState } from './planner.js';
import { Emotion, Personality, Relationships, applyEmotion, emotionLabel, makeEmotion, makePersonality } from './personality.js';

/** Which decision formalism an NPC uses. */
export type DriverKind = 'bt' | 'utility' | 'fsm' | 'goap';

/** An NPC that lives in the world and acts each tick. */
export class NpcAgent {
  readonly id: string;
  readonly blackboard = new Blackboard();
  readonly personality: Personality;
  emotion: Emotion;
  relationships: Relationships;
  kind: DriverKind;
  /** The last action this agent took (for inspection/analytics). */
  lastAction: string | null = null;
  private tree?: BehaviorTree;
  private utility?: UtilityAi;
  private fsm?: FiniteStateMachine;
  private goapState?: WorldState;
  private goapActions?: GoapAction[];
  private goapGoal?: { satisfied: (s: WorldState) => boolean };
  private goapPlan: string[] = [];

  constructor(id: string, opts: { personality?: Partial<Personality>; emotion?: Partial<Emotion>; relationships?: Relationships } = {}) {
    this.id = id;
    this.personality = makePersonality(opts.personality);
    this.emotion = makeEmotion(opts.emotion);
    this.relationships = opts.relationships ?? new Relationships();
    this.kind = 'bt';
  }

  /** Drive this agent with a behavior tree. */
  useBehaviorTree(root: BtNode): this { this.tree = BehaviorTree.of(root); this.kind = 'bt'; return this; }
  /** Drive this agent with utility AI. */
  useUtility(ai: UtilityAi): this { this.utility = ai; this.kind = 'utility'; return this; }
  /** Drive this agent with a finite state machine. */
  useFsm(fsm: FiniteStateMachine): this { this.fsm = fsm; this.kind = 'fsm'; return this; }
  /** Drive this agent with GOAP. */
  useGoap(state: WorldState, actions: GoapAction[], goal: { satisfied: (s: WorldState) => boolean }): this {
    this.goapState = state; this.goapActions = actions; this.goapGoal = goal; this.kind = 'goap'; return this;
  }

  /** Tick the agent; returns the action/status observed this step. */
  tick(ctx: AiContext): string {
    ctx.blackboard = this.blackboard;
    // Memory decay.
    this.blackboard.decayAll(ctx.dt ?? 0);
    switch (this.kind) {
      case 'bt': {
        const s = this.tree?.tick(ctx) ?? Status.Failure;
        this.lastAction = s;
        return s;
      }
      case 'utility': {
        const name = this.utility?.tick(ctx) ?? null;
        this.lastAction = name;
        return name ?? 'idle';
      }
      case 'fsm': {
        const name = this.fsm?.tick(ctx) ?? 'none';
        this.lastAction = name;
        return name;
      }
      case 'goap': {
        return this.tickGoap(ctx);
      }
      default:
        return 'idle';
    }
  }

  private tickGoap(ctx: AiContext): string {
    void ctx;
    if (this.goapPlan.length === 0 && this.goapState && this.goapActions && this.goapGoal) {
      const result = plan(this.goapState, this.goapActions, this.goapGoal);
      this.goapPlan = result?.actions ?? [];
    }
    if (this.goapPlan.length === 0) { this.lastAction = 'idle'; return 'idle'; }
    const next = this.goapPlan.shift()!;
    const action = this.goapActions?.find((a) => a.name === next);
    if (action && this.goapState && action.preconditions(this.goapState)) action.effects(this.goapState);
    this.lastAction = next;
    return next;
  }

  /** React to an event with an emotional shift. */
  feel(delta: Partial<Emotion>): string {
    this.emotion = applyEmotion(this.emotion, delta);
    return emotionLabel(this.emotion);
  }
}

/**
 * NpcSystem — an ECS system that ticks every entity carrying an 'Npc' component
 * (whose value is the NpcAgent). Each tick advances the agent and writes its
 * observed action back to the entity for other systems to read.
 */
export class NpcSystem {
  readonly name = 'nova.Npc';
  readonly query = { all: ['Npc'] as const };
  private ctxBase: Omit<AiContext, 'blackboard'>;

  constructor(opts: { world?: World } = {}) {
    this.ctxBase = { ...(opts.world ? { world: opts.world } : {}) };
  }

  update(world: World, dt: number): void {
    for (const e of world.query({ all: ['Npc'] })) {
      const agent = world.get<NpcAgent>(e, 'Npc');
      if (!agent) continue;
      const ctx: AiContext = { ...this.ctxBase, blackboard: agent.blackboard, entity: e, dt, now: Date.now() };
      const action = agent.tick(ctx);
      const existing = world.get<{ action: string }>(e, 'NpcAction');
      if (existing) existing.action = action;
      else world.add(e, 'NpcAction', { action });
    }
  }
}

export { Status, emotionLabel };
export type { AiContext, BtNode };
