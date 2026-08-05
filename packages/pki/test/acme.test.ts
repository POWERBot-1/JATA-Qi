// PRX Part C — ACME (RFC 8555) flow tests: nonces, accounts, orders,
// authorizations, challenges with keyAuthorization proofs, CSR finalization
// through the CA, revocation, and JWS verification — plus the RFC 7638
// thumbprint test vector and negative cases.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import {
  AcmeErrorImpl, AcmeErrorTypes, AcmeService, generateKeyPair, jwkThumbprint,
  keyAuthorization, parseJws, verifyJws, PkiModule,
} from '../src/index.js';
import type { KeyPair } from '../src/index.js';
import {
  Oids, derBitString, derContext, derContextPrimitive, derInteger, derOctetString,
  derOid, derSequence, derSet, derUtf8String,
} from '../src/asn1.js';
import { ecdsaDerSignature, encodeSpki } from '../src/x509.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Build a DER PKCS#10 CSR (EC P-256 subject key). */
function buildCsr(input: { subjectKey: KeyPair; cn: string; dnsNames: string[] }): Buffer {
  const { subjectKey, cn, dnsNames } = input;
  const subject = derSequence(
    derSet(derSequence(derOid(Oids.commonName), derUtf8String(cn))),
  );
  const sanExtension = derSequence(
    derOid(Oids.subjectAltName),
    derOctetString(derSequence(...dnsNames.map((d) => derContextPrimitive(2, Buffer.from(d, 'ascii'))))),
  );
  // RFC 2986: attributes [0] IMPLICIT SET OF Attribute — the [0] content is
  // the concatenated Attribute SEQUENCEs (no extra wrapper). OpenSSL's
  // canonical req_info ALWAYS carries the [0] field (empty when absent), so
  // we emit it unconditionally — otherwise OpenSSL's re-encoding adds the
  // empty field and signature verification over the re-encoded tbs fails.
  let attributes: Buffer;
  if (dnsNames.length > 0) {
    const extensionRequestAttr = derSequence(
      derOid('1.2.840.113549.1.9.14'), // extensionRequest
      derSet(derSequence(sanExtension)),
    );
    attributes = derContext(0, extensionRequestAttr);
  } else {
    attributes = derContext(0, Buffer.alloc(0));
  }
  const criChildren = [derInteger(0), subject, encodeSpki(subjectKey.jwk), attributes];
  const cri = derSequence(...criChildren);
  // Sign the full DER-encoded certificationRequestInfo TLV (header included) —
  // the convention used by OpenSSL `req -new` and Go crypto/x509 (and thus by
  // mainstream ACME clients). parseCsr accepts this form and the RFC 2986
  // content-only form.
  const raw = sign('sha256', cri, { key: subjectKey.privateKey, dsaEncoding: 'ieee-p1363' });
  const signature = derBitString(ecdsaDerSignature(raw));
  return derSequence(cri, derSequence(derOid(Oids.ecdsaWithSha256)), signature);
}

/** Build a compact JWS (ES256) signed with the given key. */
function buildJws(payload: unknown, key: KeyPair, header: Record<string, unknown> = {}): string {
  const protectedHeader = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', ...header }), 'utf8'));
  const rawPayload = payload === '' ? '' : b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${protectedHeader}.${rawPayload}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${protectedHeader}.${rawPayload}.${signature.toString('base64url')}`;
}

/** Boot a kernel with a PKI module containing a root + intermediate CA. */
async function bootPki() {
  const kernel = createTestKernel();
  const pki = new PkiModule({ issuer: 'https://id.acme.test' });
  kernel.register(pki);
  await kernel.boot();
  const root = pki.createRootCa([{ oid: '2.5.4.3', value: 'ACME Root' }]);
  const intermediate = pki.createIntermediateCa([{ oid: '2.5.4.3', value: 'ACME Intermediate' }], root.id);
  return { kernel, pki, root, intermediate };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RFC 7638 thumbprint', () => {
  it('matches the RFC 7638 test vector', () => {
    const jwk = {
      kty: 'RSA',
      n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      e: 'AQAB',
    };
    assert.equal(jwkThumbprint(jwk), 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('derives stable thumbprints for EC keys and keyAuthorizations', () => {
    const key = generateKeyPair('ec-p256');
    const t1 = jwkThumbprint(key.jwk);
    const t2 = jwkThumbprint(key.jwk);
    assert.equal(t1, t2);
    assert.ok(t1.length > 20);
    const ka = keyAuthorization('token-1', key.jwk);
    assert.match(ka, /^token-1\.[A-Za-z0-9_-]+$/);
  });
});

describe('AcmeService — nonces and accounts', () => {
  it('issues single-use nonces', async () => {
    const { kernel, pki } = await bootPki();
    try {
      const nonce = pki.acmeNewNonce();
      assert.ok(nonce.length > 16);
      assert.equal(pki.acme.checkNonce(nonce), true);
      assert.equal(pki.acme.checkNonce(nonce), false); // single-use
      assert.equal(pki.acme.checkNonce('not-a-nonce'), false);
    } finally {
      await kernel.shutdown();
    }
  });

  it('creates accounts from JWS-signed newAccount requests', async () => {
    const { kernel, pki } = await bootPki();
    try {
      const accountKey = generateKeyPair('ec-p256');
      const jws = buildJws({ contact: ['mailto:ops@example.com'], termsOfServiceAgreed: true }, accountKey, {
        jwk: accountKey.jwk,
        nonce: pki.acmeNewNonce(),
        url: '/new-account',
      });
      const result = pki.acmeNewAccount(jws, { contact: ['mailto:ops@example.com'] });
      assert.equal(result.existing, false);
      assert.equal(result.account.status, 'valid');
      assert.match(result.kid, /^acct-/);

      // Same key → existing account.
      const again = pki.acmeNewAccount(buildJws({}, accountKey, { jwk: accountKey.jwk, nonce: pki.acmeNewNonce(), url: '/new-account' }));
      assert.equal(again.existing, true);
      assert.equal(again.kid, result.kid);

      // Signature mismatch → rejected.
      const otherKey = generateKeyPair('ec-p256');
      const forged = buildJws({}, otherKey, { jwk: accountKey.jwk, nonce: pki.acmeNewNonce(), url: '/new-account' });
      assert.throws(() => pki.acmeNewAccount(forged), (e: unknown) => (e as AcmeErrorImpl).type === AcmeErrorTypes.unauthorized);
    } finally {
      await kernel.shutdown();
    }
  });
});

describe('AcmeService — full issuance flow', () => {
  it('runs order → challenge → proof → finalize → certificate → revoke', async () => {
    const { kernel, pki, intermediate } = await bootPki();
    try {
      // 1. Account.
      const accountKey = generateKeyPair('ec-p256');
      const account = pki.acmeNewAccount(
        buildJws({ termsOfServiceAgreed: true }, accountKey, { jwk: accountKey.jwk, nonce: pki.acmeNewNonce(), url: '/new-account' }),
      );
      const kid = account.kid;

      // 2. Order for two identifiers.
      const order = pki.acmeNewOrder(kid, [
        { type: 'dns', value: 'api.example.com' },
        { type: 'dns', value: 'www.example.com' },
      ]);
      assert.equal(order.status, 'pending');
      assert.equal(order.identifiers.length, 2);
      assert.equal(order.authorizationIds.length, 2);

      // 3. Authorizations + challenges per identifier.
      const authz1 = pki.acmeGetAuthorization(order.authorizationIds[0]!)!;
      const authz2 = pki.acmeGetAuthorization(order.authorizationIds[1]!)!;
      assert.equal(authz1.identifier.value, 'api.example.com');
      assert.equal(authz1.challenges.length, 3); // http-01, dns-01, tls-alpn-01
      const httpChallenge = authz1.challenges[0]!;
      assert.equal(httpChallenge.type, 'http-01');

      // 4. Client obtains keyAuthorization + requests validation.
      const ka = pki.acmeChallengeKeyAuthorization(httpChallenge.id);
      assert.equal(ka.token, httpChallenge.token);
      assert.equal(ka.keyAuthorization, keyAuthorization(httpChallenge.token, accountKey.jwk));

      const processing = pki.acmeRequestValidation(kid, httpChallenge.id);
      assert.equal(processing.status, 'processing');

      // 5. Submit the proof observed at the well-known location.
      const proven = pki.acmeSubmitProof(kid, httpChallenge.id, {
        location: 'http://api.example.com/.well-known/acme-challenge/' + httpChallenge.token,
        value: ka.keyAuthorization,
      });
      assert.equal(proven.status, 'valid');
      assert.equal(pki.acmeGetAuthorization(order.authorizationIds[0]!)!.status, 'valid');

      // Wrong proof → invalid.
      const other = pki.acmeNewOrder(kid, [{ type: 'dns', value: 'bad.example.com' }]);
      const badAuthz = pki.acmeGetAuthorization(other.authorizationIds[0]!)!;
      const badChallenge = badAuthz.challenges[1]!;
      const badKa = pki.acmeChallengeKeyAuthorization(badChallenge.id);
      const invalid = pki.acmeSubmitProof(kid, badChallenge.id, { location: 'http://bad.example.com/x', value: 'wrong' });
      assert.equal(invalid.status, 'invalid');
      assert.equal(pki.acmeGetOrder(other.id)!.status, 'invalid');

      // 6. Validate the second identifier, then finalize.
      const chal2 = authz2.challenges[0]!;
      const ka2 = pki.acmeChallengeKeyAuthorization(chal2.id);
      pki.acmeSubmitProof(kid, chal2.id, {
        location: `http://www.example.com/.well-known/acme-challenge/${chal2.token}`,
        value: ka2.keyAuthorization,
      });
      assert.equal(pki.acmeGetOrder(order.id)!.status, 'ready');

      // 7. Finalize with a CSR covering both identifiers.
      const subjectKey = generateKeyPair('ec-p256');
      const csr = buildCsr({ subjectKey, cn: 'api.example.com', dnsNames: ['api.example.com', 'www.example.com'] });
      const finalized = pki.acmeFinalize(kid, order.id, csr);
      assert.equal(finalized.order.status, 'valid');
      assert.ok(finalized.certificate, 'certificate should be issued');
      assert.ok(finalized.certificate!.certDer.length > 100);

      // The issued certificate chains to the intermediate CA.
      assert.equal(pki.ca.verifySignature(finalized.certificate!.id, intermediate.id), true);
      const cert = finalized.certificate!;
      assert.deepEqual(cert.sanDnsNames.sort(), ['api.example.com', 'www.example.com']);

      // 8. Certificate fetch + revocation.
      const fetched = pki.acmeCertificate(order.id)!;
      assert.equal(fetched.id, cert.id);
      assert.equal(pki.acmeRevoke(kid, cert.id, 'keyCompromise'), true);
      assert.equal(pki.ca.effectiveStatus(cert), 'revoked');
    } finally {
      await kernel.shutdown();
    }
  });

  it('rejects finalize before ready, bad CSRs, and unauthorized access', async () => {
    const { kernel, pki } = await bootPki();
    try {
      const accountKey = generateKeyPair('ec-p256');
      const account = pki.acmeNewAccount(
        buildJws({ termsOfServiceAgreed: true }, accountKey, { jwk: accountKey.jwk, nonce: pki.acmeNewNonce(), url: '/new-account' }),
      );
      const kid = account.kid;
      const order = pki.acmeNewOrder(kid, [{ type: 'dns', value: 'only.example.com' }]);

      // Finalize before ready.
      const csr = buildCsr({ subjectKey: generateKeyPair('ec-p256'), cn: 'only.example.com', dnsNames: ['only.example.com'] });
      assert.throws(() => pki.acmeFinalize(kid, order.id, csr), (e: unknown) => (e as AcmeErrorImpl).type === AcmeErrorTypes.orderNotReady);

      // Validate, then finalize with a CSR that does not cover the identifier.
      const authz = pki.acmeGetAuthorization(order.authorizationIds[0]!)!;
      const challenge = authz.challenges[0]!;
      const ka = pki.acmeChallengeKeyAuthorization(challenge.id);
      pki.acmeSubmitProof(kid, challenge.id, {
        location: `http://only.example.com/.well-known/acme-challenge/${challenge.token}`,
        value: ka.keyAuthorization,
      });
      assert.equal(pki.acmeGetOrder(order.id)!.status, 'ready');

      const wrongCsr = buildCsr({ subjectKey: generateKeyPair('ec-p256'), cn: 'other.example.com', dnsNames: ['other.example.com'] });
      const failed = pki.acmeFinalize(kid, order.id, wrongCsr);
      assert.equal(failed.order.status, 'invalid');
      assert.equal(failed.certificate, undefined);

      // Tampered CSR signature.
      const goodCsr = buildCsr({ subjectKey: generateKeyPair('ec-p256'), cn: 'only.example.com', dnsNames: ['only.example.com'] });
      const order2 = pki.acmeNewOrder(kid, [{ type: 'dns', value: 'only.example.com' }]);
      const authz2 = pki.acmeGetAuthorization(order2.authorizationIds[0]!)!;
      const chal2 = authz2.challenges[0]!;
      const ka2 = pki.acmeChallengeKeyAuthorization(chal2.id);
      pki.acmeSubmitProof(kid, chal2.id, { location: `http://only.example.com/x`, value: ka2.keyAuthorization });
      const tampered = Buffer.from(goodCsr);
      tampered[tampered.length - 3] = (tampered[tampered.length - 3]! ^ 0xff);
      const failed2 = pki.acmeFinalize(kid, order2.id, tampered);
      assert.equal(failed2.order.status, 'invalid');

      // Unauthorized: another account cannot touch this order's challenges.
      const otherKey = generateKeyPair('ec-p256');
      const other = pki.acmeNewAccount(
        buildJws({}, otherKey, { jwk: otherKey.jwk, nonce: pki.acmeNewNonce(), url: '/new-account' }),
      );
      assert.throws(() => pki.acmeRequestValidation(other.kid, challenge.id), (e: unknown) => (e as AcmeErrorImpl).type === AcmeErrorTypes.unauthorized);
    } finally {
      await kernel.shutdown();
    }
  });

  it('accepts CSRs signed over the content-only form (RFC 2986 literal) too', async () => {
    const { kernel, pki } = await bootPki();
    try {
      const subjectKey = generateKeyPair('ec-p256');
      const subject = derSequence(derSet(derSequence(derOid(Oids.commonName), derUtf8String('c.example.com'))));
      const sanExtension = derSequence(
        derOid(Oids.subjectAltName),
        derOctetString(derSequence(derContextPrimitive(2, Buffer.from('c.example.com', 'ascii')))),
      );
      const attributes = derContext(0, derSequence(
        derOid('1.2.840.113549.1.9.14'),
        derSet(derSequence(sanExtension)),
      ));
      const criChildren = [derInteger(0), subject, encodeSpki(subjectKey.jwk), attributes];
      const criValue = Buffer.concat(criChildren);
      const cri = derSequence(...criChildren);
      // Sign the VALUE (content) only — the strict RFC 2986 reading.
      const raw = sign('sha256', criValue, { key: subjectKey.privateKey, dsaEncoding: 'ieee-p1363' });
      const csr = derSequence(cri, derSequence(derOid(Oids.ecdsaWithSha256)), derBitString(ecdsaDerSignature(raw)));

      // parseCsr accepts it (content-only form).
      const parsed = (await import('../src/index.js')).parseCsr(csr);
      assert.equal(parsed.signatureValid, true);
      assert.deepEqual(parsed.dnsNames, ['c.example.com']);

      // And the full ACME finalize accepts it too.
      const accountKey = generateKeyPair('ec-p256');
      const account = pki.acmeNewAccount(
        buildJws({ termsOfServiceAgreed: true }, accountKey, { jwk: accountKey.jwk, nonce: pki.acmeNewNonce(), url: '/new-account' }),
      );
      const order = pki.acmeNewOrder(account.kid, [{ type: 'dns', value: 'c.example.com' }]);
      const authz = pki.acmeGetAuthorization(order.authorizationIds[0]!)!;
      const challenge = authz.challenges[0]!;
      const ka = pki.acmeChallengeKeyAuthorization(challenge.id);
      pki.acmeSubmitProof(account.kid, challenge.id, {
        location: `http://c.example.com/.well-known/acme-challenge/${challenge.token}`,
        value: ka.keyAuthorization,
      });
      const finalized = pki.acmeFinalize(account.kid, order.id, csr);
      assert.equal(finalized.order.status, 'valid');
      assert.ok(finalized.certificate);
    } finally {
      await kernel.shutdown();
    }
  });

  it('verifies JWS with parseJws + verifyJws and exposes the directory', async () => {
    const { kernel, pki } = await bootPki();
    try {
      const accountKey = generateKeyPair('ec-p256');
      const jws = parseJws(buildJws({ hello: 'world' }, accountKey, { jwk: accountKey.jwk, nonce: pki.acmeNewNonce(), url: '/test' }));
      assert.deepEqual(jws.payload, { hello: 'world' });
      assert.equal(pki.acmeVerifyJws(jws, accountKey.jwk), true);
      assert.equal(pki.acmeVerifyJws(jws, generateKeyPair('ec-p256').jwk), false);
      assert.throws(() => parseJws('only.two.parts.extra'), (e: unknown) => (e as AcmeErrorImpl).type === AcmeErrorTypes.malformed);

      const directory = pki.acmeDirectory();
      assert.equal(directory.newNonce, '/new-nonce');
      assert.equal(directory.newAccount, '/new-account');
      assert.equal(directory.newOrder, '/new-order');
      assert.ok(pki.stats().acme);
    } finally {
      await kernel.shutdown();
    }
  });
});
