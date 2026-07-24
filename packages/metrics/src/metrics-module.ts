// MetricsModule — kernel module exposing a MetricsRegistry and a tiny set of
// platform-wide instruments (requests, workflow runs, audit events) that other
// modules can update.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { MetricsRegistry } from './registry.js';
import { MetricsEvents } from './types.js';

export class MetricsModule implements IModule {
  readonly id = 'metrics';
  readonly tags = ['core', 'observability'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly registry = new MetricsRegistry();

  // Platform-wide instruments, created lazily on init.
  readonly requests = this.registry.counter('jataqi_requests_total', 'Total HTTP requests handled');
  readonly workflowRuns = this.registry.counter('jataqi_workflow_runs_total', 'Total orchestrator workflow runs');
  readonly workflowDuration = this.registry.histogram('jataqi_workflow_duration_ms', 'Workflow execution duration');
  readonly auditEvents = this.registry.counter('jataqi_audit_events_total', 'Total audit records appended');

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('metrics', this);
    kernel.container.registerValue('metrics.registry', this.registry);
    kernel.logger.info('metrics module initialized');
    await kernel.bus.emit(MetricsEvents.MetricRegistered, { module: 'metrics' });
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  snapshot() {
    return this.registry.samples();
  }

  format() {
    return this.registry.format();
  }
}
