// idp.ts — IdentityProvider (PRX Part C). An OIDC-lite identity provider:
// client registration, authorization-code flow, JWT ID tokens (HS256 or
// EdDSA-signed), opaque access tokens with introspection, refresh tokens,
// userinfo, and JWKS material. Composes with @jataqi/security (scrypt
// credentials) — it adds the protocol layer, not the password store.

import { createHmac, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { generateKeyPair, type KeyPair } from './x509.js';

export interface IdpClient {
  clientId: string;
  clientSecret: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  /** Bound platform user (first-party client-credentials grant). */
  userId?: string;
  createdAt: number;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  userId: string;
  expiresAt: number;
  used: boolean;
}

export interface AccessToken {
  token: string;
  clientId: string;
  userId: string;
  scope: string;
  expiresAt: number;
  type: 'access' | 'refresh';
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  [key: string]: unknown;
}

export interface UserInfo {
  sub: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  [key: string]: unknown;
}

export interface IdpConfig {
  /** Issuer identifier (e.g. https://id.jataqi.local). */
  issuer: string;
  /** Access-token lifetime in seconds (default 3600). */
  accessTokenTtlSec?: number;
  /** Authorization-code lifetime in seconds (default 600). */
  codeTtlSec?: number;
  /** Refresh-token lifetime in seconds (default 2_592_000 = 30 days). */
  refreshTokenTtlSec?: number;
  /** JWT signing algorithm: 'HS256' (default) or 'EdDSA'. */
  signingAlg?: 'HS256' | 'EdDSA';
  /** Signing key for EdDSA (generated when omitted). */
  signingKey?: KeyPair;
}

export class IdentityProvider {
  private readonly cfg: Required<Pick<IdpConfig, 'issuer' | 'accessTokenTtlSec' | 'codeTtlSec' | 'refreshTokenTtlSec' | 'signingAlg'>> & { signingKey: KeyPair | undefined };
  private clients = new Map<string, IdpClient>();
  private codes = new Map<string, AuthCode>();
  private tokens = new Map<string, AccessToken>();
  private users = new Map<string, UserInfo>();

  constructor(config: IdpConfig) {
    this.cfg = {
      issuer: config.issuer,
      accessTokenTtlSec: config.accessTokenTtlSec ?? 3600,
      codeTtlSec: config.codeTtlSec ?? 600,
      refreshTokenTtlSec: config.refreshTokenTtlSec ?? 2_592_000,
      signingAlg: config.signingAlg ?? 'HS256',
      signingKey: config.signingKey,
    };
  }

  // ---- clients -----------------------------------------------------------

  registerClient(input: { name: string; redirectUris: string[]; scopes?: string[]; userId?: string }): IdpClient {
    if (input.redirectUris.length === 0) throw new Error('at least one redirectUri is required');
    const client: IdpClient = {
      clientId: randomUUID(),
      clientSecret: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      name: input.name,
      redirectUris: [...input.redirectUris],
      scopes: input.scopes ?? ['openid', 'profile'],
      createdAt: Date.now(),
      ...(input.userId ? { userId: input.userId } : {}),
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  getClient(clientId: string): IdpClient | undefined {
    return this.clients.get(clientId);
  }

  listClients(): IdpClient[] {
    return [...this.clients.values()];
  }

  // ---- users -------------------------------------------------------------

  /** Register or update a user's profile claims (credentials live elsewhere). */
  upsertUser(userId: string, claims: Partial<UserInfo>): UserInfo {
    const existing = this.users.get(userId) ?? { sub: userId };
    const updated: UserInfo = { ...existing, ...claims, sub: userId };
    this.users.set(userId, updated);
    return updated;
  }

  // ---- authorization code flow ------------------------------------------

  /** Start authorization: returns a code for a valid client+redirect+scope. */
  authorize(input: { clientId: string; redirectUri: string; scope?: string; userId: string }): { code: string; redirectUri: string } {
    const client = this.clients.get(input.clientId);
    if (!client) throw new Error(`unknown client ${input.clientId}`);
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw new Error('redirectUri is not registered for this client');
    }
    const code: AuthCode = {
      code: randomUUID().replace(/-/g, ''),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scope: input.scope ?? 'openid',
      userId: input.userId,
      expiresAt: Date.now() + this.cfg.codeTtlSec * 1000,
      used: false,
    };
    this.codes.set(code.code, code);
    return { code: code.code, redirectUri: input.redirectUri };
  }

  /** Exchange an authorization code (with client credentials) for tokens. */
  token(input: { code: string; clientId: string; clientSecret: string; redirectUri: string }): TokenResponse {
    const code = this.codes.get(input.code);
    if (!code) throw new Error('invalid authorization code');
    if (code.used) throw new Error('authorization code already used');
    if (code.clientId !== input.clientId) throw new Error('code was issued to a different client');
    if (code.redirectUri !== input.redirectUri) throw new Error('redirectUri mismatch');
    if (Date.now() > code.expiresAt) throw new Error('authorization code expired');
    const client = this.clients.get(input.clientId);
    if (!client || client.clientSecret !== input.clientSecret) throw new Error('invalid client credentials');
    code.used = true;

    const accessToken = this.issueAccessToken(code.clientId, code.userId, code.scope);
    const refreshToken = this.issueRefreshToken(code.clientId, code.userId, code.scope);
    const idToken = this.issueIdToken({
      sub: code.userId,
      aud: code.clientId,
      scope: code.scope,
      extra: this.userClaims(code.userId),
      clientSecret: client.clientSecret,
    });

    return {
      access_token: accessToken.token,
      token_type: 'Bearer',
      expires_in: this.cfg.accessTokenTtlSec,
      id_token: idToken,
      refresh_token: refreshToken.token,
      scope: code.scope,
    };
  }

  /** Refresh an access token with a valid refresh token. */
  refresh(input: { refreshToken: string; clientId: string; clientSecret: string }): TokenResponse {
    const refreshToken = this.tokens.get(input.refreshToken);
    if (!refreshToken || refreshToken.type !== 'refresh') throw new Error('invalid refresh token');
    if (refreshToken.clientId !== input.clientId) throw new Error('refresh token was issued to a different client');
    const client = this.clients.get(input.clientId);
    if (!client || client.clientSecret !== input.clientSecret) throw new Error('invalid client credentials');
    if (Date.now() > refreshToken.expiresAt) throw new Error('refresh token expired');
    const accessToken = this.issueAccessToken(refreshToken.clientId, refreshToken.userId, refreshToken.scope);
    return {
      access_token: accessToken.token,
      token_type: 'Bearer',
      expires_in: this.cfg.accessTokenTtlSec,
      scope: refreshToken.scope,
    };
  }

  /** Validate an access token; returns claims when active. */
  introspect(token: string): { active: boolean; clientId?: string; userId?: string; scope?: string; exp?: number } {
    const record = this.tokens.get(token);
    if (!record || record.type !== 'access') return { active: false };
    if (Date.now() > record.expiresAt) return { active: false };
    return { active: true, clientId: record.clientId, userId: record.userId, scope: record.scope, exp: Math.floor(record.expiresAt / 1000) };
  }

  /** OIDC userinfo endpoint data for an active access token. */
  userinfo(token: string): UserInfo | undefined {
    const info = this.introspect(token);
    if (!info.active || !info.userId) return undefined;
    return this.userClaims(info.userId);
  }

  /** Revoke an access or refresh token. */
  revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  /**
   * OAuth2 client-credentials grant (RFC 6749 §4.4) for first-party clients
   * bound to a platform user (client.userId). The client secret is the
   * credential; returns an access token for the bound user.
   */
  clientCredentials(input: { clientId: string; clientSecret: string; scope?: string }): { access_token: string; token_type: 'Bearer'; expires_in: number; scope?: string } {
    const client = this.clients.get(input.clientId);
    if (!client || client.clientSecret !== input.clientSecret) throw new Error('invalid client credentials');
    if (!client.userId) throw new Error('client is not bound to a user');
    const token = this.issueAccessToken(client.clientId, client.userId, input.scope ?? client.scopes.join(' '));
    return {
      access_token: token.token,
      token_type: 'Bearer',
      expires_in: this.cfg.accessTokenTtlSec,
      ...(token.scope ? { scope: token.scope } : {}),
    };
  }

  /** Verify + decode a JWT ID token (returns claims or throws). */
  verifyIdToken(jwt: string): IdTokenClaims {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) throw new Error('malformed JWT');
    const alg = this.cfg.signingAlg;
    if (alg === 'EdDSA') {
      const key = this.cfg.signingKey;
      if (!key) throw new Error('no signing key configured');
      const ok = verify(null, Buffer.from(`${h}.${p}`), {
        key: createPublicKey(key.publicKey),
        dsaEncoding: 'ieee-p1363',
      }, Buffer.from(s, 'base64url'));
      if (!ok) throw new Error('invalid signature');
    } else {
      // HS256: the shared secret is the client's secret (looked up by aud).
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as IdTokenClaims;
      const client = this.clients.get(String(claims.aud));
      if (!client) throw new Error('unknown audience client');
      const expected = this.hmac(`${h}.${p}`, client.clientSecret);
      if (expected !== s) throw new Error('invalid signature');
    }
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as IdTokenClaims;
    if (claims.exp * 1000 < Date.now()) throw new Error('token expired');
    if (claims.iss !== this.cfg.issuer) throw new Error('unexpected issuer');
    return claims;
  }

  /** JWKS material (public key) for the signing key. */
  jwks(): { keys: Array<Record<string, string>> } {
    if (this.cfg.signingAlg === 'HS256') return { keys: [] };
    const key = this.cfg.signingKey;
    if (!key) return { keys: [] };
    return { keys: [{ ...key.jwk, kid: this.kid(), use: 'sig', alg: 'EdDSA' }] };
  }

  /** OIDC discovery document. */
  discovery(): Record<string, unknown> {
    return {
      issuer: this.cfg.issuer,
      authorization_endpoint: `${this.cfg.issuer}/authorize`,
      token_endpoint: `${this.cfg.issuer}/token`,
      userinfo_endpoint: `${this.cfg.issuer}/userinfo`,
      jwks_uri: `${this.cfg.issuer}/jwks`,
      introspection_endpoint: `${this.cfg.issuer}/introspect`,
      revocation_endpoint: `${this.cfg.issuer}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [this.cfg.signingAlg],
      scopes_supported: ['openid', 'profile', 'email'],
    };
  }

  stats(): { clients: number; codes: number; tokens: number; users: number } {
    return { clients: this.clients.size, codes: this.codes.size, tokens: this.tokens.size, users: this.users.size };
  }

  // ---- internals ---------------------------------------------------------

  private issueAccessToken(clientId: string, userId: string, scope: string): AccessToken {
    const token: AccessToken = {
      token: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      clientId,
      userId,
      scope,
      expiresAt: Date.now() + this.cfg.accessTokenTtlSec * 1000,
      type: 'access',
    };
    this.tokens.set(token.token, token);
    return token;
  }

  private issueRefreshToken(clientId: string, userId: string, scope: string): AccessToken {
    const token: AccessToken = {
      token: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      clientId,
      userId,
      scope,
      expiresAt: Date.now() + this.cfg.refreshTokenTtlSec * 1000,
      type: 'refresh',
    };
    this.tokens.set(token.token, token);
    return token;
  }

  private issueIdToken(input: { sub: string; aud: string; scope: string; extra?: Record<string, unknown>; clientSecret: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: IdTokenClaims = {
      iss: this.cfg.issuer,
      sub: input.sub,
      aud: input.aud,
      exp: now + this.cfg.accessTokenTtlSec,
      iat: now,
      jti: randomUUID().replace(/-/g, ''),
      ...(input.extra ?? {}),
    };
    const header = Buffer.from(JSON.stringify({ alg: this.cfg.signingAlg, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const body = `${header}.${payload}`;
    const signature = this.cfg.signingAlg === 'EdDSA'
      ? sign(null, Buffer.from(body), {
          key: createPrivateKey(this.cfg.signingKey!.privateKey),
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url')
      : this.hmac(body, input.clientSecret);
    return `${body}.${signature}`;
  }

  private hmac(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('base64url');
  }

  private userClaims(userId: string): UserInfo {
    return this.users.get(userId) ?? { sub: userId };
  }

  private kid(): string {
    return randomUUID().replace(/-/g, '').slice(0, 12);
  }
}

/** Generate an Ed25519 signing key pair for EdDSA JWT signing. */
export function generateSigningKey(): KeyPair {
  return generateKeyPair('ed25519');
}
