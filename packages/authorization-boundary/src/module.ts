// Kernel module: installs the A-01 authorization boundary at the composition
// root. Registering this module on a kernel makes the gate available to the
// execution surfaces (agent runtime, action runtime, connector registry) via
// container tokens, and durable audit records are written to the storage
// collection `authorization.decisions` (privacy-safe by construction).
//
// Installing the module is a composition-root obligation for any system that
// performs externally consequential operations; a composition that omits it
// has no authorization boundary and its externally consequential paths must
// be documented as blocked (see the invocation-boundary inventory).

import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import { AuthorizationGate, type A01GateConfig } from './gate.js';
import { CapabilityManifestRegistry } from './capability-manifests.js';
import { CompositeAuditSink, InMemoryAuditSink, StorageAuditSink } from './audit.js';
import type { A01AuditSink } from './types.js';

export const AUTHORIZATION_GATE_TOKEN = 'authorization.gate';
export const AUTHORIZATION_MANIFESTS_TOKEN = 'authorization.manifests';
export const AUTHORIZATION_BROKER_TOKEN = 'authorization.broker';
export const AUTHORIZATION_AUDIT_TOKEN = 'authorization.audit';

export const AUTHORIZATION_DECISIONS_COLLECTION = 'authorization.decisions';

export interface AuthorizationBoundaryModuleConfig extends A01GateConfig {
  /** Disable the durable storage sink (in-memory only). Default: durable. */
  readonly durableAudit?: boolean;
}

export class AuthorizationBoundaryModule implements IModule {
  readonly id = 'authorization-boundary';
  readonly tags = ['core', 'authorization', 'security', 'a01'] as const;
  readonly dependsOn = ['storage'] as const;

  private readonly config: AuthorizationBoundaryModuleConfig;
  private gate!: AuthorizationGate;
  private auditSink!: A01AuditSink;

  constructor(config: AuthorizationBoundaryModuleConfig = {}) {
    this.config = config;
  }

  async init(kernel: KernelApi): Promise<void> {
    const sinks: A01AuditSink[] = [new InMemoryAuditSink()];
    if (this.config.durableAudit !== false) {
      const storage = kernel.getModule<StorageModule>('storage');
      const durable = await storage.collection<{ id: string }>(AUTHORIZATION_DECISIONS_COLLECTION);
      sinks.push(new StorageAuditSink(durable));
    }
    this.auditSink = new CompositeAuditSink(sinks);

    this.gate = new AuthorizationGate({
      now: this.config.now,
      manifests: this.config.manifests ?? new CapabilityManifestRegistry(),
      broker: this.config.broker,
      engine: this.config.engine,
      policyVersion: this.config.policyVersion,
      audit: this.auditSink,
    });

    kernel.container.registerValue(AUTHORIZATION_GATE_TOKEN, this.gate);
    kernel.container.registerValue(AUTHORIZATION_MANIFESTS_TOKEN, this.gate.manifestsRegistry);
    if (this.gate.credentialBroker) {
      kernel.container.registerValue(AUTHORIZATION_BROKER_TOKEN, this.gate.credentialBroker);
    }
    kernel.container.registerValue(AUTHORIZATION_AUDIT_TOKEN, this.auditSink);
    kernel.logger.info('authorization boundary installed (fail-closed, default deny; durable audit on storage)');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* nothing to release */ }

  getService(): AuthorizationGate {
    return this.gate;
  }
}
