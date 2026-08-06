// JATA Qi Privacy — types. Data classification, retention policies, consent,
// and subject-access requests (master directive #94). Sensitive data must not
// automatically enter general-purpose AI context (directive #94 / AI safety).

export type DataSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/** Classification rule: maps a data kind to a sensitivity label. */
export interface ClassificationRule {
  id: string;
  dataKind: string; // e.g. 'pii', 'payment', 'health', 'credentials'
  sensitivity: DataSensitivity;
  description?: string;
}

export type RetentionAction = 'delete' | 'anonymize' | 'archive';

export interface RetentionPolicy {
  id: string;
  dataKind: string;
  ttlDays: number;
  action: RetentionAction;
  notes?: string;
}

export type ConsentStatus = 'granted' | 'denied' | 'withdrawn';

export interface ConsentRecord {
  id: string;
  subjectId: string;
  purpose: string;
  status: ConsentStatus;
  createdAt: number;
  updatedAt: number;
}

export type SARType = 'export' | 'delete';
export type SARStatus = 'requested' | 'in_progress' | 'completed' | 'denied';

export interface SubjectAccessRequest {
  id: string;
  subjectId: string;
  type: SARType;
  status: SARStatus;
  reason?: string;
  createdAt: number;
  completedAt?: number;
}

export const PrivacyEvents = Object.freeze({
  RetentionDue: 'privacy.retention.due',
  SARRequested: 'privacy.sar.requested',
  ConsentChanged: 'privacy.consent.changed',
} as const);

/** Sensitivities that must NOT be sent to general-purpose external AI context. */
export const AI_RESTRICTED_SENSITIVITIES: ReadonlySet<DataSensitivity> = new Set(['confidential', 'restricted']);

// ---- Privacy Engineering deep-dive: PIA, RoPA, secure deletion, minimization ---

export interface PiaDataFlow {
  /** e.g. 'user.registration', 'payments.checkout'. */
  flow: string;
  /** Data kinds touched by the flow (e.g. 'pii', 'payment'). */
  dataKinds: string[];
  /** Recipients / processors of the data. */
  recipients: string[];
  /** Storage location (region / data center). */
  storage?: string;
  /** Retention applied to the flow's data. */
  retentionDays?: number;
}

export type PiaRisk = 'low' | 'medium' | 'high' | 'unacceptable';

export interface PiaAssessment {
  id: string;
  title: string;
  flow: string;
  dataFlows: PiaDataFlow[];
  /** Privacy-by-design score 0..100. */
  designScore: number;
  risk: PiaRisk;
  /** Identified risks with mitigations. */
  mitigations: Array<{ risk: string; mitigation: string; residual: PiaRisk }>;
  status: 'draft' | 'review' | 'approved' | 'rejected';
  assessedBy: string;
  approvedBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProcessingRecord {
  id: string;
  /** Processing activity name. */
  activity: string;
  controller: string;
  /** Data kinds processed (mapped to classifications). */
  dataKinds: string[];
  purposes: string[];
  /** Legal basis, e.g. 'consent' | 'contract' | 'legal_obligation' | 'legitimate_interest'. */
  legalBasis: string;
  recipients: string[];
  /** Cross-border transfer destinations. */
  transfers?: string[];
  retentionDays?: number;
  registeredAt: number;
}

export type DeletionMethod = 'overwrite' | 'crypto_shred' | 'physical_destroy';

export interface SecureDeletion {
  id: string;
  /** Logical data set identifier (e.g. 'user:u-123'). */
  target: string;
  dataKind: string;
  method: DeletionMethod;
  /** Evidence: SHA-256 of the destruction attestation. */
  evidenceHash: string;
  /** Crypto-shred: the key that protected the data was destroyed. */
  keyDestroyed?: boolean;
  verified: boolean;
  performedBy: string;
  createdAt: number;
}

export interface MinimizationCheck {
  id: string;
  /** Processing purpose (consent purpose). */
  purpose: string;
  /** Fields collected for the purpose. */
  collected: string[];
  /** Fields actually necessary for the purpose. */
  necessary: string[];
  /** Excess fields → minimization violation. */
  excess: string[];
  compliant: boolean;
  checkedAt: number;
}

export const PrivacyEngineeringEvents = Object.freeze({
  PiaSubmitted: 'privacy.pia.submitted',
  PiaApproved: 'privacy.pia.approved',
  ProcessingRegistered: 'privacy.processing.registered',
  SecureDeletionVerified: 'privacy.deletion.verified',
  MinimizationViolation: 'privacy.minimization.violation',
} as const);
