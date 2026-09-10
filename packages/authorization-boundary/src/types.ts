// A-01 — Authoritative Agent Capability & Credential Boundary: domain types.
//
// Design invariants (fail-closed, no fail-open path anywhere in this package):
//
//   * DEFAULT = DENY. Every decision starts as DENY and is only upgraded to
//     ALLOW when every mandatory check passes. Any exception, ambiguity, or
//     unavailable dependency converts the outcome to DENY.
//   * The decision binds, at minimum: principal, tenant, agent, run,
//     capability, tool, operation, target, data classification, impact,
//     approval (where required), credential scope/audience, budget/rate
//     constraints, and provenance/correlation identifiers.
//   * No model output, prompt, caller-supplied metadata, tool, plugin,
//     connector, worker, queue message, or runtime parameter may override an
//     authoritative decision. The only inputs to a decision are the
//     AuthorizationGate API and the registered policy state (manifests,
//     grants, broker, engine).
//   * Credentials never enter prompts, model context, tool output, logs,
//     audit payloads, durable memory, or RAG/knowledge content: audit records
//     and envelopes carry credential REFERENCES (id, audience, scopes) only.

/** Closed set of data classifications. Higher is more sensitive. */
export type A01DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

/** Closed set of impact levels. Higher is more consequential. */
export type A01ImpactLevel = 'READ' | 'REVERSIBLE_WRITE' | 'CONSEQUENTIAL_WRITE' | 'EXTERNAL_SIDE_EFFECT';

export const A01_CLASSIFICATION_ORDER: Readonly<Record<A01DataClassification, number>> = Object.freeze({
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
});

export const A01_IMPACT_ORDER: Readonly<Record<A01ImpactLevel, number>> = Object.freeze({
  READ: 0,
  REVERSIBLE_WRITE: 1,
  CONSEQUENTIAL_WRITE: 2,
  EXTERNAL_SIDE_EFFECT: 3,
});

export const A01_DATA_CLASSIFICATIONS: readonly A01DataClassification[] = Object.freeze([
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
]);

export const A01_IMPACT_LEVELS: readonly A01ImpactLevel[] = Object.freeze([
  'READ',
  'REVERSIBLE_WRITE',
  'CONSEQUENTIAL_WRITE',
  'EXTERNAL_SIDE_EFFECT',
]);

/**
 * Closed set of machine-readable denial reasons. Every DENY envelope carries
 * one or more of these codes; every negative test asserts on codes, not on
 * free-text messages, so the contract stays auditable.
 */
export type A01DenialReason =
  | 'ENVELOPE_MALFORMED'
  | 'ENVELOPE_TAMPERED'
  | 'ENVELOPE_NOT_ALLOWED'
  | 'AUTHORIZATION_ENVELOPE_MISSING'
  | 'AUTHORIZATION_EXPIRED'
  | 'REPLAYED_AUTHORIZATION'
  | 'MISSING_PRINCIPAL'
  | 'FORGED_PRINCIPAL'
  | 'PRINCIPAL_SUBSTITUTION'
  | 'IDENTITY_CONFLICT'
  | 'MISSING_TENANT'
  | 'BLANK_TENANT'
  | 'NON_STRING_TENANT'
  | 'TENANT_SUBSTITUTION'
  | 'TENANT_OUT_OF_SCOPE'
  | 'MISSING_AGENT'
  | 'MISSING_RUN'
  | 'MISSING_CAPABILITY'
  | 'UNKNOWN_CAPABILITY'
  | 'CAPABILITY_VERSION_MISMATCH'
  | 'MISSING_TOOL'
  | 'UNKNOWN_TOOL'
  | 'UNDECLARED_TOOL_AUTHORIZATION'
  | 'MISSING_OPERATION'
  | 'OPERATION_NOT_ALLOWED'
  | 'OPERATION_SUBSTITUTION'
  | 'TARGET_NOT_ALLOWED'
  | 'TARGET_SUBSTITUTION'
  | 'WILDCARD_ESCALATION'
  | 'CLASSIFICATION_EXCEEDED'
  | 'IMPACT_EXCEEDED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_MISSING'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_MISMATCH'
  | 'CREDENTIAL_REQUIRED'
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_SCOPE_INSUFFICIENT'
  | 'CREDENTIAL_AUDIENCE_MISMATCH'
  | 'CREDENTIAL_BINDING_MISMATCH'
  | 'CREDENTIAL_REPLAY'
  | 'BUDGET_EXHAUSTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'POLICY_ENGINE_UNAVAILABLE'
  | 'CREDENTIAL_BROKER_UNAVAILABLE'
  | 'AMBIGUOUS_POLICY_RESULT'
  | 'AUDIT_UNAVAILABLE'
  | 'UNBOUND_CONNECTOR'
  | 'OVER_PRIVILEGED_CONNECTOR'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PRINCIPAL_REVOKED'
  /** P2-S1: the identity lifecycle state is not ACTIVE (suspended / deactivated / deprovisioned). */
  | 'IDENTITY_STATE_INACTIVE'
  /** P2-S1: the request tenant does not match the identity's tenant (tenant substitution). */
  | 'IDENTITY_TENANT_MISMATCH'
  /** P2-S3: the operation is privileged and no valid elevation was presented. */
  | 'PRIVILEGE_ELEVATION_REQUIRED'
  /** P2-S3: a covering elevation exists but its window has passed (deny-early). */
  | 'PRIVILEGE_ELEVATION_EXPIRED'
  /** P2-S3: a covering elevation exists but was revoked. */
  | 'PRIVILEGE_ELEVATION_REVOKED'
  /** P2-S3: the elevation scope does not match the operation's required scope. */
  | 'PRIVILEGE_SCOPE_MISMATCH'
  /** P2-S3: the elevation plane role is not acceptable for the operation class. */
  | 'PRIVILEGE_ROLE_MISMATCH'
  /** P2-S3: the elevation is bound to a different session (session binding). */
  | 'PRIVILEGE_SESSION_MISMATCH'
  /** P2-S3: the elevation's step-up evidence is stale (spec A-26). */
  | 'STEP_UP_STALE'
  /** P2-S3: the privilege plane is unavailable (fail-closed; no ambient authority). */
  | 'PRIVILEGE_CHECK_UNAVAILABLE'
  /** P2-S4: the referenced delegation grant does not exist (or is invisible to the request scope). */
  | 'DELEGATION_UNKNOWN_GRANT'
  /** P2-S4: the grant binds a different delegatee principal (no acting-as). */
  | 'DELEGATION_NOT_DELEGATEE'
  /** P2-S4: a tenant-scoped grant exercised in another tenant (spec A-09). */
  | 'DELEGATION_CROSS_TENANT_REFUSED'
  /** P2-S4: a platform-scoped grant exercised as tenant-scoped authority (spec A-08 tenant widening). */
  | 'DELEGATION_SCOPE_TENANT'
  /** P2-S4: the request operation is outside the grant scope (spec A-08). */
  | 'DELEGATION_SCOPE_OPERATION'
  /** P2-S4: the request target is outside the grant scope (spec A-08). */
  | 'DELEGATION_SCOPE_TARGET'
  /** P2-S4: the request classification exceeds the grant ceiling (spec A-08). */
  | 'DELEGATION_SCOPE_CLASSIFICATION'
  /** P2-S4: the request impact exceeds the grant ceiling (spec A-08). */
  | 'DELEGATION_SCOPE_IMPACT'
  /** P2-S4: the grant window has passed (deny-early). */
  | 'DELEGATION_EXPIRED'
  /** P2-S4: the grant was revoked. */
  | 'DELEGATION_REVOKED'
  /** P2-S4: the grant was already consumed (one-shot / use-count exhausted). */
  | 'DELEGATION_CONSUMED'
  /** P2-S4: the grant chain depth exceeds the allowed bound. */
  | 'DELEGATION_CHAIN_DEPTH_EXCEEDED'
  /** P2-S4: the delegator's cited manifest revision is no longer active (spec A-16). */
  | 'DELEGATION_DELEGATOR_AUTHORITY_CHANGED'
  /** P2-S4: a platform-scoped grant lacks the recorded platform-plane elevation. */
  | 'DELEGATION_PLATFORM_SCOPE_REQUIRED'
  /** P2-S4: the grant requires (or carries an invalid) digest-bound approval. */
  | 'DELEGATION_APPROVAL_REQUIRED'
  /** P2-S4: the delegation plane is unavailable (fail-closed; no ambient authority). */
  | 'DELEGATION_CHECK_UNAVAILABLE'
  | 'SECURITY_STATE_UNAVAILABLE';

export const A01_DENIAL_REASONS: readonly A01DenialReason[] = Object.freeze([
  'ENVELOPE_MALFORMED',
  'ENVELOPE_TAMPERED',
  'ENVELOPE_NOT_ALLOWED',
  'AUTHORIZATION_ENVELOPE_MISSING',
  'AUTHORIZATION_EXPIRED',
  'REPLAYED_AUTHORIZATION',
  'MISSING_PRINCIPAL',
  'FORGED_PRINCIPAL',
  'PRINCIPAL_SUBSTITUTION',
  'IDENTITY_CONFLICT',
  'MISSING_TENANT',
  'BLANK_TENANT',
  'NON_STRING_TENANT',
  'TENANT_SUBSTITUTION',
  'TENANT_OUT_OF_SCOPE',
  'MISSING_AGENT',
  'MISSING_RUN',
  'MISSING_CAPABILITY',
  'UNKNOWN_CAPABILITY',
  'CAPABILITY_VERSION_MISMATCH',
  'MISSING_TOOL',
  'UNKNOWN_TOOL',
  'UNDECLARED_TOOL_AUTHORIZATION',
  'MISSING_OPERATION',
  'OPERATION_NOT_ALLOWED',
  'OPERATION_SUBSTITUTION',
  'TARGET_NOT_ALLOWED',
  'TARGET_SUBSTITUTION',
  'WILDCARD_ESCALATION',
  'CLASSIFICATION_EXCEEDED',
  'IMPACT_EXCEEDED',
  'APPROVAL_REQUIRED',
  'APPROVAL_MISSING',
  'APPROVAL_EXPIRED',
  'APPROVAL_MISMATCH',
  'CREDENTIAL_REQUIRED',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_EXPIRED',
  'CREDENTIAL_REVOKED',
  'CREDENTIAL_SCOPE_INSUFFICIENT',
  'CREDENTIAL_AUDIENCE_MISMATCH',
  'CREDENTIAL_BINDING_MISMATCH',
  'CREDENTIAL_REPLAY',
  'BUDGET_EXHAUSTED',
  'RATE_LIMIT_EXCEEDED',
  'POLICY_ENGINE_UNAVAILABLE',
  'CREDENTIAL_BROKER_UNAVAILABLE',
  'AMBIGUOUS_POLICY_RESULT',
  'AUDIT_UNAVAILABLE',
  'UNBOUND_CONNECTOR',
  'OVER_PRIVILEGED_CONNECTOR',
  'IDEMPOTENCY_CONFLICT',
  'PRINCIPAL_REVOKED',
  'IDENTITY_STATE_INACTIVE',
  'IDENTITY_TENANT_MISMATCH',
  'PRIVILEGE_ELEVATION_REQUIRED',
  'PRIVILEGE_ELEVATION_EXPIRED',
  'PRIVILEGE_ELEVATION_REVOKED',
  'PRIVILEGE_SCOPE_MISMATCH',
  'PRIVILEGE_ROLE_MISMATCH',
  'PRIVILEGE_SESSION_MISMATCH',
  'STEP_UP_STALE',
  'PRIVILEGE_CHECK_UNAVAILABLE',
  'DELEGATION_UNKNOWN_GRANT',
  'DELEGATION_NOT_DELEGATEE',
  'DELEGATION_CROSS_TENANT_REFUSED',
  'DELEGATION_SCOPE_TENANT',
  'DELEGATION_SCOPE_OPERATION',
  'DELEGATION_SCOPE_TARGET',
  'DELEGATION_SCOPE_CLASSIFICATION',
  'DELEGATION_SCOPE_IMPACT',
  'DELEGATION_EXPIRED',
  'DELEGATION_REVOKED',
  'DELEGATION_CONSUMED',
  'DELEGATION_CHAIN_DEPTH_EXCEEDED',
  'DELEGATION_DELEGATOR_AUTHORITY_CHANGED',
  'DELEGATION_PLATFORM_SCOPE_REQUIRED',
  'DELEGATION_APPROVAL_REQUIRED',
  'DELEGATION_CHECK_UNAVAILABLE',
  'SECURITY_STATE_UNAVAILABLE',
]);

// ---------------------------------------------------------------------------
// Bound identities
// ---------------------------------------------------------------------------

/**
 * The authoritative principal binding for one decision. This reuses the T-01
 * identity substrate (verified id, server-verified tenant, recognized
 * authentication method, server-side authentication event id) rather than
 * inventing a competing identity system. Callers may project from an
 * `AuthenticatedPrincipal` or a T-02 durable `AuthenticatedPrincipalSnapshot`;
 * they may never substitute or fabricate the fields.
 */
export interface A01PrincipalBinding {
  readonly id: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  /** Must be a recognized T-01 authentication method. */
  readonly authenticationMethod: string;
  /** Server-side audit correlation of the authentication event (T-01/T-02). */
  readonly authenticationEventId: string;
}

export interface A01AgentBinding {
  readonly agentId: string;
  readonly agentVersion?: string;
}

export interface A01RunBinding {
  readonly runId: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface A01CapabilityBinding {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
}

export interface A01TargetBinding {
  readonly system: string;
  readonly resource?: string;
  readonly audience?: string;
}

/**
 * P2-S4: a delegation grant REFERENCE carried by a decision request. The
 * delegation stage (ordered after principal/tenant + privilege, before
 * capability) verifies the referenced durable grant; the reference is the
 * grant id only — never grant material or caller-controlled scope.
 */
export interface A01DelegationBinding {
  readonly delegationId: string;
}

/**
 * Exact approval/action binding. `approvedActionDigest` is a SHA-256 digest
 * over the exact authorized action fields (see `a01ActionDigest`), so one
 * approval can never be reused for a different operation, target, tenant,
 * principal, capability, classification, or impact.
 */
export interface A01ApprovalBinding {
  readonly approvalId: string;
  readonly approverId: string;
  readonly approvedAt: number;
  readonly expiresAt: number;
  readonly approvedActionDigest: string;
}

/**
 * Credential REFERENCE binding. The envelope never carries secret material —
 * only the identity and scope of the credential the decision requires. The
 * material itself is delivered by the credential broker at the enforcement
 * point, immediately before the side effect, and never persisted or logged.
 */
export interface A01CredentialBinding {
  readonly credentialId: string;
  /** Audience the credential may be presented to; null = none declared (a
   * credential issued for a specific audience still must match). */
  readonly audience: string | null;
  readonly scopes: readonly string[];
}

export interface A01ProvenanceBinding {
  readonly source: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly createdAt: number;
  readonly idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Decision request
// ---------------------------------------------------------------------------

/**
 * Everything the policy decision point needs to render one authoritative
 * decision for one invocation. All fields are required at the boundary; the
 * request is constructed from verified identities and declared tool/adapter
 * metadata — never from model output or caller-supplied metadata.
 */
export interface A01AuthorizationRequest {
  readonly principal: A01PrincipalBinding;
  /** Must equal `principal.tenantId`; a mismatch is tenant substitution. */
  readonly tenantId: string;
  readonly agent: A01AgentBinding;
  readonly run: A01RunBinding;
  readonly capability: A01CapabilityBinding;
  readonly tool: string;
  readonly operation: string;
  readonly target: A01TargetBinding;
  readonly dataClassification: A01DataClassification;
  readonly impact: A01ImpactLevel;
  readonly approval?: A01ApprovalBinding;
  /**
   * Credential binding this invocation carries (id/audience/scopes — NEVER
   * material). Required when the capability manifest demands scopes; the
   * broker validates it at decision and re-acquires it at enforcement.
   */
  readonly credential?: A01CredentialBinding;
  /** Cost units this invocation consumes from the run budget (default 1). */
  readonly budgetCostUnits?: number;
  /** Stable key for idempotent replay of an externally side-effecting action. */
  readonly idempotencyKey?: string;
  readonly provenance?: { readonly source: string; readonly causationId?: string };
  /** P2-S4: a durable delegation grant reference (verified by the delegation stage). */
  readonly delegation?: A01DelegationBinding;
}

// ---------------------------------------------------------------------------
// Capability manifests
// ---------------------------------------------------------------------------

export interface A01AllowedOperation {
  readonly tool: string;
  readonly operation: string;
}

/**
 * Explicit, versioned declaration of what one capability may do. Manifests
 * are registered once per (capabilityId, version) and are immutable; a newer
 * version may only NARROW the previous one (see CapabilityManifestRegistry).
 * Adding permissions, widening tenant/resource scope, introducing wildcards,
 * dropping approval, or raising classification/impact in a new version is a
 * registration error, not a policy negotiation.
 */
export interface A01CapabilityManifest {
  readonly capabilityId: string;
  readonly version: string;
  readonly description?: string;
  /** Closed allow-list of (tool, operation) pairs. Empty means the capability grants nothing. */
  readonly allowedOperations: readonly A01AllowedOperation[];
  /**
   * Allowed target systems and optional resource patterns. A pattern is
   * exact-match unless it contains `*` (simple segment glob). An explicit
   * `*` must be registered deliberately; it is never inferred.
   */
  readonly allowedTargets: readonly { readonly system: string; readonly resourcePattern?: string }[];
  /** Explicit tenant scopes. Empty is legal only together with `allowTenantWildcard: true`. */
  readonly tenantScopes: readonly string[];
  /** Deliberate system-scope flag; required when `tenantScopes` is empty. */
  readonly allowTenantWildcard: boolean;
  readonly maxDataClassification: A01DataClassification;
  readonly maxImpact: A01ImpactLevel;
  /** Credential scopes an invocation must carry; empty means no credential required. */
  readonly requiredCredentialScopes: readonly string[];
  /** When set, the invocation target audience and any issued credential audience must equal it. */
  readonly credentialAudience?: string;
  /** When true, a valid exact-bound approval is mandatory. */
  readonly requiresApproval: boolean;
  readonly rateLimit: { readonly windowMs: number; readonly max: number };
  /** Maximum cost units one run may consume under this capability. */
  readonly budgetPerRunCostUnits: number;
  /** Maximum age of an ALLOW decision under this capability. */
  readonly maxLifetimeMs: number;
  readonly registeredBy: { readonly principalId: string; readonly tenantId: string };
  readonly policyVersion: string;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Decisions and envelopes
// ---------------------------------------------------------------------------

export type A01DecisionOutcome = 'ALLOW' | 'DENY';

export interface A01DecisionRecord {
  readonly decisionId: string;
  readonly decision: A01DecisionOutcome;
  readonly reasonCodes: readonly A01DenialReason[];
  readonly policyVersion: string;
  readonly decidedAt: number;
  /** Envelope expires at this instant; after it, the decision is stale. */
  readonly expiresAt: number;
  readonly budgetCostUnits: number;
}

/**
 * The sealed authorization envelope. Created exclusively by the policy
 * decision point, deep-frozen, and integrity-protected by a SHA-256 digest
 * over its canonical form. Downstream components must CONSUME this envelope
 * (re-verifying integrity) rather than reconstruct authorization from
 * untrusted caller metadata. Any in-process mutation attempt is detectable.
 */
export interface A01AuthorizationEnvelope {
  readonly envelopeId: string;
  readonly version: 1;
  readonly principal: A01PrincipalBinding;
  readonly tenantId: string;
  readonly agent: A01AgentBinding;
  readonly run: A01RunBinding;
  readonly capability: A01CapabilityBinding;
  readonly tool: string;
  readonly operation: string;
  readonly target: A01TargetBinding;
  readonly dataClassification: A01DataClassification;
  readonly impact: A01ImpactLevel;
  readonly approval?: A01ApprovalBinding;
  readonly credential?: A01CredentialBinding;
  /** P2-S4: the delegation grant reference the request presented (mirrored from the sealed request). */
  readonly delegation?: A01DelegationBinding;
  readonly provenance: A01ProvenanceBinding;
  readonly decision: A01DecisionRecord;
  /**
   * R2 durable citations (present ONLY on `decideAsync` envelopes, covered
   * by the integrity digest). Enforcement re-validates them against live
   * durable state; an envelope without citations is refused by the durable
   * enforcement path (it cannot prove which manifest revision authorized it).
   */
  readonly manifestId?: string;
  readonly manifestDigest?: string;
  readonly sessionEventId?: string;
  readonly sessionStatus?: A01SessionAuditStatus;
  readonly securityStoreTxId?: string;
  /**
   * P2-S3 durable privilege citations (present only when the decision passed
   * the privilege stage; covered by the integrity digest). Enforcement
   * re-validates the elevation against live durable state.
   */
  readonly privilegeElevationId?: string;
  readonly privilegeOperationClass?: string;
  readonly privilegeStatus?: string;
  /**
   * P2-S4 durable delegation citation (present only when the decision passed
   * the delegation stage; covered by the integrity digest). Enforcement
   * re-validates and atomically consumes the grant against live durable state.
   */
  readonly delegationStatus?: string;
  readonly integrity: { readonly algorithm: 'sha256'; readonly digest: string };
}

/**
 * R2: the durable session assessment outcome cited on an envelope / audit
 * record. `KERNEL_INTERNAL_VERIFIED` marks the verified-kernel-worker path
 * (cryptographic process verification, no S-8 row by design).
 */
export type A01SessionAuditStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'UNKNOWN' | 'KERNEL_INTERNAL_VERIFIED';

export const A01_SESSION_AUDIT_STATUSES: readonly A01SessionAuditStatus[] = Object.freeze([
  'ACTIVE',
  'REVOKED',
  'EXPIRED',
  'UNKNOWN',
  'KERNEL_INTERNAL_VERIFIED',
]);

export function isA01SessionAuditStatus(value: unknown): value is A01SessionAuditStatus {
  return typeof value === 'string' && (A01_SESSION_AUDIT_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Audit (durable, privacy-safe provenance)
// ---------------------------------------------------------------------------

/**
 * One durable authorization provenance record. Privacy-safe by construction:
 * it references credentials (id/audience/scopes) and approvals (id) but never
 * contains secret material, raw tokens, or prompt/tool content.
 */
export interface A01AuditRecord {
  readonly id: string;
  readonly kind: 'DECISION' | 'CONSUMED';
  readonly principalId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly tool: string;
  readonly operation: string;
  readonly targetSystem: string;
  readonly targetResource?: string;
  readonly dataClassification: A01DataClassification;
  readonly impact: A01ImpactLevel;
  readonly decision: A01DecisionOutcome;
  readonly reasonCodes: readonly A01DenialReason[];
  readonly policyVersion: string;
  readonly approvalReference?: string;
  readonly credentialReference?: { readonly credentialId: string; readonly audience: string | null; readonly scopes: readonly string[] };
  readonly envelopeId: string;
  readonly idempotencyKey?: string;
  readonly decidedAt: number;
  readonly consumedAt?: number;
  readonly sideEffectInvoked?: boolean;
  readonly idempotentReplay?: boolean;
  /**
   * R2 S-10 extensions (durable path only): the exact manifest revision,
   * session assessment, and enforcement transaction behind the record.
   */
  readonly manifestId?: string;
  readonly manifestDigest?: string;
  readonly sessionEventId?: string;
  readonly sessionStatus?: A01SessionAuditStatus;
  readonly securityStoreTxId?: string;
}

/**
 * R2 S-10 credential-lifecycle audit row (`CREDENTIAL_ISSUED` /
 * `CREDENTIAL_REVOKED`). Written by the durable broker inside its mutation
 * transaction. References only — never material.
 */
export interface A01CredentialAuditRecord {
  readonly id: string;
  readonly kind: 'CREDENTIAL_ISSUED' | 'CREDENTIAL_REVOKED';
  readonly credentialId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly capabilityId: string;
  readonly tool: string;
  readonly operation: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly issuedBy: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly recordedAt: number;
}

/**
 * R2 S-10 retention/GC batch audit row. Written by the substrate GC inside
 * each deletion transaction (same tx as the deletes it evidences).
 */
export interface A01GcAuditRecord {
  readonly id: string;
  readonly kind: 'GC_BATCH';
  readonly collection: string;
  readonly tenantId: string;
  readonly deletedCount: number;
  readonly markedExpiredCount: number;
  readonly maintenanceBy: string;
  readonly startedAt: number;
  readonly completedAt: number;
}

/** Every row shape the S-10 `authorization.decisions` collection may hold. */
export type A01StoredAuditRecord = A01AuditRecord | A01CredentialAuditRecord | A01GcAuditRecord;

export const A01_STORED_AUDIT_KINDS: readonly A01StoredAuditRecord['kind'][] = Object.freeze([
  'DECISION',
  'CONSUMED',
  'CREDENTIAL_ISSUED',
  'CREDENTIAL_REVOKED',
  'GC_BATCH',
]);

export function isA01StoredAuditKind(value: unknown): value is A01StoredAuditRecord['kind'] {
  return typeof value === 'string' && (A01_STORED_AUDIT_KINDS as readonly string[]).includes(value);
}

/**
 * R2: the receipt returned (instead of a cached side-effect result) when a
 * durable idempotent duplicate finds a COMPLETED S-5 row. Durable results
 * are never cached (results may carry secrets or unbounded bulk); the
 * receipt re-fetches the referenced evidence. Discriminate with
 * `isA01IdempotencyReceipt`.
 */
export interface A01IdempotencyReceipt {
  readonly idempotentReplay: true;
  readonly decisionId: string;
  readonly envelopeId: string;
  readonly completedAt: number;
}

export function isA01IdempotencyReceipt(value: unknown): value is A01IdempotencyReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.idempotentReplay === true &&
    typeof candidate.decisionId === 'string' &&
    typeof candidate.envelopeId === 'string' &&
    typeof candidate.completedAt === 'number'
  );
}

export interface A01AuditSink {
  record(record: A01AuditRecord): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Credential broker
// ---------------------------------------------------------------------------

/**
 * Binding specification for one issued credential. The broker validates the
 * binding at issue time and again at acquire time against the authoritative
 * envelope. `secretMaterial` is supplied by the issuer (a test/dev secret
 * generator today; a real secret provider behind this same interface in
 * production). The material is returned to the issuer exactly once at issue
 * time and is otherwise only ever delivered at the enforcement point.
 */
export interface A01CredentialIssueSpec {
  readonly credentialId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly capabilityId: string;
  readonly tool: string;
  readonly operation: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly lifetimeMs: number;
  readonly issuedBy: string;
  readonly secretMaterial?: string;
}

/** Secret-bearing view, delivered only at the enforcement point. */
export interface ScopedCredential {
  readonly credentialId: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly material: string;
}

/**
 * The view of an envelope the broker needs to validate a credential without
 * consuming it. The PDP uses `checkFor` at decision time; the enforcement
 * point uses `acquireFor` (which checks AND consumes) immediately before the
 * side effect.
 */
export interface A01CredentialCheckView {
  readonly envelopeId: string;
  readonly principal: { readonly id: string };
  readonly tenantId: string;
  readonly capability: { readonly capabilityId: string };
  readonly tool: string;
  readonly operation: string;
  readonly target: { readonly audience?: string };
  readonly credential?: { readonly credentialId: string; readonly audience: string | null; readonly scopes: readonly string[] };
}

/**
 * The A-01 credential-broker abstraction. Implementations must be
 * fail-closed: an unavailable broker is never treated as "no credential
 * required". Production secret-provider integrations implement this same
 * interface; A-01 ships the InMemory implementation and does not pretend any
 * external infrastructure exists.
 */
export interface CredentialBroker {
  readonly id: string;
  available(): boolean;
  issue(spec: A01CredentialIssueSpec): { readonly credentialId: string; readonly material: string; readonly expiresAt: number };
  /**
   * Validate the credential bound to this envelope view WITHOUT consuming it.
   * Returns machine-readable denial codes; empty means acquirable.
   */
  checkFor(view: A01CredentialCheckView, requiredScopes: readonly string[]): readonly A01DenialReason[];
  /**
   * Resolve the credential bound to this envelope, enforcing binding match,
   * scope sufficiency, audience, expiry, and single-use per envelope.
   * Throws `CredentialDeniedError` with machine-readable reasons.
   */
  acquireFor(envelope: A01AuthorizationEnvelope, requiredScopes: readonly string[]): ScopedCredential;
  revoke(credentialId: string): void;
}

// ---------------------------------------------------------------------------
// Discretionary policy engine
// ---------------------------------------------------------------------------

/**
 * Pluggable discretionary policy layer. The mandatory checks (identity
 * binding, manifest scope, approval, credential, replay, budget, rate) are
 * ALWAYS enforced by the decision point regardless of this engine; the engine
 * adds discretionary rules. A throwing or ambiguous engine fails the decision
 * closed (POLICY_ENGINE_UNAVAILABLE / AMBIGUOUS_POLICY_RESULT).
 */
export interface A01PolicyEngine {
  readonly id: string;
  evaluate(
    request: A01AuthorizationRequest,
    manifest: A01CapabilityManifest,
  ): { readonly outcome: A01DecisionOutcome; readonly reasons: readonly A01DenialReason[] };
}

/** Default engine: no discretionary denials. Mandatory checks still apply. */
export class PermissiveBaselinePolicyEngine implements A01PolicyEngine {
  readonly id = 'a01-baseline-policy';
  evaluate(
    _request: A01AuthorizationRequest,
    _manifest: A01CapabilityManifest,
  ): { outcome: A01DecisionOutcome; reasons: readonly A01DenialReason[] } {
    return { outcome: 'ALLOW', reasons: [] };
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the enforcement gate BEFORE any protected side effect runs.
 * Carries the closed-set denial reason codes for auditable assertions.
 */
export class AuthorizationDeniedError extends Error {
  readonly reasons: readonly A01DenialReason[];
  constructor(reasons: readonly A01DenialReason[], detail?: string) {
    const code = reasons.length > 0 ? reasons[0] : 'ENVELOPE_MALFORMED';
    super(`AUTHORIZATION_DENIED: ${code}${reasons.length > 1 ? ` (+${reasons.length - 1} more: ${reasons.join(', ')})` : ''}${detail ? ` — ${detail}` : ''}`);
    this.name = 'AuthorizationDeniedError';
    this.reasons = Object.freeze([...reasons]);
    Object.setPrototypeOf(this, AuthorizationDeniedError.prototype);
  }
}

/** Thrown by the credential broker on any credential rejection. */
export class CredentialDeniedError extends Error {
  readonly reasons: readonly A01DenialReason[];
  constructor(reasons: readonly A01DenialReason[]) {
    const code = reasons.length > 0 ? reasons[0] : 'CREDENTIAL_MISSING';
    super(`CREDENTIAL_DENIED: ${code}${reasons.length > 1 ? ` (+${reasons.length - 1} more: ${reasons.join(', ')})` : ''}`);
    this.name = 'CredentialDeniedError';
    this.reasons = Object.freeze([...reasons]);
    Object.setPrototypeOf(this, CredentialDeniedError.prototype);
  }
}

/** Thrown when a capability manifest registration is rejected. */
export class ManifestRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestRejectedError';
    Object.setPrototypeOf(this, ManifestRejectedError.prototype);
  }
}

/** Thrown when the envelope integrity check fails (tamper detection). */
export class EnvelopeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeIntegrityError';
    Object.setPrototypeOf(this, EnvelopeIntegrityError.prototype);
  }
}

export function isA01DataClassification(value: unknown): value is A01DataClassification {
  return typeof value === 'string' && (A01_DATA_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function isA01ImpactLevel(value: unknown): value is A01ImpactLevel {
  return typeof value === 'string' && (A01_IMPACT_LEVELS as readonly string[]).includes(value);
}

export function isA01DenialReason(value: unknown): value is A01DenialReason {
  return typeof value === 'string' && (A01_DENIAL_REASONS as readonly string[]).includes(value);
}
