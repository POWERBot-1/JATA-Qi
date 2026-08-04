// Competitive rating — Elo with configurable K-factor and rank tiers. The
// foundation of leaderboards and seeding (§13 "rankings").

export interface RankTier { name: string; minRating: number; order: number }

/** Standard ladder tiers, ordered lowest → highest. */
export const RANK_TIERS: RankTier[] = [
  { name: 'Bronze', minRating: 0, order: 0 },
  { name: 'Silver', minRating: 1200, order: 1 },
  { name: 'Gold', minRating: 1400, order: 2 },
  { name: 'Platinum', minRating: 1600, order: 3 },
  { name: 'Diamond', minRating: 1800, order: 4 },
  { name: 'Master', minRating: 2000, order: 5 },
  { name: 'Grandmaster', minRating: 2200, order: 6 },
];

/** Expected score for player A vs player B (0..1). */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Update two players' ratings after a match. `scoreA` is A's result (1=win,
 * 0.5=draw, 0=loss). Returns the new ratings; B is updated symmetrically.
 */
export function updateRatings(
  ratingA: number, ratingB: number, scoreA: number, kFactor = 32,
): { a: number; b: number; deltaA: number; deltaB: number } {
  if (scoreA < 0 || scoreA > 1) throw new Error('scoreA must be in [0,1]');
  const eA = expectedScore(ratingA, ratingB);
  const eB = 1 - eA;
  const scoreB = 1 - scoreA;
  const deltaA = kFactor * (scoreA - eA);
  const deltaB = kFactor * (scoreB - eB);
  return { a: ratingA + deltaA, b: ratingB + deltaB, deltaA, deltaB };
}

/** The rank tier for a given rating. */
export function tierFor(rating: number): RankTier {
  let tier = RANK_TIERS[0]!;
  for (const t of RANK_TIERS) if (rating >= t.minRating) tier = t;
  return tier;
}
