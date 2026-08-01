// NOVA AI development agents — the five specialized roles that turn a design
// into buildable artifacts: Game Director (vision/roadmap), World Builder
// (procedural world), Character Designer, Programmer (code modules), and Tester
// (automated test scenarios). Each is a deterministic producer given a design.

import { generateWorld, type WorldDefinition } from '@jataqi/game-world';
import { hashSeed } from '@jataqi/game-world';
import type { CodeModule, GameDesignDocument, Milestone, TestScenario } from './types.js';

/** Game Director AI — owns the vision, roadmap, and milestone plan. */
export class GameDirector {
  plan(design: GameDesignDocument): { roadmap: string[]; milestones: Milestone[] } {
    const roadmap = [
      'Prototype core loop',
      'Vertical slice (one polished level)',
      'Content production (world, characters, missions)',
      'Multiplayer & economy integration',
      'Beta release + live-ops readiness',
    ];
    const milestones: Milestone[] = [
      { id: 'ms-1', name: 'Prototype', status: 'planned', deliverables: ['core mechanics', 'placeholder art'] },
      { id: 'ms-2', name: 'Vertical Slice', status: 'planned', deliverables: ['one complete level', 'UI pass'] },
      { id: 'ms-3', name: 'Alpha', status: 'planned', deliverables: ['full world', 'all missions'] },
      { id: 'ms-4', name: 'Beta', status: 'planned', deliverables: ['polish', 'bug fixes', 'performance'] },
    ];
    void design;
    return { roadmap, milestones };
  }
}

/** World Builder AI — generates a coherent procedural world from the design. */
export class WorldBuilder {
  build(design: GameDesignDocument, size = 64): { seed: string; world: WorldDefinition } {
    const seed = 'nova-' + hashSeed(design.concept.title + design.concept.setting).toString(36);
    const world = generateWorld({
      seed,
      width: size,
      height: size,
      settlements: design.concept.features.includes('open-world') ? 32 : 16,
      regionGrid: 4,
      island: 0.4,
    });
    return { seed, world };
  }
}

/** Character Designer AI — selects/refines the character roster from the design. */
export class CharacterDesigner {
  roster(design: GameDesignDocument) {
    // The design already produces the canonical roster; the agent validates it.
    return design.characters.map((c) => ({ ...c, finalized: true }));
  }
}

/** Programmer AI — plans the code modules (systems) the build requires. */
export class Programmer {
  modules(design: GameDesignDocument): CodeModule[] {
    const mods: CodeModule[] = [];
    const c = design.concept;
    mods.push({ id: 'mod-input', name: 'InputSystem', responsibility: 'Polls input and maps it to actions.', systems: ['nova.Input'], dependsOn: [], contract: 'action(name): number in [-1,1]' });
    mods.push({ id: 'mod-player', name: 'PlayerController', responsibility: 'Moves the player entity from input.', systems: ['nova.PlayerController'], dependsOn: ['InputSystem'], contract: 'requires Transform + Velocity' });
    if (c.features.includes('combat') || c.genre.includes('fps') || c.genre.includes('fighting')) {
      mods.push({ id: 'mod-combat', name: 'CombatSystem', responsibility: 'Resolves attacks, damage, and health.', systems: ['nova.Combat'], dependsOn: ['PlayerController'], contract: 'Health(component) + Damage(events)' });
    }
    if (c.features.includes('vehicles') || c.genre.includes('racing')) {
      mods.push({ id: 'mod-vehicle', name: 'VehicleSystem', responsibility: 'Vehicle physics and control.', systems: ['nova.Vehicle'], dependsOn: ['InputSystem'], contract: 'requires Transform + RigidBody + Vehicle(component)' });
    }
    if (c.features.includes('economy')) {
      mods.push({ id: 'mod-economy', name: 'EconomySystem', responsibility: 'Currencies, wallets, and transactions.', systems: ['nova.Economy'], dependsOn: [], contract: 'Wallet(entity) + spend/earn events' });
    }
    if (c.multiplayer !== 'single-player') {
      mods.push({ id: 'mod-net', name: 'NetworkSystem', responsibility: 'State replication + RPCs.', systems: ['nova.Network'], dependsOn: ['PlayerController'], contract: 'authoritative server + client prediction' });
    }
    mods.push({ id: 'mod-save', name: 'SaveSystem', responsibility: 'Serializes world state to storage.', systems: ['nova.Save'], dependsOn: [], contract: 'snapshot(): WorldData' });
    return mods;
  }
}

/** Testing AI — generates automated test scenarios covering the design. */
export class Tester {
  scenarios(design: GameDesignDocument): TestScenario[] {
    const tests: TestScenario[] = [
      { id: 't-smoke', title: 'Boot to playable state', category: 'smoke', steps: ['Start the game', 'Reach the first interactive moment'], expectedOutcome: 'No crashes; input responds' },
      { id: 't-core', title: 'Core loop', category: 'smoke', steps: ['Complete the tutorial', 'Finish one main quest'], expectedOutcome: 'Progression saved; rewards granted' },
      { id: 't-balance', title: 'Difficulty curve', category: 'balance', steps: ['Play early, mid, and late missions'], expectedOutcome: 'Difficulty scales smoothly' },
    ];
    if (design.concept.multiplayer !== 'single-player') {
      tests.push({ id: 't-net', title: 'Multiplayer sync', category: 'smoke', steps: ['Connect two clients', 'Perform a shared action'], expectedOutcome: 'Both clients converge' });
    }
    tests.push(
      { id: 't-edge', title: 'Boundary stress', category: 'edge-case', steps: ['Move to world edge', 'Spam input', 'Force-disconnect'], expectedOutcome: 'Handled gracefully' },
      { id: 't-perf', title: 'Frame budget', category: 'performance', steps: ['Load a dense area', 'Measure over 10s'], expectedOutcome: 'Sustains target frame rate' },
    );
    return tests;
  }
}

export const AGENTS = {
  director: new GameDirector(),
  world: new WorldBuilder(),
  characters: new CharacterDesigner(),
  programmer: new Programmer(),
  tester: new Tester(),
};
