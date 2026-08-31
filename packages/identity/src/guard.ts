// Impersonation Defense (JQ-IDENTITY-GUARD) and Human Governance Gate

export type ThreatClassification = 'LEGITIMATE' | 'UNKNOWN' | 'SUSPICIOUS' | 'IMPERSONATION' | 'MALICIOUS';

export interface ThreatReport {
  referenceId: string;
  sourceUri: string;
  classification: ThreatClassification;
  confidence: number;
  reason: string;
  timestamp: string;
}

export class IdentityGuard {
  evaluateReference(sourceUri: string, claimedCreator: string, claimedName: string): ThreatReport {
    const cleanName = claimedName.trim().toUpperCase();
    const cleanCreator = claimedCreator.trim().toLowerCase();

    if (cleanName === 'JATA QI' && cleanCreator.includes('gitanya kariuki')) {
      return {
        referenceId: `ref-${Date.now()}`,
        sourceUri,
        classification: 'LEGITIMATE',
        confidence: 0.99,
        reason: 'Canonical name and creator match authorized identity record.',
        timestamp: new Date().toISOString(),
      };
    }

    if (cleanName.includes('JATA QI') && !cleanCreator.includes('gitanya kariuki')) {
      return {
        referenceId: `ref-${Date.now()}`,
        sourceUri,
        classification: 'IMPERSONATION',
        confidence: 0.95,
        reason: 'Name matches JATA Qi but creator attribution differs.',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      referenceId: `ref-${Date.now()}`,
      sourceUri,
      classification: 'UNKNOWN',
      confidence: 0.5,
      reason: 'Insufficient evidence to verify authorization.',
      timestamp: new Date().toISOString(),
    };
  }
}

export class HumanGovernanceGate {
  checkAuthorization(actionType: string, requestedLevel: number): { allowed: boolean; reason: string } {
    if (requestedLevel <= 2) {
      return { allowed: true, reason: `Action '${actionType}' at governance level ${requestedLevel} permitted autonomously.` };
    }
    return { allowed: false, reason: `Action '${actionType}' at governance level ${requestedLevel} requires human authorization.` };
  }
}
