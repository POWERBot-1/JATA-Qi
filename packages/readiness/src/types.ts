// JATA Qi Readiness — types.
//
// A machine-readable Production Readiness Registry (master directive #64, #100).
// Every capability carries an honest status backed by evidence. The platform
// never reports PRODUCTION_READY without evidence, and clearly distinguishes
// implemented, partial, simulation-only, research-only and planned work.

export type ReadinessStatus =
  | 'NOT_IMPLEMENTED'
  | 'PLANNED'
  | 'DESIGNED'
  | 'SCAFFOLDED'
  | 'IMPLEMENTED'
  | 'INTEGRATED'
  | 'TESTED'
  | 'SECURITY_REVIEWED'
  | 'STAGING_READY'
  | 'PRODUCTION_READY'
  | 'PARTIALLY_IMPLEMENTED'
  | 'SIMULATION_ONLY'
  | 'RESEARCH_ONLY'
  | 'DEPRECATED';

export interface Capability {
  /** Stable capability id, e.g. 'kernel' or 'finance.ledgers'. */
  id: string;
  name: string;
  category: string;
  status: ReadinessStatus;
  /** Module/package that implements it, if any. */
  module?: string;
  /** Concrete evidence justifying the status (tests, endpoints, commits). */
  evidence?: string[];
  notes?: string;
  updatedAt: number;
}

export interface ReadinessSummary {
  total: number;
  byStatus: Record<string, number>;
  productionReady: number;
  notImplemented: number;
  /** Honest headline: the platform is NOT production-ready overall. */
  overall: string;
}

export const ReadinessEvents = Object.freeze({
  CapabilityUpdated: 'readiness.capability.updated',
} as const);
