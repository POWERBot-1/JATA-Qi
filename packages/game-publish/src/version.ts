// Semantic versioning helpers for build/publish.

export interface SemVer { major: number; minor: number; patch: number; pre?: string }

/** Parse a semver string (supports optional -pre). */
export function parseSemVer(v: string): SemVer {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) throw new Error(`invalid semver: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), ...(m[4] ? { pre: m[4] } : {}) };
}

export function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre ? '-' + v.pre : ''}`;
}

/** Bump a version by release type. */
export function bump(version: string, kind: 'major' | 'minor' | 'patch'): string {
  const v = parseSemVer(version);
  const next: SemVer = { major: v.major, minor: v.minor, patch: v.patch };
  if (kind === 'major') { next.major++; next.minor = 0; next.patch = 0; }
  else if (kind === 'minor') { next.minor++; next.patch = 0; }
  else next.patch++;
  return formatSemVer(next);
}

/** Compare two semvers: -1 / 0 / 1. */
export function compareSemVer(a: string, b: string): number {
  const va = parseSemVer(a), vb = parseSemVer(b);
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  if (va.pre && vb.pre) return va.pre < vb.pre ? -1 : va.pre > vb.pre ? 1 : 0;
  return 0;
}
