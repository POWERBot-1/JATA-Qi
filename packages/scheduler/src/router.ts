// Adaptive Compute Router (spec Step 31 "Adaptive Compute Router"). Picks a
// compute target for a task based on its profile and the targets that are
// actually registered. Per the spec's operating principle, it never assumes
// "quantum = better": a quantum target is only recommended when one is
// registered AND suited to the task.

import type { ComputeKind } from './types.js';

export interface TaskProfile {
  /** What kind of work this is. */
  kind: 'nlp' | 'simulation' | 'optimization' | 'training' | 'perception' | 'io' | string;
  prefer?: 'speed' | 'throughput' | 'cost';
  requireGpu?: boolean;
}

export interface TargetInfo {
  id: string;
  kind: ComputeKind;
}

/** Map a task profile to the *preferred* compute kind (the ideal, if available). */
export function preferredKind(profile: TaskProfile): ComputeKind {
  switch (profile.kind) {
    case 'simulation':
    case 'training':
    case 'perception':
      return 'gpu';
    case 'nlp':
      return 'cloud';
    case 'optimization':
      return 'quantum'; // only used if a quantum target is actually registered
    case 'io':
      return 'edge';
    default:
      return 'cpu';
  }
}

/** Recommend a registered target for a profile, falling back gracefully. */
export function recommendTarget(profile: TaskProfile, targets: TargetInfo[]): string {
  const preferred = preferredKind(profile);
  const match = targets.find((t) => t.kind === preferred);
  if (match) return match.id;

  if (profile.requireGpu) {
    const gpu = targets.find((t) => t.kind === 'gpu');
    if (gpu) return gpu.id;
  }
  // Cloud is a reasonable general-purpose fallback for compute-heavy tasks.
  const cloud = targets.find((t) => t.kind === 'cloud');
  if (cloud) return cloud.id;
  return 'default';
}
