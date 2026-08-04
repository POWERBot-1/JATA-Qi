// Behavior trees — a composable, reusable decision formalism (explicitly named
// in §6). A tree is ticked each frame; nodes return Success/Failure/Running.
// Composites (Sequence/Selector/Parallel) and decorators compose leaves into
// rich, interruptible behaviors.

import { Status } from './status.js';
import type { AiContext } from './status.js';

/** Base node interface. */
export interface BtNode {
  readonly name?: string;
  tick(ctx: AiContext): Status;
  /** Reset transient state (e.g. running index). */
  reset?(): void;
}

// ---- Leaves --------------------------------------------------------------

/** An action leaf runs a side-effecting function and returns its status. */
export class Action implements BtNode {
  constructor(public readonly name: string, private fn: (ctx: AiContext) => Status) {}
  tick(ctx: AiContext): Status { return this.fn(ctx); }
}

/** A condition leaf returns Success/Failure from a boolean predicate. */
export class Condition implements BtNode {
  constructor(public readonly name: string, private fn: (ctx: AiContext) => boolean) {}
  tick(ctx: AiContext): Status { return this.fn(ctx) ? Status.Success : Status.Failure; }
}

// ---- Composites ----------------------------------------------------------

/** Sequence — runs children in order; fails fast, succeeds when all succeed. */
export class Sequence implements BtNode {
  private index = 0;
  constructor(public readonly name: string, private children: BtNode[]) {}
  tick(ctx: AiContext): Status {
    for (; this.index < this.children.length; this.index++) {
      const s = this.children[this.index]!.tick(ctx);
      if (s === Status.Running) return Status.Running;
      if (s === Status.Failure) { this.index = 0; return Status.Failure; }
    }
    this.index = 0;
    return Status.Success;
  }
  reset(): void { this.index = 0; for (const c of this.children) c.reset?.(); }
}

/** Selector (priority) — runs children until one succeeds. */
export class Selector implements BtNode {
  private index = 0;
  constructor(public readonly name: string, private children: BtNode[]) {}
  tick(ctx: AiContext): Status {
    for (; this.index < this.children.length; this.index++) {
      const s = this.children[this.index]!.tick(ctx);
      if (s === Status.Running) return Status.Running;
      if (s === Status.Success) { this.index = 0; return Status.Success; }
    }
    this.index = 0;
    return Status.Failure;
  }
  reset(): void { this.index = 0; for (const c of this.children) c.reset?.(); }
}

/** Parallel — ticks all children each frame; policies decide the result. */
export class Parallel implements BtNode {
  constructor(
    public readonly name: string,
    private children: BtNode[],
    private successPolicy: 'all' | 'one' = 'all',
    private failurePolicy: 'all' | 'one' = 'one',
  ) {}
  tick(ctx: AiContext): Status {
    let successes = 0, failures = 0;
    for (const c of this.children) {
      const s = c.tick(ctx);
      if (s === Status.Success) successes++;
      else if (s === Status.Failure) failures++;
    }
    const successNeed = this.successPolicy === 'all' ? this.children.length : 1;
    const failNeed = this.failurePolicy === 'all' ? this.children.length : 1;
    if (failures >= failNeed) return Status.Failure;
    if (successes >= successNeed) return Status.Success;
    return Status.Running;
  }
  reset(): void { for (const c of this.children) c.reset?.(); }
}

// ---- Decorators ----------------------------------------------------------

/** Inverter — flips Success/Failure (Running passes through). */
export class Inverter implements BtNode {
  constructor(public readonly name: string, private child: BtNode) {}
  tick(ctx: AiContext): Status {
    const s = this.child.tick(ctx);
    if (s === Status.Running) return Status.Running;
    return s === Status.Success ? Status.Failure : Status.Success;
  }
  reset(): void { this.child.reset?.(); }
}

/** Repeater — re-ticks the child up to N times per tick. */
export class Repeater implements BtNode {
  constructor(public readonly name: string, private child: BtNode, private times = 1) {}
  tick(ctx: AiContext): Status {
    let s: Status = Status.Success;
    for (let i = 0; i < this.times; i++) s = this.child.tick(ctx);
    return s;
  }
  reset(): void { this.child.reset?.(); }
}

/** UntilFail — keeps ticking the child until it returns Failure. */
export class UntilFail implements BtNode {
  constructor(public readonly name: string, private child: BtNode) {}
  tick(ctx: AiContext): Status {
    const s = this.child.tick(ctx);
    return s === Status.Failure ? Status.Success : Status.Running;
  }
  reset(): void { this.child.reset?.(); }
}

/** Succeeder — always returns Success regardless of the child's result. */
export class Succeeder implements BtNode {
  constructor(public readonly name: string, private child: BtNode) {}
  tick(ctx: AiContext): Status { this.child.tick(ctx); return Status.Success; }
  reset(): void { this.child.reset?.(); }
}

// ---- Fluent builder ------------------------------------------------------

export const bt = {
  action: (name: string, fn: (ctx: AiContext) => Status) => new Action(name, fn),
  condition: (name: string, fn: (ctx: AiContext) => boolean) => new Condition(name, fn),
  sequence: (name: string, ...children: BtNode[]) => new Sequence(name, children),
  selector: (name: string, ...children: BtNode[]) => new Selector(name, children),
  parallel: (name: string, children: BtNode[], success: 'all' | 'one' = 'all', failure: 'all' | 'one' = 'one') => new Parallel(name, children, success, failure),
  invert: (name: string, child: BtNode) => new Inverter(name, child),
  repeat: (name: string, child: BtNode, times = 1) => new Repeater(name, child, times),
  untilFail: (name: string, child: BtNode) => new UntilFail(name, child),
  succeed: (name: string, child: BtNode) => new Succeeder(name, child),
};

/** A behavior-tree driver ticks a tree each step. */
export class BehaviorTree {
  private root: BtNode;
  constructor(root: BtNode) { this.root = root; }
  tick(ctx: AiContext): Status { return this.root.tick(ctx); }
  reset(): void { this.root.reset?.(); }
  static of(root: BtNode): BehaviorTree { return new BehaviorTree(root); }
}
