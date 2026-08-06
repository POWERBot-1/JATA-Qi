// Formal Incident Command Framework — severity classification, role-based
// response, SLA-driven auto-escalation, evidence preservation with
// chain-of-custody hashes, communication protocols, and lifecycle tracking.

import { randomUUID } from 'node:crypto';
import {
  ESCALATION_SLA_MIN, INCIDENT_LIFECYCLE, INCIDENT_SEVERITY_ORDER,
  type IncidentComm, type IncidentEvidence, type IncidentSeverity,
  type IncidentStatus, type IncidentUpdate, type SecurityIncidentRecord,
} from './types.js';
export { ESCALATION_SLA_MIN, INCIDENT_LIFECYCLE, INCIDENT_SEVERITY_ORDER } from './types.js';

export interface IncidentCommandOptions {
  /** Auto-escalate when an incident sits at a status for > SLA minutes. */
  autoEscalate?: boolean;
}

const STATUS_RANK: Record<IncidentStatus, number> = {
  detected: 0, triage: 1, investigating: 2, contained: 3, eradicated: 4, recovered: 5, closed: 6,
};

export class IncidentCommand {
  private incidents: SecurityIncidentRecord[] = [];
  private readonly opts: Required<IncidentCommandOptions>;

  constructor(opts: IncidentCommandOptions = {}) {
    this.opts = { autoEscalate: opts.autoEscalate ?? true };
  }

  /** Map a finding severity (low..critical) onto the 4-tier incident scale. */
  static classifySeverity(severity: string): IncidentSeverity {
    switch (severity) {
      case 'critical': return 'sev1';
      case 'high': return 'sev2';
      case 'medium': return 'sev3';
      default: return 'sev4';
    }
  }

  open(input: { title: string; severity: IncidentSeverity | string; commander?: string; responders?: string[] }): SecurityIncidentRecord {
    const severity = INCIDENT_SEVERITY_ORDER.includes(input.severity as IncidentSeverity)
      ? input.severity as IncidentSeverity
      : IncidentCommand.classifySeverity(input.severity);
    const incident: SecurityIncidentRecord = {
      id: randomUUID(), title: input.title, severity, status: 'detected',
      ...(input.commander ? { commander: input.commander } : {}),
      responders: input.responders ?? [],
      escalations: 0,
      detectedAt: Date.now(),
      timeline: [{ ts: Date.now(), status: 'detected', by: input.commander ?? 'soc', note: 'incident detected' }],
      evidence: [], communications: [],
    };
    this.incidents.unshift(incident);
    return incident;
  }

  get(id: string): SecurityIncidentRecord | undefined {
    return this.incidents.find((i) => i.id === id);
  }

  list(filter?: { severity?: IncidentSeverity; status?: IncidentStatus }): SecurityIncidentRecord[] {
    return this.incidents.filter((i) =>
      (!filter?.severity || i.severity === filter.severity) &&
      (!filter?.status || i.status === filter.status));
  }

  /** Advance an incident through the lifecycle (detected → ... → closed). */
  transition(id: string, status: IncidentStatus, by: string, note: string): SecurityIncidentRecord | undefined {
    const incident = this.get(id);
    if (!incident) return undefined;
    const current = STATUS_RANK[incident.status];
    const next = STATUS_RANK[status];
    if (next < current) throw new Error(`cannot move ${incident.status} → ${status} (lifecycle is forward-only)`);
    incident.status = status;
    if (status === 'closed') incident.closedAt = Date.now();
    incident.timeline.push({ ts: Date.now(), status, by, note });
    return incident;
  }

  /** Assign the incident commander (single point of authority). */
  assignCommander(id: string, commander: string): SecurityIncidentRecord | undefined {
    const incident = this.get(id);
    if (!incident) return undefined;
    incident.commander = commander;
    incident.timeline.push({ ts: Date.now(), status: incident.status, by: commander, note: `commander assigned: ${commander}` });
    return incident;
  }

  addResponder(id: string, responder: string): SecurityIncidentRecord | undefined {
    const incident = this.get(id);
    if (!incident) return undefined;
    if (!incident.responders.includes(responder)) incident.responders.push(responder);
    return incident;
  }

  /** Preserve forensic evidence with chain-of-custody hash. */
  preserveEvidence(id: string, input: { description: string; artifactHash?: string; preservedBy: string }): IncidentEvidence | undefined {
    const incident = this.get(id);
    if (!incident) return undefined;
    const evidence: IncidentEvidence = {
      id: randomUUID(), description: input.description, preservedBy: input.preservedBy,
      ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
      ts: Date.now(),
    };
    incident.evidence.push(evidence);
    return evidence;
  }

  /** Communication protocol: log stakeholder/executive updates. */
  communicate(id: string, input: { channel: IncidentComm['channel']; message: string; by: string; to?: string }): IncidentComm | undefined {
    const incident = this.get(id);
    if (!incident) return undefined;
    const comm: IncidentComm = { ts: Date.now(), channel: input.channel, message: input.message, by: input.by, ...(input.to ? { to: input.to } : {}) };
    incident.communications.push(comm);
    return comm;
  }

  /**
   * SLA / escalation sweep: incidents stuck at a pre-containment status past
   * their severity SLA auto-escalate (commander → on-call SOC lead). Called
   * periodically by the module (or on demand).
   */
  sweepEscalations(now = Date.now()): Array<{ id: string; escalated: boolean; reason?: string }> {
    const out: Array<{ id: string; escalated: boolean; reason?: string }> = [];
    for (const incident of this.incidents) {
      if (incident.status === 'closed') continue;
      const lastUpdate = incident.timeline[incident.timeline.length - 1]!;
      const slaMin = ESCALATION_SLA_MIN[incident.severity];
      const elapsedMin = (now - lastUpdate.ts) / 60_000;
      if (this.opts.autoEscalate && elapsedMin > slaMin && STATUS_RANK[incident.status] < STATUS_RANK.contained) {
        incident.escalations += 1;
        incident.timeline.push({
          ts: now, status: incident.status, by: 'soc-auto',
          note: `auto-escalated (SLA ${slaMin}m exceeded, level ${incident.escalations})`,
        });
        out.push({ id: incident.id, escalated: true, reason: `SLA ${Math.round(elapsedMin)}m > ${slaMin}m` });
      } else {
        out.push({ id: incident.id, escalated: false });
      }
    }
    return out;
  }

  /** Post-incident review: produce the executive report entry. */
  review(id: string, input: { rca: string; lessons: string[]; by: string }): SecurityIncidentRecord | undefined {
    const incident = this.get(id);
    if (!incident) return undefined;
    incident.timeline.push({
      ts: Date.now(), status: incident.status, by: input.by,
      note: `review: ${input.rca} | lessons: ${input.lessons.join('; ')}`,
    });
    return incident;
  }

  /** MTTA/MTTR analytics over closed incidents. */
  metrics(): { avgTimeToTriageMin: number; avgTimeToContainMin: number; avgTimeToResolveMin: number } {
    let triage = 0, contain = 0, resolve = 0, n = 0;
    for (const i of this.incidents) {
      const triageAt = i.timeline.find((t) => t.status === 'triage')?.ts ?? i.detectedAt;
      const containedAt = i.timeline.find((t) => t.status === 'contained')?.ts;
      const closedAt = i.closedAt;
      triage += triageAt - i.detectedAt;
      if (containedAt) contain += containedAt - i.detectedAt;
      if (closedAt) resolve += closedAt - i.detectedAt;
      n += 1;
    }
    const avg = (ms: number): number => (n === 0 ? 0 : Math.round(ms / Math.max(1, n) / 60_000));
    return {
      avgTimeToTriageMin: avg(triage),
      avgTimeToContainMin: contain === 0 ? 0 : Math.round(contain / Math.max(1, this.incidents.filter((i) => i.timeline.some((t) => t.status === 'contained')).length) / 60_000),
      avgTimeToResolveMin: avg(resolve),
    };
  }

  statusDistribution(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of INCIDENT_LIFECYCLE) out[s] = 0;
    for (const i of this.incidents) out[i.status] = (out[i.status] ?? 0) + 1;
    return out;
  }
}
