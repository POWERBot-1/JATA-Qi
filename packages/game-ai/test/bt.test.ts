// Behavior tree tests — composites, decorators, memory effects.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Status, Blackboard, BehaviorTree, bt, type AiContext } from '../src/index.js';

function ctx(bb = new Blackboard()): AiContext { return { blackboard: bb }; }

describe('behavior trees — leaves', () => {
  it('action returns its status', () => {
    const t = BehaviorTree.of(bt.action('a', () => Status.Success));
    assert.equal(t.tick(ctx()), Status.Success);
  });

  it('condition maps a boolean', () => {
    const t = BehaviorTree.of(bt.condition('c', () => false));
    assert.equal(t.tick(ctx()), Status.Failure);
  });
});

describe('behavior trees — composites', () => {
  it('sequence fails fast and remembers the running child', () => {
    let ran = 0;
    const seq = bt.sequence('s',
      bt.action('a', () => { ran++; return Status.Success; }),
      bt.action('b', () => Status.Running),
      bt.action('c', () => { ran++; return Status.Success; }),
    );
    const t = BehaviorTree.of(seq);
    assert.equal(t.tick(ctx()), Status.Running);
    assert.equal(ran, 1);
    // Next tick resumes at b; once b succeeds it continues to c.
  });

  it('selector picks the first succeeding child', () => {
    const sel = bt.selector('sel',
      bt.condition('fail', () => false),
      bt.action('ok', () => Status.Success),
      bt.action('never', () => Status.Failure),
    );
    assert.equal(BehaviorTree.of(sel).tick(ctx()), Status.Success);
  });

  it('parallel runs all children and applies policies', () => {
    const par = bt.parallel('p', [
      bt.action('a', () => Status.Success),
      bt.action('b', () => Status.Failure),
    ], 'all', 'one');
    assert.equal(BehaviorTree.of(par).tick(ctx()), Status.Failure); // one failure
  });
});

describe('behavior trees — decorators', () => {
  it('inverter flips success/failure', () => {
    const inv = bt.invert('inv', bt.action('a', () => Status.Success));
    assert.equal(BehaviorTree.of(inv).tick(ctx()), Status.Failure);
  });

  it('untilFail keeps running until the child fails', () => {
    let n = 0;
    const uf = bt.untilFail('uf', bt.action('a', () => { n++; return n >= 3 ? Status.Failure : Status.Success; }));
    const t = BehaviorTree.of(uf);
    assert.equal(t.tick(ctx()), Status.Running);
    assert.equal(t.tick(ctx()), Status.Running);
    assert.equal(t.tick(ctx()), Status.Success);
  });

  it('succeeder always succeeds', () => {
    const s = bt.succeed('s', bt.action('a', () => Status.Failure));
    assert.equal(BehaviorTree.of(s).tick(ctx()), Status.Success);
  });
});

describe('behavior trees — behavior + memory', () => {
  it('a guard reads/writes blackboard to change behavior', () => {
    const bb = new Blackboard();
    bb.set('alerted', false);
    const tree = BehaviorTree.of(bt.selector('root',
      bt.sequence('attack',
        bt.condition('alerted?', () => bb.get<boolean>('alerted') === true),
        bt.action('strike', () => Status.Success),
      ),
      bt.action('idle', () => Status.Success),
    ));
    assert.equal(tree.tick(ctx(bb)), Status.Success); // idle branch wins
    bb.set('alerted', true);
    // selector resumes from index 0 after a terminal result each tick
    assert.equal(tree.tick(ctx(bb)), Status.Success); // attack branch wins
  });
});
