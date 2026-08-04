// ca.ts — CertificateAuthority (PRX Part C). Maintains a root/intermediate
// CA hierarchy, issues end-entity and intermediate certificates, revokes
// certificates, and produces signed CRLs. All cryptography is real
// (node:crypto ECDSA P-256 / RSA); certificates are standard DER X.509 v3.

import { randomUUID } from 'node:crypto';
import { X509Certificate, createPublicKey } from 'node:crypto';
import {
  computeSubjectKeyId, generateKeyPair, parseCertificate, signCertificate, signCrl,
  type CertificateOptions, type DnAttribute, type KeyPair, type RevokedCert,
} from './x509.js';
import { Oids } from './asn1.js';

export type CaRole = 'root' | 'intermediate';
export type CertificateStatus = 'valid' | 'revoked' | 'expired';

export interface CaRecord {
  id: string;
  role: CaRole;
  subject: DnAttribute[];
  keyPair: KeyPair;
  /** DER certificate bytes (base64). */
  certDer: string;
  issuerId?: string;
  createdAt: number;
}

export interface IssuedCertificate {
  id: string;
  caId: string;
  serialNumber: bigint;
  subject: DnAttribute[];
  sanDnsNames: string[];
  sanIpAddresses: string[];
  notBefore: Date;
  notAfter: Date;
  /** DER certificate bytes (base64). */
  certDer: string;
  status: CertificateStatus;
  revokedAt?: number;
  revocationReason?: string;
  createdAt: number;
}

export interface IssueCertificateInput {
  /** Issuing CA id (must exist). */
  caId: string;
  subject: DnAttribute[];
  sanDnsNames?: string[];
  sanIpAddresses?: string[];
  /** Public JWK of the certificate holder. */
  subjectPublicKeyJwk: Record<string, string>;
  /** Validity in days (default 825 — ~2.3 years, CA/B Forum limit). */
  validityDays?: number;
  /** Key usages (default: digitalSignature + keyEncipherment). */
  keyUsage?: string[];
  extendedKeyUsage?: string[];
  ca?: boolean;
  crlDistributionPoints?: string[];
}

export interface CrlRecord {
  id: string;
  caId: string;
  der: string; // base64 DER CRL
  thisUpdate: Date;
  nextUpdate: Date;
  number: bigint;
  revokedCount: number;
}

export class CertificateAuthority {
  private cas = new Map<string, CaRecord>();
  private certs = new Map<string, IssuedCertificate>();
  private crls = new Map<string, CrlRecord>();
  private nextCrlNumber = 1n;

  // ---- CA hierarchy ------------------------------------------------------

  /** Create a new CA (root, or intermediate issued by an existing CA). */
  createCa(input: {
    role: CaRole;
    subject: DnAttribute[];
    /** Parent CA id (required for role='intermediate'). */
    issuerId?: string;
    algorithm?: 'ec-p256' | 'rsa-2048';
    validityDays?: number;
  }): CaRecord {
    if (input.role === 'intermediate' && !input.issuerId) {
      throw new Error('intermediate CA requires an issuerId');
    }
    if (input.issuerId && !this.cas.has(input.issuerId)) {
      throw new Error(`issuer CA ${input.issuerId} not found`);
    }
    const keyPair = generateKeyPair(input.algorithm ?? 'ec-p256');
    const issuer = input.issuerId ? this.cas.get(input.issuerId)! : undefined;
    const now = Date.now();
    const notBefore = new Date(now - 60_000);
    const notAfter = new Date(now + (input.validityDays ?? 3650) * 86_400_000);

    const subjectKeyId = computeSubjectKeyId(keyPair.jwk);
    const extensions = {
      ca: true,
      keyUsage: ['keyCertSign', 'cRLSign', 'digitalSignature'],
      subjectKeyIdentifier: subjectKeyId,
      ...(issuer ? { authorityKeyIdentifier: computeSubjectKeyId(issuer.keyPair.jwk) } : {}),
    };

    const certOptions: CertificateOptions = {
      subject: input.subject,
      issuer: issuer?.subject ?? input.subject,
      notBefore,
      notAfter,
      subjectPublicKeyJwk: keyPair.jwk,
      signatureOid: keyPair.algorithm === 'ec-p256' ? Oids.ecdsaWithSha256 : Oids.sha256WithRsa,
      extensions,
    };

    const der = signCertificate({
      ...certOptions,
      issuerPrivateKey: issuer?.keyPair.privateKey ?? keyPair.privateKey,
    });

    const ca: CaRecord = {
      id: randomUUID(),
      role: input.role,
      subject: input.subject,
      keyPair,
      certDer: der.toString('base64'),
      ...(input.issuerId ? { issuerId: input.issuerId } : {}),
      createdAt: now,
    };
    this.cas.set(ca.id, ca);
    return ca;
  }

  getCa(id: string): CaRecord | undefined {
    return this.cas.get(id);
  }

  listCas(role?: CaRole): CaRecord[] {
    const all = [...this.cas.values()];
    return role ? all.filter((c) => c.role === role) : all;
  }

  /** DER bytes of a CA certificate. */
  caCertDer(id: string): Buffer | undefined {
    const ca = this.cas.get(id);
    return ca ? Buffer.from(ca.certDer, 'base64') : undefined;
  }

  // ---- issuance ----------------------------------------------------------

  /** Issue a certificate signed by the given CA. */
  issue(input: IssueCertificateInput): IssuedCertificate {
    const ca = this.cas.get(input.caId);
    if (!ca) throw new Error(`CA ${input.caId} not found`);
    const now = Date.now();
    const serial = BigInt('0x' + randomUUID().replace(/-/g, '').slice(0, 16));

    const cert: IssuedCertificate = {
      id: randomUUID(),
      caId: input.caId,
      serialNumber: serial,
      subject: input.subject,
      sanDnsNames: input.sanDnsNames ?? [],
      sanIpAddresses: input.sanIpAddresses ?? [],
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + (input.validityDays ?? 825) * 86_400_000),
      certDer: '',
      status: 'valid',
      createdAt: now,
    };

    const der = signCertificate({
      subject: input.subject,
      issuer: ca.subject,
      serialNumber: serial,
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
      subjectPublicKeyJwk: input.subjectPublicKeyJwk,
      signatureOid: ca.keyPair.algorithm === 'ec-p256' ? Oids.ecdsaWithSha256 : Oids.sha256WithRsa,
      extensions: {
        ca: input.ca ?? false,
        keyUsage: input.keyUsage ?? (input.ca ? ['keyCertSign', 'cRLSign'] : ['digitalSignature', 'keyEncipherment']),
        ...(input.extendedKeyUsage ? { extendedKeyUsage: input.extendedKeyUsage } : {}),
        ...(input.sanDnsNames?.length || input.sanIpAddresses?.length
          ? { sanDnsNames: input.sanDnsNames, sanIpAddresses: input.sanIpAddresses }
          : {}),
        subjectKeyIdentifier: computeSubjectKeyId(input.subjectPublicKeyJwk),
        authorityKeyIdentifier: computeSubjectKeyId(ca.keyPair.jwk),
        ...(input.crlDistributionPoints?.length ? { crlDistributionPoints: input.crlDistributionPoints } : {}),
      },
      issuerPrivateKey: ca.keyPair.privateKey,
    });

    cert.certDer = der.toString('base64');
    this.certs.set(cert.id, cert);
    return cert;
  }

  get(id: string): IssuedCertificate | undefined {
    return this.certs.get(id);
  }

  getBySerial(serial: bigint): IssuedCertificate | undefined {
    return [...this.certs.values()].find((c) => c.serialNumber === serial);
  }

  list(status?: CertificateStatus): IssuedCertificate[] {
    const all = [...this.certs.values()];
    return status ? all.filter((c) => this.effectiveStatus(c) === status) : all;
  }

  /** DER bytes of an issued certificate. */
  certDer(id: string): Buffer | undefined {
    const c = this.certs.get(id);
    return c ? Buffer.from(c.certDer, 'base64') : undefined;
  }

  // ---- revocation + CRL --------------------------------------------------

  /** Revoke a certificate and emit a fresh CRL for its CA. */
  revoke(id: string, reason = 'unspecified'): IssuedCertificate {
    const cert = this.certs.get(id);
    if (!cert) throw new Error(`certificate ${id} not found`);
    if (cert.status !== 'valid') throw new Error(`certificate ${id} is already ${cert.status}`);
    cert.status = 'revoked';
    cert.revokedAt = Date.now();
    cert.revocationReason = reason;
    this.generateCrl(cert.caId);
    return cert;
  }

  /** Generate (or refresh) the CRL for a CA, including all revoked certs. */
  generateCrl(caId: string, nextUpdateDays = 7): CrlRecord {
    const ca = this.cas.get(caId);
    if (!ca) throw new Error(`CA ${caId} not found`);
    const revoked: RevokedCert[] = [...this.certs.values()]
      .filter((c) => c.caId === caId && c.status === 'revoked')
      .map((c) => ({ serialNumber: c.serialNumber, revocationDate: new Date(c.revokedAt ?? c.createdAt) }));
    const now = new Date();
    const der = signCrl({
      issuer: ca.subject,
      thisUpdate: now,
      nextUpdate: new Date(now.getTime() + nextUpdateDays * 86_400_000),
      revoked,
      issuerPrivateKey: ca.keyPair.privateKey,
      signatureOid: ca.keyPair.algorithm === 'ec-p256' ? Oids.ecdsaWithSha256 : Oids.sha256WithRsa,
      crlNumber: this.nextCrlNumber++,
    });
    const record: CrlRecord = {
      id: randomUUID(),
      caId,
      der: der.toString('base64'),
      thisUpdate: now,
      nextUpdate: new Date(now.getTime() + nextUpdateDays * 86_400_000),
      number: this.nextCrlNumber - 1n,
      revokedCount: revoked.length,
    };
    this.crls.set(record.id, record);
    return record;
  }

  /** Most recent CRL for a CA. */
  latestCrl(caId: string): CrlRecord | undefined {
    return [...this.crls.values()].filter((c) => c.caId === caId).sort((a, b) => Number(b.number - a.number))[0];
  }

  crlsFor(caId: string): CrlRecord[] {
    return [...this.crls.values()].filter((c) => c.caId === caId);
  }

  // ---- verification ------------------------------------------------------

  /** Verify a certificate's signature against its issuing CA. */
  verifySignature(certIdOrDer: string | Buffer, caId?: string): boolean {
    const der = typeof certIdOrDer === 'string'
      ? (this.certs.get(certIdOrDer) ?? this.cas.get(certIdOrDer))?.certDer
      : certIdOrDer.toString('base64');
    if (!der) return false;
    const cert = new X509Certificate(Buffer.from(der, 'base64'));
    const issuer = caId ? this.cas.get(caId) : [...this.cas.values()].find((c) => {
      try { return cert.checkIssued(parseCertificate(Buffer.from(c.certDer, 'base64'))); } catch { return false; }
    });
    if (!issuer) return false;
    const issuerKey = createPublicKey(issuer.keyPair.publicKey);
    return cert.verify(issuerKey);
  }

  effectiveStatus(cert: IssuedCertificate): CertificateStatus {
    if (cert.status === 'revoked') return 'revoked';
    if (Date.now() > cert.notAfter.getTime()) return 'expired';
    return 'valid';
  }

  /** Chain check: certificate is issued by this CA (direct or transitive). */
  isIssuedBy(certId: string, caId: string): boolean {
    const cert = this.certs.get(certId);
    if (!cert) return false;
    if (cert.caId === caId) return true;
    const issuer = this.cas.get(cert.caId);
    return issuer?.issuerId === caId;
  }

  stats(): { cas: number; roots: number; intermediates: number; issued: number; revoked: number; crls: number } {
    const all = [...this.cas.values()];
    return {
      cas: all.length,
      roots: all.filter((c) => c.role === 'root').length,
      intermediates: all.filter((c) => c.role === 'intermediate').length,
      issued: this.certs.size,
      revoked: [...this.certs.values()].filter((c) => c.status === 'revoked').length,
      crls: this.crls.size,
    };
  }
}
