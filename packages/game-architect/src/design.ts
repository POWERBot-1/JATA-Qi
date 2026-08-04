// Game design generator — expands a GameConcept into a complete Game Design
// Document (story, characters, missions, rules, physics, economy, UI, sound).
// Deterministic: the same concept always yields the same design.

import type { Character, EconomyDesign, GameConcept, GameDesignDocument, Mission, SoundDesign, UiSpec } from './types.js';

/** Expand a concept into a full design document. */
export function designGame(concept: GameConcept): GameDesignDocument {
  const genres = concept.genre;
  const setting = concept.themes.length > 0 ? concept.themes.join(' ') : 'an original';
  return {
    concept,
    logline: logline(concept, setting),
    story: story(concept, setting),
    characters: generateCharacters(concept),
    missions: generateMissions(concept),
    rules: rulesFor(genres),
    physicsProfile: physicsProfile(concept),
    economy: economyFor(concept),
    ui: uiFor(concept),
    sound: soundFor(concept),
  };
}

function logline(c: GameConcept, setting: string): string {
  const genre = c.genre[0] ?? 'adventure';
  return `A ${genre} experience set in a ${setting} world${c.features.includes('multiplayer') ? ' shared with other players' : ''}, where the player ${playerVerb(c)} to ${playerGoal(c)}.`;
}

function playerVerb(c: GameConcept): string {
  if (c.genre.includes('racing')) return 'rivals opponents';
  if (c.genre.includes('fps') || c.genre.includes('shooter')) return 'battles enemies';
  if (c.genre.includes('puzzle')) return 'solves mysteries';
  if (c.genre.includes('simulation')) return 'builds and manages';
  return 'explores and overcomes';
}
function playerGoal(c: GameConcept): string {
  if (c.genre.includes('racing')) return 'become the fastest champion';
  if (c.features.includes('open-world')) return 'uncover the secrets of the world';
  return 'restore balance to the world';
}

function story(c: GameConcept, setting: string): { premise: string; acts: string[]; stakes: string } {
  const premise = `In a ${setting} world on the brink of change, an unlikely hero emerges. ${capitalize(c.setting)} forces threaten everything, and only one path remains.`;
  const acts = [
    'Act I — The Call: the protagonist is drawn into the central conflict and meets key allies.',
    'Act II — The Rise: the hero masters their abilities, explores the world, and confronts escalating threats.',
    'Act III — The reckoning: a climactic confrontation resolves the central tension and shapes the world.',
  ];
  const stakes = c.features.includes('permadeath')
    ? 'Every decision is permanent; failure ends the journey.'
    : 'The fate of the world and everyone in it hangs in the balance.';
  return { premise, acts, stakes };
}

function generateCharacters(c: GameConcept): Character[] {
  const chars: Character[] = [];
  const genre = c.genre[0] ?? 'adventure';
  chars.push({
    id: 'protagonist', name: 'The Protagonist', role: 'protagonist',
    archetype: genreArchetype(genre),
    description: `A relatable hero whose ${genreArchetype(genre).toLowerCase()} skills define the player's playstyle.`,
    abilities: genreAbilities(genre),
    personality: ['determined', 'curious', 'courageous'],
  });
  chars.push({
    id: 'antagonist', name: 'The Antagonist', role: 'antagonist',
    archetype: 'Rival', description: 'A compelling adversary whose motives mirror and challenge the protagonist.',
    abilities: ['adaptive tactics', 'command of forces'], personality: ['ruthless', 'intelligent', 'driven'],
  });
  chars.push({
    id: 'mentor', name: 'The Mentor', role: 'mentor',
    archetype: 'Guide', description: 'A seasoned figure who teaches the mechanics and lore.',
    abilities: ['wisdom', 'training'], personality: ['wise', 'patient'],
  });
  if (c.multiplayer !== 'single-player') {
    chars.push({
      id: 'ally', name: 'Co-op Ally', role: 'ally', archetype: 'Companion',
      description: 'A second player or AI companion that complements the protagonist.',
      abilities: ['teamwork', 'support'], personality: ['loyal', 'coordinated'],
    });
  }
  return chars;
}

function genreArchetype(g: string): string {
  switch (g) {
    case 'racing': return 'Pilot';
    case 'fps': case 'shooter': return 'Soldier';
    case 'rpg': return 'Adventurer';
    case 'platformer': return 'Jumper';
    case 'puzzle': return 'Solver';
    case 'strategy': return 'Commander';
    case 'fighting': return 'Fighter';
    default: return 'Explorer';
  }
}
function genreAbilities(g: string): string[] {
  switch (g) {
    case 'racing': return ['boost', 'drift', 'precision driving'];
    case 'fps': case 'shooter': return ['aiming', 'tactical movement', 'weapon mastery'];
    case 'rpg': return ['leveling', 'skill trees', 'inventory'];
    case 'platformer': return ['double jump', 'wall climb', 'dash'];
    case 'puzzle': return ['manipulation', 'logic', 'pattern recognition'];
    default: return ['exploration', 'interaction', 'problem solving'];
  }
}

function generateMissions(c: GameConcept): Mission[] {
  const missions: Mission[] = [
    { id: 'm-tutorial', title: 'First Steps', kind: 'tutorial', summary: 'Learn movement and core mechanics.', objectives: ['Complete the intro sequence', 'Master the basic ability'], rewards: ['Starter equipment'] },
  ];
  const mainCount = c.features.includes('open-world') ? 5 : 3;
  for (let i = 1; i <= mainCount; i++) {
    missions.push({
      id: `m-main-${i}`, title: `Main Quest ${i}`, kind: 'main',
      summary: `A pivotal story beat advancing the central conflict${i > 1 ? ' from the previous chapter' : ''}.`,
      objectives: [`Reach the ${zoneName(i)}`, `Confront the challenge`, `Claim the reward`],
      rewards: [`Chapter ${i} unlock`, `${i * 100} XP`],
    });
  }
  if (c.multiplayer !== 'single-player') {
    missions.push({ id: 'm-side-arena', title: 'The Arena', kind: 'side', summary: 'A repeatable challenge against other players or waves.', objectives: ['Enter the arena', 'Survive 3 rounds'], rewards: ['Cosmetic reward', 'Currency'] });
  }
  if (c.features.includes('economy')) {
    missions.push({ id: 'm-side-trade', title: 'The Merchant Run', kind: 'side', summary: 'Trade goods across the world for profit.', objectives: ['Acquire goods', 'Sell at a distant market'], rewards: ['Currency', 'Reputation'] });
  }
  return missions;
}

function zoneName(i: number): string {
  const zones = ['Outpost', 'Crossroads', 'Stronghold', 'Frontier', 'Citadel', 'Heartland'];
  return zones[Math.min(i - 1, zones.length - 1)]!;
}

function rulesFor(genres: string[]): { win: string[]; lose: string[]; scoring: string } {
  if (genres.includes('racing')) return { win: ['Cross the finish line first'], lose: ['Fail to finish within the time limit'], scoring: 'Final position + lap time' };
  if (genres.includes('puzzle')) return { win: ['Solve every puzzle'], lose: ['Run out of moves'], scoring: 'Moves used + time' };
  return { win: ['Complete the main story', 'Defeat the antagonist'], lose: ['Deplete all health', 'Fail a critical objective'], scoring: 'Progress + achievements' };
}

function physicsProfile(c: GameConcept): string[] {
  const p = new Set<string>(['rigid-body dynamics', 'gravity', 'collision']);
  if (c.genre.includes('racing') || c.features.includes('vehicles')) { p.add('vehicle physics'); p.add('wheel friction'); }
  if (c.features.includes('combat')) p.add('projectile & impact physics');
  if (c.themes.some((t) => /water|underwater|ocean/i.test(t))) p.add('fluid/water simulation');
  if (c.features.includes('weather')) p.add('weather interaction');
  return [...p];
}

function economyFor(c: GameConcept): EconomyDesign {
  const currencies = c.features.includes('economy')
    ? [{ name: 'Credits', earn: 'quests, trades, combat', spend: 'gear, upgrades' }]
    : [{ name: 'Score', earn: 'completing objectives', spend: 'nothing (cosmetic only)' }];
  return { currencies, sinks: ['upgrades', 'consumables', 'cosmetics'], sources: ['quests', 'combat', 'trade'] };
}

function uiFor(c: GameConcept): UiSpec {
  const hud = ['health/status', 'minimap'];
  if (c.genre.includes('racing')) { hud.push('speedometer', 'lap counter', 'position'); }
  if (c.features.includes('economy')) hud.push('currency');
  if (c.multiplayer !== 'single-player') hud.push('player list', 'chat');
  return { hud, menus: ['main', 'settings', 'inventory', 'pause'] };
}

function soundFor(c: GameConcept): SoundDesign {
  const music = [`${c.themes[0] ?? 'orchestral'} theme`, 'exploration ambient', 'combat intensity'];
  const sfx = ['footsteps', 'impacts', 'UI feedback'];
  if (c.genre.includes('racing')) { sfx.push('engine', 'tire screech'); }
  if (c.features.includes('combat')) sfx.push('weapon fire', 'explosions');
  return { music, sfx, voice: ['protagonist', 'mentor', 'antagonist'] };
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

export type { Character, Mission };
