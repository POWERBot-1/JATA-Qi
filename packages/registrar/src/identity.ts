// Identity verification — registrant KYC lifecycle. The registrar records
// identity evidence and transitions a registrant through verification states.
// This is identity *management*, not an actual KYC provider integration; a
// production deployment wires a verification provider to the verification hook.

import type { KycStatus, Registrant } from './types.js';

export class IdentityStore {
  private registrants = new Map<string, Registrant>();

  register(input: { name: string; email: string; organization?: string; country?: string }, now = Date.now()): Registrant {
    const id = `reg-${randomId()}`;
    const r: Registrant = { id, ...input, kyc: 'unverified', kycEvidence: [], createdAt: now };
    this.registrants.set(id, r);
    return { ...r };
  }

  get(id: string): Registrant | undefined {
    const r = this.registrants.get(id);
    return r ? { ...r, kycEvidence: [...r.kycEvidence] } : undefined;
  }

  list(): Registrant[] {
    return [...this.registrants.values()].map((r) => ({ ...r, kycEvidence: [...r.kycEvidence] }));
  }

  /** Submit KYC evidence and move the registrant to pending verification. */
  submitKyc(id: string, evidence: string[], now = Date.now()): Registrant {
    const r = this.mustGet(id);
    r.kycEvidence.push(...evidence);
    r.kyc = 'pending';
    r.updatedAt = now;
    return { ...r, kycEvidence: [...r.kycEvidence] };
  }

  /** A verification provider decides the outcome. */
  decideKyc(id: string, status: Extract<KycStatus, 'verified' | 'rejected' | 'suspended'>, now = Date.now()): Registrant {
    const r = this.mustGet(id);
    r.kyc = status;
    if (status === 'verified') r.verifiedAt = now;
    r.updatedAt = now;
    return { ...r, kycEvidence: [...r.kycEvidence] };
  }

  private mustGet(id: string): Registrant {
    const r = this.registrants.get(id);
    if (!r) throw new Error(`registrant ${id} not found`);
    return r;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
