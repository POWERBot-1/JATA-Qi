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
