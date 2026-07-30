// JATA Qi Cyberdefense — types (#17). Threat intel, vulnerabilities, incidents.
export type ThreatType = 'ip' | 'domain' | 'hash' | 'url' | 'email';
export type VulnSeverity = 'low' | 'medium' | 'high' | 'critical';
export type VulnStatus = 'open' | 'remediated' | 'accepted';
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'investigating' | 'contained' | 'resolved';

export interface ThreatIndicator {
  id: string; type: ThreatType; value: string; severity: VulnSeverity;
  source: string; status: 'active' | 'expired'; createdAt: number;
}
export interface Vulnerability {
  id: string; cveId?: string; title: string; severity: VulnSeverity;
  status: VulnStatus; affectedSystem: string; description?: string;
  reportedBy: string; createdAt: number; updatedAt: number;
}
export interface SecurityIncident {
  id: string; title: string; description?: string; severity: IncidentSeverity;
  status: IncidentStatus; assignee?: string; organizationId?: string;
  createdBy: string; createdAt: number; resolvedAt?: number;
}
export interface SecurityEventLog {
  id: string; type: string; source: string; severity: IncidentSeverity;
  detail?: string; timestamp: number;
}
export const CyberdefenseEvents = Object.freeze({
  IncidentCreated: 'cyber.incident.created',
  IncidentResolved: 'cyber.incident.resolved',
  VulnerabilityReported: 'cyber.vulnerability.reported',
  ThreatDetected: 'cyber.threat.detected',
} as const);
