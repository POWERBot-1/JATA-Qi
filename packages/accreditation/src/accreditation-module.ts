// AccreditationModule — the Legal Operation Mode + accreditation governance
// backbone (PRX Parts I, J, L). It enforces that capabilities requiring
// external accreditation, public trust, or delegated Internet authority are
// only operable (and only honestly claimable) after a verified, signed
// accreditation grant is recorded and the platform is in ACCREDITED_PRODUCTION
// mode.
//
// Trust model: every grant is signed by the platform governance Ed25519 key
// (configured via JATAQI_GOVERNANCE_KEY, or generated per-boot for dev) and
// appended to a SHA-256-chained immutable ledger. The private key is never
// persisted by this module; for production it must be supplied via config or a
// KMS/HSM-backed provider.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { fingerprint, signData, verifyData, publicKeyFromPrivate, generateKeyPair, toBase64 } from '@jataqi/provenance';
import { ACCREDITATION_DOMAINS, getDomain, requiresAccreditation } from './domains.js';
import { AccreditationLedger } from './ledger.js';
import type {
  AccreditationDomain,
  AccreditationGrant,
  ClaimVerificationResult,
  GateDecision,
  GateReason,
  GrantStatus,
  OperationMode,
  RecordGrantInput,
} from './types.js';

export const AccreditationEvents = Object.freeze({
  GrantRecorded: 'accreditation.grant.recorded',
  GrantStatusChanged: 'accreditation.grant.status',
  ModeChanged: 'accreditation.mode.changed',
  GateDenied: 'accreditation.gate.denied',
  ClaimVerified: 'accreditation.claim.verified',
} as const);

export interface AccreditationConfig {
  /** Initial operation mode. Default DEVELOPMENT. */
  mode?: OperationMode;
  /**
   * Governance private key (PKCS#8 DER, base64) used to sign grants. If
   * omitted, an ephemeral key is generated per boot (dev only).
   */
  governancePrivateKey?: string;
  /** Whether the gate emits denial events on the bus. Default true. */
  emitDenials?: boolean;
}

export class AccreditationModule implements IModule {
  readonly id = 'accreditation';
  readonly tags = ['core', 'governance'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private cfg: Required<Pick<AccreditationConfig, 'mode' | 'emitDenials'>> & {
    governancePrivateKey: string;
  };
  private governancePublicKey: string;
  private grants = new Map<string, AccreditationGrant>();
  private ledger = new AccreditationLedger();

  constructor(cfg: AccreditationConfig = {}) {
    const governancePrivateKey =
      cfg.governancePrivateKey ?? toBase64(generateKeyPair().privateKeyDer);
    this.cfg = {
      mode: cfg.mode ?? 'DEVELOPMENT',
      emitDenials: cfg.emitDenials ?? true,
      governancePrivateKey,
    };
    this.governancePublicKey = publicKeyFromPrivate(governancePrivateKey);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('accreditation', this);
    if (!this.cfg.governancePrivateKey) {
      kernel.logger.warn(
        'accreditation: no governance key configured — using an ephemeral key (dev only)',
      );
    }
    kernel.logger.info(
      `accreditation: operation mode = ${this.cfg.mode}, domains = ${ACCREDITATION_DOMAINS.length}`,
    );
  }

  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless aside from in-memory ledger */ }

  // ---- operation mode -----------------------------------------------------

  getMode(): OperationMode {
    return this.cfg.mode;
  }

  /** Transition the operation mode. Records a ledger entry. */
  setMode(mode: OperationMode): void {
    if (mode === this.cfg.mode) return;
    const prev = this.cfg.mode;
    this.cfg.mode = mode;
    this.ledger.append('mode.set', { from: prev, to: mode });
    void this.api.bus.emit(AccreditationEvents.ModeChanged, { from: prev, to: mode });
    this.api.logger.info(`accreditation: mode ${prev} → ${mode}`);
  }

  // ---- domain catalog -----------------------------------------------------

  listDomains(): AccreditationDomain[] {
    return [...ACCREDITATION_DOMAINS];
  }

  domain(id: string): AccreditationDomain | undefined {
    return getDomain(id);
  }

  // ---- grants -------------------------------------------------------------

  private grantPayload(g: AccreditationGrant): Record<string, unknown> {
    // Everything except the signature fields; used for fingerprint + signing.
    return {
      id: g.id,
      domain: g.domain,
      externalRef: g.externalRef,
      issuedBy: g.issuedBy,
      scope: g.scope,
      status: g.status,
      validFrom: g.validFrom,
      validUntil: g.validUntil,
      recordedAt: g.recordedAt,
      recordedBy: g.recordedBy,
      evidence: g.evidence,
    };
  }

  /**
   * Record an externally-issued accreditation grant. The grant is signed by the
   * governance key and appended to the immutable ledger. Throws if the domain
   * is unknown.
   */
  recordGrant(input: RecordGrantInput): AccreditationGrant {
    if (!getDomain(input.domain)) {
      throw new Error(`accreditation: unknown domain "${input.domain}"`);
    }
    if (input.validUntil !== 0 && input.validUntil < input.validFrom) {
      throw new Error('accreditation: validUntil must be >= validFrom (or 0 for indefinite)');
    }
    const partial: AccreditationGrant = {
      id: randomUUID(),
      domain: input.domain,
      ...(input.externalRef ? { externalRef: input.externalRef } : {}),
      issuedBy: input.issuedBy,
      scope: input.scope,
      status: 'PENDING',
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      recordedAt: Date.now(),
      recordedBy: input.recordedBy,
      evidence: input.evidence ?? [],
      fingerprint: '',
      signature: '',
      signedBy: this.governancePublicKey,
    };
    partial.fingerprint = fingerprint(this.grantPayload(partial));
    partial.signature = signData(this.grantPayload(partial), this.cfg.governancePrivateKey);
    partial.signedBy = this.governancePublicKey;
    this.grants.set(partial.id, partial);
    this.ledger.append('grant.recorded', { grantId: partial.id, domain: partial.domain, scope: partial.scope });
    void this.api.bus.emit(AccreditationEvents.GrantRecorded, { grantId: partial.id, domain: partial.domain });
    return { ...partial };
  }

  /** Transition a grant to a new status. Appends a ledger entry. */
  setGrantStatus(id: string, status: GrantStatus, actor: string): AccreditationGrant {
    const g = this.grants.get(id);
    if (!g) throw new Error(`accreditation: grant "${id}" not found`);
    const prev = g.status;
    const updated: AccreditationGrant = { ...g, status };
    // Re-sign so the on-record status is authentic.
    updated.fingerprint = fingerprint(this.grantPayload(updated));
    updated.signature = signData(this.grantPayload(updated), this.cfg.governancePrivateKey);
    this.grants.set(id, updated);
    const action =
      status === 'ACTIVE' ? 'grant.activated' :
      status === 'SUSPENDED' ? 'grant.suspended' :
      status === 'REVOKED' ? 'grant.revoked' :
      status === 'EXPIRED' ? 'grant.expired' : 'grant.status';
    this.ledger.append(action, { grantId: id, from: prev, to: status, actor });
    void this.api.bus.emit(AccreditationEvents.GrantStatusChanged, { grantId: id, from: prev, to: status });
    return { ...updated };
  }

  /** Convenience: mark a recorded grant ACTIVE (externally verified). */
  activate(id: string, actor: string): AccreditationGrant {
    return this.setGrantStatus(id, 'ACTIVE', actor);
  }

  revoke(id: string, actor: string): AccreditationGrant {
    return this.setGrantStatus(id, 'REVOKED', actor);
  }

  suspend(id: string, actor: string): AccreditationGrant {
    return this.setGrantStatus(id, 'SUSPENDED', actor);
  }

  getGrant(id: string): AccreditationGrant | undefined {
    const g = this.grants.get(id);
    return g ? { ...g } : undefined;
  }

  listGrants(domain?: string): AccreditationGrant[] {
    const all = [...this.grants.values()];
    return (domain ? all.filter((g) => g.domain === domain) : all).map((g) => ({ ...g }));
  }

  /** Verify a grant's signature + fingerprint (tamper detection). */
  verifyGrant(id: string): boolean {
    const g = this.grants.get(id);
    if (!g) return false;
    const payload = this.grantPayload(g);
    if (fingerprint(payload) !== g.fingerprint) return false;
    return verifyData(payload, g.signature, g.signedBy);
  }

  /** Verify every recorded grant (chain-of-trust integrity check). */
  verifyAllGrants(): { verified: number; failed: string[] } {
    const failed: string[] = [];
    let verified = 0;
    for (const g of this.grants.values()) {
      if (this.verifyGrant(g.id)) verified++;
      else failed.push(g.id);
    }
    return { verified, failed };
  }

  // ---- the gate (Part L enforcement) --------------------------------------

  /** The currently-time-valid, ACTIVE grant for a domain, if any. */
  activeGrantFor(domain: string): AccreditationGrant | undefined {
    const now = Date.now();
    return this.listGrants(domain).find((g) => {
      if (g.status !== 'ACTIVE') return false;
      if (g.validFrom > now) return false;
      if (g.validUntil !== 0 && g.validUntil <= now) return false;
      return true;
    });
  }

  private decide(reason: GateReason, message: string, domain: string, grant?: AccreditationGrant): GateDecision {
    return { allowed: reason.startsWith('ALLOWED'), reason, message, ...(grant ? { grant } : {}), mode: this.cfg.mode, domain };
  }

  /**
   * The core enforcement primitive. Returns whether a capability/domain action
   * is permitted under the current operation mode and recorded accreditations.
   *
   * Capabilities that require accreditation are denied unless an ACTIVE grant
   * exists AND the platform is in ACCREDITED_PRODUCTION. A `simulation` action
   * in DEVELOPMENT mode is allowed (inert/dry-run) so the platform can be
   * exercised end-to-end without making any public-trust claim.
   */
  gate(domain: string, opts: { simulation?: boolean } = {}): GateDecision {
    if (!getDomain(domain)) {
      return this.decide('DENIED_UNKNOWN_DOMAIN', `Unknown accreditation domain "${domain}"`, domain);
    }
    if (!requiresAccreditation(domain)) {
      // Private / operational capability — usable without public trust.
      if (this.cfg.mode === 'DEVELOPMENT') {
        return this.decide('ALLOWED_DEVELOPMENT', `"${domain}" is operational and permitted in development (non-public)`, domain);
      }
      return this.decide('ALLOWED_PRIVATE', `"${domain}" is operational (private infrastructure)`, domain);
    }
    // Accreditation-required capability.
    if (opts.simulation && this.cfg.mode === 'DEVELOPMENT') {
      return this.decide('ALLOWED_DEVELOPMENT', `"${domain}" exercised in simulation only (no public claim)`, domain);
    }
    const grants = this.listGrants(domain);
    if (grants.length === 0) {
      this.emitDenial(domain, 'DENIED_NO_GRANT', `No accreditation recorded for "${domain}"`);
      return this.decide('DENIED_NO_GRANT', `No accreditation recorded for "${domain}" — operation requires external accreditation`, domain);
    }
    const now = Date.now();
    // Inspect non-active grants for a more precise denial reason.
    const suspended = grants.find((g) => g.status === 'SUSPENDED' && (g.validUntil === 0 || g.validUntil > now));
    if (suspended && !this.activeGrantFor(domain)) {
      this.emitDenial(domain, 'DENIED_SUSPENDED', `Accreditation for "${domain}" is suspended`);
      return this.decide('DENIED_SUSPENDED', `Accreditation for "${domain}" is suspended`, domain, suspended);
    }
    const active = this.activeGrantFor(domain);
    if (!active) {
      this.emitDenial(domain, 'DENIED_EXPIRED', `No active accreditation for "${domain}"`);
      return this.decide('DENIED_EXPIRED', `No active accreditation for "${domain}" (grants are pending, expired, or revoked)`, domain);
    }
    if (this.cfg.mode !== 'ACCREDITED_PRODUCTION') {
      this.emitDenial(domain, 'DENIED_MODE', `Active accreditation exists but mode is ${this.cfg.mode}`);
      return this.decide('DENIED_MODE', `Active accreditation exists for "${domain}" but platform mode is ${this.cfg.mode} (requires ACCREDITED_PRODUCTION)`, domain, active);
    }
    return this.decide('ALLOWED_ACCREDITED', `"${domain}" is accredited and platform is in production`, domain, active);
  }

  private emitDenial(domain: string, reason: GateReason, message: string): void {
    if (!this.cfg.emitDenials) return;
    void this.api.bus.emit(AccreditationEvents.GateDenied, { domain, reason, message });
  }

  // ---- honest public claims (Part L) --------------------------------------

  /**
   * Verify whether a public claim about the platform's accreditation status is
   * honest given recorded grants and the current mode. The platform MUST NOT
   * state or imply accreditation that has not been verified.
   */
  verifyClaim(claim: string): ClaimVerificationResult {
    const required = domainsForClaim(claim);
    if (required.length === 0) {
      return { claim, honest: true, domains: [], backingGrants: [], message: 'Claim does not assert public-trust accreditation.' };
    }
    if (this.cfg.mode !== 'ACCREDITED_PRODUCTION') {
      return { claim, honest: false, domains: required, backingGrants: [], message: `Platform mode is ${this.cfg.mode}; cannot assert public-trust accreditation.` };
    }
    const backing: AccreditationGrant[] = [];
    for (const d of required) {
      const g = this.activeGrantFor(d);
      if (!g) {
        return { claim, honest: false, domains: required, backingGrants: [], message: `Missing active accreditation for "${d}".` };
      }
      backing.push(g);
    }
    return { claim, honest: true, domains: required, backingGrants: backing, message: 'Claim is backed by active, verified accreditations.' };
  }

  // ---- ledger + compliance reporting --------------------------------------

  ledgerEntries() {
    return this.ledger.all();
  }

  ledgerRootHash(): string {
    return this.ledger.rootHash();
  }

  verifyLedger(): boolean {
    return this.ledger.verify();
  }

  /**
   * Compliance posture report (Part J). For each accreditation domain: whether
   * accreditation is required, whether an active grant exists, the bodies, and
   * the control frameworks the platform must satisfy for audit.
   */
  complianceReport(): Array<{
    domain: string;
    name: string;
    requiresAccreditation: boolean;
    activeGrant: boolean;
    accreditationBodies: string[];
    controlFrameworks: string[];
  }> {
    return ACCREDITATION_DOMAINS.map((d) => ({
      domain: d.id,
      name: d.name,
      requiresAccreditation: d.requiresAccreditation,
      activeGrant: !!this.activeGrantFor(d.id),
      accreditationBodies: [...d.accreditationBodies],
      controlFrameworks: [...d.controlFrameworks],
    }));
  }
}

/** Map a natural-language claim to the accreditation domain(s) it implies. */
export function domainsForClaim(claim: string): string[] {
  const c = claim.toLowerCase();
  const out: string[] = [];
  if (/(tld|top-level|registry operator|\.[-a-z]+\b.*registry)/.test(c) || /\bregistry\b/.test(c)) out.push('tld-registry');
  if (/\bregistrar\b/.test(c)) out.push('registrar');
  if (/(publicly trusted ca|public certificate authority|root ca|public ca|trusted ca|certificate authority|certification authority)\b/.test(c)) out.push('ca-root');
  if (/(intermediate ca|issue.*certificates|certificate issuance)\b/.test(c)) out.push('ca-intermediate');
  if (/(dns authority|delegated dns|root zone|global dns authority)\b/.test(c)) out.push('dns-authority');
  if (/(rir|regional internet registry|asn|ip allocation)\b/.test(c)) out.push('rir-member');
  return [...new Set(out)];
}
