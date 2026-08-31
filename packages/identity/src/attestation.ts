// Capability Attestation Engine (JQ-CAPABILITY-ATTESTATION-ENGINE)

export type AttestationStatus = 'IMPLEMENTED' | 'TESTED' | 'DEPLOYED' | 'EXPERIMENTAL' | 'PLANNED';

export interface CapabilityAttestation {
  capabilityId: string;
  name: string;
  status: AttestationStatus;
  evidence: string[];
  verified: boolean;
  timestamp: string;
}

export class CapabilityAttestationEngine {
  private readonly attestations = new Map<string, CapabilityAttestation>();

  registerAttestation(
    capabilityId: string,
    name: string,
    status: AttestationStatus,
    evidence: string[],
    verified: boolean
  ): CapabilityAttestation {
    const attestation: CapabilityAttestation = {
      capabilityId,
      name,
      status,
      evidence,
      verified,
      timestamp: new Date().toISOString(),
    };
    this.attestations.set(capabilityId, attestation);
    return attestation;
  }

  getAttestation(capabilityId: string): CapabilityAttestation | undefined {
    return this.attestations.get(capabilityId);
  }

  listActiveCapabilities(): CapabilityAttestation[] {
    return Array.from(this.attestations.values()).filter(
      (a) => a.status !== 'PLANNED' && a.status !== 'EXPERIMENTAL'
    );
  }
}
