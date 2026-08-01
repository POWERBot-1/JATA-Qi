// Prompt parser — extracts a structured GameConcept from a natural-language
// game idea using deterministic keyword analysis. An optional LLM can refine the
// concept afterwards, but the heuristic baseline alone produces a coherent,
// reproducible concept (so generation is fully testable without a network).

import type { ArtStyle, GameConcept, GameFeature, Genre, MultiplayerKind, Perspective, Platform } from './types.js';

interface Rule<T> { re: RegExp; value: T }

const GENRE_RULES: Rule<Genre>[] = [
  { re: /open[- ]?world/i, value: 'open-world' },
  { re: /\bracing|\bgrand prix|\bformula|\bdrift/i, value: 'racing' },
  { re: /\bfirst[- ]?person|fps|\bshooter/i, value: 'fps' },
  { re: /\brpg|\brole[- ]?playing|\blevel up/i, value: 'rpg' },
  { re: /\bplatformer|\bplatform game|mario[- ]?like/i, value: 'platformer' },
  { re: /\bpuzzle|\bmatch[- ]?3|\bsokoban/i, value: 'puzzle' },
  { re: /\bstrategy|\b4x|\brts|\bturn[- ]?based/i, value: 'strategy' },
  { re: /\bcard\b|\bcollectible|\btcg/i, value: 'card' },
  { re: /\bsandbox|\bminecraft|\buecraft/i, value: 'sandbox' },
  { re: /\bsurvival/i, value: 'survival' },
  { re: /\badventure|\bquest/i, value: 'adventure' },
  { re: /\bsimulation|\bsim\b|\bfarming|\btycoon/i, value: 'simulation' },
  { re: /\bfighting|\bbrawler|\bbeat ?em up/i, value: 'fighting' },
  { re: /\bstealth/i, value: 'stealth' },
  { re: /\brhythm|\bmusic game|\bdance/i, value: 'rhythm' },
];

const FEATURE_RULES: Rule<GameFeature>[] = [
  { re: /multiplayer|co[- ]?op|online/i, value: 'multiplayer' },
  { re: /open[- ]?world/i, value: 'open-world' },
  { re: /story[- ]?driven|narrative|cinematic/i, value: 'story-driven' },
  { re: /procedural|infinite world|generated/i, value: 'procedural' },
  { re: /craft(ing)?|build(ing)?/i, value: 'crafting' },
  { re: /economy|trade|market|currency/i, value: 'economy' },
  { re: /combat|fight|battle|weapon/i, value: 'combat' },
  { re: /vehicle|car|drone|drive/i, value: 'vehicles' },
  { re: /\bpvp|versus/i, value: 'pvp' },
  { re: /\bpve|enemy|monster|zombie/i, value: 'pve' },
  { re: /day[- ]?night|cycle/i, value: 'day-night' },
  { re: /weather|rain|storm|climate/i, value: 'weather' },
  { re: /permadeath|rogue[- ]?like/i, value: 'permadeath' },
];

const PERSPECTIVE_RULES: Rule<Perspective>[] = [
  { re: /first[- ]?person|fps/i, value: 'first-person' },
  { re: /third[- ]?person|over[- ]?the[- ]?shoulder/i, value: 'third-person' },
  { re: /top[- ]?down|isometric/i, value: 'top-down' },
  { re: /side[- ]?scroll(ing)?|2d platform/i, value: 'side-scrolling' },
  { re: /vr|virtual reality|vision pro|quest/i, value: 'vr' },
];

const THEME_WORDS = [
  'futuristic', 'cyberpunk', 'sci-fi', 'science fiction', 'fantasy', 'medieval',
  'post-apocalyptic', 'apocalyptic', 'steampunk', 'noir', 'horror', 'space',
  'western', 'african', 'asian', 'tropical', 'arctic', 'underwater', 'desert',
  'urban', 'mythological', 'historical', 'neon',
];

const ART_RULES: Rule<ArtStyle>[] = [
  { re: /pixel( art)?|8[- ]?bit|16[- ]?bit|retro/i, value: 'pixel-art' },
  { re: /low[- ]?poly|flat[- ]?shaded/i, value: 'low-poly' },
  { re: /voxel|blocky|minecraft[- ]?like/i, value: 'voxel' },
  { re: /cel[- ]?shaded|anime|cartoon/i, value: 'cel-shaded' },
  { re: /hand[- ]?drawn|paint(ed|ing)|watercolor/i, value: 'hand-drawn' },
  { re: /realistic|photorealistic|aaa/i, value: 'realistic' },
];

const PLATFORM_RULES: Rule<Platform>[] = [
  { re: /\bweb\b|browser|html5/i, value: 'web' },
  { re: /\bmobile|android|ios|phone|tablet/i, value: 'mobile' },
  { re: /\bpc\b|windows|mac|linux|desktop/i, value: 'pc' },
  { re: /\bconsole|playstation|xbox|nintendo/i, value: 'console' },
  { re: /\bvr|quest|vision pro|index/i, value: 'vr' },
];

/** Extract a structured concept from a free-text prompt. */
export function parsePrompt(prompt: string): GameConcept {
  const p = prompt.trim();
  const genres = unique(match(p, GENRE_RULES));
  const features = unique(match(p, FEATURE_RULES));
  const perspective = match(p, PERSPECTIVE_RULES)[0] ?? inferPerspective(genres);
  const themes = unique(THEME_WORDS.filter((t) => new RegExp(t, 'i').test(p)));
  const artStyle = match(p, ART_RULES)[0] ?? inferArtStyle(genres, themes);
  const platforms = unique(match(p, PLATFORM_RULES));
  const multiplayer = inferMultiplayer(p, features);
  const title = generateTitle(p, genres, themes);

  return {
    title,
    genre: genres.length > 0 ? genres : ['adventure'],
    perspective,
    themes,
    setting: themes.length > 0 ? capitalize(themes[0]!) : 'original',
    features: dedupeFeatures(features, genres),
    multiplayer,
    platforms: platforms.length > 0 ? platforms : ['web', 'pc'],
    artStyle,
    audience: inferAudience(multiplayer, genres),
    prompt: p,
  };
}

function match<T>(text: string, rules: Rule<T>[]): T[] {
  return rules.filter((r) => r.re.test(text)).map((r) => r.value);
}
function unique<T>(arr: T[]): T[] { return [...new Set(arr)]; }

function inferPerspective(genres: Genre[]): Perspective {
  if (genres.includes('racing') || genres.includes('fps')) return 'third-person';
  if (genres.includes('platformer')) return 'side-scrolling';
  if (genres.includes('strategy') || genres.includes('puzzle')) return 'top-down';
  return 'third-person';
}
function inferArtStyle(genres: Genre[], themes: string[]): ArtStyle {
  if (themes.some((t) => /pixel|retro/i.test(t))) return 'pixel-art';
  if (genres.includes('sandbox')) return 'voxel';
  if (themes.some((t) => /futuristic|sci-fi|space|cyberpunk/i.test(t))) return 'stylized';
  return 'stylized';
}
function inferMultiplayer(p: string, features: GameFeature[]): MultiplayerKind {
  if (/mmo|massively multiplayer|thousands of players/i.test(p)) return 'mmo';
  if (features.includes('pvp')) return 'pvp';
  if (features.includes('multiplayer') || /co[- ]?op/i.test(p)) return 'co-op';
  return 'single-player';
}
function inferAudience(mp: MultiplayerKind, genres: Genre[]): string {
  if (mp === 'mmo' || mp === 'pvp') return 'competitive / online';
  if (genres.includes('puzzle') || genres.includes('platformer')) return 'casual / family';
  return 'core gamers';
}

function dedupeFeatures(features: GameFeature[], genres: Genre[]): GameFeature[] {
  const out = new Set(features);
  if (genres.includes('open-world')) out.add('open-world');
  if (genres.includes('racing') || genres.includes('fps')) out.add('combat');
  return [...out];
}

function generateTitle(prompt: string, genres: Genre[], themes: string[]): string {
  const theme = themes[0] ? capitalize(themes[0]!) : 'Nova';
  const genre = genres[0] ? capitalize(genres[0]!) : 'Saga';
  // Try to lift a distinctive capitalized noun from the prompt.
  const cap = prompt.match(/\b([A-Z][a-z]{3,})\b/);
  const proper = cap && !['Create', 'Make', 'Build', 'Game', 'With', 'That', 'This'].includes(cap[1]!) ? cap[1] : null;
  return proper ? `${theme} ${genre}: ${proper}` : `${theme} ${genre}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
