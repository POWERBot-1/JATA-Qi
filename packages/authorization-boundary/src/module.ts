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
import { KernelInternalIdentity, KERNEL_INTERNAL_IDENTITY_TOKEN } from './kernel-principal.js';
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

/**
 * R1: the id of the mandatory kernel security invariant that makes the A-01
 * boundary authoritative. Declared by `requireAuthorizationBoundary()` and
 * evaluated by the kernel after init, before any module starts.
 */
export const A01_MANDATORY_BOUNDARY_INVARIANT = 'a01.authorization-boundary.mandatory';

/** R1: the module id the invariant requires to be present and initialized. */
export const AUTHORIZATION_BOUNDARY_MODULE_ID = 'authorization-boundary';

/**
 * R1 — declare the A-01 authorization boundary MANDATORY for this kernel.
 *
 * The composition root calls this alongside registering the module. The
 * invariant is evaluated at the end of the init phase and fails boot unless
 * ALL of the following hold:
 *
 *   1. the `authorization-boundary` module is registered;
 *   2. it reached the `initialized` state (it actually ran, it was not merely
 *      present in the module map);
 *   3. the container exposes an authorization gate at the canonical token;
 *   4. that binding is SEALED — no later registration, module ordering, test
 *      override, or `container.clear()` can substitute a different gate;
 *   5. the sealed binding is the very gate the initialized module built (a
 *      second, non-authoritative gate cannot stand in for it);
 *   6. a verified kernel-internal service identity is installed and sealed.
 *
 * There is no configuration, environment variable, or flag that removes the
 * invariant once declared, and re-declaring it is a hard error.
 */
export function requireAuthorizationBoundary(kernel: KernelApi): void {
  kernel.requireSecurityInvariant({
    id: A01_MANDATORY_BOUNDARY_INVARIANT,
    description:
      'the A-01 authorization boundary must be present, initialized, sealed and authoritative in this composition',
    check(k: KernelApi): boolean | string {
      let boundary: AuthorizationBoundaryModule;
      try {
        boundary = k.getModule<AuthorizationBoundaryModule>(AUTHORIZATION_BOUNDARY_MODULE_ID);
      } catch {
        return `module "${AUTHORIZATION_BOUNDARY_MODULE_ID}" is not registered in this composition`;
      }
      if (!(boundary instanceof AuthorizationBoundaryModule)) {
        return `module "${AUTHORIZATION_BOUNDARY_MODULE_ID}" is not an AuthorizationBoundaryModule; a substitute module cannot satisfy the boundary`;
      }
      const state = k.getModuleState(AUTHORIZATION_BOUNDARY_MODULE_ID);
      if (state !== 'initialized' && state !== 'starting' && state !== 'started') {
        return `module "${AUTHORIZATION_BOUNDARY_MODULE_ID}" is in state "${state}" and was never initialized`;
      }
      if (!k.container.has(AUTHORIZATION_GATE_TOKEN)) {
        return `container token "${AUTHORIZATION_GATE_TOKEN}" is unbound; enforcement surfaces would resolve no boundary`;
      }
      if (!k.container.isSealed(AUTHORIZATION_GATE_TOKEN)) {
        return `container token "${AUTHORIZATION_GATE_TOKEN}" is bound but NOT sealed; the boundary could be substituted after boot`;
      }
      const bound = k.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN);
      if (!(bound instanceof AuthorizationGate)) {
        return `container token "${AUTHORIZATION_GATE_TOKEN}" is not an AuthorizationGate`;
      }
      if (bound !== boundary.getService()) {
        return 'the bound gate is not the gate the initialized authorization-boundary module built; a non-authoritative gate cannot substitute for the boundary';
      }
      if (!k.container.has(KERNEL_INTERNAL_IDENTITY_TOKEN) || !k.container.isSealed(KERNEL_INTERNAL_IDENTITY_TOKEN)) {
        return 'the verified kernel-internal service identity is missing or unsealed; kernel-internal workers could not establish an attributable principal';
      }
      return true;
    },
  });
}

export interface AuthorizationBoundaryModuleConfig extends A01GateConfig {
  /** Disable the durable storage sink (in-memory only). Default: durable. */
  readonly durableAudit?: boolean;
}

export class AuthorizationBoundaryModule implements IModule {
  readonly id = 'authorization-boundary';
  readonly tags = ['core', 'authorization', 'security', 'a01'] as const;
  readonly dependsOn = ['storage'] as const;

  private readonly config: AuthorizationBoundaryModuleConfig;
  private gate: AuthorizationGate | undefined;
  private auditSink!: A01AuditSink;
  private kernelIdentity: KernelInternalIdentity | undefined;

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

    // R1/D2: mint the process kernel identity BEFORE the gate, so the gate can
    // verify kernel-internal service principals against it.
    this.kernelIdentity = new KernelInternalIdentity({ now: this.config.now });
    const kernelIdentity = this.kernelIdentity;

    this.gate = new AuthorizationGate({
      now: this.config.now,
      // Only principals THIS process actually minted verify. A forged or
      // foreign KERNEL_INTERNAL principal is not a kernel worker.
      verifyKernelPrincipal: (principal, scope) =>
        kernelIdentity.verify(principal, scope as Parameters<KernelInternalIdentity['verify']>[1]),
      manifests: this.config.manifests ?? new CapabilityManifestRegistry(),
      broker: this.config.broker,
      engine: this.config.engine,
      policyVersion: this.config.policyVersion,
      audit: this.auditSink,
    });

    // R1: SEALED bindings. A sealed token cannot be replaced, overridden,
    // unregistered, or cleared — module registration order, a later module,
    // or a test fixture cannot substitute a different (or absent) boundary.
    kernel.container.registerSealed(AUTHORIZATION_GATE_TOKEN, this.gate);
    kernel.container.registerSealed(KERNEL_INTERNAL_IDENTITY_TOKEN, this.kernelIdentity);
    kernel.container.registerValue(AUTHORIZATION_MANIFESTS_TOKEN, this.gate.manifestsRegistry);
    if (this.gate.credentialBroker) {
      kernel.container.registerValue(AUTHORIZATION_BROKER_TOKEN, this.gate.credentialBroker);
    }
    kernel.container.registerValue(AUTHORIZATION_AUDIT_TOKEN, this.auditSink);
    kernel.logger.info('authorization boundary installed (fail-closed, default deny; durable audit on storage)');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* nothing to release */ }

  /**
   * The authoritative gate. Throws if the module has not been initialized —
   * an uninitialized boundary must never be silently treated as "no boundary,
   * therefore allow".
   */
  getService(): AuthorizationGate {
    if (!this.gate) {
      throw new Error(
        'AuthorizationBoundaryModule: the boundary has not been initialized; there is no authoritative gate to hand out (fail-closed).',
      );
    }
    return this.gate;
  }

  /** The process's verified kernel-internal service identity. */
  getKernelIdentity(): KernelInternalIdentity {
    if (!this.kernelIdentity) {
      throw new Error('AuthorizationBoundaryModule: kernel-internal identity is not initialized (fail-closed).');
    }
    return this.kernelIdentity;
  }
}
