// Governed capability registry.
//
// The loop invokes every engine operation through this registry — never by
// reaching into a package. Each capability carries its governance metadata
// (side-effect class, authority requirement, grants, timeout). The registry
// performs the *capability-level* guardrails; external *action* authority is
// additionally enforced by the commercial control plane / action runtime.

import type {
  CapabilityInvocationContext,
  CapabilityResult,
  GovernedCapability,
  LoopStage,
} from './types.js';
import { UnifiedLoopError } from './types.js';

export class CapabilityRegistry {
  private readonly byStage = new Map<LoopStage, GovernedCapability>();
  private readonly byId = new Map<string, GovernedCapability>();

  register(capability: GovernedCapability): void {
    if (this.byStage.has(capability.stage)) {
      throw new UnifiedLoopError(`A capability is already registered for stage ${capability.stage}.`);
    }
    if (this.byId.has(capability.capabilityId)) {
      throw new UnifiedLoopError(`Capability ${capability.capabilityId} is already registered.`);
    }
    this.byStage.set(capability.stage, capability);
    this.byId.set(capability.capabilityId, capability);
  }

  get(stage: LoopStage): GovernedCapability | undefined {
    return this.byStage.get(stage);
  }

  getById(id: string): GovernedCapability | undefined {
    return this.byId.get(id);
  }

  list(): GovernedCapability[] {
    return [...this.byId.values()];
  }

  /**
   * Invoke a capability with a hard timeout and tenant-continuity guard.
   * Capabilities themselves enforce engine-level authorization; this wrapper
   * guarantees the loop never blocks forever and never loses tenant context.
   */
  async invoke(capability: GovernedCapability, ctx: CapabilityInvocationContext): Promise<CapabilityResult> {
    // Tenant continuity: the actor's tenant must be present throughout.
    if (!ctx.actor.tenantId.trim() || !ctx.state.tenantId.trim()) {
      throw new UnifiedLoopError('Tenant context disappeared before capability invocation (fail-closed).');
    }
    if (ctx.actor.tenantId !== ctx.state.tenantId) {
      throw new UnifiedLoopError('Capability actor tenant does not match loop tenant (fail-closed).');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), capability.timeoutMs);
    // Link caller cancellation.
    const onAbort = (): void => controller.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await capability.invoke({ ...ctx, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }
}
