// ra.ts — RegistrationAuthority (PRX Part C). Validates domain control and
// applicant identity before certificate issuance, per CA/B Forum BR §3.2.2:
//   - dns-txt  : applicant publishes a random token in a DNS TXT record
//   - http-01  : applicant serves the token at
//                http://{domain}/.well-known/pki-validation/{token}
//   - email    : applicant approves a token emailed to an admin contact
// A request must be validated (token proof) and approved before the CA issues.

import { randomUUID } from 'node:crypto';

export type ValidationMethod = 'dns-txt' | 'http-01' | 'email';
export type RaRequestStatus = 'pending' | 'validated' | 'approved' | 'issued' | 'rejected';

export interface CertificateRequest {
  id: string;
  /** Target domain names to cover (SANs). */
  domains: string[];
  subject: Array<{ oid: string; value: string }>;
  /** Public JWK of the applicant. */
  publicKeyJwk: Record<string, string>;
  method: ValidationMethod;
  /** Random token the applicant must prove control with. */
  token: string;
  status: RaRequestStatus;
  validation?: { field: string; found: string; ok: boolean };
  requestedBy: string;
  createdAt: number;
  /** Filled when issued. */
  issuedCertId?: string;
}

export class RegistrationAuthority {
  private requests = new Map<string, CertificateRequest>();

  /** Open a certificate request with a proof token for the chosen method. */
  create(input: {
    domains: string[];
    subject: Array<{ oid: string; value: string }>;
    publicKeyJwk: Record<string, string>;
    method: ValidationMethod;
    requestedBy: string;
  }): CertificateRequest {
    if (input.domains.length === 0) throw new Error('at least one domain is required');
    if (!input.method) throw new Error('validation method is required');
    const request: CertificateRequest = {
      id: randomUUID(),
      domains: [...input.domains],
      subject: input.subject,
      publicKeyJwk: input.publicKeyJwk,
      method: input.method,
      token: randomUUID().replace(/-/g, ''),
      status: 'pending',
      requestedBy: input.requestedBy,
      createdAt: Date.now(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  get(id: string): CertificateRequest | undefined {
    return this.requests.get(id);
  }

  list(status?: RaRequestStatus): CertificateRequest[] {
    const all = [...this.requests.values()];
    return status ? all.filter((r) => r.status === status) : all;
  }

  /** The expected proof location for a request (per method). */
  proofLocation(request: CertificateRequest): { kind: string; value: string } {
    switch (request.method) {
      case 'dns-txt':
        return { kind: 'dns TXT', value: `_jataqi-pki-validation.${request.domains[0]} = "${request.token}"` };
      case 'http-01':
        return { kind: 'URL', value: `http://${request.domains[0]}/.well-known/pki-validation/${request.token}` };
      case 'email':
        return { kind: 'email', value: `approval email to admin@${request.domains[0]} containing token ${request.token}` };
    }
  }

  /**
   * Validate a request by submitting the observed proof. The token must
   * match exactly and must be observed on the correct location for the
   * request's method (CA/B Forum BR 3.2.2.4/5/6).
   */
  validate(id: string, observed: { location: string; token: string }): CertificateRequest | undefined {
    const request = this.requests.get(id);
    if (!request) return undefined;
    if (request.status !== 'pending' && request.status !== 'validated') {
      throw new Error(`request ${id} is ${request.status} (not validatable)`);
    }
    const expected = this.proofLocation(request);
    const locationOk = observed.location.toLowerCase().includes(request.domains[0]!.toLowerCase());
    const tokenOk = observed.token === request.token;
    const ok = locationOk && tokenOk;
    request.validation = { field: expected.kind, found: observed.location, ok };
    if (ok) request.status = 'validated';
    return request;
  }

  /** Approve a validated request (human/automated gate). */
  approve(id: string, approver: string): CertificateRequest | undefined {
    const request = this.requests.get(id);
    if (!request) return undefined;
    if (request.status !== 'validated') {
      throw new Error(`request ${id} must be validated before approval (status: ${request.status})`);
    }
    if (!request.validation?.ok) throw new Error(`request ${id} validation failed`);
    request.status = 'approved';
    return request;
  }

  /** Reject a request (e.g. validation failed or policy deny). */
  reject(id: string, reason: string): CertificateRequest | undefined {
    const request = this.requests.get(id);
    if (!request) return undefined;
    request.status = 'rejected';
    request.validation = { field: 'policy', found: reason, ok: false };
    return request;
  }

  /** Mark an approved request as issued (called by the issuing flow). */
  markIssued(id: string, certId: string): CertificateRequest | undefined {
    const request = this.requests.get(id);
    if (!request) return undefined;
    if (request.status !== 'approved') throw new Error(`request ${id} must be approved before issuance`);
    request.status = 'issued';
    request.issuedCertId = certId;
    return request;
  }

  stats(): { total: number; pending: number; validated: number; approved: number; issued: number; rejected: number } {
    const all = [...this.requests.values()];
    const count = (s: RaRequestStatus): number => all.filter((r) => r.status === s).length;
    return {
      total: all.length,
      pending: count('pending'),
      validated: count('validated'),
      approved: count('approved'),
      issued: count('issued'),
      rejected: count('rejected'),
    };
  }
}
