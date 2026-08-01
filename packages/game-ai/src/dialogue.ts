// Dialogue system — branching conversations with guards and effects (§6
// "conversations"). A dialogue is a graph of nodes; choices branch to other
// nodes and can mutate shared conversation state.

export type DialogueState = Record<string, boolean | number | string>;
export type DialogueGuard = (state: DialogueState) => boolean;
export type DialogueEffect = (state: DialogueState) => void;

export interface DialogueChoice {
  text: string;
  next?: string; // node id; omitted ends the conversation
  guard?: DialogueGuard;
  effect?: DialogueEffect;
}

export interface DialogueNode {
  id: string;
  speaker?: string;
  text: string;
  onEnter?: DialogueEffect;
  choices: DialogueChoice[];
}

export class DialogueGraph {
  private nodes = new Map<string, DialogueNode>();
  readonly start: string;
  constructor(start: string, nodes: DialogueNode[]) {
    this.start = start;
    for (const n of nodes) this.nodes.set(n.id, n);
  }
  get(id: string): DialogueNode | undefined { return this.nodes.get(id); }
}

/** Runs a dialogue over a mutable state object. */
export class DialogueRunner {
  private graph: DialogueGraph;
  private state: DialogueState;
  private currentId: string;
  private done = false;
  /** Lines spoken so far (transcript). */
  readonly log: string[] = [];

  constructor(graph: DialogueGraph, state: DialogueState = {}) {
    this.graph = graph;
    this.state = state;
    this.currentId = graph.start;
    this.enterCurrent();
  }

  get stateSnapshot(): DialogueState { return { ...this.state }; }

  /** The current node (visible choices filtered by their guards). */
  current(): { node: DialogueNode; choices: DialogueChoice[] } {
    const node = this.graph.get(this.currentId)!;
    return { node, choices: node.choices.filter((c) => !c.guard || c.guard(this.state)) };
  }

  /** Select a (visible) choice by index. */
  choose(index: number): void {
    if (this.done) return;
    const { choices } = this.current();
    const choice = choices[index];
    if (!choice) return;
    choice.effect?.(this.state);
    if (!choice.next) { this.done = true; return; }
    this.currentId = choice.next;
    this.enterCurrent();
  }

  isComplete(): boolean { return this.done; }

  private enterCurrent(): void {
    const node = this.graph.get(this.currentId);
    if (!node) { this.done = true; return; }
    node.onEnter?.(this.state);
    this.log.push(`${node.speaker ? node.speaker + ': ' : ''}${node.text}`);
    if (node.choices.length === 0) this.done = true;
  }
}
