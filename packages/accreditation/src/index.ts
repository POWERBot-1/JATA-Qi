// @jataqi/accreditation — Legal Operation Mode + accreditation governance.
// Public API.

export { AccreditationModule, AccreditationEvents, domainsForClaim } from './accreditation-module.js';
export type { AccreditationConfig } from './accreditation-module.js';
export { ACCREDITATION_DOMAINS, getDomain, requiresAccreditation } from './domains.js';
export { AccreditationLedger, canonicalJSON } from './ledger.js';
export type {
  OperationMode,
  AccreditationDomain,
  AccreditationGrant,
  RecordGrantInput,
  GrantStatus,
  GateDecision,
  GateReason,
  ClaimVerificationResult,
  AccreditationLedgerEntry,
} from './types.js';
