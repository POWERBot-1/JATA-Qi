// P2-S1 — provider-neutral OIDC authentication boundary (spec §5; A-01, A-02,
// A-03, A-06, A-15, A-22, A-23, A-26) over real PostgreSQL.
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS (no skip).
//
// Covered:
//   * the pinned-JWKS JWT core (node:crypto only): unsecured/`none`/
//     algorithm-confusion/wrong-kid/wrong-key/signature-tamper refusal;
//     RS256 + ES256 verification; private-key JWK refusal; URL pin fetched
//     exactly once (injectable fetcher — an honest double, never a live IdP);
//   * the required-claim boundary (exact failure codes) and the 4-case
//     deny-early skew table (asserted at the exact second boundary);
//   * the authenticator pipeline: signature FIRST (A-15 store-read counter),
//     server-side tenant derivation (A-06 forged tenant claim ignored),
//     unknown-subject refusal (A-06), ENROLLED/SUSPENDED activation,
//     terminal refusal, role narrowing, empty-effective-roles refusal;
//   * durable jti replay (A-01), static-token revocation mid-session (A-03,
//     S1 authentication site), duplicate-submission insert-once (A-23),
//     closed-schema/material refusal (A-22), step-up recency (A-26),
//     ProductionAuthenticatorContract conformance.
//
// The token material is signed with locally generated RSA/EC keys against a
// locally pinned JWKS: an honest test double of a provider-signed assertion.
// No external identity provider is activated, contacted, or required.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Jwk } from '../src/index.js';
import { StorageModule } from '@jataqi/storage';
import {
  assertIdentityDocumentShape,
  assessOidcClaims,
  assertStepUpRecency,
  AuthenticationEventStore,
  decodeJwtSections,
  IdentityStore,
  IdentityStoreError,
  JtiReplayStore,
  JwtError,
  OidcAuthenticator,
  OidcAuthenticatorError,
  AutoLinkedStaticTokenAuthenticator,
  StaticTokenAuthenticator,
  TokenRegistryStore,
  OIDC_CLOCK_SKEW_SECONDS,
  resolveJwksPin,
  verifyJwt,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

let pg: R2Postgres;
let storage: StorageModule;
let identity: IdentityStore;
let jti: JtiReplayStore;
let tokens: TokenRegistryStore;

const T0_MS = Date.now();
const T0_S = Math.floor(T0_MS / 1000);
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;

const ISSUER = 'https://idp.example.com/realms/jataqi';
const AUDIENCE = 'jataqi-api';
const TENANT = 'acme';

before(async () => {
  pg = await bootR2Postgres('p2s1oidc', 59500);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  identity = await IdentityStore.open(storage);
  jti = await JtiReplayStore.open(storage);
  tokens = await TokenRegistryStore.open(storage);
});

after(async () => {
  await pg.stop();
});

// ---------------------------------------------------------------------------
// Key + token fixtures (honest local doubles; no external IdP)
// ---------------------------------------------------------------------------

interface KeyFixture {
  privateKey: KeyObject;
  publicJwk: Jwk;
  kid: string;
  alg: 'RS256' | 'ES256';
}

function rsaFixture(): KeyFixture {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Jwk;
  return { privateKey, publicJwk: { ...jwk, kty: 'RSA', kid: 'rsa-key-1', alg: 'RS256' }, kid: 'rsa-key-1', alg: 'RS256' };
}

function ecFixture(): KeyFixture {
  // P-256 via ECDH (the only P-256 generator in node:crypto), exported as
  // DER and re-imported as KeyObjects.
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const ecdhAny = ecdh as unknown as { getPublicKeyDER: (f: string) => Buffer; getPrivateKeyDER: (f: string) => Buffer };
  const publicKey = createPublicKey({ key: ecdhAny.getPublicKeyDER('spki'), format: 'der', type: 'spki' });
  const privateKey = createPrivateKey({ key: ecdhAny.getPrivateKeyDER('sec1'), format: 'der', type: 'sec1' });
  const jwk = publicKey.export({ format: 'jwk' }) as Jwk;
  return { privateKey, publicJwk: { ...jwk, kty: 'EC', crv: 'P-256', kid: 'ec-key-1', alg: 'ES256' }, kid: 'ec-key-1', alg: 'ES256' };
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

function signJwt(
  fixture: KeyFixture,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature =
    fixture.alg === 'RS256'
      ? cryptoSign('sha256', Buffer.from(signingInput), fixture.privateKey)
      : cryptoSign(null, Buffer.from(signingInput), { key: fixture.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

/** A claims-valid assertion (fresh, correct iss/aud, unique jti). */
function validClaims(nowS: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: `sub-${nextId('t')}`,
    iss: ISSUER,
    aud: AUDIENCE,
    exp: nowS + 3_600,
    nbf: nowS - 60,
    iat: nowS - 60,
    jti: nextId('jti'),
    ...overrides,
  };
}

function makeAuthenticator(fixture: KeyFixture, overrides: { identityStore?: IdentityStore; jtiReplay?: JtiReplayStore } = {}): Promise<OidcAuthenticator> {
  return OidcAuthenticator.create({
    issuer: ISSUER,
    audience: [AUDIENCE],
    jwks: { kind: 'inline', keys: [fixture.publicJwk] },
    identityStore: overrides.identityStore ?? identity,
    jtiReplay: overrides.jtiReplay ?? jti,
  });
}

describe('P2-S1 OIDC boundary: pinned-JWKS JWT core (no PG needed)', () => {
  const rsa = rsaFixture();
  const ec = ecFixture();

  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S1 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('refuses unsecured (2-part) and malformed tokens', () => {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: rsa.kid }));
    const payload = b64url(JSON.stringify(validClaims(T0_S)));
    assert.throws(() => decodeJwtSections(`${header}.${payload}`), (e: unknown) => e instanceof JwtError && e.code === 'JWT_UNSECURED', 'a 2-part token is unsecured');
    assert.throws(() => decodeJwtSections(`${header}.${payload}.sig.extra`), (e: unknown) => e instanceof JwtError, 'a 4-part token is malformed');
    assert.throws(() => decodeJwtSections('not-a-jwt'), (e: unknown) => e instanceof JwtError);
  });

  it('verifies RS256 and ES256 against the pinned keys; refuses a tampered signature', async () => {
    const pin = await resolveJwksPin({ kind: 'inline', keys: [rsa.publicJwk, ec.publicJwk] }, T0_MS);
    const claims = validClaims(T0_S);
    const rsaToken = signJwt(rsa, { alg: 'RS256', kid: rsa.kid, typ: 'JWT' }, claims);
    const esToken = signJwt(ec, { alg: 'ES256', kid: ec.kid, typ: 'JWT' }, validClaims(T0_S));
    const rsaOut = verifyJwt(rsaToken, pin);
    assert.equal(rsaOut.payload.sub, claims.sub, 'RS256 verifies against the pinned RSA key');
    verifyJwt(esToken, pin); // ES256 verifies against the pinned EC key
    // Tamper: re-encode with a changed claim, keep the old signature.
    const tampered = `${b64url(JSON.stringify({ alg: 'RS256', kid: rsa.kid }))}.${b64url(JSON.stringify({ ...claims, sub: 'attacker' }))}.${b64url(Buffer.from([0]))}`;
    assert.throws(() => verifyJwt(tampered, pin), (e: unknown) => e instanceof JwtError && e.code === 'JWT_SIGNATURE_INVALID');
  });

  it('refuses alg "none", HMAC algorithms (confusion), wrong keys, unknown/missing kids', async () => {
    const pin = await resolveJwksPin({ kind: 'inline', keys: [rsa.publicJwk] }, T0_MS);
    const claims = validClaims(T0_S);
    // alg none (unsigned) — refused even though "verifiable" trivially.
    const noneToken = `${b64url(JSON.stringify({ alg: 'none', kid: rsa.kid }))}.${b64url(JSON.stringify(claims))}.`;
    assert.throws(() => verifyJwt(noneToken, pin), (e: unknown) => e instanceof JwtError && e.code === 'JWT_ALG_REJECTED');
    // HS256 (algorithm confusion) — an HMAC alg is never admitted.
    const hsToken = `${b64url(JSON.stringify({ alg: 'HS256', kid: rsa.kid }))}.${b64url(JSON.stringify(claims))}.${b64url('x')}`;
    assert.throws(() => verifyJwt(hsToken, pin), (e: unknown) => e instanceof JwtError && e.code === 'JWT_ALG_REJECTED');
    // Wrong key: signed by the EC key but the kid claims the RSA key.
    const wrongKey = signJwt(ec, { alg: 'ES256', kid: rsa.kid }, validClaims(T0_S));
    assert.throws(() => verifyJwt(wrongKey, pin), (e: unknown) => e instanceof JwtError && (e as JwtError).code === 'JWT_KID_UNKNOWN', 'key-type/alg cross-check refuses an EC key under an RSA kid');
    const unknownKid = signJwt(rsa, { alg: 'RS256', kid: 'not-pinned' }, validClaims(T0_S));
    assert.throws(() => verifyJwt(unknownKid, pin), (e: unknown) => e instanceof JwtError && e.code === 'JWT_KID_UNKNOWN');
    const noKid = `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.${b64url('x')}`;
    assert.throws(() => verifyJwt(noKid, pin), (e: unknown) => e instanceof JwtError && e.code === 'JWT_KID_MISSING');
  });

  it('resolveJwksPin: inline + URL (fetched exactly once; honest double) + refusals', async () => {
    // Inline pin.
    const inline = await resolveJwksPin({ kind: 'inline', keys: [rsa.publicJwk] }, T0_MS);
    assert.equal(inline.keys.size, 1);
    // URL pin with an INJECTABLE fetcher: fetched exactly once, no redirects.
    let fetches = 0;
    const urlPin = await resolveJwksPin(
      {
        kind: 'url',
        url: 'https://idp.example.com/.well-known/jwks.json',
        fetcher: async (u: string) => {
          fetches += 1;
          assert.equal(u, 'https://idp.example.com/.well-known/jwks.json');
          return JSON.stringify({ keys: [rsa.publicJwk] });
        },
      },
      T0_MS,
    );
    assert.equal(fetches, 1, 'the URL pin fetches exactly once at construction');
    assert.equal(urlPin.url, 'https://idp.example.com/.well-known/jwks.json');
    // A second construction fetches once MORE (per-boot pin — never at verification time).
    let fetches2 = 0;
    await resolveJwksPin({ kind: 'url', url: 'https://idp.example.com/.well-known/jwks.json', fetcher: async () => { fetches2 += 1; return JSON.stringify({ keys: [rsa.publicJwk] }); } }, T0_MS);
    assert.equal(fetches2, 1);
    // Private-key material in a JWK is refused (only public JWKS).
    const privateJwk: Jwk = { ...rsa.publicJwk, d: 'private-material' };
    await assert.rejects(() => resolveJwksPin({ kind: 'inline', keys: [privateJwk] }, T0_MS), (e: unknown) => e instanceof JwtError && e.code === 'JWKS_REJECTED_KEY');
    // Empty set refused.
    await assert.rejects(() => resolveJwksPin({ kind: 'inline', keys: [] }, T0_MS), (e: unknown) => e instanceof JwtError && e.code === 'JWKS_EMPTY');
    // Non-http(s) URL refused.
    await assert.rejects(() => resolveJwksPin({ kind: 'url', url: 'file:///etc/passwd' }, T0_MS), (e: unknown) => e instanceof JwtError && e.code === 'JWKS_MALFORMED');
    // Fetch failure rejects the resolution (boot fails closed).
    await assert.rejects(
      () => resolveJwksPin({ kind: 'url', url: 'https://idp.example.com/.well-known/jwks.json', fetcher: async () => { throw new Error('ECONNREFUSED'); } }, T0_MS),
      (e: unknown) => e instanceof JwtError && e.code === 'JWKS_FETCH_FAILED',
    );
  });

  it('claim table: every missing/invalid claim denies with its exact code (A-03/A-15 inputs)', () => {
    const opts = { issuer: ISSUER, audience: [AUDIENCE] };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['sub missing', { ...validClaims(T0_S), sub: undefined }, 'OIDC_CLAIM_SUB_MISSING'],
      ['sub blank', { ...validClaims(T0_S), sub: '   ' }, 'OIDC_CLAIM_SUB_MISSING'],
      ['iss mismatch', { ...validClaims(T0_S), iss: 'https://evil.example.com' }, 'OIDC_CLAIM_ISS_MISMATCH'],
      ['aud not allowed', { ...validClaims(T0_S), aud: 'other-api' }, 'OIDC_CLAIM_AUD_MISMATCH'],
      ['aud array none allowed', { ...validClaims(T0_S), aud: ['a', 'b'] }, 'OIDC_CLAIM_AUD_MISMATCH'],
      ['exp missing', { ...validClaims(T0_S), exp: undefined }, 'OIDC_CLAIM_EXP_MISSING'],
      ['nbf missing', { ...validClaims(T0_S), nbf: undefined }, 'OIDC_CLAIM_NBF_MISSING'],
      ['iat missing', { ...validClaims(T0_S), iat: undefined }, 'OIDC_CLAIM_IAT_MISSING'],
      ['jti missing', { ...validClaims(T0_S), jti: undefined }, 'OIDC_CLAIM_JTI_MISSING'],
      ['auth_time invalid', { ...validClaims(T0_S), auth_time: 'soon' }, 'OIDC_CLAIM_AUTH_TIME_INVALID'],
    ];
    for (const [name, payload, code] of cases) {
      const cleaned = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
      const result = assessOidcClaims(cleaned, opts, T0_S);
      assert.equal(result.ok, false, `${name} must deny`);
      assert.equal((result as { code: string }).code, code, `${name} → exact code`);
    }
    // The happy path (incl. aud as an array containing the allowed audience).
    const ok = assessOidcClaims(validClaims(T0_S, { aud: [AUDIENCE, 'other'] }), opts, T0_S);
    assert.equal(ok.ok, true, 'a fully valid assertion is admitted');
  });

  it('A-02: the 4-case deny-early skew table holds at the EXACT second boundary', () => {
    const opts = { issuer: ISSUER, audience: [AUDIENCE] };
    const base = validClaims(T0_S);
    const SKEW = OIDC_CLOCK_SKEW_SECONDS;
    assert.equal(SKEW, 300, 'the shared skew bound is 300 s');
    // exp: deny-early `now + SKEW >= exp ⇒ DENY` (boundary INCLUSIVE).
    assert.equal(assessOidcClaims(base, opts, T0_S).ok, true, 'sanity: a 3600 s-lived assertion is fresh');
    const expAt = (delta: number): boolean => {
      const r = assessOidcClaims({ ...base, exp: T0_S + delta }, opts, T0_S);
      return r.ok ? true : r.code === 'OIDC_CLAIM_EXPIRED' ? false : false;
    };
    assert.equal(expAt(+SKEW), false, `exp = now+${SKEW} (boundary) ⇒ DENY`);
    assert.equal(expAt(+SKEW + 1), true, `exp = now+${SKEW + 1} (just beyond) ⇒ ALLOW`);
    assert.equal(expAt(+SKEW - 1), false, `exp = now+${SKEW - 1} (inside band) ⇒ DENY`);
    assert.equal(expAt(-1), false, 'exp = now−1 (expired) ⇒ DENY');
    // nbf: `nbf > now + SKEW ⇒ DENY` (boundary allows at exactly +SKEW).
    const nbfAt = (delta: number): boolean => {
      const r = assessOidcClaims({ ...base, nbf: T0_S + delta }, opts, T0_S);
      if (r.ok) return true;
      return r.code === 'OIDC_CLAIM_NOT_YET_VALID' ? false : false;
    };
    assert.equal(nbfAt(+SKEW), true, `nbf = now+${SKEW} (boundary) ⇒ ALLOW`);
    assert.equal(nbfAt(+SKEW + 1), false, `nbf = now+${SKEW + 1} ⇒ DENY (future beyond skew)`);
    assert.equal(nbfAt(-60), true, 'nbf in the past ⇒ ALLOW');
    // iat: `iat > now + SKEW ⇒ DENY`.
    const iatAt = (delta: number): boolean => {
      const r = assessOidcClaims({ ...base, iat: T0_S + delta }, opts, T0_S);
      if (r.ok) return true;
      return r.code === 'OIDC_CLAIM_IAT_FUTURE' ? false : false;
    };
    assert.equal(iatAt(+SKEW), true, `iat = now+${SKEW} (boundary) ⇒ ALLOW`);
    assert.equal(iatAt(+SKEW + 1), false, `iat = now+${SKEW + 1} ⇒ DENY (future beyond skew)`);
    assert.equal(iatAt(-60), true, 'iat in the past ⇒ ALLOW');
  });

  it('A-26: step-up recency — fresh (incl. exact boundary) honored, stale refused', () => {
    const maxAgeMs = 60_000;
    const fresh = assertStepUpRecency(T0_S - 60, T0_S, maxAgeMs);
    assert.equal(fresh.fresh, true, 'auth_time exactly at the maxAge boundary is fresh');
    const stale = assertStepUpRecency(T0_S - 61, T0_S, maxAgeMs);
    assert.equal(stale.fresh, false, 'auth_time one second beyond the bound is stale');
    assert.equal(stale.ageMs, 61_000, 'the age is reported in milliseconds');
    assert.throws(() => assertStepUpRecency(NaN, T0_S, maxAgeMs), JwtError);
    assert.throws(() => assertStepUpRecency(T0_S, T0_S, 0), JwtError);
  });
});

describe('P2-S1 OIDC boundary: the authenticator (real PostgreSQL)', () => {
  const rsa = rsaFixture();
  let authenticator: OidcAuthenticator;
  let subject: string;
  let principalId: string;

  // A-15: the store-read counter — identity state must NOT be read before the
  // claims stage (wrong iss/aud must not probe identity existence).
  let storeReads = 0;
  let origFindBySubject: IdentityStore['findBySubject'];
  let origGetPrincipal: IdentityStore['getPrincipal'];

  before(async () => {
    authenticator = await makeAuthenticator(rsa);
    subject = `sub-${nextId('main')}`;
    principalId = nextId('p');
    await identity.enroll(
      { principalId, tenantId: TENANT, roles: ['operator', 'agent'], enrolledBy: 'admin:setup', issuer: ISSUER, subject },
      T0_MS,
    );
    origFindBySubject = identity.findBySubject.bind(identity);
    origGetPrincipal = identity.getPrincipal.bind(identity);
    identity.findBySubject = (async (issuer: string, s: string) => {
      storeReads += 1;
      return origFindBySubject(issuer, s);
    }) as IdentityStore['findBySubject'];
    identity.getPrincipal = (async (pid: string, tenantId: string) => {
      storeReads += 1;
      return origGetPrincipal(pid, tenantId);
    }) as IdentityStore['getPrincipal'];
  });

  after(async () => {
    if (origFindBySubject) {
      identity.findBySubject = origFindBySubject;
      identity.getPrincipal = origGetPrincipal;
    }
  });

  it('A-06: an unknown subject authenticates to NOTHING (no default tenant)', async () => {
    const token = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(Math.floor(Date.now() / 1000), { sub: `unknown-${nextId('x')}` }));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: token }, Date.now(), nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'IDENTITY_NOT_ENROLLED',
    );
  });

  it('A-15: wrong iss and wrong aud deny at the claims stage BEFORE any store read', async () => {
    storeReads = 0;
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    const wrongIss = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(nowS, { iss: 'https://evil.example.com' }));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: wrongIss }, nowMs, nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'OIDC_CLAIM_ISS_MISMATCH',
    );
    const wrongAud = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(Math.floor(Date.now() / 1000), { aud: 'other-api' }));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: wrongAud }, Date.now(), nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'OIDC_CLAIM_AUD_MISMATCH',
    );
    assert.equal(storeReads, 0, 'no identity store read occurred before the claims-stage denial');
  });

  it('ENROLLED → ACTIVATED: a fresh verification is the activation evidence', async () => {
    const token = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(Math.floor(Date.now() / 1000), { sub: subject }));
    const principal = await authenticator.verify({ method: 'OIDC', material: token }, Date.now(), nextId('req'));
    assert.equal(principal.id, principalId);
    assert.equal(principal.tenantId, TENANT, 'the tenant comes from the server-side mapping');
    assert.equal(principal.authenticationMethod, 'OIDC');
    const doc = (await identity.getPrincipal(principalId, TENANT))!;
    assert.equal(doc.state, 'ACTIVATED', 'the ENROLLED identity activated on first verification');
    const events = await identity.queryEvents(TENANT, 'AUTH_LOGIN');
    assert.ok(events.some((e) => e.principalId === principalId), 'the AUTH_LOGIN event is durably recorded');
  });

  it('SUSPENDED → ACTIVATED: re-activation on fresh verification', async () => {
    await identity.suspend(principalId, TENANT, 'test suspension', Date.now());
    const token = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(Math.floor(Date.now() / 1000), { sub: subject }));
    const principal = await authenticator.verify({ method: 'OIDC', material: token }, Date.now(), nextId('req'));
    assert.equal((await identity.getPrincipal(principalId, TENANT))!.state, 'ACTIVATED', 'the suspended identity re-activated');
    assert.ok(principal.roles.length > 0);
  });

  it('A-01: the same assertion (same jti) presented twice — the 2nd is a REPLAY', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const claims = validClaims(nowS, { sub: subject });
    const token = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, claims);
    await authenticator.verify({ method: 'OIDC', material: token }, Date.now(), nextId('req'));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: token }, Date.now() + 1, nextId('req2')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'JTI_REPLAY_DETECTED',
      'the second presentation of the same jti is a durable replay refusal',
    );
  });

  it('A-02 (authenticator): exp inside the deny-early band denies; just beyond admits', async () => {
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    const inside = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(nowS, { sub: subject, exp: nowS + OIDC_CLOCK_SKEW_SECONDS }));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: inside }, nowMs, nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'OIDC_CLAIM_EXPIRED',
      'exp at the deny-early boundary (now+300s) is refused',
    );
    const beyond = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(nowS, { sub: subject, exp: nowS + OIDC_CLOCK_SKEW_SECONDS + 1 }));
    const principal = await authenticator.verify({ method: 'OIDC', material: beyond }, nowMs, nextId('req'));
    assert.equal(principal.tenantId, TENANT, 'exp just beyond the boundary (now+301s) admits');
  });

  it('A-06: a forged tenant claim in the assertion is IGNORED (server-side mapping wins)', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const token = signJwt(
      rsa,
      { alg: 'RS256', kid: rsa.kid },
      validClaims(nowS, { sub: subject, tenant_id: 'evil-tenant', tid: 'evil-tenant' }),
    );
    const principal = await authenticator.verify({ method: 'OIDC', material: token }, Date.now(), nextId('req'));
    assert.equal(principal.tenantId, TENANT, 'the tenant is derived server-side; forged claims are ignored');
  });

  it('role narrowing: asserted roles ∩ assigned (never widened); invalid/system roles refuse', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    // Assert a SUBSET: only the asserted roles are returned.
    const subset = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(nowS, { sub: subject, roles: ['agent'] }));
    const p1 = await authenticator.verify({ method: 'OIDC', material: subset }, Date.now(), nextId('req'));
    assert.deepEqual(p1.roles, ['agent'], 'the effective roles are asserted ∩ assigned');
    // An unknown role refuses (the assertion cannot mint roles).
    const unknown = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(Math.floor(Date.now() / 1000), { sub: subject, roles: ['wizard'] }));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: unknown }, Date.now(), nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'OIDC_CLAIM_ROLES_INVALID',
    );
    // The kernel-internal `system` role can never be asserted from the wire.
    const system = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(Math.floor(Date.now() / 1000), { sub: subject, roles: ['system'] }));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: system }, Date.now(), nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'OIDC_CLAIM_ROLES_INVALID',
    );
    // A disjoint assertion ⇒ no effective roles ⇒ refuse (a role-less principal cannot authenticate).
    const disjoint = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(Math.floor(Date.now() / 1000), { sub: subject, roles: ['observer'] }));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: disjoint }, Date.now(), nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'NO_EFFECTIVE_ROLES',
    );
  });

  it('terminal identities cannot authenticate (no re-enable)', async () => {
    const pid = nextId('term');
    const sub = `sub-${nextId('term')}`;
    await identity.enroll({ principalId: pid, tenantId: TENANT, roles: ['observer'], enrolledBy: 'admin:setup', issuer: ISSUER, subject: sub }, Date.now());
    await identity.activate(pid, TENANT, { authenticationEventId: 't', method: 'OIDC' }, Date.now() + 1);
    await identity.suspend(pid, TENANT, 'review', Date.now() + 2);
    await identity.deactivate(pid, TENANT, 'termination', Date.now() + 3);
    await identity.deprovision(pid, TENANT, 'termination', Date.now() + 4);
    const nowS = Math.floor(Date.now() / 1000);
    const token = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(nowS, { sub }));
    await assert.rejects(
      () => authenticator.verify({ method: 'OIDC', material: token }, Date.now(), nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'IDENTITY_STATE_INACTIVE',
    );
  });

  it('wrong-key signatures refuse with JWT_SIGNATURE_INVALID (same kid, different key — never an identity probe)', async () => {
    const other = rsaFixture();
    // Same kid string, different key: the pin holds `other`'s RSA key under
    // kid 'rsa-key-1'; the assertion is signed by `rsa` under that kid. The
    // kid resolves but the signature cannot verify ⇒ signature-stage refusal.
    const pinAuth = await makeAuthenticator(other);
    const nowS = Math.floor(Date.now() / 1000);
    const forged = signJwt(rsa, { alg: 'RS256', kid: rsa.kid }, validClaims(nowS, { sub: subject }));
    let readsBefore: number;
    {
      // (The authenticator owns its store refs; the counter below is only
      // meaningful for the main authenticator — assert the refusal code.)
      readsBefore = storeReads;
    }
    await assert.rejects(
      () => pinAuth.verify({ method: 'OIDC', material: forged }, Date.now(), nextId('req')),
      (e: unknown) => e instanceof OidcAuthenticatorError && e.code === 'JWT_SIGNATURE_INVALID',
      'a signature that does not verify against the pinned key is refused at the signature stage',
    );
    void readsBefore;
  });

  it('ProductionAuthenticatorContract: flags, id, health (pin state only — no live IdP probe)', async () => {
    assert.equal(authenticator.id, 'oidc');
    assert.deepEqual(authenticator.supports, ['OIDC']);
    assert.equal(authenticator.verifiesCryptographicProof, true);
    assert.equal(authenticator.validatesIssuerAndAudience, true);
    assert.equal(authenticator.replayResistant, true);
    const health = await authenticator.health();
    assert.equal(health.status, 'healthy');
    assert.ok(health.detail !== undefined && health.detail.includes('pinned JWKS'), 'the health report cites the pin (availability = pin state, by design)');
    const pinInfo = authenticator.pinInfo;
    assert.equal(pinInfo.source, 'inline');
    assert.equal(pinInfo.kidCount, 1);
  });

  it('A-03 (S1 authentication site): a static token revoked via S-9 refuses the NEXT authentication', async () => {
    const pid = nextId('st');
    const material = `static-material-${pid}`;
    await tokens.importRecords([{ token: material, tenantId: TENANT, principalId: pid, roles: ['operator'], label: 'a03' }], 'cli:test', Date.now());
    const wrapped = new AutoLinkedStaticTokenAuthenticator(new StaticTokenAuthenticator([], { registry: tokens }), identity, 'cli:test');
    const principal = await wrapped.verify({ method: 'STATIC_TOKEN', material }, Date.now(), nextId('req'));
    assert.equal(principal.tenantId, TENANT);
    // The auto-link created the identity (spec §21.1) — idempotent on repeat.
    assert.ok((await identity.getPrincipal(pid, TENANT)), 'auto-link created the identity from the verified token');
    const again = await wrapped.verify({ method: 'STATIC_TOKEN', material }, Date.now() + 1, nextId('req'));
    assert.equal(again.id, pid, 'repeat verification is idempotent');
    // Revoke the token (S-9) — the NEXT authentication must refuse.
    const fp = AuthenticationEventStore.fingerprint(material);
    await tokens.revokeByFingerprint(fp, 'a03 revocation', Date.now() + 2);
    await assert.rejects(
      () => wrapped.verify({ method: 'STATIC_TOKEN', material }, Date.now() + 3, nextId('req')),
      Error,
      'after S-9 revocation the next authentication refuses (no ALLOW after the revocation commit)',
    );
  });

  it('A-23: duplicate submissions — enrollment is insert-once, import is idempotent-skip (one durable record)', async () => {
    const pid = nextId('dup');
    await identity.enroll({ principalId: pid, tenantId: TENANT, roles: ['observer'], enrolledBy: 'admin:dup' }, Date.now());
    await assert.rejects(
      () => identity.enroll({ principalId: pid, tenantId: TENANT, roles: ['observer'], enrolledBy: 'admin:dup-again' }, Date.now() + 1),
      IdentityStoreError,
      'double enrollment of the same (tenant, principal) is refused (insert-once)',
    );
    const material = `dup-material-${pid}`;
    const first = await tokens.importRecords([{ token: material, tenantId: TENANT, principalId: pid, roles: ['observer'], label: 'dup' }], 'cli:test', Date.now());
    const second = await tokens.importRecords([{ token: material, tenantId: TENANT, principalId: pid, roles: ['observer'], label: 'dup' }], 'cli:test', Date.now() + 1);
    assert.equal(first.imported, 1);
    assert.equal(second.imported, 0, 'an identical re-import is skipped (idempotent)');
    const fp = AuthenticationEventStore.fingerprint(material);
    const reg = (await tokens.getRegistration(fp, TENANT))!;
    assert.equal(reg.status, 'ACTIVE', 'exactly one durable registration record');
  });

  it('A-22: closed schema + material refusal — the identity plane persists no secret material', async () => {
    // A document carrying material-shaped fields is refused by the closed
    // schema gate (the same gate every identity write passes).
    assert.throws(
      () =>
        assertIdentityDocumentShape(
          { id: 'x', principalId: 'p', tenantId: TENANT, state: 'ENROLLED', version: 1, createdAt: T0_MS, updatedAt: T0_MS, material: 'secret-token' },
          new Set(['id', 'principalId', 'tenantId', 'state', 'version', 'createdAt', 'updatedAt']),
          'principal',
        ),
      IdentityStoreError,
      'a material field outside the closed allow-list is refused',
    );
    // Insert-once: re-appending an identity event with a taken id is refused.
    const ev = {
      id: nextId('ev'),
      at: Date.now(),
      tenantId: TENANT,
      kind: 'ADMIN_ACTION' as const,
      principalId: principalId,
      resource: 'identity.principals',
      decision: 'ALLOW' as const,
      result: 'a22 probe',
    };
    await identity.appendEvent(ev);
    await assert.rejects(() => identity.appendEvent(ev), (e: unknown) => e instanceof IdentityStoreError && (e as IdentityStoreError).code === 'EVENT_ALREADY_RECORDED');
    // The durably stored principal doc conforms to the closed shape (no material fields can exist).
    const doc = (await identity.getPrincipal(principalId, TENANT))!;
    assertIdentityDocumentShape(
      doc as unknown as Record<string, unknown>,
      new Set(['id', 'principalId', 'tenantId', 'state', 'version', 'lastTransition', 'createdAt', 'updatedAt']),
      'principal',
    );
  });
});
