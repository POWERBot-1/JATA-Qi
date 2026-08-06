// JATA Qi Active Defense & Adaptive Resilience Layer — shared types.

// ---- risk -------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskSignal {
  /** Signal type, e.g. 'login_failed', 'login_new_device', 'honeytoken_touch', 'tool_misuse', 'blocked_request'. */
  type: string;
  /** Default weight per type; explicit weight overrides. */
  weight?: number;
  /** Resource / context (e.g. 'sensitive:payments'). */
  context?: string;
  ts?: number;
}

export interface RiskAssessment {
  userId: string;
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
  updatedAt: number;
}

// ---- findings (detection) -----------------------------------------------------

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type FindingStatus = 'open' | 'acknowledged' | 'resolved';

export interface Finding {
  id: string;
  rule: string;
  severity: FindingSeverity;
  title: string;
  detail?: string;
  actor?: string;
  context?: Record<string, unknown>;
  status: FindingStatus;
  createdAt: number;
  resolvedAt?: number;
}

// ---- deception ----------------------------------------------------------------

export interface Honeytoken {
  id: string;
  label: string;
  value: string;
  placement: string;
  /** One-time use: the token rotates after a touch. */
  oneTime: boolean;
  createdAt: number;
  touched: boolean;
}

export interface DecoyService {
  id: string;
  name: string;
  kind: 'api' | 'service' | 'database' | 'credential';
  endpoint?: string;
  createdAt: number;
}

export interface DeceptionTouch {
  id: string;
  kind: 'honeytoken' | 'decoy';
  target: string;
  source?: string;
  context?: Record<string, unknown>;
  ts: number;
}

// ---- containment ---------------------------------------------------------------

export type ContainmentKind =
  | 'isolate_workload'
  | 'quarantine_service'
  | 'disable_credential'
  | 'block_ip'
  | 'block_token'
  | 'revoke_sessions'
  | 'rotate_secret'
  | 'preserve_evidence';

export type ContainmentStatus = 'pending_approval' | 'running' | 'completed' | 'denied' | 'failed';

export interface ContainmentAction {
  id: string;
  kind: ContainmentKind;
  target: string;
  reason: string;
  /** 'auto' executes immediately; 'approval' requires human approval (destructive/irreversible/business-impacting). */
  requiresApproval: boolean;
  status: ContainmentStatus;
  requestedBy?: string;
  approvedBy?: string;
  deniedReason?: string;
  createdAt: number;
  completedAt?: number;
}

// ---- bans -----------------------------------------------------------------------

export type BanScope = 'user' | 'ip' | 'token';

export interface BanRecord {
  id: string;
  scope: BanScope;
  value: string;
  reason: string;
  permanent: boolean;
  expiresAt?: number;
  createdBy?: string;
  createdAt: number;
}

// ---- recovery ---------------------------------------------------------------------

export type RecoveryStage = 'restore' | 'validate_integrity' | 'verify_config' | 'reestablish_comms' | 'health_check' | 'resumed';

export interface RecoveryRun {
  id: string;
  target: string;
  fromSnapshot?: string;
  stage: RecoveryStage;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

// ---- continuous improvement --------------------------------------------------------

export interface IncidentRecord {
  id: string;
  title: string;
  severity: FindingSeverity;
  findingIds: string[];
  actionIds: string[];
  status: 'open' | 'reviewed' | 'closed';
  rca?: string;
  lessonsLearned?: string[];
  playbookVersion?: number;
  createdAt: number;
  reviewedAt?: number;
}

export interface PlaybookVersion {
  version: number;
  note: string;
  createdAt: number;
}

// ---- posture / report ---------------------------------------------------------------

export interface DefenseStats {
  riskAssessments: number;
  criticalSessions: number;
  openFindings: number;
  criticalFindings: number;
  containmentActions: number;
  pendingApprovals: number;
  activeBans: number;
  honeytokens: number;
  decoys: number;
  touches: number;
  incidents: number;
  recoveryRuns: number;
  playbookVersion: number;
}

export interface DefenseReport {
  generatedAt: number;
  stats: DefenseStats;
  riskDistribution: Record<RiskLevel, number>;
  findingsBySeverity: Record<FindingSeverity, number>;
  recentFindings: Finding[];
  activeBans: BanRecord[];
  pendingApprovals: ContainmentAction[];
  incidents: IncidentRecord[];
}
