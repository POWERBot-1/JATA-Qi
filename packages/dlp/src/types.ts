// Data Loss Prevention — types.

export type SensitiveDataType =
  | 'pii'          // names, emails, national IDs
  | 'card'         // payment card numbers
  | 'credential'   // passwords, API keys, tokens
  | 'secret'       // private keys, secrets
  | 'health'       // health records
  | 'source_code'; // proprietary source / internal docs

export type DlpAction = 'allow' | 'block' | 'redact' | 'quarantine' | 'notify';
export type DlpChannel = 'email' | 'api_response' | 'upload' | 'export' | 'clipboard' | 'log' | 'ai_prompt';

export interface DlpRule {
  id: string;
  name: string;
  dataType: SensitiveDataType;
  /** Detection patterns (regex, tested case-insensitively). */
  patterns: string[];
  /** Optional Shannon-entropy threshold (0..8) for high-entropy secrets. */
  minEntropy?: number;
  /** Channels the rule applies to; empty = all. */
  channels?: DlpChannel[];
  /** Action when a match exceeds the threshold. */
  action: DlpAction;
  /** Matches per scan before the action triggers (burst gate). */
  threshold?: number;
  /** Redaction replacement (for redact action). */
  redactionMask?: string;
  /** Notify recipient(s) (for notify action). */
  notifyTo?: string[];
}

export interface DlpScanResult {
  ruleId: string;
  dataType: SensitiveDataType;
  matches: number;
  redacted: string;
  riskScore: number;
  action: DlpAction;
}

export interface DlpIncident {
  id: string;
  ruleId: string;
  dataType: SensitiveDataType;
  channel: DlpChannel;
  /** Actor / principal attempting the transfer. */
  actor?: string;
  /** Destination (email address, endpoint, ...). */
  destination?: string;
  matches: number;
  action: DlpAction;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Redacted snippet for evidence (never raw content). */
  evidence: string;
  createdAt: number;
  status: 'open' | 'reviewed' | 'resolved';
}

export interface DlpPolicyStats {
  rules: number;
  scans: number;
  incidents: number;
  openIncidents: number;
  blocked: number;
  redacted: number;
  quarantined: number;
  byDataType: Record<string, number>;
}

export const DlpEvents = Object.freeze({
  IncidentCreated: 'dlp.incident.created',
  Blocked: 'dlp.blocked',
  Redacted: 'dlp.redacted',
} as const);
