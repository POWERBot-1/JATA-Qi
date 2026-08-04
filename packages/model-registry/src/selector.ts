// Model selection logic. Filters by hard constraints (capabilities, provider,
// context window) then ranks survivors by the requested preference.

import type { ModelDescriptor, SelectionPreference, SelectionRequest } from './types.js';

/** Filter models by the hard constraints in the request. */
export function filter(models: ModelDescriptor[], req: SelectionRequest): ModelDescriptor[] {
  return models.filter((m) => {
    if (req.capabilities && !req.capabilities.every((c) => m.capabilities.includes(c))) return false;
    if (req.providers && !req.providers.includes(m.provider)) return false;
    if (req.minContextWindow && (m.contextWindow ?? 0) < req.minContextWindow) return false;
    return true;
  });
}

/** A normalized 0..1 score for a model along a preference dimension (higher = better). */
export function score(model: ModelDescriptor, prefer: SelectionPreference): number | undefined {
  switch (prefer) {
    case 'cost': {
      // Unknown cost (both undefined) → cannot rank on cost.
      if (model.inputCostPer1k === undefined && model.outputCostPer1k === undefined) return undefined;
      const cost = (model.inputCostPer1k ?? 0) + (model.outputCostPer1k ?? 0);
      if (cost <= 0) return 1; // explicitly free → highest cost score
      return 1 / (1 + cost); // cheaper is better
    }
    case 'latency':
      if (model.latencyMs === undefined) return undefined;
      return 1 / (1 + model.latencyMs);
    case 'quality':
    default:
      if (model.quality === undefined) return undefined;
      return model.quality / 100;
  }
}

/** Pick the best model for a request, with a human rationale. */
export function select(models: ModelDescriptor[], req: SelectionRequest = {}): {
  model: ModelDescriptor | undefined;
  candidates: number;
  score?: number;
  rationale: string;
} {
  const prefer: SelectionPreference = req.prefer ?? 'quality';
  const candidates = filter(models, req);
  if (candidates.length === 0) {
    return { model: undefined, candidates: 0, rationale: 'no model matches the requested constraints' };
  }

  let best: ModelDescriptor | undefined;
  let bestScore: number | undefined;
  for (const m of candidates) {
    const s = score(m, prefer);
    if (s === undefined) continue;
    if (bestScore === undefined || s > bestScore) {
      best = m;
      bestScore = s;
    }
  }

  // Fallback: if nothing had the preferred metric, prefer the `default` flag, then
  // the first candidate.
  if (!best) {
    best = candidates.find((m) => m.default) ?? candidates[0];
    return {
      model: best,
      candidates: candidates.length,
      rationale: `selected ${best?.id} (no ${prefer} metadata; default/first match)`,
    };
  }

  return {
    model: best,
    candidates: candidates.length,
    score: bestScore,
    rationale: `selected ${best.id} (best ${prefer} among ${candidates.length} candidate(s))`,
  };
}
