// JATA Qi Accreditation & Legal Operation Mode — types.
//
// Part L of the Autonomous Internet Infrastructure Platform. The platform is
// architected so that capabilities requiring external accreditation, public
// trust, or delegated Internet authority activate ONLY after a verified
// accreditation grant is recorded. The software never claims to be an
// accredited registry, registrar, public certificate authority, or delegated
// DNS authority unless those approvals are present and verified.
//
// All public-key signatures are real Ed25519 (via @jataqi/provenance crypto).

/** The three legal operation modes of the platform. */
export type OperationMode =
  | 'DEVELOPMENT'
  | 'PRIVATE_INFRASTRUCTURE'
  | 'ACCREDITED_PRODUCTION';

/**
 * A class of public-trust or delegated Internet authority that requires
 * external accreditation before it may be operated or claimed.
 */
export interface AccreditationDomain {
  /** Stable id, e.g. 'tld-registry'. */
  id: string;
  /** Human readable name, e.g. 'Top-Level Domain Registry'. */
  name: string;
  /** Short description of the service class. */
  description: string;
  /**
   * Whether operating this domain in a public-trust capacity requires external
   * accreditation. When true the gate() will deny the action until an active
   * AccreditationGrant exists.
   */
  requiresAccreditation: boolean;
  /**
   * The bodies that issue accreditation for this domain (informational; used in
   * compliance reporting). e.g. ['ICANN', 'IANA'].
   */
  accreditationBodies: string[];
  /**
   * Control frameworks relevant to this domain (Part J). e.g.
   * ['ICANN-Registry-Agreement', 'SOC2', 'ISO-27001'].
   */
  controlFrameworks: string[];
}

/** Lifecycle of an accreditation grant. */
export type GrantStatus =
  | 'PENDING' // applied-for, awaiting external verification
  | 'ACTIVE' // externally verified and current
  | 'SUSPENDED' // temporarily revoked by the authority
  | 'REVOKED' // permanently withdrawn
  | 'EXPIRED'; // past its validUntil date

/**
 * A verified external accreditation grant. Each grant is cryptographically
 * signed by the platform's governance key (Ed25519) and appended to the
 * immutable accreditation ledger, so the chain of accreditation is auditable
 * and tamper-evident.
 */
export interface AccreditationGrant {
  /** Stable id (UUID-like). */
  id: string;
  /** The accredited domain id. */
  domain: string;
  /** Identifier issued by the external accreditation body, if any. */
  externalRef?: string;
  /** The accreditation body that issued it, e.g. 'ICANN'. */
  issuedBy: string;
  /** Free-text scope of the grant (e.g. a TLD string, a CA name). */
  scope: string;
  status: GrantStatus;
  /** Epoch ms when the grant becomes valid. */
  validFrom: number;
  /** Epoch ms when the grant expires (required; 0 means indefinite — discouraged). */
  validUntil: number;
  /** Epoch ms when the grant was recorded on-platform. */
  recordedAt: number;
  /** Recorded-by governance principal. */
  recordedBy: string;
  /** Supporting evidence (contract refs, audit reports, accreditation ids). */
  evidence: string[];
  /** SHA-256 fingerprint of the canonical grant (excludes signature fields). */
  fingerprint: string;
  /** Ed25519 signature over the canonical grant, base64. */
  signature: string;
  /** Public key (SPKI DER base64) that produced the signature. */
  signedBy: string;
}

/** A request to record an accreditation grant (before signing). */
export interface RecordGrantInput {
  domain: string;
  externalRef?: string;
  issuedBy: string;
  scope: string;
  validFrom: number;
  validUntil: number;
  recordedBy: string;
  evidence?: string[];
}

/** The decision returned by the gate for a gated action. */
export interface GateDecision {
  /** Whether the action is permitted. */
  allowed: boolean;
  /** Why allowed or denied (machine-readable reason code). */
  reason: GateReason;
  /** Human-readable explanation. */
  message: string;
  /** The grant that authorized the action, if any. */
  grant?: AccreditationGrant;
  /** The operation mode that governed the decision. */
  mode: OperationMode;
  /** The domain the decision concerns. */
  domain: string;
}

export type GateReason =
  | 'ALLOWED_ACCREDITED' // active grant present
  | 'ALLOWED_PRIVATE' // private-infrastructure capability, no public trust needed
  | 'ALLOWED_DEVELOPMENT' // permitted in development mode (inert/simulation)
  | 'DENIED_NO_GRANT' // requires accreditation but none active
  | 'DENIED_EXPIRED' // grant exists but expired
  | 'DENIED_SUSPENDED' // grant exists but suspended
  | 'DENIED_MODE' // current mode does not permit the capability
  | 'DENIED_UNKNOWN_DOMAIN'; // domain not in the catalog

/** Result of verifying the platform's own public claims about accreditation. */
export interface ClaimVerificationResult {
  /** The claim text evaluated. */
  claim: string;
  /** Whether the claim is honest given recorded grants. */
  honest: boolean;
  /** Domains the claim depends on. */
  domains: string[];
  /** Active grants that back the claim. */
  backingGrants: AccreditationGrant[];
  /** Explanation. */
  message: string;
}

/** Immutable ledger entry for the accreditation audit trail. */
export interface AccreditationLedgerEntry {
  /** Monotonic sequence number. */
  seq: number;
  /** Epoch ms. */
  ts: number;
  /** Action: 'grant.recorded' | 'grant.revoked' | 'grant.suspended' | 'mode.set'. */
  action: string;
  /** SHA-256 of the previous entry's canonical form (chain link). */
  prevHash: string;
  /** Canonical fingerprint of this entry's payload. */
  entryHash: string;
  /** Payload (grant id, mode, etc.). */
  payload: Record<string, unknown>;
}
