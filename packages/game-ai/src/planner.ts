// GOAP-lite — goal-oriented action planning. The agent describes a desired
// world state and available actions (preconditions + effects + cost); the
// planner finds the least-cost action sequence that achieves the goal. This is
// the "autonomous agents" capability of §6.

export type WorldState = Record<string, boolean | number>;

export interface GoapAction {
  name: string;
  /** True when the action can run in this state. */
  preconditions: (s: WorldState) => boolean;
  /** Mutates the state when the action is applied. */
  effects: (s: WorldState) => void;
  /** Step cost (default 1). */
  cost?: number;
}

export interface GoapGoal {
  /** True when the goal is satisfied by this state. */
  satisfied: (s: WorldState) => boolean;
}

export interface PlanResult {
  actions: string[];
  cost: number;
}

/** Plan a least-cost action sequence from `start` to satisfy `goal`. */
export function plan(start: WorldState, actions: GoapAction[], goal: GoapGoal, maxNodes = 2000): PlanResult | null {
  if (goal.satisfied(start)) return { actions: [], cost: 0 };
  // Dijkstra over reachable states (frontier prioritized by g).
  const seen = new Set<string>([key(start)]);
  const frontier: Array<{ state: WorldState; g: number; path: string[] }> = [{ state: clone(start), g: 0, path: [] }];
  let expanded = 0;
  while (frontier.length > 0) {
    if (expanded++ > maxNodes) return null;
    frontier.sort((a, b) => a.g - b.g);
    const node = frontier.shift()!;
    if (goal.satisfied(node.state)) return { actions: node.path, cost: node.g };
    for (const a of actions) {
      if (!a.preconditions(node.state)) continue;
      const next = clone(node.state);
      a.effects(next);
      const k = key(next);
      if (seen.has(k)) continue;
      seen.add(k);
      frontier.push({ state: next, g: node.g + (a.cost ?? 1), path: [...node.path, a.name] });
    }
  }
  return null;
}

function clone(s: WorldState): WorldState { return { ...s }; }
function key(s: WorldState): string {
  return Object.keys(s).sort().map((k) => `${k}=${s[k]}`).join('|');
}
