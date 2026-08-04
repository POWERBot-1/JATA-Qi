// NPC intelligence tests — utility AI, FSM, GOAP, personality/emotion/
// relationships, dialogue, and the NpcAgent + NpcSystem over the ECS.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@jataqi/game-engine';
import {
  Blackboard, UtilityAi, curves, FiniteStateMachine, FsmState, plan,
  makePersonality, applyEmotion, emotionLabel, Relationships,
  DialogueGraph, DialogueRunner, NpcAgent, NpcSystem, Status, bt,
} from '../src/index.js';
import type { AiContext, WorldState } from '../src/index.js';

describe('utility AI', () => {
  it('picks the highest-scoring action', () => {
    const bb = new Blackboard();
    bb.set('hunger', 0.9);
    bb.set('gold', 0.1);
    const ai = new UtilityAi()
      .add({
        name: 'eat', considerations: [{ score: (c: AiContext) => c.blackboard.get<number>('hunger') ?? 0, weight: 1 }],
        run: () => { bb.set('hunger', Math.max(0, (bb.get<number>('hunger') ?? 0) - 0.5)); },
      })
      .add({
        name: 'work', considerations: [{ score: (c: AiContext) => 1 - (c.blackboard.get<number>('gold') ?? 0), weight: 1 }],
        run: () => { bb.set('gold', (bb.get<number>('gold') ?? 0) + 0.2); },
      });
    const choice = ai.decide({ blackboard: bb });
    assert.equal(choice?.name, 'eat'); // hunger 0.9 > (1-0.1)=0.9 tie -> first wins; bias both 0
  });

  it('applies response curves and bias', () => {
    const bb = new Blackboard();
    bb.set('threat', 0.6);
    const flee = { name: 'flee', considerations: [{ score: (c: AiContext) => c.blackboard.get<number>('threat') ?? 0, weight: 1, curve: curves.quadratic }], run: () => {}, bias: 0.1 };
    const ai = new UtilityAi().add(flee);
    const s = ai.score(flee, { blackboard: bb });
    assert.ok(s > 0);
    assert.ok(s < 1.2);
  });
});

describe('finite state machine', () => {
  it('transitions on guards and runs on-update', () => {
    const bb = new Blackboard();
    let patrolled = 0;
    const fsm = new FiniteStateMachine('idle');
    fsm.add(new FsmState('idle', undefined, (c: AiContext) => { if (c.blackboard.get('enemy')) return; }).to('patrol', (c: AiContext) => !c.blackboard.get('enemy')));
    fsm.add(new FsmState('patrol', () => {}, (c: AiContext) => { if (c.blackboard.get('enemy')) return; patrolled++; }).to('chase', (c: AiContext) => !!c.blackboard.get('enemy')));
    fsm.add(new FsmState('chase').to('idle', (c: AiContext) => !c.blackboard.get('enemy')));
    fsm.tick({ blackboard: bb }); // idle -> patrol
    assert.equal(fsm.currentName, 'patrol');
    fsm.tick({ blackboard: bb }); // patrol
    bb.set('enemy', true);
    fsm.tick({ blackboard: bb }); // -> chase
    assert.equal(fsm.currentName, 'chase');
    assert.ok(patrolled >= 1);
  });
});

describe('GOAP planner', () => {
  it('finds a least-cost plan to satisfy a goal', () => {
    const actions = [
      { name: 'getAxe', preconditions: (s: WorldState) => !s.hasAxe, effects: (s: WorldState) => { s.hasAxe = true; }, cost: 1 },
      { name: 'chopWood', preconditions: (s: WorldState) => !!s.hasAxe, effects: (s: WorldState) => { s.wood = ((s.wood as number) ?? 0) + 1; }, cost: 2 },
    ];
    const result = plan({ hasAxe: false, wood: 0 }, actions, { satisfied: (s) => (s.wood as number) >= 1 });
    assert.ok(result);
    assert.deepEqual(result!.actions, ['getAxe', 'chopWood']);
    assert.equal(result!.cost, 3);
  });

  it('returns an empty plan when the goal is already met', () => {
    const result = plan({ ready: true }, [], { satisfied: (s) => !!s.ready });
    assert.deepEqual(result!.actions, []);
  });

  it('returns null when the goal is unreachable', () => {
    const result = plan({}, [{ name: 'noop', preconditions: () => false, effects: () => {} }], { satisfied: () => false });
    assert.equal(result, null);
  });
});

describe('personality / emotion / relationships', () => {
  it('derives emotion labels from PAD vectors', () => {
    assert.equal(emotionLabel({ p: 0.6, a: 0.6, d: 0 }), 'joyful');
    assert.equal(emotionLabel({ p: -0.5, a: 0.6, d: 0 }), 'angry');
  });

  it('applyEmotion shifts and decays toward baseline', () => {
    let e = applyEmotion({ p: 0, a: 0, d: 0 }, { p: 0.8 });
    assert.ok(e.p > 0 && e.p < 0.8); // decayed
  });

  it('relationships track affinity and friend/enemy thresholds', () => {
    const r = new Relationships();
    r.adjust('npc1', 'player', 0.5);
    assert.equal(r.isFriend('npc1', 'player'), true);
    r.adjust('npc1', 'player', -1.0);
    assert.equal(r.isEnemy('npc1', 'player'), true);
    assert.ok(r.neighbors('npc1').includes('player'));
  });

  it('personality has defaults and overrides', () => {
    const p = makePersonality({ extraversion: 0.9 });
    assert.equal(p.extraversion, 0.9);
    assert.equal(p.openness, 0.5);
  });
});

describe('dialogue', () => {
  it('branches on choices and mutates state', () => {
    const graph = new DialogueGraph('start', [
      { id: 'start', speaker: 'NPC', text: 'Need help?', choices: [
        { text: 'Yes', next: 'yes', effect: (s) => { s.helped = true; } },
        { text: 'No', next: 'bye' },
      ] },
      { id: 'yes', speaker: 'NPC', text: 'Done!', choices: [] },
      { id: 'bye', speaker: 'NPC', text: 'Goodbye.', choices: [] },
    ]);
    const runner = new DialogueRunner(graph);
    assert.equal(runner.current().node.id, 'start');
    runner.choose(0); // Yes -> yes
    assert.equal(runner.stateSnapshot.helped, true);
    assert.equal(runner.current().node.id, 'yes');
    assert.ok(runner.isComplete()); // 'yes' has no choices
    assert.ok(runner.log.length >= 2);
  });

  it('respects choice guards', () => {
    const graph = new DialogueGraph('s', [
      { id: 's', text: 'hi', choices: [
        { text: 'secret', next: 'secret', guard: (st) => !!st.unlocked },
        { text: 'leave', next: 'end' },
      ] },
      { id: 'secret', text: '...', choices: [] },
      { id: 'end', text: 'bye', choices: [] },
    ]);
    const runner = new DialogueRunner(graph, {});
    assert.equal(runner.current().choices.length, 1); // secret hidden
  });
});

describe('NpcAgent + NpcSystem', () => {
  it('an agent driven by a behavior tree ticks and records its action', () => {
    const agent = new NpcAgent('g1').useBehaviorTree(
      bt.selector('root', bt.action('patrol', () => Status.Success)),
    );
    const action = agent.tick({ blackboard: new Blackboard(), dt: 0.016 });
    assert.equal(action, Status.Success);
    assert.equal(agent.lastAction, Status.Success);
  });

  it('an agent reacts emotionally', () => {
    const agent = new NpcAgent('g2');
    const label = agent.feel({ p: -0.6, a: 0.6 });
    assert.equal(label, 'angry');
  });

  it('NpcSystem ticks every Npc entity and writes NpcAction', () => {
    const world = new World();
    const sys = new NpcSystem({ world });
    const e = world.createEntity();
    const agent = new NpcAgent('npc-1').useBehaviorTree(bt.action('idle', () => Status.Success));
    world.add(e, 'Npc', agent);
    sys.update(world, 0.016);
    assert.equal(world.get<{ action: string }>(e, 'NpcAction')!.action, Status.Success);
  });

  it('a GOAP agent executes its plan step by step', () => {
    const agent = new NpcAgent('planner').useGoap(
      { hasAxe: false, wood: 0 },
      [
        { name: 'getAxe', preconditions: (s) => !s.hasAxe, effects: (s) => { s.hasAxe = true; }, cost: 1 },
        { name: 'chop', preconditions: (s) => !!s.hasAxe, effects: (s) => { s.wood = ((s.wood as number) ?? 0) + 1; }, cost: 1 },
      ],
      { satisfied: (s) => (s.wood as number) >= 1 },
    );
    assert.equal(agent.tick({ blackboard: new Blackboard() }), 'getAxe');
    assert.equal(agent.tick({ blackboard: new Blackboard() }), 'chop');
    assert.equal(agent.tick({ blackboard: new Blackboard() }), 'idle'); // plan done
  });
});
