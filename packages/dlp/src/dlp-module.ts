// DlpModule — Data Loss Prevention kernel module.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { DlpEngine } from './engine.js';
import { DlpEvents } from './types.js';
import type { DlpAction, DlpChannel, DlpIncident, DlpPolicyStats, DlpRule, SensitiveDataType } from './types.js';

export class DlpModule implements IModule {
  readonly id = 'dlp';
  readonly tags = ['core', 'security', 'governance'] as const;
  readonly dependsOn = [] as const;

  readonly engine: DlpEngine;
  private api!: KernelApi;

  constructor(rules?: DlpRule[]) {
    this.engine = new DlpEngine((incident) => {
      try {
        void this.api?.bus.emit(DlpEvents.IncidentCreated, {
          id: incident.id, ruleId: incident.ruleId, dataType: incident.dataType,
          channel: incident.channel, severity: incident.severity, action: incident.action,
          ...(incident.actor ? { actor: incident.actor } : {}),
          ...(incident.destination ? { destination: incident.destination } : {}),
        });
      } catch { /* bus may be mid-boot */ }
    }, rules);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('dlp', this);
    kernel.logger.info('dlp module initialized (data loss prevention)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  rules() { return this.engine.rulesList(); }
  addRule(rule: DlpRule) { this.engine.addRule(rule); }
  upsertRule(rule: DlpRule) { this.engine.upsertRule(rule); }
  removeRule(id: string) { return this.engine.removeRule(id); }

  scan(input: { content: string; channel: DlpChannel; actor?: string; destination?: string }): {
    results: DlpScanResultLike[]; incident?: DlpIncident; action: DlpAction;
  } {
    const result = this.engine.scan(input);
    if (result.action === 'block') try { void this.api?.bus.emit(DlpEvents.Blocked, { channel: input.channel, actor: input.actor }); } catch { /* noop */ }
    if (result.action === 'redact') try { void this.api?.bus.emit(DlpEvents.Redacted, { channel: input.channel }); } catch { /* noop */ }
    return result;
  }

  incidents(filter?: { dataType?: SensitiveDataType; status?: DlpIncident['status']; channel?: DlpChannel }) {
    return this.engine.incidentsList(filter);
  }

  updateIncident(id: string, status: DlpIncident['status']) { return this.engine.updateIncident(id, status); }

  stats(): DlpPolicyStats { return this.engine.stats(); }
}

export interface DlpScanResultLike {
  ruleId: string;
  dataType: SensitiveDataType;
  matches: number;
  redacted: string;
  riskScore: number;
  action: DlpAction;
}

export { DlpEngine, shannonEntropy, DEFAULT_DLP_RULES } from './engine.js';
export { DlpEvents } from './types.js';
