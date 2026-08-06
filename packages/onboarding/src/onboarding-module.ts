// OnboardingModule — guided enterprise onboarding kernel module.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { OnboardingEngine } from './engine.js';
import type { OnboardingInvite, OnboardingRun, OrgProfile, SetupStep, TenantProvision } from './engine.js';

export const OnboardingEvents = Object.freeze({
  OnboardingStarted: 'onboarding.started',
  TenantProvisioned: 'onboarding.tenant.provisioned',
  InviteSent: 'onboarding.invite.sent',
  OnboardingCompleted: 'onboarding.completed',
} as const);

export class OnboardingModule implements IModule {
  readonly id = 'onboarding';
  readonly tags = ['core', 'commercial', 'enterprise'] as const;
  readonly dependsOn = [] as const;

  readonly engine = new OnboardingEngine();
  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('onboarding', this);
    kernel.logger.info('onboarding module initialized (guided enterprise setup)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  startOnboarding(input: { orgName: string; adminEmail: string; industry?: string; region?: string }): OnboardingRun {
    const run = this.engine.start(input);
    try { void this.api?.bus.emit(OnboardingEvents.OnboardingStarted, { id: run.id, orgName: run.orgName }); } catch { /* noop */ }
    return run;
  }
  getRun(id: string) { return this.engine.getRun(id); }
  listRuns() { return this.engine.listRuns(); }
  progress(id: string) { return this.engine.progress(id); }

  setOrgProfile(runId: string, profile: OrgProfile) { return this.engine.setOrgProfile(runId, profile); }
  completeAdmin(runId: string, adminRoles?: string[]) { return this.engine.completeAdmin(runId, adminRoles); }

  provisionTenant(runId: string, input: { region?: string; storageDriver?: TenantProvision['storageDriver']; quotas?: Record<string, number> } = {}): OnboardingRun {
    const run = this.engine.provisionTenant(runId, input);
    try { void this.api?.bus.emit(OnboardingEvents.TenantProvisioned, { id: run.id, tenantId: run.tenant?.tenantId }); } catch { /* noop */ }
    return run;
  }

  invite(runId: string, input: { email: string; role: string }): OnboardingInvite {
    const invite = this.engine.invite(runId, input);
    try { void this.api?.bus.emit(OnboardingEvents.InviteSent, { id: invite.id, email: invite.email, role: invite.role }); } catch { /* noop */ }
    return invite;
  }
  acceptInvite(runId: string, inviteId: string) { return this.engine.acceptInvite(runId, inviteId); }
  completeInvitations(runId: string) { return this.engine.completeInvitations(runId); }

  generateSampleData(runId: string, kinds: string[], seed?: number) { return this.engine.generateSampleData(runId, kinds, seed); }
  skipSampleData(runId: string) { return this.engine.skipSampleData(runId); }

  complete(runId: string): OnboardingRun {
    const run = this.engine.complete(runId);
    try { void this.api?.bus.emit(OnboardingEvents.OnboardingCompleted, { id: run.id, orgName: run.orgName }); } catch { /* noop */ }
    return run;
  }

  stats() { return this.engine.stats(); }
}

export { OnboardingEngine, DEFAULT_SETUP_STEPS } from './engine.js';
export type { OnboardingRun, OrgProfile, SetupStep, SetupStepId, TenantProvision, OnboardingInvite, SampleDataSet } from './engine.js';
