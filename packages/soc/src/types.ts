// JATA Qi Global Security Operations — shared types.

// ---- telemetry pipeline + security data lake --------------------------------

export type TelemetrySource =
  | 'gateway' | 'auth' | 'rbac' | 'audit' | 'network' | 'endpoint' | 'cloud'
  | 'ai' | 'agent' | 'tool' | 'database' | 'mobile' | 'integration' | 'soc';

export interface SecurityEvent {
  id: string;
  ts: number;
  source: TelemetrySource;
  type: string;
  actor?: string;
  /** e.g. client IP, device id, service name. */
  origin?: string;
  severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  detail?: string;
  data?: Record<string, unknown>;
}

/** Hash-chained entry in the security data lake (tamper-evident). */
export interface LakeEntry extends SecurityEvent {
  /** SHA-256 of the previous entry (immutable chain). */
  prevHash: string;
  /** SHA-256 of this entry's canonical JSON. */
  hash: string;
}

// ---- threat hunting -----------------------------------------------------------

export interface HuntPlaybook {
  id: string;
  name: string;
  description: string;
  /** Telemetry patterns to search for (type exact or prefix). */
  patterns: string[];
  /** Severity assigned when hits are found. */
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface HuntSession {
  id: string;
  playbookId: string;
  playbookName: string;
  startedAt: number;
  finishedAt?: number;
  scanned: number;
  hits: Array<{ eventId: string; ts: number; actor?: string; origin?: string; detail?: string }>;
  summary?: string;
}

// ---- threat intelligence ------------------------------------------------------

export type IntelType = 'ip' | 'domain' | 'hash' | 'email' | 'url' | 'campaign';
export type TlpLevel = 'white' | 'green' | 'amber' | 'red';

export interface IntelIndicator {
  id: string;
  type: IntelType;
  value: string;
  confidence: number;   // 0..1
  severity: 'low' | 'medium' | 'high' | 'critical';
  tlp: TlpLevel;
  source: string;
  expiresAt?: number;
  tags?: string[];
  createdAt: number;
}

export interface IntelMatch {
  indicator: IntelIndicator;
  matchedValue: string;
  ts: number;
}

// ---- insider risk ---------------------------------------------------------------

export interface PrivilegedAction {
  actor: string;
  action: string;
  sensitivity: 'standard' | 'privileged' | 'critical';
  ts: number;
  detail?: string;
}

export interface InsiderAlert {
  id: string;
  actor: string;
  rule: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  ts: number;
}

// ---- abuse detection --------------------------------------------------------------

export interface AbuseAlert {
  id: string;
  rule: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  actors?: string[];
  origins?: string[];
  ts: number;
}

// ---- incident command --------------------------------------------------------------

export type IncidentSeverity = 'sev4' | 'sev3' | 'sev2' | 'sev1';
export type IncidentStatus = 'detected' | 'triage' | 'investigating' | 'contained' | 'eradicated' | 'recovered' | 'closed';

export interface IncidentUpdate {
  ts: number;
  status: IncidentStatus;
  by: string;
  note: string;
}

export interface IncidentEvidence {
  id: string;
  description: string;
  /** Hash of the preserved artifact (chain-of-custody). */
  artifactHash?: string;
  preservedBy: string;
  ts: number;
}

export interface IncidentComm {
  ts: number;
  channel: 'internal' | 'stakeholder' | 'executive' | 'public';
  to?: string;
  message: string;
  by: string;
}

export interface SecurityIncidentRecord {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  commander?: string;
  responders: string[];
  /** Monotonic escalation count (auto-escalation). */
  escalations: number;
  detectedAt: number;
  timeline: IncidentUpdate[];
  evidence: IncidentEvidence[];
  communications: IncidentComm[];
  closedAt?: number;
}

export const INCIDENT_SEVERITY_ORDER: IncidentSeverity[] = ['sev4', 'sev3', 'sev2', 'sev1'];

export const INCIDENT_LIFECYCLE: IncidentStatus[] = [
  'detected', 'triage', 'investigating', 'contained', 'eradicated', 'recovered', 'closed',
];

/** Severity → minutes allowed before auto-escalation (SLA). */
export const ESCALATION_SLA_MIN: Record<IncidentSeverity, number> = {
  sev4: 24 * 60,
  sev3: 8 * 60,
  sev2: 60,
  sev1: 15,
};

// ---- adversarial validation ---------------------------------------------------------

export type CampaignKind =
  | 'credential_stuffing' | 'phishing_lure' | 'privilege_escalation' | 'data_exfiltration'
  | 'lateral_movement' | 'supply_chain_tamper';

export interface CampaignStep {
  name: string;
  /** Telemetry the campaign emits while running. */
  telemetry: Array<{ type: string; actor?: string; origin?: string; data?: Record<string, unknown> }>;
  /** Defense control expected to catch this step. */
  expectedControl: string;
}

export interface ExerciseCampaign {
  id: string;
  kind: CampaignKind;
  name: string;
  steps: CampaignStep[];
  startedAt: number;
  finishedAt?: number;
  results: Array<{ step: string; detected: boolean; control: string; notes?: string }>;
  score: number; // 0..1 detected fraction
}

export interface TabletopScenario {
  id: string;
  title: string;
  description: string;
  injects: string[];
  facilitatorNotes: string[];
  createdAt: number;
}

// ---- metrics / reports ----------------------------------------------------------------

export interface SocKpis {
  incidents: number;
  openIncidents: number;
  sev1Incidents: number;
  avgTimeToTriageMin: number;
  avgTimeToContainMin: number;
  avgTimeToResolveMin: number;
  findingsToday: number;
  telemetryEvents: number;
  lakeEntries: number;
  huntsRun: number;
  intelIndicators: number;
  intelMatches: number;
  insiderAlerts: number;
  abuseAlerts: number;
  campaignsRun: number;
  validationScore: number;
  exercises: number;
}

export interface SocReport {
  generatedAt: number;
  kpis: SocKpis;
  openIncidents: SecurityIncidentRecord[];
  recentAlerts: Array<{ type: 'insider' | 'abuse' | 'hunt'; severity: string; message: string; ts: number }>;
  intelBySeverity: Record<string, number>;
  incidentStatusDistribution: Record<string, number>;
  lakeIntegrity: { entries: number; chainValid: boolean };
}
