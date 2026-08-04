// JATA Qi Health — types (#24). IMPORTANT: This module manages health
// INFORMATION and records only. It does NOT diagnose, prescribe, or make
// clinical decisions. Clinical decisions remain the responsibility of qualified
// healthcare professionals. All health data is RESTRICTED sensitivity.

export type RecordCategory = 'general' | 'clinical' | 'research' | 'administrative';
export type HealthSensitivity = 'confidential' | 'restricted';

export interface HealthRecord {
  id: string;
  patientId: string;
  category: RecordCategory;
  title: string;
  content: string;
  provider?: string;
  organizationId?: string;
  sensitivity: HealthSensitivity;
  createdBy: string;
  createdAt: number;
}

export interface VitalReading {
  id: string;
  patientId: string;
  type: string; // 'blood_pressure_systolic' | 'heart_rate' | 'weight_kg' | etc.
  value: number;
  unit: string;
  notes?: string;
  recordedAt: number;
}

export interface HealthEducation {
  id: string;
  topic: string;
  title: string;
  content: string;
  audience?: string;
  source?: string;
  disclaimer?: string;
  createdAt: number;
}

/** Must be displayed prominently. */
export const HEALTH_DISCLAIMER =
  'JATA Qi Health provides health information management only. It does NOT diagnose, ' +
  'prescribe, or replace professional medical advice. Clinical decisions remain the ' +
  'responsibility of qualified healthcare professionals.';

export const HealthEvents = Object.freeze({
  RecordCreated: 'health.record.created',
  VitalRecorded: 'health.vital.recorded',
} as const);
