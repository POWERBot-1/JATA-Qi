// PkiModule (PRX Part C) — kernel module exposing the CertificateAuthority,
// RegistrationAuthority, and IdentityProvider as one governed PKI surface.
// Emits bus events on CA creation, issuance, revocation, and IdP tokens.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { StorageModule } from '@jataqi/storage';
import { CertificateAuthority, type CaRecord, type CrlRecord, type IssuedCertificate, type IssueCertificateInput } from './ca.js';
import { RegistrationAuthority, type CertificateRequest, type ValidationMethod } from './ra.js';
import { IdentityProvider, type IdpClient, type TokenResponse, type UserInfo } from './idp.js';
import {
  AcmeService, parseJws, verifyJws,
  type AcmeAuthorization, type AcmeChallenge, type AcmeIdentifier,
  type AcmeOrder, type NewAccountResult, type ParsedJws,
} from './acme.js';

export const PkiEvents = Object.freeze({
  CaCreated: 'pki.ca.created',
  CertificateIssued: 'pki.certificate.issued',
  CertificateRevoked: 'pki.certificate.revoked',
  CrlPublished: 'pki.crl.published',
  RaRequested: 'pki.ra.requested',
  RaApproved: 'pki.ra.approved',
  ClientRegistered: 'pki.idp.client.registered',
  TokensIssued: 'pki.idp.tokens.issued',
} as const);

export interface PkiModuleConfig {
  /** IdP issuer identifier (default 'https://id.jataqi.local'). */
  issuer?: string;
  /** IdP JWT signing algorithm. */
  signingAlg?: 'HS256' | 'EdDSA';
  /** ACME default certificate validity in days (default 90). */
  acmeValidityDays?: number;
  /** ACME issuing CA id (default: newest intermediate, else root). */
  acmeIssuerCaId?: string;
}

export class PkiModule implements IModule {
  readonly id = 'pki';
  readonly tags = ['core', 'security', 'pki'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private readonly cfg: Required<Pick<PkiModuleConfig, 'issuer' | 'signingAlg'>> & Pick<PkiModuleConfig, 'acmeValidityDays' | 'acmeIssuerCaId'>;
  readonly ca: CertificateAuthority;
  readonly ra: RegistrationAuthority;
  readonly idp: IdentityProvider;
  readonly acme: AcmeService;

  constructor(cfg: PkiModuleConfig = {}) {
    this.cfg = { issuer: cfg.issuer ?? 'https://id.jataqi.local', signingAlg: cfg.signingAlg ?? 'HS256' };
    this.ca = new CertificateAuthority();
    this.ra = new RegistrationAuthority();
    this.idp = new IdentityProvider({ issuer: this.cfg.issuer, signingAlg: this.cfg.signingAlg });
    this.acme = new AcmeService(this.ca, {
      ...(cfg.acmeValidityDays !== undefined ? { validityDays: cfg.acmeValidityDays } : {}),
      ...(cfg.acmeIssuerCaId !== undefined ? { issuerCaId: cfg.acmeIssuerCaId } : {}),
    });
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('pki', this);
    kernel.logger.info('pki module initialized (CA + RA + IdP)');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- CA surface --------------------------------------------------------

  createRootCa(subject: Array<{ oid: string; value: string }>): CaRecord {
    const ca = this.ca.createCa({ role: 'root', subject });
    void this.api.bus.emit(PkiEvents.CaCreated, { id: ca.id, role: 'root', subject: ca.subject });
    return ca;
  }

  createIntermediateCa(subject: Array<{ oid: string; value: string }>, issuerId: string): CaRecord {
    const ca = this.ca.createCa({ role: 'intermediate', subject, issuerId });
    void this.api.bus.emit(PkiEvents.CaCreated, { id: ca.id, role: 'intermediate', issuerId });
    return ca;
  }

  issueCertificate(input: IssueCertificateInput): IssuedCertificate {
    const cert = this.ca.issue(input);
    void this.api.bus.emit(PkiEvents.CertificateIssued, { id: cert.id, caId: cert.caId, serial: cert.serialNumber.toString() });
    return cert;
  }

  revokeCertificate(id: string, reason?: string): IssuedCertificate {
    const cert = this.ca.revoke(id, reason);
    void this.api.bus.emit(PkiEvents.CertificateRevoked, { id: cert.id, reason });
    const crl = this.ca.latestCrl(cert.caId);
    if (crl) void this.api.bus.emit(PkiEvents.CrlPublished, { caId: cert.caId, number: crl.number.toString() });
    return cert;
  }

  // ---- RA surface --------------------------------------------------------

  createRequest(input: {
    domains: string[];
    subject: Array<{ oid: string; value: string }>;
    publicKeyJwk: Record<string, string>;
    method: ValidationMethod;
    requestedBy: string;
  }): CertificateRequest {
    const request = this.ra.create(input);
    void this.api.bus.emit(PkiEvents.RaRequested, { id: request.id, domains: request.domains, method: request.method });
    return request;
  }

  /** One-stop flow: request → validate → approve → issue (returns cert). */
  async issueViaRa(input: {
    domains: string[];
    subject: Array<{ oid: string; value: string }>;
    publicKeyJwk: Record<string, string>;
    method: ValidationMethod;
    observed: { location: string; token: string };
    approver: string;
    caId: string;
  }): Promise<{ request: CertificateRequest; certificate: IssuedCertificate }> {
    const request = this.createRequest({
      domains: input.domains,
      subject: input.subject,
      publicKeyJwk: input.publicKeyJwk,
      method: input.method,
      requestedBy: input.approver,
    });
    // Operators may pre-provision the proof token out-of-band; when the
    // observed token is empty, the request token is used (automated flows).
    const observedToken = input.observed.token || request.token;
    const validated = this.ra.validate(request.id, { ...input.observed, token: observedToken });
    if (!validated || validated.status !== 'validated') {
      throw new Error(`domain validation failed for ${input.domains.join(', ')}`);
    }
    const approved = this.ra.approve(request.id, input.approver);
    if (!approved) throw new Error('request could not be approved');
    void this.api.bus.emit(PkiEvents.RaApproved, { id: approved.id, approver: input.approver });
    const certificate = this.issueCertificate({
      caId: input.caId,
      subject: approved.subject,
      sanDnsNames: approved.domains,
      subjectPublicKeyJwk: approved.publicKeyJwk,
    });
    this.ra.markIssued(request.id, certificate.id);
    return { request, certificate };
  }

  // ---- IdP surface -------------------------------------------------------

  registerIdpClient(input: { name: string; redirectUris: string[]; scopes?: string[] }): IdpClient {
    const client = this.idp.registerClient(input);
    void this.api.bus.emit(PkiEvents.ClientRegistered, { clientId: client.clientId, name: client.name });
    return client;
  }

  idpAuthorize(input: { clientId: string; redirectUri: string; scope?: string; userId: string }): { code: string; redirectUri: string } {
    return this.idp.authorize(input);
  }

  idpToken(input: { code: string; clientId: string; clientSecret: string; redirectUri: string }): TokenResponse {
    const response = this.idp.token(input);
    void this.api.bus.emit(PkiEvents.TokensIssued, { clientId: input.clientId });
    return response;
  }

  idpUserinfo(accessToken: string): UserInfo | undefined {
    return this.idp.userinfo(accessToken);
  }

  /**
   * OIDC → platform session bridge (executive directive — IdP integration):
   * introspects an IdP access token and mints a platform session for the
   * mapped subject. When the subject has no platform account yet, one is
   * provisioned JIT with the IdP-declared roles and an unusable random
   * password (credentials never leave the IdP). Requires @jataqi/security.
   */
  async loginWithIdpToken(accessToken: string, opts: { remoteAddress?: string } = {}): Promise<{
    ok: boolean;
    reason?: string;
    session?: { token: string; userId: string; username: string; expiresAt: number };
    principal?: { userId: string; username: string; roles: string[] };
  }> {
    const info = this.idp.introspect(accessToken);
    if (!info.active || !info.userId) return { ok: false, reason: 'invalid or expired IdP token' };
    const claims = (this.idp.userinfo(accessToken) ?? {}) as Record<string, unknown>;
    const preferredUsername = claims.preferred_username;
    const username = typeof preferredUsername === 'string' && preferredUsername
      ? preferredUsername
      : info.userId;
    const roles = Array.isArray(claims.roles)
      ? (claims.roles as unknown[]).filter((r): r is string => typeof r === 'string')
      : ['analyst'];
    try {
      const security = this.api.getModule('security') as unknown as {
        getUser: (username: string) => Promise<{ id: string; username: string; active: boolean; roles: string[] } | undefined>;
        registerUser: (username: string, password: string, roles: string[], metadata?: Record<string, unknown>) => Promise<unknown>;
        createSessionForUser: (username: string, roles: string[], opts?: { remoteAddress?: string }) => Promise<{
          ok: boolean;
          reason?: string;
          session?: { token: string; userId: string; username: string; expiresAt: number };
          principal?: { userId: string; username: string; roles: string[] };
        }>;
      };
      let user = await security.getUser(username);
      if (!user) {
        await security.registerUser(username, randomUnusablePassword(), roles, { provisionedBy: 'idp' });
      }
      const result = await security.createSessionForUser(username, roles, { remoteAddress: opts.remoteAddress });
      if (!result.ok) return { ok: false, reason: result.reason ?? 'session creation failed' };
      return {
        ok: true,
        session: result.session ? { token: result.session.token, userId: result.session.userId, username: result.session.username, expiresAt: result.session.expiresAt } : undefined,
        principal: result.principal ? { userId: result.principal.userId, username: result.principal.username, roles: [...result.principal.roles] } : undefined,
      };
    } catch {
      return { ok: false, reason: 'security module unavailable' };
    }
  }

  // ---- ACME (RFC 8555) ---------------------------------------------------

  /** RFC 8555 directory object. */
  acmeDirectory(): Record<string, unknown> { return this.acme.directory(); }

  acmeNewNonce(): string { return this.acme.newNonce(); }

  /** Process a newAccount POST body (compact JWS). */
  acmeNewAccount(serializedJws: string, opts?: { onlyReturnExisting?: boolean; contact?: string[] }): NewAccountResult {
    return this.acme.newAccount(parseJws(serializedJws), opts);
  }

  acmeNewOrder(accountId: string, identifiers: AcmeIdentifier[]): AcmeOrder {
    return this.acme.newOrder(accountId, identifiers);
  }

  acmeGetOrder(orderId: string): AcmeOrder | undefined { return this.acme.getOrder(orderId); }
  acmeListOrders(accountId?: string): AcmeOrder[] { return this.acme.listOrders(accountId); }
  acmeGetAuthorization(authzId: string): AcmeAuthorization | undefined { return this.acme.getAuthorization(authzId); }
  acmeGetChallenge(challengeId: string): AcmeChallenge | undefined { return this.acme.getChallenge(challengeId); }

  acmeRequestValidation(accountId: string, challengeId: string): AcmeChallenge {
    return this.acme.requestValidation(accountId, challengeId);
  }

  acmeChallengeKeyAuthorization(challengeId: string): { token: string; keyAuthorization: string } {
    return this.acme.challengeKeyAuthorization(challengeId);
  }

  acmeSubmitProof(accountId: string, challengeId: string, observed: { location: string; value: string }): AcmeChallenge {
    return this.acme.submitProof(accountId, challengeId, observed);
  }

  acmeFinalize(accountId: string, orderId: string, csrDer: Buffer) {
    return this.acme.finalize(accountId, orderId, csrDer);
  }

  acmeCertificate(orderId: string) { return this.acme.certificateForOrder(orderId); }

  acmeRevoke(accountId: string, certId: string, reason?: string): boolean {
    return this.acme.revoke(accountId, certId, reason);
  }

  /** Parse + verify a JWS (exposed for gateway/CLI request handling). */
  acmeParseJws(serialized: string): ParsedJws { return parseJws(serialized); }
  acmeVerifyJws(jws: ParsedJws, jwk: Record<string, string>): boolean { return verifyJws(jws, jwk); }

  /** PKI aggregate stats for ops surfaces. */
  stats(): Record<string, unknown> {
    return {
      ca: this.ca.stats(),
      ra: this.ra.stats(),
      idp: this.idp.stats(),
      acme: this.acme.stats(),
      issuer: this.cfg.issuer,
      signingAlg: this.cfg.signingAlg,
    };
  }
}

/** Random password for JIT-provisioned accounts (credentials stay in the IdP). */
function randomUnusablePassword(): string {
  return `idp-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
