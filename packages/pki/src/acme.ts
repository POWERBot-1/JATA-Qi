// acme.ts — ACME (RFC 8555) directory + order/authorization/challenge
// service for the PRX Part C PKI. Composes the existing RegistrationAuthority
// proof semantics (token-at-location domain validation) and the
// CertificateAuthority for issuance. Implements the server-side of the
// protocol:
//   - replay nonces (RFC 8555 §6.5)
//   - account management with JWK identification (§7.3)
//   - orders, authorizations, and challenges (§7.4 / §7.5)
//   - JWS request verification (§6.2) with RFC 7638 key thumbprints
//   - CSR finalization + issuance via the CA (§7.4.2)
//   - certificate revocation (§7.6)
//
// HTTP framing is intentionally not included: this service exposes the
// protocol operations so any transport (the gateway, a raw HTTP server, or
// tests) can map RFC 8555 endpoints onto them.

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { CertificateAuthority, IssuedCertificate } from './ca.js';
import { parseCsr } from './csr.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcmeStatus = 'pending' | 'processing' | 'valid' | 'invalid' | 'ready' | 'revoked' | 'deactivated';

export type AcmeChallengeType = 'http-01' | 'dns-01' | 'tls-alpn-01';

export interface AcmeAccount {
  id: string;
  /** Account key (JWK) — the account is identified by its thumbprint. */
  jwk: Record<string, string>;
  contact?: string[];
  status: 'valid' | 'deactivated' | 'revoked';
  createdAt: number;
}

export interface AcmeIdentifier {
  type: 'dns';
  value: string;
}

export interface AcmeChallenge {
  id: string;
  type: AcmeChallengeType;
  url: string;
  token: string;
  status: AcmeStatus;
  validatedAt?: number;
  error?: { type: string; detail: string };
}

export interface AcmeAuthorization {
  id: string;
  identifier: AcmeIdentifier;
  status: AcmeStatus;
  challenges: AcmeChallenge[];
  expiresAt: number;
  orderId: string;
  wildcard: boolean;
}

export type AcmeOrderStatus = 'pending' | 'ready' | 'processing' | 'valid' | 'invalid';

export interface AcmeOrder {
  id: string;
  accountId: string;
  identifiers: AcmeIdentifier[];
  status: AcmeOrderStatus;
  authorizationIds: string[];
  finalizeUrl: string;
  certificateUrl?: string;
  expiresAt: number;
  notBefore?: string;
  notAfter?: string;
  error?: { type: string; detail: string };
  createdAt: number;
}

export interface AcmeError {
  type: string; // e.g. 'urn:ietf:params:acme:error:malformed'
  detail: string;
  status?: number;
}

/** A parsed + verified JWS request (compact serialization). */
export interface ParsedJws {
  protectedHeader: Record<string, unknown>;
  payload: unknown;
  /** Raw signature bytes (r||s for ES256, raw for EdDSA, PKCS#1 for RS256). */
  signature: Buffer;
  rawProtected: string;
  rawPayload: string;
}

export interface NewAccountResult {
  account: AcmeAccount;
  kid: string;
  /** True when an account with this key already existed. */
  existing: boolean;
}

export interface FinalizeResult {
  order: AcmeOrder;
  /** The issued certificate; undefined when finalization failed. */
  certificate?: IssuedCertificate;
}

export interface AcmeServiceConfig {
  /** Default validity days for issued certificates (default 90). */
  validityDays?: number;
  /** Nonce lifetime in ms (default 10 minutes). */
  nonceTtlMs?: number;
  /** Authorization expiry in ms (default 24h). */
  authzTtlMs?: number;
  /**
   * Resolves the issuing CA id for a set of identifiers. Defaults to the
   * newest intermediate CA, falling back to a root, or undefined when no
   * CA exists yet.
   */
  issuerCaId?: string;
}

export const AcmeErrorTypes = Object.freeze({
  badNonce: 'urn:ietf:params:acme:error:badNonce',
  badPublicKey: 'urn:ietf:params:acme:error:badPublicKey',
  badSignatureAlgorithm: 'urn:ietf:params:acme:error:badSignatureAlgorithm',
  malformed: 'urn:ietf:params:acme:error:malformed',
  accountDoesNotExist: 'urn:ietf:params:acme:error:accountDoesNotExist',
  orderNotReady: 'urn:ietf:params:acme:error:orderNotReady',
  unauthorized: 'urn:ietf:params:acme:error:unauthorized',
  badCSR: 'urn:ietf:params:acme:error:badCSR',
  rejectedIdentifier: 'urn:ietf:params:acme:error:rejectedIdentifier',
  rateLimited: 'urn:ietf:params:acme:error:rateLimited',
  userActionRequired: 'urn:ietf:params:acme:error:userActionRequired',
} as const);

export class AcmeErrorImpl extends Error implements AcmeError {
  readonly type: string;
  readonly detail: string;
  readonly status: number;
  constructor(type: string, detail: string, status = 400) {
    super(detail);
    this.name = 'AcmeError';
    this.type = type;
    this.detail = detail;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// RFC 7638 JWK thumbprint + keyAuthorization
// ---------------------------------------------------------------------------

/** Canonical JWK member ordering per RFC 7638 §3.2. */
function canonicalJwk(jwk: Record<string, string>): string {
  const kty = jwk.kty;
  if (kty === 'EC') {
    return JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y });
  }
  if (kty === 'RSA') {
    return JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n });
  }
  if (kty === 'OKP') {
    return JSON.stringify({ crv: jwk.crv, kty: 'OKP', x: jwk.x });
  }
  throw new AcmeErrorImpl(AcmeErrorTypes.badPublicKey, `unsupported JWK kty ${kty}`);
}

/** RFC 7638 JWK thumbprint (base64url of SHA-256). */
export function jwkThumbprint(jwk: Record<string, string>): string {
  return createHash('sha256').update(canonicalJwk(jwk)).digest('base64url');
}

/**
 * RFC 8555 §8.1 keyAuthorization = token + '.' + base64url(sha256(thumbprint)).
 * This is what the client must serve at the challenge location.
 */
export function keyAuthorization(token: string, accountJwk: Record<string, string>): string {
  return `${token}.${createHash('sha256').update(jwkThumbprint(accountJwk)).digest('base64url')}`;
}

// ---------------------------------------------------------------------------
// JWS parsing + verification (RFC 8555 §6.2, RFC 7515)
// ---------------------------------------------------------------------------

function b64urlDecode(text: string): Buffer {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Parse a compact JWS (`protected.payload.signature`). Returns the parts
 * with a decoded header/payload; signature verification is separate so the
 * account key can be resolved first.
 */
export function parseJws(serialized: string): ParsedJws {
  const parts = serialized.split('.');
  if (parts.length !== 3) {
    throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'expected a compact JWS with three parts');
  }
  const [rawProtected, rawPayload, rawSignature] = parts as [string, string, string];
  if (!rawProtected || !rawSignature) {
    throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'empty JWS part');
  }
  let protectedHeader: Record<string, unknown>;
  try {
    protectedHeader = JSON.parse(b64urlDecode(rawProtected).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'protected header is not valid JSON');
  }
  let payload: unknown = null;
  if (rawPayload.length > 0) {
    try {
      payload = JSON.parse(b64urlDecode(rawPayload).toString('utf8'));
    } catch {
      payload = b64urlDecode(rawPayload).toString('utf8');
    }
  }
  return {
    protectedHeader,
    payload,
    signature: b64urlDecode(rawSignature),
    rawProtected,
    rawPayload,
  };
}

function createKeyFromJwk(jwk: Record<string, string>) {
  try {
    return createPublicKey({ key: jwk as never, format: 'jwk' });
  } catch {
    throw new AcmeErrorImpl(AcmeErrorTypes.badPublicKey, 'account key is not a usable public key');
  }
}

/** Verify a JWS signature against an account JWK. Supports ES256/EdDSA/RS256. */
export function verifyJws(jws: ParsedJws, jwk: Record<string, string>): boolean {
  const alg = String(jws.protectedHeader['alg'] ?? '');
  const signingInput = Buffer.from(`${jws.rawProtected}.${jws.rawPayload}`, 'utf8');
  try {
    const key = createKeyFromJwk(jwk);
    if (alg === 'ES256') {
      return cryptoVerify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, jws.signature);
    }
    if (alg === 'EdDSA') {
      return cryptoVerify(null, signingInput, key, jws.signature);
    }
    if (alg === 'RS256') {
      return cryptoVerify('sha256', signingInput, key, jws.signature);
    }
    throw new AcmeErrorImpl(AcmeErrorTypes.badSignatureAlgorithm, `unsupported alg ${alg}`);
  } catch (err) {
    if (err instanceof AcmeErrorImpl) throw err;
    return false;
  }
}

// ---------------------------------------------------------------------------
// AcmeService
// ---------------------------------------------------------------------------

const NONCE_BYTES = 16;
const DEFAULT_VALIDITY_DAYS = 90;
const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_AUTHZ_TTL_MS = 24 * 60 * 60 * 1000;

export class AcmeService {
  private readonly cfg: Required<Pick<AcmeServiceConfig, 'validityDays' | 'nonceTtlMs' | 'authzTtlMs'>> & Pick<AcmeServiceConfig, 'issuerCaId'>;
  private readonly ca: CertificateAuthority;

  private nonces = new Map<string, number>(); // nonce -> createdAt
  private accounts = new Map<string, AcmeAccount>(); // id -> account
  private accountsByThumbprint = new Map<string, string>(); // thumbprint -> account id
  private orders = new Map<string, AcmeOrder>();
  private authzs = new Map<string, AcmeAuthorization>();
  private challenges = new Map<string, AcmeChallenge>();

  constructor(ca: CertificateAuthority, cfg: AcmeServiceConfig = {}) {
    this.ca = ca;
    this.cfg = {
      validityDays: cfg.validityDays ?? DEFAULT_VALIDITY_DAYS,
      nonceTtlMs: cfg.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS,
      authzTtlMs: cfg.authzTtlMs ?? DEFAULT_AUTHZ_TTL_MS,
      issuerCaId: cfg.issuerCaId,
    };
  }

  // ---- nonces (RFC 8555 §6.5) --------------------------------------------

  newNonce(): string {
    this.reapNonces();
    const nonce = randomBytes(NONCE_BYTES).toString('base64url');
    this.nonces.set(nonce, Date.now());
    return nonce;
  }

  /** Consume a nonce; returns false (and rejects) when unknown/expired/reused. */
  checkNonce(nonce: unknown): boolean {
    if (typeof nonce !== 'string') return false;
    this.reapNonces();
    const createdAt = this.nonces.get(nonce);
    if (createdAt === undefined) return false;
    this.nonces.delete(nonce);
    return true;
  }

  private reapNonces(): void {
    const now = Date.now();
    for (const [nonce, createdAt] of this.nonces) {
      if (now - createdAt > this.cfg.nonceTtlMs) this.nonces.delete(nonce);
    }
  }

  // ---- accounts (RFC 8555 §7.3) ------------------------------------------

  /**
   * Process a newAccount request. The request is JWS-signed with the
   * account key embedded in the protected header (`jwk` member) per
   * RFC 8555 §7.3.1 — there is no kid yet.
   */
  newAccount(jws: ParsedJws, opts: { onlyReturnExisting?: boolean; contact?: string[] } = {}): NewAccountResult {
    const jwk = jws.protectedHeader['jwk'];
    if (!jwk || typeof jwk !== 'object') {
      throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'newAccount requires the account JWK in the protected header');
    }
    const accountJwk = jwk as Record<string, string>;
    if (!accountJwk.kty || !accountJwk.crv && !accountJwk.n) {
      throw new AcmeErrorImpl(AcmeErrorTypes.badPublicKey, 'incomplete account JWK');
    }
    if (!verifyJws(jws, accountJwk)) {
      throw new AcmeErrorImpl(AcmeErrorTypes.unauthorized, 'JWS signature does not match the account key');
    }
    const thumbprint = jwkThumbprint(accountJwk);
    const existingId = this.accountsByThumbprint.get(thumbprint);
    if (existingId) {
      const account = this.accounts.get(existingId)!;
      return { account, kid: existingId, existing: true };
    }
    if (opts.onlyReturnExisting) {
      throw new AcmeErrorImpl(AcmeErrorTypes.accountDoesNotExist, 'no account exists for this key', 400);
    }
    const id = `acct-${randomUUID()}`;
    const account: AcmeAccount = {
      id,
      jwk: accountJwk,
      ...(opts.contact?.length ? { contact: [...opts.contact] } : {}),
      status: 'valid',
      createdAt: Date.now(),
    };
    this.accounts.set(id, account);
    this.accountsByThumbprint.set(thumbprint, id);
    return { account, kid: id, existing: false };
  }

  getAccount(kid: string): AcmeAccount | undefined {
    return this.accounts.get(kid);
  }

  listAccounts(): AcmeAccount[] {
    return [...this.accounts.values()];
  }

  setAccountStatus(kid: string, status: 'deactivated' | 'revoked'): AcmeAccount | undefined {
    const account = this.accounts.get(kid);
    if (!account) return undefined;
    account.status = status;
    return account;
  }

  // ---- orders (RFC 8555 §7.4) --------------------------------------------

  newOrder(accountId: string, identifiers: AcmeIdentifier[]): AcmeOrder {
    const account = this.accounts.get(accountId);
    if (!account || account.status !== 'valid') {
      throw new AcmeErrorImpl(AcmeErrorTypes.accountDoesNotExist, 'unknown or inactive account');
    }
    if (identifiers.length === 0) {
      throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'an order requires at least one identifier');
    }
    for (const id of identifiers) {
      if (id.type !== 'dns' || !id.value) {
        throw new AcmeErrorImpl(AcmeErrorTypes.rejectedIdentifier, `unsupported identifier ${id.type}:${id.value}`);
      }
    }
    const now = Date.now();
    const orderId = `ord-${randomUUID()}`;
    const expiresAt = now + this.cfg.authzTtlMs;
    const authorizationIds: string[] = [];
    for (const identifier of identifiers) {
      const authz = this.createAuthorization(orderId, identifier, expiresAt);
      authorizationIds.push(authz.id);
    }
    const order: AcmeOrder = {
      id: orderId,
      accountId,
      identifiers: identifiers.map((i) => ({ ...i })),
      status: 'pending',
      authorizationIds,
      finalizeUrl: `/finalize/${orderId}`,
      expiresAt,
      createdAt: now,
    };
    this.orders.set(orderId, order);
    return order;
  }

  getOrder(orderId: string): AcmeOrder | undefined {
    return this.orders.get(orderId);
  }

  listOrders(accountId?: string): AcmeOrder[] {
    const all = [...this.orders.values()];
    return accountId ? all.filter((o) => o.accountId === accountId) : all;
  }

  /** Recompute an order's status from its authorizations. */
  refreshOrder(orderId: string): AcmeOrder | undefined {
    const order = this.orders.get(orderId);
    if (!order || order.status === 'valid' || order.status === 'invalid') return order;
    const authzs = order.authorizationIds.map((id) => this.authzs.get(id));
    if (authzs.some((a) => a?.status === 'invalid')) {
      order.status = 'invalid';
      order.error = { type: AcmeErrorTypes.unauthorized, detail: 'an authorization failed validation' };
      return order;
    }
    if (authzs.every((a) => a?.status === 'valid')) order.status = 'ready';
    return order;
  }

  // ---- authorizations + challenges (RFC 8555 §7.5) -----------------------

  private createAuthorization(orderId: string, identifier: AcmeIdentifier, expiresAt: number): AcmeAuthorization {
    const authzId = `authz-${randomUUID()}`;
    const wildcard = identifier.value.startsWith('*.');
    const challenges: AcmeChallenge[] = (['http-01', 'dns-01', 'tls-alpn-01'] as AcmeChallengeType[]).map((type) => {
      const challengeId = `chal-${randomUUID()}`;
      const challenge: AcmeChallenge = {
        id: challengeId,
        type,
        url: `/challenge/${challengeId}`,
        token: randomBytes(16).toString('base64url'),
        status: 'pending',
      };
      this.challenges.set(challengeId, challenge);
      return challenge;
    });
    const authz: AcmeAuthorization = {
      id: authzId,
      identifier: { ...identifier },
      status: 'pending',
      challenges,
      expiresAt,
      orderId,
      wildcard,
    };
    this.authzs.set(authzId, authz);
    return authz;
  }

  getAuthorization(authzId: string): AcmeAuthorization | undefined {
    return this.authzs.get(authzId);
  }

  getChallenge(challengeId: string): AcmeChallenge | undefined {
    return this.challenges.get(challengeId);
  }

  /**
   * Client requests validation of a challenge (the "processing" transition).
   * The actual proof is submitted separately via submitProof — this models
   * the POST-to-challenge-URL step of RFC 8555 §7.5.1.
   */
  requestValidation(accountId: string, challengeId: string): AcmeChallenge {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'unknown challenge');
    const owner = this.ownerOfChallenge(challengeId);
    if (owner?.accountId !== accountId) {
      throw new AcmeErrorImpl(AcmeErrorTypes.unauthorized, 'challenge belongs to a different account');
    }
    if (challenge.status === 'valid') return challenge;
    challenge.status = 'processing';
    return challenge;
  }

  /** The keyAuthorization the client must present for a challenge. */
  challengeKeyAuthorization(challengeId: string): { token: string; keyAuthorization: string } {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'unknown challenge');
    const authz = this.authzs.get(this.authzIdFor(challengeId));
    const order = authz ? this.orders.get(authz.orderId) : undefined;
    const account = order ? this.accounts.get(order.accountId) : undefined;
    if (!account) throw new AcmeErrorImpl(AcmeErrorTypes.unauthorized, 'no account for challenge');
    return {
      token: challenge.token,
      keyAuthorization: keyAuthorization(challenge.token, account.jwk),
    };
  }

  /**
   * Server-side validation: the operator/client presents the observed proof
   * (the keyAuthorization found at the challenge's well-known location).
   * On success the challenge AND its authorization become valid; when all
   * authorizations of the order are valid the order becomes 'ready'.
   */
  submitProof(accountId: string, challengeId: string, observed: { location: string; value: string }): AcmeChallenge {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'unknown challenge');
    const owner = this.ownerOfChallenge(challengeId);
    if (owner?.accountId !== accountId) {
      throw new AcmeErrorImpl(AcmeErrorTypes.unauthorized, 'challenge belongs to a different account');
    }
    if (challenge.status === 'valid') return challenge;
    const expected = this.challengeKeyAuthorization(challengeId).keyAuthorization;
    // Location must reference the identifier domain (RFC 8555 §8.3/§8.4).
    const authz = this.authzs.get(this.authzIdFor(challengeId))!;
    const domainOk = observed.location.toLowerCase().includes(authz.identifier.value.replace(/^\*\./, '').toLowerCase());
    const valueOk = observed.value.trim() === expected;
    if (!domainOk || !valueOk) {
      challenge.status = 'invalid';
      challenge.error = { type: AcmeErrorTypes.unauthorized, detail: `keyAuthorization mismatch at ${observed.location}` };
      authz.status = 'invalid';
      this.refreshOrder(authz.orderId);
      return challenge;
    }
    challenge.status = 'valid';
    challenge.validatedAt = Date.now();
    authz.status = 'valid';
    this.refreshOrder(authz.orderId);
    return challenge;
  }

  private authzIdFor(challengeId: string): string {
    for (const [id, authz] of this.authzs) {
      if (authz.challenges.some((c) => c.id === challengeId)) return id;
    }
    return '';
  }

  private ownerOfChallenge(challengeId: string): AcmeOrder | undefined {
    const authzId = this.authzIdFor(challengeId);
    if (!authzId) return undefined;
    const authz = this.authzs.get(authzId);
    return authz ? this.orders.get(authz.orderId) : undefined;
  }

  // ---- finalize (RFC 8555 §7.4.2) ----------------------------------------

  /**
   * Finalize an order with a DER PKCS#10 CSR. The CSR must be signed by the
   * subject key, and its identifiers must cover the order's identifiers.
   * On success the CA issues the certificate and the order becomes 'valid'.
   */
  finalize(accountId: string, orderId: string, csrDer: Buffer): FinalizeResult {
    const order = this.orders.get(orderId);
    if (!order) throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'unknown order');
    if (order.accountId !== accountId) throw new AcmeErrorImpl(AcmeErrorTypes.unauthorized, 'order belongs to a different account');
    this.refreshOrder(orderId);
    if (order.status !== 'ready') {
      throw new AcmeErrorImpl(AcmeErrorTypes.orderNotReady, `order is ${order.status}, expected ready`, 403);
    }
    let csr: ReturnType<typeof parseCsr>;
    try {
      csr = parseCsr(csrDer);
    } catch (err) {
      order.status = 'invalid';
      order.error = { type: AcmeErrorTypes.badCSR, detail: (err as Error).message };
      return { order, certificate: undefined };
    }
    if (!csr.signatureValid) {
      order.status = 'invalid';
      order.error = { type: AcmeErrorTypes.badCSR, detail: 'CSR signature does not match the subject key' };
      return { order, certificate: undefined };
    }
    // Identifier coverage: every order identifier must be in the CSR SANs.
    const sans = new Set(csr.dnsNames.map((d) => d.toLowerCase()));
    for (const identifier of order.identifiers) {
      const value = identifier.value.toLowerCase();
      const covered = sans.has(value) || (value.startsWith('*.') && sans.has(value.slice(2)));
      if (!covered) {
        order.status = 'invalid';
        order.error = { type: AcmeErrorTypes.badCSR, detail: `CSR does not cover identifier ${identifier.value}` };
        return { order, certificate: undefined };
      }
    }
    // Issue through the CA.
    const issuerCaId = this.resolveIssuerCa();
    if (!issuerCaId) {
      order.status = 'invalid';
      order.error = { type: AcmeErrorTypes.unauthorized, detail: 'no issuing CA configured' };
      return { order, certificate: undefined };
    }
    order.status = 'processing';
    const subject = [{ oid: '2.5.4.3', value: csr.commonName ?? csr.dnsNames[0] ?? order.identifiers[0]!.value }];
    const certificate = this.ca.issue({
      caId: issuerCaId,
      subject,
      sanDnsNames: csr.dnsNames,
      subjectPublicKeyJwk: csr.publicKeyJwk,
      validityDays: this.cfg.validityDays,
      extendedKeyUsage: ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'],
    });
    order.status = 'valid';
    order.certificateUrl = `/certificate/${orderId}`;
    return { order, certificate };
  }

  certificateForOrder(orderId: string): IssuedCertificate | undefined {
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'valid') return undefined;
    // The certificate is the most recently issued cert for this order's CN;
    // look it up by matching the last-issued certificate of the order.
    return this.lastIssuedForOrder(order);
  }

  private lastIssuedForOrder(order: AcmeOrder): IssuedCertificate | undefined {
    // The CA issues sequentially; the certificate for an order is the newest
    // issued certificate whose SANs cover the order's identifiers.
    const candidates = this.ca.list().filter((c) => {
      const sans = c.sanDnsNames.map((d) => d.toLowerCase());
      return order.identifiers.every((i) => sans.includes(i.value.toLowerCase()) || (i.value.startsWith('*.') && sans.includes(i.value.slice(2))));
    });
    return candidates.sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** Revoke a certificate by id (RFC 8555 §7.6). */
  revoke(accountId: string, certId: string, reason?: string): boolean {
    const cert = this.ca.get(certId);
    if (!cert) throw new AcmeErrorImpl(AcmeErrorTypes.malformed, 'unknown certificate');
    // The account must own the order that produced this certificate.
    const owner = [...this.orders.values()].find((o) => o.certificateUrl && this.lastIssuedForOrder(o)?.id === certId);
    if (owner && owner.accountId !== accountId) {
      throw new AcmeErrorImpl(AcmeErrorTypes.unauthorized, 'certificate belongs to a different account');
    }
    this.ca.revoke(certId, reason ?? 'unspecified');
    return true;
  }

  // ---- directory (RFC 8555 §7.1.1) ---------------------------------------

  directory(): Record<string, unknown> {
    return {
      newNonce: '/new-nonce',
      newAccount: '/new-account',
      newOrder: '/new-order',
      revokeCert: '/revoke-cert',
      keyChange: '/key-change',
      meta: {
        termsOfService: 'https://jataqi.local/terms',
        website: 'https://jataqi.local',
        caaIdentities: ['jataqi.local'],
        externalAccountRequired: false,
        profiles: { default: { description: 'Default ACME profile' } },
      },
    };
  }

  stats(): { nonces: number; accounts: number; orders: number; authorizations: number; challenges: number } {
    return {
      nonces: this.nonces.size,
      accounts: this.accounts.size,
      orders: this.orders.size,
      authorizations: this.authzs.size,
      challenges: this.challenges.size,
    };
  }

  private resolveIssuerCa(): string | undefined {
    if (this.cfg.issuerCaId && this.ca.getCa(this.cfg.issuerCaId)) return this.cfg.issuerCaId;
    const intermediates = this.ca.listCas('intermediate');
    if (intermediates.length > 0) {
      return intermediates.sort((a, b) => b.createdAt - a.createdAt)[0]!.id;
    }
    const roots = this.ca.listCas('root');
    return roots.length > 0 ? roots[0]!.id : undefined;
  }
}
