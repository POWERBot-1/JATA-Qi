// Personality, emotion, and relationship model (§6). Personality is a small
// trait vector (Big-Five inspired); emotion is a PAD (pleasure / arousal /
// dominance) vector that evolves from events; relationships are a directed
// affinity graph. All three can bias decision making (utility weights, BT
// priorities).

/** Big-Five-inspired personality traits, each in [0,1]. */
export interface Personality {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

export function makePersonality(p: Partial<Personality> = {}): Personality {
  return { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5, ...p };
}

/** PAD emotion model — pleasure, arousal, dominance, each in [-1,1]. */
export interface Emotion { p: number; a: number; d: number; }

export function makeEmotion(e: Partial<Emotion> = {}): Emotion {
  return { p: 0, a: 0, d: 0, ...e };
}

/** A discrete emotion label derived from the PAD vector. */
export function emotionLabel(e: Emotion): string {
  if (e.p > 0.3 && e.a > 0.3) return 'joyful';
  if (e.p > 0.3 && e.a < -0.2) return 'calm';
  if (e.p < -0.3 && e.a > 0.3) return 'angry';
  if (e.p < -0.3 && e.a < -0.3) return 'sad';
  if (e.a > 0.5 && e.d < -0.3) return 'afraid';
  if (e.d > 0.4) return 'confident';
  return 'neutral';
}

/** Apply an emotional event, decaying toward baseline. */
export function applyEmotion(current: Emotion, delta: Partial<Emotion>, decay = 0.05): Emotion {
  return {
    p: clamp11((current.p + (delta.p ?? 0)) * (1 - decay)),
    a: clamp11((current.a + (delta.a ?? 0)) * (1 - decay)),
    d: clamp11((current.d + (delta.d ?? 0)) * (1 - decay)),
  };
}

/** A directed relationship graph of affinity (-1 enemy .. +1 ally). */
export class Relationships {
  private affinities = new Map<string, number>();

  private key(from: string, to: string): string { return `${from}->${to}`; }

  get(from: string, to: string): number { return this.affinities.get(this.key(from, to)) ?? 0; }

  /** Adjust affinity by delta, clamped to [-1,1]. */
  adjust(from: string, to: string, delta: number): number {
    const k = this.key(from, to);
    const v = clamp11((this.affinities.get(k) ?? 0) + delta);
    this.affinities.set(k, v);
    return v;
  }

  set(from: string, to: string, value: number): void { this.affinities.set(this.key(from, to), clamp11(value)); }

  /** True when affinity is at or above a threshold. */
  isFriend(from: string, to: string, threshold = 0.4): boolean { return this.get(from, to) >= threshold; }
  isEnemy(from: string, to: string, threshold = -0.4): boolean { return this.get(from, to) <= threshold; }

  /** All neighbors an agent has a relationship with. */
  neighbors(of: string): string[] {
    const out: string[] = [];
    for (const k of this.affinities.keys()) {
      const [from, to] = k.split('->');
      if (from === of && to) out.push(to);
    }
    return out;
  }
}

function clamp11(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }
