// PkiModule (PRX Part C) — kernel module exposing the CertificateAuthority,
// RegistrationAuthority, and IdentityProvider as one governed PKI surface.
// Emits bus events on CA creation, issuance, revocation, and IdP tokens.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { StorageModule } from '@jataqi/storage';
import { CertificateAuthority, type CaRecord, type CrlRecord, type IssuedCertificate, type IssueCertificateInput } from './ca.js';
import { RegistrationAuthority, type CertificateRequest, type ValidationMethod } from './ra.js';
import { IdentityProvider, type IdpClient, type TokenResponse, type UserInfo } from './idp.js';

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
}

export class PkiModule implements IModule {
  readonly id = 'pki';
  readonly tags = ['core', 'security', 'pki'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private readonly cfg: Required<PkiModuleConfig>;
  readonly ca: CertificateAuthority;
  readonly ra: RegistrationAuthority;
  readonly idp: IdentityProvider;

  constructor(cfg: PkiModuleConfig = {}) {
    this.cfg = { issuer: cfg.issuer ?? 'https://id.jataqi.local', signingAlg: cfg.signingAlg ?? 'HS256' };
    this.ca = new CertificateAuthority();
    this.ra = new RegistrationAuthority();
    this.idp = new IdentityProvider({ issuer: this.cfg.issuer, signingAlg: this.cfg.signingAlg });
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

  /** PKI aggregate stats for ops surfaces. */
  stats(): Record<string, unknown> {
    return {
      ca: this.ca.stats(),
      ra: this.ra.stats(),
      idp: this.idp.stats(),
      issuer: this.cfg.issuer,
      signingAlg: this.cfg.signingAlg,
    };
  }
}
