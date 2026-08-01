// NOVA Game Architect tests — prompt parsing, design generation, the 5 agents,
// the autonomous build pipeline, and determinism.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GameArchitect, parsePrompt, designGame, AGENTS, fingerprint,
} from '../src/index.js';

const EXAMPLE = 'Create an open-world African futuristic racing game with villages, cities, wildlife, drones, and multiplayer';

describe('parsePrompt', () => {
  it('detects genres, features, themes, perspective', () => {
    const c = parsePrompt(EXAMPLE);
    assert.ok(c.genre.includes('open-world'));
    assert.ok(c.genre.includes('racing'));
    assert.ok(c.features.includes('multiplayer'));
    assert.ok(c.features.includes('open-world'));
    assert.ok(c.features.includes('vehicles'));
    assert.ok(c.themes.includes('african'));
    assert.ok(c.themes.includes('futuristic'));
    assert.equal(c.perspective, 'third-person');
    assert.ok(c.multiplayer !== 'single-player');
    assert.ok(c.title.length > 0);
  });

  it('falls back to sensible defaults for a vague prompt', () => {
    const c = parsePrompt('a fun game');
    assert.ok(c.genre.length > 0);
    assert.ok(c.platforms.length > 0);
  });
});

describe('designGame', () => {
  it('produces a complete design document tailored to the genre', () => {
    const c = parsePrompt(EXAMPLE);
    const d = designGame(c);
    assert.ok(d.logline.length > 0);
    assert.ok(d.characters.length >= 3);
    assert.ok(d.missions.some((m) => m.kind === 'tutorial'));
    assert.ok(d.missions.length >= 4);
    // Racing → vehicle physics + speedometer HUD + engine SFX.
    assert.ok(d.physicsProfile.some((p) => /vehicle/i.test(p)));
    assert.ok(d.ui.hud.includes('speedometer'));
    assert.ok(d.sound.sfx.includes('engine'));
    assert.ok(d.story.acts.length === 3);
  });
});

describe('AI agents', () => {
  it('Programmer plans the right modules for racing + multiplayer', () => {
    const d = designGame(parsePrompt(EXAMPLE));
    const mods = AGENTS.programmer.modules(d).map((m) => m.name);
    assert.ok(mods.includes('VehicleSystem'));
    assert.ok(mods.includes('NetworkSystem'));
    assert.ok(mods.includes('SaveSystem'));
  });

  it('Tester includes a multiplayer sync test for online games', () => {
    const d = designGame(parsePrompt(EXAMPLE));
    const tests = AGENTS.tester.scenarios(d);
    assert.ok(tests.some((t) => /sync/i.test(t.title)));
    assert.ok(tests.some((t) => t.category === 'performance'));
  });

  it('World Builder produces a coherent seeded world', () => {
    const d = designGame(parsePrompt(EXAMPLE));
    const { seed, world } = AGENTS.world.build(d, 48);
    assert.ok(seed.startsWith('nova-'));
    assert.ok(world.settlements.length > 0);
    assert.ok(world.landRatio > 0 && world.landRatio < 1);
  });

  it('Director plans milestones and a roadmap', () => {
    const d = designGame(parsePrompt(EXAMPLE));
    const { roadmap, milestones } = AGENTS.director.plan(d);
    assert.ok(roadmap.length >= 4);
    assert.ok(milestones.length >= 3);
  });
});

describe('GameArchitect — createFromPrompt + autonomousBuild', () => {
  it('creates a full project from a prompt', async () => {
    const arch = new GameArchitect();
    const project = await arch.createFromPrompt(EXAMPLE);
    assert.ok(project.id);
    assert.ok(project.concept.genre.includes('racing'));
    assert.ok(project.modules.length >= 3);
    assert.ok(project.tests.length >= 3);
    assert.ok(project.milestones.length >= 3);
    assert.ok(project.seed.startsWith('nova-'));
  });

  it('runs the autonomous build pipeline to a beta manifest', async () => {
    const arch = new GameArchitect();
    const project = await arch.createFromPrompt(EXAMPLE);
    const manifest = await arch.autonomousBuild(project, 'beta');
    assert.equal(manifest.channel, 'beta');
    assert.equal(manifest.releaseNotes.length, 8);
    assert.ok(manifest.releaseNotes[7]!.includes('beta'));
    assert.equal(manifest.targets.length, project.concept.platforms.length);
    assert.ok(manifest.targets.every((t) => t.status === 'ready'));
    assert.equal(manifest.fingerprint.length, 64);
  });

  it('is deterministic: same prompt → same seed and fingerprint', async () => {
    const arch = new GameArchitect();
    const a = await arch.createFromPrompt(EXAMPLE);
    const b = await arch.createFromPrompt(EXAMPLE);
    assert.equal(a.seed, b.seed);
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it('honors an optional LLM refinement hook', async () => {
    let called = false;
    const arch = new GameArchitect({
      async refineConcept(_prompt, concept) { called = true; return { ...concept as object, title: 'LLM Title' }; },
    });
    const project = await arch.createFromPrompt('a racing game');
    assert.equal(called, true);
    assert.equal(project.title, 'LLM Title');
  });
});
