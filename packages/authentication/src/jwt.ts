// P2-S1 — pinned-JWKS JWT verification core (spec §5.1.2/§5.1.3, A-15,
// A-22, A-23).
//
// ZERO new dependencies: signature verification runs on `node:crypto`
// (JWK import + RSA PKCS#1 v1.5 / ECDSA P-256). The algorithm set is a
// CLOSED allow-list (`RS256`, `ES256`):
//   * unsigned tokens (2-segment JWS, or `alg: "none"`) are rejected;
//   * HMAC variants (HS*) are rejected — this is the algorithm-confusion
//     guard: an HMAC-signed token can never be verified against the pinned
//     public key, and the allow-list refuses the request before any key
//     handling;
//   * unknown/other algorithms (PS256, ES256K, ES384, ...) are rejected.
//
// The JWKS source is PINNED: either an explicit inline JWK set (no network
// at all — staging/test doubles and operator-pinned rotations) or an exact
// configured URL fetched ONCE at construction (no redirects; an injectable
// fetcher exists so tests run hermetically — the fetcher is a test double,
// never represented as a production identity provider). Key rotation is
// operator-driven: update the pin ⇒ new boot or configuration reload.
// There is NO runtime un-pinned fetch.
//
// Error codes are closed and deterministic (the OIDC authenticator maps
// them to `PrincipalValidationError`s with the same codes).

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

/** The closed JATA Qi OIDC algorithm set (spec: RS256/ES256 only). */
export type JwtAlgorithm = 'RS256' | 'ES256';

export const DEFAULT_OIDC_ALGORITHMS: readonly JwtAlgorithm[] = Object.freeze(['RS256', 'ES256']);

/** Closed, deterministic JWT/JWKS failure codes. */
export type JwtFailureCode =
  | 'JWT_MALFORMED'
  | 'JWT_UNSECURED'
  | 'JWT_ALG_REJECTED'
  | 'JWT_KID_MISSING'
  | 'JWT_KID_UNKNOWN'
  | 'JWT_KID_NOT_PINNED'
  | 'JWT_SIGNATURE_INVALID'
  | 'JWT_CLAIMS_INVALID'
  | 'JWKS_MALFORMED'
  | 'JWKS_EMPTY'
  | 'JWKS_FETCH_FAILED'
  | 'JWKS_REJECTED_KEY';

export class JwtError extends Error {
  readonly code: JwtFailureCode;
  constructor(code: JwtFailureCode, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = 'JwtError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A JSON Web Key (public-key material only; private keys are rejected). */
export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  // RSA (RS256):
  readonly n?: string;
  readonly e?: string;
  // EC P-256 (ES256):
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  // (present but rejected: private-key material)
  readonly d?: string;
  readonly dp?: string;
  readonly dq?: string;
  readonly qi?: string;
  readonly p?: string;
  readonly q?: string;
}

/**
 * The PINNED JWKS source. `inline` = an explicit operator-pinned JWK set
 * (no network). `url` = an exact configured URL fetched once at resolution
 * (no redirects; the fetcher is injectable for hermetic tests).
 */
export type JwksSource =
  | { readonly kind: 'inline'; readonly keys: readonly Jwk[] }
  | {
      readonly kind: 'url';
      /** The exact pinned URL — verification never consults any other URL. */
      readonly url: string;
      /** Injectable fetcher (tests). Defaults to `fetch` with `redirect: 'error'`. */
      readonly fetcher?: (url: string) => Promise<string>;
      /** Optional additional pin: only these kids may be used at verification. */
      readonly acceptedKids?: readonly string[];
    };

/** The resolved, in-memory pin (fetched ONCE; no runtime re-fetch). */
export interface ResolvedJwksPin {
  readonly source: 'inline' | 'url';
  /** The pinned URL (url variant only). */
  readonly url?: string;
  /** When the pin was resolved (ms) — surfaced by `health()`. */
  readonly resolvedAt: number;
  /** kid → public KeyObject. */
  readonly keys: ReadonlyMap<string, KeyObject>;
  /** The restricted kid set (url variant with acceptedKids). */
  readonly acceptedKids?: ReadonlySet<string>;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

function decodeBase64Url(segment: string, context: string): Buffer {
  if (typeof segment !== 'string' || segment.length === 0 || !BASE64URL_PATTERN.test(segment)) {
    throw new JwtError('JWT_MALFORMED', `${context} is not valid base64url (fail-closed).`);
  }
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    throw new JwtError('JWT_MALFORMED', `${context} could not be decoded (fail-closed).`);
  }
}

/**
 * Split and decode a JWS. EXACTLY three dot-separated segments are accepted:
 * a two-segment (unsecured) token is `JWT_UNSECURED`; anything else is
 * `JWT_MALFORMED`.
 */
export function decodeJwtSections(material: string): {
  readonly signingInput: string;
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signature: Buffer;
} {
  if (typeof material !== 'string' || material.length === 0) {
    throw new JwtError('JWT_MALFORMED', 'JWT material is empty (fail-closed).');
  }
  const parts = material.split('.');
  if (parts.length === 2) {
    throw new JwtError('JWT_UNSECURED', 'an unsecured (unsigned) JWS is never accepted (fail-closed).');
  }
  if (parts.length !== 3) {
    throw new JwtError('JWT_MALFORMED', `a JWT must have exactly 3 segments (got ${parts.length}) (fail-closed).`);
  }
  const [h, p, s] = parts as [string, string, string];
  const headerBytes = decodeBase64Url(h, 'JWT header');
  const payloadBytes = decodeBase64Url(p, 'JWT payload');
  const signature = decodeBase64Url(s, 'JWT signature');
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(headerBytes.toString('utf8'));
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new JwtError('JWT_MALFORMED', 'JWT header or payload is not valid JSON (fail-closed).');
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new JwtError('JWT_MALFORMED', 'JWT header is not a JSON object (fail-closed).');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new JwtError('JWT_MALFORMED', 'JWT payload is not a JSON object (fail-closed).');
  }
  return { signingInput: `${h}.${p}`, header: header as Record<string, unknown>, payload: payload as Record<string, unknown>, signature };
}

/**
 * Verify a pinned JWK (public-key material only). Private-key fields make
 * the key unacceptable (a JWKS carrying private material is a mispinning —
 * refuse rather than parse it further).
 */
function importJwk(key: Jwk, index: number): { kid: string; algorithm: JwtAlgorithm; key: KeyObject } {
  const kid = key.kid;
  if (typeof kid !== 'string' || kid.trim().length === 0) {
    throw new JwtError('JWKS_REJECTED_KEY', `JWK[${index}] has no usable kid (fail-closed).`);
  }
  const privateKeyFields: (keyof Jwk)[] = ['d', 'dp', 'dq', 'qi', 'p', 'q'];
  if (privateKeyFields.some((field) => key[field] !== undefined)) {
    throw new JwtError('JWKS_REJECTED_KEY', `JWK[${index}] carries private-key material; only public JWKS are accepted (fail-closed).`);
  }
  const alg: unknown = key.alg;
  if (key.kty === 'RSA') {
    if (key.n === undefined || key.e === undefined) {
      throw new JwtError('JWKS_REJECTED_KEY', `JWK[${index}] (RSA) is missing n/e (fail-closed).`);
    }
    if (alg !== undefined && alg !== 'RS256') {
      throw new JwtError('JWKS_REJECTED_KEY', `JWK[${index}] (RSA) declares alg "${String(alg)}"; only RS256 is accepted (fail-closed).`);
    }
    const keyObj = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
    return { kid, algorithm: 'RS256', key: keyObj };
  }
  if (key.kty === 'EC') {
    if (key.crv !== 'P-256' || key.x === undefined || key.y === undefined) {
      throw new JwtError('JWKS_REJECTED_KEY', `JWK[${index}] (EC) must be P-256 with x/y (fail-closed).`);
    }
    if (alg !== undefined && alg !== 'ES256') {
      throw new JwtError('JWKS_REJECTED_KEY', `JWK[${index}] (EC) declares alg "${String(alg)}"; only ES256 is accepted (fail-closed).`);
    }
    const keyObj = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, format: 'jwk' });
    return { kid, algorithm: 'ES256', key: keyObj };
  }
  throw new JwtError('JWKS_REJECTED_KEY', `JWK[${index}] has unsupported kty "${String(key.kty)}" (fail-closed).`);
}

/**
 * Resolve a pinned JWKS source into an in-memory key pin. The `url` variant
 * fetches EXACTLY ONCE (no redirects; a failure rejects the resolution —
 * boot fails closed). Deterministic: the same pin input yields the same key
 * set.
 */
export async function resolveJwksPin(source: JwksSource, resolvedAt: number): Promise<ResolvedJwksPin> {
  if (!source || typeof source !== 'object' || (source.kind !== 'inline' && source.kind !== 'url')) {
    throw new JwtError('JWKS_MALFORMED', 'a JWKS pin requires kind "inline" or "url" (fail-closed).');
  }
  const keys = new Map<string, KeyObject>();
  const load = (keysJson: readonly Jwk[]): void => {
    if (!Array.isArray(keysJson) || keysJson.length === 0) {
      throw new JwtError('JWKS_EMPTY', 'the pinned JWK set is empty (fail-closed).');
    }
    for (let i = 0; i < keysJson.length; i += 1) {
      const imported = importJwk(keysJson[i], i);
      if (keys.has(imported.kid)) {
        throw new JwtError('JWKS_MALFORMED', `duplicate kid "${imported.kid}" in the pinned JWK set (fail-closed).`);
      }
      keys.set(imported.kid, imported.key);
    }
  };
  if (source.kind === 'inline') {
    load(source.keys);
    return { source: 'inline', resolvedAt, keys };
  }
  const url = source.url;
  if (typeof url !== 'string' || url.trim().length === 0 || !/^https?:\/\//i.test(url)) {
    throw new JwtError('JWKS_MALFORMED', 'the pinned JWKS URL must be an http(s) URL (fail-closed).');
  }
  const fetcher =
    source.fetcher ??
    (async (u: string): Promise<string> => {
      const response = await fetch(u, { redirect: 'error' });
      if (!response.ok) {
        throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
      }
      return response.text();
    });
  let body: string;
  try {
    body = await fetcher(url);
  } catch (error) {
    throw new JwtError('JWKS_FETCH_FAILED', `the pinned JWKS URL could not be fetched (${error instanceof Error ? error.message : String(error)}) (fail-closed).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new JwtError('JWKS_MALFORMED', 'the pinned JWKS response is not valid JSON (fail-closed).');
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { keys?: unknown }).keys)) {
    throw new JwtError('JWKS_MALFORMED', 'the pinned JWKS response is not a {keys: [...]} document (fail-closed).');
  }
  load((parsed as { keys: Jwk[] }).keys);
  return {
    source: 'url',
    url,
    resolvedAt,
    keys,
    ...(source.acceptedKids !== undefined
      ? { acceptedKids: new Set(source.acceptedKids) as ReadonlySet<string> }
      : {}),
  };
}

/**
 * ECDSA raw R||S (64 bytes on P-256) → ASN.1 DER, as `node:crypto` expects.
 * Pure and total: an invalid input yields `null` (the caller rejects).
 */
export function ecRawSignatureToDer(raw: Buffer): Buffer | null {
  if (raw.length !== 64) return null;
  const trim = (b: Buffer): Buffer => {
    let i = 0;
    while (i < b.length - 1 && b[i]! === 0) i += 1;
    let out = b.subarray(i);
    if (out.length === 0 || (out[0]! & 0x80) === 0x80) {
      out = Buffer.concat([Buffer.from([0]), out]);
    }
    return Buffer.from(out);
  };
  const r = trim(raw.subarray(0, 32));
  const s = trim(raw.subarray(32, 64));
  if (r.length === 0 || s.length === 0 || r.length > 33 || s.length > 33) return null;
  const body = Buffer.concat([
    Buffer.from([0x02, r.length]), r,
    Buffer.from([0x02, s.length]), s,
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export interface JwtVerifyOptions {
  /** The admitted algorithm set. Defaults to the closed RS256|ES256 pair. */
  readonly allowedAlgorithms?: readonly JwtAlgorithm[];
}

/**
 * Verify a JWT against a resolved pin (signature + alg + kid). Pure: no
 * clock, no claims, no I/O. Throws `JwtError` (closed codes) on ANY failure
 * — there is no degraded/permissive path.
 */
export function verifyJwt(
  material: string,
  pin: ResolvedJwksPin,
  options: JwtVerifyOptions = {},
): { readonly header: Record<string, unknown>; readonly payload: Record<string, unknown> } {
  const allowed: readonly JwtAlgorithm[] = options.allowedAlgorithms ?? DEFAULT_OIDC_ALGORITHMS;
  const { signingInput, header, payload, signature } = decodeJwtSections(material);

  const alg = header.alg;
  if (alg === 'none') {
    throw new JwtError('JWT_ALG_REJECTED', 'alg "none" (unsigned) is never accepted (fail-closed).');
  }
  if (typeof alg !== 'string' || !(allowed as readonly string[]).includes(alg)) {
    throw new JwtError(
      'JWT_ALG_REJECTED',
      `alg "${String(alg)}" is not in the admitted set [${allowed.join(',')}] (fail-closed; HMAC/other algorithms are refused — no algorithm confusion)`,
    );
  }
  const kid = header.kid;
  if (typeof kid !== 'string' || kid.trim().length === 0) {
    throw new JwtError('JWT_KID_MISSING', 'the JWT header has no usable kid (fail-closed).');
  }
  if (pin.acceptedKids !== undefined && !pin.acceptedKids.has(kid)) {
    throw new JwtError('JWT_KID_NOT_PINNED', `kid "${kid}" is not in the pinned accepted kid set (fail-closed).`);
  }
  const key = pin.keys.get(kid);
  if (!key) {
    throw new JwtError('JWT_KID_UNKNOWN', `kid "${kid}" is unknown to the pinned JWKS (fail-closed).`);
  }
  // The key's import algorithm must match the claimed alg (a pin that
  // returned an EC key for an RS256 claim — or vice versa — is refused).
  const keyIsRsa = key.asymmetricKeyType === 'rsa';
  if (alg === 'RS256' && !keyIsRsa) {
    throw new JwtError('JWT_KID_UNKNOWN', `kid "${kid}" does not hold an RSA key for RS256 (fail-closed).`);
  }
  if (alg === 'ES256' && keyIsRsa) {
    throw new JwtError('JWT_KID_UNKNOWN', `kid "${kid}" does not hold an EC P-256 key for ES256 (fail-closed).`);
  }
  let ok: boolean;
  try {
    if (alg === 'RS256') {
      ok = createVerify('RSA-SHA256').update(signingInput).end().verify(key, signature);
    } else {
      const der = ecRawSignatureToDer(signature);
      if (!der) throw new Error('invalid ES256 signature length');
      ok = createVerify('sha256').update(signingInput).end().verify(key, der);
    }
  } catch (error) {
    if (error instanceof JwtError) throw error;
    throw new JwtError('JWT_SIGNATURE_INVALID', `signature verification failed (${error instanceof Error ? error.message : String(error)}) (fail-closed).`);
  }
  if (!ok) {
    throw new JwtError('JWT_SIGNATURE_INVALID', 'the signature does not verify against the pinned key (fail-closed).');
  }
  return { header, payload };
}

// ---------------------------------------------------------------------------
// OIDC required-claim boundary (spec §5.1.4; A-02, A-15, A-22, A-26)
// ---------------------------------------------------------------------------

/**
 * The shared 300 s deny-early clock-skew bound (S-8 precedent, spec §11.5).
 * Milliseconds — the codebase `now` convention (used by the jti GC grace,
 * recovery expiry, and session skew). The JWT claims boundary (below) works
 * in RFC 7519 numericdates (epoch SECONDS) and derives its skew from this
 * constant (`OIDC_CLOCK_SKEW_SECONDS`) — one bound, two honest units.
 */
export const OIDC_CLOCK_SKEW_MS = 300_000;

/** The same shared bound in epoch seconds (JWT numericdate units). */
export const OIDC_CLOCK_SKEW_SECONDS = Math.floor(OIDC_CLOCK_SKEW_MS / 1000);

/**
 * The documented 4-case boundary table (asserted exactly in the S1 test
 * suite). Units: epoch SECONDS (RFC 7519 `exp`/`nbf`/`iat` numericdates).
 *
 *   claim = exp (expiry; deny-early `now + SKEW >= exp ⇒ DENY`):
 *     exp − now = +300  ⇒ DENY   (boundary: inside the deny-early band, inclusive)
 *     exp − now = +301  ⇒ ALLOW  (just beyond the band)
 *     exp − now = +299  ⇒ DENY   (inside the band)
 *     exp − now = −1    ⇒ DENY   (already expired)
 *
 *   claim = nbf (not-before; `nbf > now + SKEW ⇒ DENY`):
 *     nbf − now = +300  ⇒ ALLOW  (within the skew tolerance, boundary)
 *     nbf − now = +301  ⇒ DENY   (future beyond skew)
 *     nbf − now = past  ⇒ ALLOW  (already valid)
 *
 *   claim = iat (issued-at; `iat > now + SKEW ⇒ DENY`):
 *     iat − now = +300  ⇒ ALLOW  (within the skew tolerance, boundary)
 *     iat − now = +301  ⇒ DENY   (future beyond skew)
 *     iat − now = past  ⇒ ALLOW
 */

export interface OidcClaimOptions {
  /** The exact expected issuer (one issuer per authenticator). */
  readonly issuer: string;
  /** The configured audience allow-list (the token aud must be a member). */
  readonly audience: readonly string[];
  /**
   * The deny-early skew in epoch SECONDS (JWT numericdate units). Defaults
   * to the shared 300 s bound.
   */
  readonly skewSeconds?: number;
}

export type OidcClaimFailureCode =
  | 'OIDC_CLAIM_SUB_MISSING'
  | 'OIDC_CLAIM_ISS_MISMATCH'
  | 'OIDC_CLAIM_AUD_MISMATCH'
  | 'OIDC_CLAIM_EXP_MISSING'
  | 'OIDC_CLAIM_EXPIRED'
  | 'OIDC_CLAIM_NBF_MISSING'
  | 'OIDC_CLAIM_NOT_YET_VALID'
  | 'OIDC_CLAIM_IAT_MISSING'
  | 'OIDC_CLAIM_IAT_FUTURE'
  | 'OIDC_CLAIM_JTI_MISSING'
  | 'OIDC_CLAIM_AUTH_TIME_INVALID';

export interface OidcVerifiedClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: readonly string[];
  readonly exp: number;
  readonly nbf: number;
  readonly iat: number;
  readonly jti: string;
  readonly authTime?: number;
}

export type OidcClaimAssessment =
  | { readonly ok: true; readonly claims: OidcVerifiedClaims }
  | { readonly ok: false; readonly code: OidcClaimFailureCode; readonly detail: string };

function deny(code: OidcClaimFailureCode, detail: string): OidcClaimAssessment {
  return { ok: false, code, detail };
}

/**
 * The required-claim boundary — pure, deterministic, fail-closed. This is
 * the ONLY place OIDC claims are interpreted; the authenticator composes it
 * with signature verification and the durable stores. No permissive claim
 * handling exists: every missing/malformed/out-of-boundary claim denies.
 */
export function assessOidcClaims(
  payload: Record<string, unknown>,
  options: OidcClaimOptions,
  nowSeconds: number,
): OidcClaimAssessment {
  // `nowSeconds` is epoch SECONDS (RFC 7519 numericdate units) — the same
  // units as the exp/nbf/iat claims. Callers convert from the codebase
  // millisecond `now` at the boundary (OidcAuthenticator.verify).
  const now = nowSeconds;
  const skew = options.skewSeconds ?? OIDC_CLOCK_SKEW_SECONDS;

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.trim().length === 0) {
    return deny('OIDC_CLAIM_SUB_MISSING', 'the "sub" claim is missing or blank (fail-closed).');
  }

  const iss = payload.iss;
  if (typeof iss !== 'string' || iss !== options.issuer) {
    return deny('OIDC_CLAIM_ISS_MISMATCH', `the "iss" claim does not exactly match the configured issuer (fail-closed).`);
  }

  const audRaw = payload.aud;
  const aud: string[] = Array.isArray(audRaw)
    ? audRaw.filter((a): a is string => typeof a === 'string')
    : typeof audRaw === 'string'
      ? [audRaw]
      : [];
  if (aud.length === 0 || !aud.some((a) => (options.audience as readonly string[]).includes(a))) {
    return deny('OIDC_CLAIM_AUD_MISMATCH', `the "aud" claim is not in the configured audience allow-list (fail-closed).`);
  }

  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
    return deny('OIDC_CLAIM_EXP_MISSING', 'the "exp" claim is missing or invalid (fail-closed).');
  }
  // Deny-early by the shared skew bound (uniform rule, spec §11.5).
  if (now + skew >= exp) {
    return deny('OIDC_CLAIM_EXPIRED', 'the assertion is at/past its exp inside the deny-early skew band (fail-closed).');
  }

  const nbf = payload.nbf;
  if (typeof nbf !== 'number' || !Number.isFinite(nbf)) {
    return deny('OIDC_CLAIM_NBF_MISSING', 'the "nbf" claim is missing or invalid (fail-closed).');
  }
  if (nbf > now + skew) {
    return deny('OIDC_CLAIM_NOT_YET_VALID', 'the assertion is not yet valid beyond the skew bound (fail-closed).');
  }

  const iat = payload.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat) || iat < 0) {
    return deny('OIDC_CLAIM_IAT_MISSING', 'the "iat" claim is missing or invalid (fail-closed).');
  }
  if (iat > now + skew) {
    return deny('OIDC_CLAIM_IAT_FUTURE', 'the "iat" claim is in the future beyond the skew bound (fail-closed).');
  }

  const jti = payload.jti;
  if (typeof jti !== 'string' || jti.trim().length === 0) {
    return deny('OIDC_CLAIM_JTI_MISSING', 'the "jti" claim is missing or blank (fail-closed).');
  }

  let authTime: number | undefined;
  if (payload.auth_time !== undefined) {
    if (typeof payload.auth_time !== 'number' || !Number.isFinite(payload.auth_time)) {
      return deny('OIDC_CLAIM_AUTH_TIME_INVALID', 'the "auth_time" claim is present but invalid (fail-closed).');
    }
    authTime = payload.auth_time;
  }

  return {
    ok: true,
    claims: {
      sub,
      iss,
      aud,
      exp,
      nbf,
      iat,
      jti,
      ...(authTime !== undefined ? { authTime } : {}),
    },
  };
}

/**
 * A-26 (S1 level) — step-up recency: an `auth_time` older than `maxAgeMs`
 * is STALE; fresh (or exactly at the bound) is honored. The S5 challenge
 * flow builds on this check; S1 defines and tests the pair assertion.
 *
 * Units: `authTimeSeconds`/`nowSeconds` are epoch SECONDS (RFC 7519
 * `auth_time` numericdate); `maxAgeMs` is the caller's age budget in
 * MILLISECONDS (the codebase `now` convention).
 */
export function assertStepUpRecency(
  authTimeSeconds: number,
  nowSeconds: number,
  maxAgeMs: number,
): { readonly fresh: boolean; readonly ageMs: number } {
  if (typeof authTimeSeconds !== 'number' || !Number.isFinite(authTimeSeconds)) {
    throw new JwtError('JWT_CLAIMS_INVALID', 'assertStepUpRecency requires a finite auth_time (fail-closed).');
  }
  if (typeof nowSeconds !== 'number' || !Number.isFinite(nowSeconds)) {
    throw new JwtError('JWT_CLAIMS_INVALID', 'assertStepUpRecency requires a finite now (fail-closed).');
  }
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new JwtError('JWT_CLAIMS_INVALID', 'assertStepUpRecency requires a positive maxAgeMs (fail-closed).');
  }
  const ageMs = (nowSeconds - authTimeSeconds) * 1000;
  return { fresh: ageMs <= maxAgeMs, ageMs };
}
