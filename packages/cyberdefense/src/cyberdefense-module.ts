// CyberdefenseModule — threat indicators, vulnerability tracking, security incidents (#17).
import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { CyberdefenseEvents } from './types.js';
import type { IncidentSeverity, IncidentStatus, SecurityEventLog, SecurityIncident, ThreatIndicator, Vulnerability, VulnSeverity, VulnStatus } from './types.js';

const COL = { THREAT: 'cyber.threats', VULN: 'cyber.vulns', INC: 'cyber.incidents', EVT: 'cyber.events' };

export class CyberdefenseModule implements IModule {
  readonly id = 'cyberdefense'; readonly tags = ['core', 'security'] as const; readonly dependsOn = ['storage'] as const;
  private api!: KernelApi; private threats!: ICollection<ThreatIndicator>;
  private vulns!: ICollection<Vulnerability>; private incidents!: ICollection<SecurityIncident>;
  private events!: ICollection<SecurityEventLog>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>> };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.threats = await C<ThreatIndicator>(COL.THREAT); this.vulns = await C<Vulnerability>(COL.VULN);
    this.incidents = await C<SecurityIncident>(COL.INC); this.events = await C<SecurityEventLog>(COL.EVT);
    kernel.container.registerValue('cyberdefense', this);
    kernel.logger.info('cyberdefense module initialized');
  }
  async start(_k: KernelApi): Promise<void> {} async stop(_k: KernelApi): Promise<void> {}

  // --- threat indicators ---
  async addThreat(input: { type: ThreatIndicator['type']; value: string; severity: VulnSeverity; source: string }): Promise<ThreatIndicator> {
    const t: ThreatIndicator = { id: randomUUID(), ...input, status: 'active', createdAt: Date.now() };
    await this.threats.put(t); await this.audit(input.source, 'threat_added', { id: t.id, value: input.value });
    return t;
  }
  async checkValue(value: string): Promise<{ matched: boolean; indicators: ThreatIndicator[] }> {
    const all = (await this.threats.all()).filter((t) => t.status === 'active');
    const matched = all.filter((t) => t.value === value);
    if (matched.length > 0) await this.api.bus.emit(CyberdefenseEvents.ThreatDetected, { value, count: matched.length });
    return { matched: matched.length > 0, indicators: matched };
  }
  async listThreats(status?: string): Promise<ThreatIndicator[]> {
    const all = await this.threats.all(); return status ? all.filter((t) => t.status === status) : all;
  }

  // --- vulnerabilities ---
  async reportVulnerability(input: { cveId?: string; title: string; severity: VulnSeverity; affectedSystem: string; description?: string; reportedBy: string }): Promise<Vulnerability> {
    const now = Date.now();
    const v: Vulnerability = { id: randomUUID(), ...input, status: 'open', createdAt: now, updatedAt: now };
    await this.vulns.put(v);
    await this.api.bus.emit(CyberdefenseEvents.VulnerabilityReported, { id: v.id, severity: v.severity });
    if (v.severity === 'critical') await this.notify(v.reportedBy, 'cyber', 'Critical vulnerability reported', `${v.title} on ${v.affectedSystem}`);
    await this.audit(input.reportedBy, 'vulnerability_reported', { id: v.id, severity: v.severity });
    return v;
  }
  async updateVulnerability(id: string, status: VulnStatus, updatedBy: string): Promise<Vulnerability> {
    const v = await this.vulns.get(id); if (!v) throw new Error(`cyberdefense: vulnerability "${id}" not found`);
    const u: Vulnerability = { ...v, status, updatedAt: Date.now() }; await this.vulns.put(u);
    await this.audit(updatedBy, 'vulnerability_updated', { id, status });
    return u;
  }
  async listVulnerabilities(severity?: VulnSeverity, status?: VulnStatus): Promise<Vulnerability[]> {
    let all = await this.vulns.all();
    if (severity) all = all.filter((v) => v.severity === severity);
    if (status) all = all.filter((v) => v.status === status);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- incidents ---
  async createIncident(input: { title: string; description?: string; severity: IncidentSeverity; createdBy: string; organizationId?: string }): Promise<SecurityIncident> {
    const inc: SecurityIncident = { id: randomUUID(), ...input, status: 'open', createdAt: Date.now() };
    await this.incidents.put(inc);
    await this.api.bus.emit(CyberdefenseEvents.IncidentCreated, { id: inc.id, severity: inc.severity });
    if (inc.severity === 'critical' || inc.severity === 'high') await this.notify(input.createdBy, 'cyber', `Security incident: ${inc.title}`, inc.description ?? '');
    await this.audit(input.createdBy, 'incident_created', { id: inc.id, severity: inc.severity });
    return inc;
  }
  async updateIncident(id: string, changes: Partial<Pick<SecurityIncident, 'status' | 'assignee' | 'severity'>>, updatedBy: string): Promise<SecurityIncident> {
    const inc = await this.incidents.get(id); if (!inc) throw new Error(`cyberdefense: incident "${id}" not found`);
    const u: SecurityIncident = { ...inc, ...changes, ...(changes.status === 'resolved' ? { resolvedAt: Date.now() } : {}) };
    await this.incidents.put(u);
    if (changes.status === 'resolved') await this.api.bus.emit(CyberdefenseEvents.IncidentResolved, { id });
    await this.audit(updatedBy, 'incident_updated', { id, changes });
    return u;
  }
  async listIncidents(status?: IncidentStatus, severity?: IncidentSeverity): Promise<SecurityIncident[]> {
    let all = await this.incidents.all();
    if (status) all = all.filter((i) => i.status === status);
    if (severity) all = all.filter((i) => i.severity === severity);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- security events ---
  async recordEvent(input: { type: string; source: string; severity: IncidentSeverity; detail?: string }): Promise<SecurityEventLog> {
    const e: SecurityEventLog = { id: randomUUID(), ...input, timestamp: Date.now() };
    await this.events.put(e); return e;
  }
  async listEvents(severity?: IncidentSeverity, limit = 100): Promise<SecurityEventLog[]> {
    let all = await this.events.all();
    if (severity) all = all.filter((e) => e.severity === severity);
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try { const s = this.api.getModule('security') as unknown as { audit: (r: Record<string, unknown>) => Promise<unknown> } | undefined; if (s?.audit) await s.audit({ actor, action: `cyber.${action}`, result: 'success', detail }); } catch {}
  }
  private async notify(r: string, t: string, title: string, body: string): Promise<void> {
    try { const n = this.api.getModule('notifications') as unknown as { notify: (r: string, p: { type: string; title: string; body?: string }) => Promise<unknown> } | undefined; if (n?.notify) await n.notify(r, { type: t, title, body }); } catch {}
  }
}
