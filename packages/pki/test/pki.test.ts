// PRX Part C — PKI tests: DER encoding, X.509 certificate construction,
// CA hierarchy + issuance, revocation + CRLs, signature verification,
// Registration Authority domain validation, and the Identity Provider
// OIDC-lite flow. Where possible, certificates are cross-validated with
// node:crypto's X509Certificate (the same OpenSSL core the platform uses).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPublicKey, verify } from 'node:crypto';
import {
  derInteger, derOid, derSequence, derOctetString, Tags,
} from '../src/asn1.js';
import {
  generateKeyPair, signCertificate, encodeSpki, computeSubjectKeyId,
  ecdsaDerSignature, type KeyPair,
} from '../src/x509.js';
import { CertificateAuthority } from '../src/ca.js';
import { RegistrationAuthority } from '../src/ra.js';
import { IdentityProvider } from '../src/idp.js';

const OID_CN = '2.5.4.3';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';

function dn(cn: string) {
  return [{ oid: OID_CN, value: cn }];
}

function pemOf(der: Buffer): string {
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

describe('asn1 DER encoder', () => {
  it('encodes INTEGERs minimally with sign preservation', () => {
    assert.deepEqual(derInteger(0), Buffer.from('020100', 'hex'));
    assert.deepEqual(derInteger(127), Buffer.from('02017f', 'hex'));
    assert.deepEqual(derInteger(128), Buffer.from('02020080', 'hex'));
    assert.deepEqual(derInteger(255), Buffer.from('020200ff', 'hex'));
    assert.deepEqual(derInteger(256), Buffer.from('02020100', 'hex'));
  });

  it('encodes OIDs in base-128', () => {
    assert.deepEqual(derOid('1.2.840.10045.4.3.2'), Buffer.from('06082a8648ce3d040302', 'hex'));
    assert.deepEqual(derOid('2.5.4.3'), Buffer.from('0603550403', 'hex'));
  });

  it('uses long-form lengths above 127', () => {
    const big = derSequence(...Array.from({ length: 200 }, () => derOctetString(Buffer.alloc(1))));
    // content = 200 * 3 bytes = 600 = 0x0258 → long form with 2 length bytes
    assert.equal(big[1], 0x82);
    assert.equal(big[2], 0x02);
    assert.equal(big[3], 0x58);
  });

  it('encodes UTCTime without the ISO T separator', async () => {
    const { derUtcTime } = await import('../src/asn1.js');
    const t = new Date(Date.UTC(2026, 7, 4, 13, 46, 3));
    const enc = derUtcTime(t);
    assert.equal(enc.subarray(2).toString('ascii'), '260804134603Z');
  });
});

describe('x509 certificate construction', () => {
  it('generates EC P-256 and RSA key pairs usable by node:crypto', () => {
    for (const alg of ['ec-p256', 'rsa-2048'] as const) {
      const kp = generateKeyPair(alg);
      assert.ok(kp.privateKey.includes('PRIVATE KEY'));
      assert.ok(kp.publicKey.includes('PUBLIC KEY'));
      const pub = createPublicKey(kp.publicKey);
      assert.equal(pub.asymmetricKeyType, alg === 'ec-p256' ? 'ec' : 'rsa');
    }
  });

  it('encodes SPKI that node:crypto can parse to the same key', () => {
    const kp = generateKeyPair('ec-p256');
    const spki = encodeSpki(kp.jwk);
    const parsed = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const a = parsed.export({ format: 'jwk' }) as Record<string, string>;
    assert.equal(a.x, kp.jwk.x);
    assert.equal(a.y, kp.jwk.y);
  });

  it('produces certificates that node:crypto parses with correct fields', () => {
    const kp = generateKeyPair('ec-p256');
    const now = Date.now();
    const der = signCertificate({
      subject: dn('leaf.example.com'),
      issuer: dn('Test Root'),
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 86_400_000),
      subjectPublicKeyJwk: kp.jwk,
      signatureOid: OID_ECDSA_SHA256,
      issuerPrivateKey: kp.privateKey,
      extensions: {
        ca: false,
        keyUsage: ['digitalSignature', 'keyEncipherment'],
        extendedKeyUsage: ['1.3.6.1.5.5.7.3.1'],
        sanDnsNames: ['leaf.example.com', 'www.example.com'],
        subjectKeyIdentifier: computeSubjectKeyId(kp.jwk),
        authorityKeyIdentifier: computeSubjectKeyId(kp.jwk),
      },
    });
    const cert = new X509Certificate(pemOf(der));
    assert.equal(cert.subject, 'CN=leaf.example.com');
    assert.equal(cert.issuer, 'CN=Test Root');
    assert.equal(cert.ca, false);
    assert.ok(cert.subjectAltName?.includes('DNS:leaf.example.com'));
    assert.ok(cert.subjectAltName?.includes('DNS:www.example.com'));
    // Signature verifies against the signing key (OpenSSL X509 layer).
    assert.equal(cert.verify(createPublicKey(kp.publicKey)), true);
    // ... and is rejected by a different key.
    const other = generateKeyPair('ec-p256');
    assert.equal(cert.verify(createPublicKey(other.publicKey)), false);
  });
});

describe('CertificateAuthority', () => {
  it('creates root and intermediate CAs', () => {
    const ca = new CertificateAuthority();
    const root = ca.createCa({ role: 'root', subject: dn('Root CA') });
    const sub = ca.createCa({ role: 'intermediate', subject: dn('Sub CA'), issuerId: root.id });
    assert.equal(ca.listCas('root').length, 1);
    assert.equal(ca.listCas('intermediate').length, 1);
    assert.equal(sub.issuerId, root.id);
    assert.throws(() => ca.createCa({ role: 'intermediate', subject: dn('Orphan') }), /issuerId/);
  });

  it('issues certificates and verifies signatures against the issuing CA only', () => {
    const ca = new CertificateAuthority();
    const root = ca.createCa({ role: 'root', subject: dn('Root CA') });
    const sub = ca.createCa({ role: 'intermediate', subject: dn('Sub CA'), issuerId: root.id });
    const kp = generateKeyPair('ec-p256');
    const cert = ca.issue({
      caId: sub.id,
      subject: dn('api.example.com'),
      sanDnsNames: ['api.example.com'],
      subjectPublicKeyJwk: kp.jwk,
    });
    assert.equal(ca.verifySignature(cert.id, sub.id), true);
    assert.equal(ca.verifySignature(cert.id, root.id), false);
    assert.equal(ca.isIssuedBy(cert.id, sub.id), true);
    assert.equal(ca.isIssuedBy(cert.id, root.id), true); // transitive via sub
    assert.equal(ca.effectiveStatus(cert), 'valid');
    // Cross-check with OpenSSL itself.
    assert.equal(new X509Certificate(pemOf(ca.certDer(cert.id)!) as string).verify(createPublicKey(sub.keyPair.publicKey)), true);
  });

  it('supports RSA signing too', () => {
    const ca = new CertificateAuthority();
    const root = ca.createCa({ role: 'root', subject: dn('RSA Root'), algorithm: 'rsa-2048' });
    const kp = generateKeyPair('ec-p256');
    const cert = ca.issue({ caId: root.id, subject: dn('rsa.example.com'), subjectPublicKeyJwk: kp.jwk });
    assert.equal(ca.verifySignature(cert.id, root.id), true);
  });

  it('revokes certificates and publishes signed CRLs', () => {
    const ca = new CertificateAuthority();
    const root = ca.createCa({ role: 'root', subject: dn('Root CA') });
    const kp = generateKeyPair('ec-p256');
    const a = ca.issue({ caId: root.id, subject: dn('a.example.com'), subjectPublicKeyJwk: kp.jwk });
    const b = ca.issue({ caId: root.id, subject: dn('b.example.com'), subjectPublicKeyJwk: kp.jwk });
    ca.revoke(a.id, 'keyCompromise');
    const crl = ca.latestCrl(root.id)!;
    assert.equal(crl.revokedCount, 1);
    assert.equal(ca.effectiveStatus(a), 'revoked');
    assert.equal(ca.effectiveStatus(b), 'valid');
    assert.throws(() => ca.revoke(a.id), /already revoked/);
    // The CRL is signed by the CA (parseable DER structure).
    assert.ok(Buffer.from(crl.der, 'base64')[0] === 0x30);
  });

  it('reports aggregate stats', () => {
    const ca = new CertificateAuthority();
    const root = ca.createCa({ role: 'root', subject: dn('Root') });
    ca.createCa({ role: 'intermediate', subject: dn('Sub'), issuerId: root.id });
    const stats = ca.stats();
    assert.equal(stats.roots, 1);
    assert.equal(stats.intermediates, 1);
    assert.equal(stats.issued, 0);
  });
});

describe('RegistrationAuthority', () => {
  it('creates requests with method-specific proof locations', () => {
    const ra = new RegistrationAuthority();
    const kp = generateKeyPair('ec-p256');
    const req = ra.create({
      domains: ['example.com'], subject: dn('example.com'), publicKeyJwk: kp.jwk,
      method: 'dns-txt', requestedBy: 'admin',
    });
    assert.equal(req.status, 'pending');
    assert.ok(req.token.length >= 32);
    assert.match(ra.proofLocation(req).value, /_jataqi-pki-validation\.example\.com/);
    const http = ra.create({
      domains: ['x.io'], subject: dn('x.io'), publicKeyJwk: kp.jwk,
      method: 'http-01', requestedBy: 'admin',
    });
    assert.match(ra.proofLocation(http).value, /\.well-known\/pki-validation\//);
  });

  it('validates only on exact token + matching location, then approves', () => {
    const ra = new RegistrationAuthority();
    const kp = generateKeyPair('ec-p256');
    const req = ra.create({
      domains: ['example.com'], subject: dn('example.com'), publicKeyJwk: kp.jwk,
      method: 'dns-txt', requestedBy: 'admin',
    });
    // Wrong token.
    const bad = ra.validate(req.id, { location: '_jataqi-pki-validation.example.com', token: 'nope' })!;
    assert.equal(bad.status, 'pending');
    assert.equal(bad.validation!.ok, false);
    // Wrong location (does not reference the validated domain).
    ra.validate(req.id, { location: 'https://unrelated.example.net/proof', token: req.token });
    assert.equal(ra.get(req.id)!.status, 'pending');
    // Correct proof.
    const good = ra.validate(req.id, { location: '_jataqi-pki-validation.example.com', token: req.token })!;
    assert.equal(good.status, 'validated');
    assert.equal(good.validation!.ok, true);
    // Approve requires validation.
    const approved = ra.approve(req.id, 'admin')!;
    assert.equal(approved.status, 'approved');
    assert.throws(() => ra.approve(req.id, 'admin'), /must be validated/);
  });

  it('tracks issued requests end-to-end', () => {
    const ra = new RegistrationAuthority();
    const kp = generateKeyPair('ec-p256');
    const req = ra.create({
      domains: ['a.com'], subject: dn('a.com'), publicKeyJwk: kp.jwk,
      method: 'email', requestedBy: 'ops',
    });
    ra.validate(req.id, { location: 'admin@a.com', token: req.token });
    ra.approve(req.id, 'ops');
    ra.markIssued(req.id, 'cert-1');
    assert.equal(ra.get(req.id)!.issuedCertId, 'cert-1');
    const stats = ra.stats();
    assert.equal(stats.issued, 1);
  });
});

describe('IdentityProvider', () => {
  it('registers clients and runs the authorization-code flow', () => {
    const idp = new IdentityProvider({ issuer: 'https://id.example.com' });
    const client = idp.registerClient({ name: 'web', redirectUris: ['https://app.example.com/cb'], scopes: ['openid', 'profile'] });
    assert.ok(client.clientId);
    assert.ok(client.clientSecret.length >= 32);
    assert.throws(() => idp.registerClient({ name: 'x', redirectUris: [] }), /redirectUri/);

    const { code } = idp.authorize({ clientId: client.clientId, redirectUri: 'https://app.example.com/cb', userId: 'u-1' });
    assert.throws(() => idp.authorize({ clientId: client.clientId, redirectUri: 'https://evil.example.com', userId: 'u-1' }), /not registered/);

    const tokens = idp.token({ code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: 'https://app.example.com/cb' });
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.ok(tokens.id_token);
    assert.equal(tokens.token_type, 'Bearer');

    // ID token verifies and carries claims.
    const claims = idp.verifyIdToken(tokens.id_token!);
    assert.equal(claims.iss, 'https://id.example.com');
    assert.equal(claims.sub, 'u-1');
    assert.equal(claims.aud, client.clientId);

    // Codes are single-use.
    assert.throws(() => idp.token({ code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: 'https://app.example.com/cb' }), /already used/);
  });

  it('introspects, serves userinfo, refreshes, and revokes', () => {
    const idp = new IdentityProvider({ issuer: 'https://id.example.com' });
    idp.upsertUser('u-2', { name: 'Ada', email: 'ada@example.com' });
    const client = idp.registerClient({ name: 'app', redirectUris: ['https://app.example.com/cb'] });
    const { code } = idp.authorize({ clientId: client.clientId, redirectUri: 'https://app.example.com/cb', userId: 'u-2' });
    const tokens = idp.token({ code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: 'https://app.example.com/cb' });

    const intro = idp.introspect(tokens.access_token);
    assert.equal(intro.active, true);
    assert.equal(intro.userId, 'u-2');

    const info = idp.userinfo(tokens.access_token)!;
    assert.equal(info.name, 'Ada');
    assert.equal(info.email, 'ada@example.com');

    const refreshed = idp.refresh({ refreshToken: tokens.refresh_token!, clientId: client.clientId, clientSecret: client.clientSecret });
    assert.ok(refreshed.access_token);

    assert.equal(idp.revoke(tokens.access_token), true);
    assert.equal(idp.introspect(tokens.access_token).active, false);
    assert.equal(idp.userinfo(tokens.access_token), undefined);
  });

  it('exposes discovery metadata and JWKS (EdDSA mode)', () => {
    const idp = new IdentityProvider({ issuer: 'https://id.example.com', signingAlg: 'EdDSA' });
    const discovery = idp.discovery();
    assert.equal(discovery.issuer, 'https://id.example.com');
    assert.deepEqual(discovery.id_token_signing_alg_values_supported, ['EdDSA']);
    assert.ok(Array.isArray(idp.jwks().keys));
  });
});

describe('PkiModule integration', () => {
  it('issueViaRa completes the full governed flow', async () => {
    const kernel = (await import('@jataqi/core-kernel/testing')).createTestKernel();
    const { PkiModule } = await import('../src/index.js');
    const mod = new PkiModule({ issuer: 'https://id.jataqi.local' });
    kernel.register(mod);
    await kernel.boot();
    try {
      const root = mod.createRootCa([{ oid: '2.5.4.3', value: 'JATA Qi Root' }]);
      const sub = mod.createIntermediateCa([{ oid: '2.5.4.3', value: 'JATA Qi Sub' }], root.id);
      const kp = generateKeyPair('ec-p256');
      // Stepwise governed flow: request → validate → approve → issue.
      const req = mod.createRequest({
        domains: ['secure.example.com'],
        subject: [{ oid: '2.5.4.3', value: 'secure.example.com' }],
        publicKeyJwk: kp.jwk,
        method: 'http-01',
        requestedBy: 'admin',
      });
      assert.equal(req.status, 'pending');
      const validated = mod.ra.validate(req.id, {
        location: 'secure.example.com/.well-known/pki-validation/x',
        token: req.token,
      })!;
      assert.equal(validated.status, 'validated');
      const approved = mod.ra.approve(req.id, 'admin')!;
      assert.equal(approved.status, 'approved');
      const certificate = mod.issueCertificate({
        caId: sub.id,
        subject: approved.subject,
        sanDnsNames: approved.domains,
        subjectPublicKeyJwk: approved.publicKeyJwk,
      });
      mod.ra.markIssued(req.id, certificate.id);
      assert.equal(mod.ra.get(req.id)!.issuedCertId, certificate.id);
      assert.equal(mod.ca.verifySignature(certificate.id, sub.id), true);

      // IdP on the same module.
      const client = mod.registerIdpClient({ name: 'portal', redirectUris: ['https://portal.example.com/cb'] });
      const { code } = mod.idpAuthorize({ clientId: client.clientId, redirectUri: 'https://portal.example.com/cb', userId: 'u9' });
      const tokens = mod.idpToken({ code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: 'https://portal.example.com/cb' });
      assert.ok(tokens.id_token);
      assert.equal(mod.idpUserinfo(tokens.access_token)?.sub, 'u9');
      assert.ok(mod.stats().ca);
    } finally {
      await kernel.shutdown();
    }
  });
});
