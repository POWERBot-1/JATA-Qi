// OperationsModule — production operations kernel module.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { OperationsEngine } from './engine.js';
import type { BackupVerification, DrDrill, DrillStage, EscalationSla, HealthStatus, OpsHealthReport } from './engine.js';

export const OperationsEvents = Object.freeze({
  OnCallChanged: 'ops.oncall.changed',
  BackupVerified: 'ops.backup.verified',
  BackupVerificationFailed: 'ops.backup.verification_failed',
  DrillStarted: 'ops.drill.started',
  DrillCompleted: 'ops.drill.completed',
  HealthReported: 'ops.health.reported',
} as const);

export class OperationsModule implements IModule {
  readonly id = 'operations';
  readonly tags = ['core', 'operations', 'reliability'] as const;
  readonly dependsOn = [] as const;

  readonly engine = new OperationsEngine();
  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('operations', this);
    kernel.logger.info('operations module initialized (production operations)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  createRotation(input: Parameters<OperationsEngine['createRotation']>[0]) { return this.engine.createRotation(input); }
  currentOnCall(rotationId: string) { return this.engine.currentOnCall(rotationId); }
  escalationChain(rotationId: string, severity: 'sev1' | 'sev2' | 'sev3' | 'sev4') { return this.engine.escalationChain(rotationId, severity); }
  rotations() { return this.engine.rotationsList(); }

  addEscalationSla(sla: Omit<EscalationSla, 'id'>) { return this.engine.addEscalationSla(sla); }
  escalationLevel(severity: string, elapsedMin: number) { return this.engine.escalationLevel(severity, elapsedMin); }
  escalationSlas() { return this.engine.escalationSlas(); }

  verifyBackup(input: Parameters<OperationsEngine['verifyBackup']>[0]): BackupVerification {
    const verification = this.engine.verifyBackup(input);
    try {
      void this.api?.bus.emit(
        verification.ok ? OperationsEvents.BackupVerified : OperationsEvents.BackupVerificationFailed,
        { id: verification.id, backupId: verification.backupId, ok: verification.ok },
      );
    } catch { /* noop */ }
    return verification;
  }
  verifications() { return this.engine.verificationsList(); }

  startDrill(input: { name: string; scope: string; executedBy: string }): DrDrill {
    const drill = this.engine.startDrill(input);
    try { void this.api?.bus.emit(OperationsEvents.DrillStarted, { id: drill.id, name: drill.name }); } catch { /* noop */ }
    return drill;
  }
  advanceDrill(id: string, stage: DrillStage, notes?: string) {
    const drill = this.engine.advanceDrill(id, stage, notes);
    if (drill?.stage === 'completed') try { void this.api?.bus.emit(OperationsEvents.DrillCompleted, { id: drill.id, result: drill.result }); } catch { /* noop */ }
    return drill;
  }
  failDrill(id: string, notes?: string) { return this.engine.failDrill(id, notes); }
  drills() { return this.engine.drillsList(); }

  generateHealthReport(input: { checks: Array<{ name: string; status: HealthStatus; detail?: string }>; uptimePct?: number; openIncidents?: number; rotationId?: string }): OpsHealthReport {
    const report = this.engine.generateHealthReport(input);
    try { void this.api?.bus.emit(OperationsEvents.HealthReported, { id: report.id, overall: report.overall }); } catch { /* noop */ }
    return report;
  }
  reports() { return this.engine.reportsList(); }

  stats() { return this.engine.stats(); }
}

export { OperationsEngine } from './engine.js';
export type { OnCallShift, RotationConfig, EscalationSla, BackupVerification, DrDrill, DrillStage, OpsHealthReport, HealthStatus } from './engine.js';
