// Onboarding — guided enterprise setup: organization setup, tenant
// provisioning, administrator onboarding, user invitations with role
// assignment, and sample-data generation.

import { createHash, randomUUID } from 'node:crypto';

export type SetupStepId = 'org_profile' | 'admin_account' | 'tenant_provision' | 'invitations' | 'sample_data' | 'complete';

export interface SetupStep {
  id: SetupStepId;
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  completedAt?: number;
}

export interface OrgProfile {
  name: string;
  slug: string;
  industry?: string;
  region?: string;
  sizeBand?: string;
}

export interface TenantProvision {
  tenantId: string;
  namespace: string;
  region: string;
  storageDriver: 'memory' | 'filesystem' | 'sqlite' | 'postgres';
  quotas: Record<string, number>;
  provisionedAt: number;
}

export interface OnboardingInvite {
  id: string;
  email: string;
  role: string;
  status: 'pending' | 'accepted';
  token: string;
  createdAt: number;
  acceptedAt?: number;
}

export interface SampleDataSet {
  id: string;
  kind: string;
  label: string;
  /** Counts per entity generated. */
  generated: Record<string, number>;
  createdAt: number;
}

export interface OnboardingRun {
  id: string;
  orgName: string;
  adminEmail: string;
  startedAt: number;
  completedAt?: number;
  steps: SetupStep[];
  tenant?: TenantProvision;
  invites: OnboardingInvite[];
  sampleData?: SampleDataSet;
}


// ---- Phase 5: customer account lifecycle -------------------------------------

export type CustomerAccountStatus = 'active' | 'suspended' | 'offboarding' | 'offboarded';

export interface CustomerAccount {
  id: string;
  orgName: string;
  slug: string;
  tenantId: string;
  adminEmail: string;
  /** Commerce customer id (billing identity). */
  customerId: string;
  /** Active subscription id (commerce). */
  subscriptionId?: string;
  planSlug?: string;
  status: CustomerAccountStatus;
  createdAt: number;
  updatedAt: number;
  suspension?: { reason: string; at: number };
  offboarding?: {
    retentionDays: number;
    deleteData: boolean;
    startedAt: number;
    completedAt?: number;
    /** Deletion evidence hash (data-retention workflow). */
    evidenceHash?: string;
  };
}

export interface OffboardingRecord {
  id: string;
  accountId: string;
  orgName: string;
  tenantId: string;
  retentionDays: number;
  deleteData: boolean;
  startedAt: number;
  completedAt?: number;
  evidenceHash?: string;
  status: 'pending' | 'completed';
}

export const DEFAULT_SETUP_STEPS: SetupStep[] = [
  { id: 'org_profile', name: 'Organization profile', description: 'Name, industry, region, size band', status: 'pending' },
  { id: 'admin_account', name: 'Administrator account', description: 'Primary admin identity + roles', status: 'pending' },
  { id: 'tenant_provision', name: 'Tenant provisioning', description: 'Isolated namespace + quotas', status: 'pending' },
  { id: 'invitations', name: 'Team invitations', description: 'Invite users with roles', status: 'pending' },
  { id: 'sample_data', name: 'Sample data', description: 'Optional demo datasets', status: 'pending' },
  { id: 'complete', name: 'Complete', description: 'Ready for production use', status: 'pending' },
];

/** Sample data generators per kind — deterministic counts for tests/demos. */
const SAMPLE_GENERATORS: Record<string, (seed: number) => Record<string, number>> = {
  marketplace: (seed) => ({ storefronts: 2 + (seed % 3), listings: 8 + (seed % 7), reviews: 12 + (seed % 9) }),
  tanya: (seed) => ({ personas: 1 + (seed % 3), conversations: 4 + (seed % 5) }),
  mobility: (seed) => ({ vehicles: 3 + (seed % 4), drivers: 2 + (seed % 3), trips: 6 + (seed % 6) }),
  restaurants: (seed) => ({ venues: 1 + (seed % 2), menus: 3 + (seed % 4), tables: 8 + (seed % 5) }),
};

export class OnboardingEngine {
  private runs = new Map<string, OnboardingRun>();
  private static runCounter = 0;

  start(input: { orgName: string; adminEmail: string; industry?: string; region?: string }): OnboardingRun {
    if (!input.orgName || !input.adminEmail) throw new Error('orgName and adminEmail are required');
    const run: OnboardingRun = {
      id: randomUUID(),
      orgName: input.orgName,
      adminEmail: input.adminEmail,
      startedAt: Date.now(),
      steps: DEFAULT_SETUP_STEPS.map((s) => ({ ...s })),
      invites: [],
    };
    this.runs.set(run.id, run);
    // Kick off step 1.
    this.setStep(run.id, 'org_profile', 'in_progress');
    return run;
  }

  getRun(id: string): OnboardingRun | undefined {
    return this.runs.get(id);
  }

  listRuns(): OnboardingRun[] {
    return [...this.runs.values()];
  }

  private setStep(runId: string, step: SetupStepId, status: SetupStep['status']): OnboardingRun {
    const run = this.runs.get(runId)!;
    const s = run.steps.find((x) => x.id === step)!;
    s.status = status;
    if (status === 'done' || status === 'skipped') s.completedAt = Date.now();
    return run;
  }

  /** Step 1: organization profile. */
  setOrgProfile(runId: string, profile: OrgProfile): OnboardingRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown onboarding run ${runId}`);
    this.setStep(runId, 'org_profile', 'done');
    this.setStep(runId, 'admin_account', 'in_progress');
    (run as OnboardingRun & { profile?: OrgProfile }).profile = profile;
    return run;
  }

  /** Step 2: administrator onboarding (role assignment). */
  completeAdmin(runId: string, adminRoles: string[] = ['admin', 'developer']): OnboardingRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown onboarding run ${runId}`);
    (run as OnboardingRun & { adminRoles?: string[] }).adminRoles = adminRoles;
    this.setStep(runId, 'admin_account', 'done');
    this.setStep(runId, 'tenant_provision', 'in_progress');
    return run;
  }

  /**
   * Step 3: automated tenant provisioning — isolated namespace, region,
   * storage driver, and per-feature quotas.
   */
  provisionTenant(runId: string, input: { region?: string; storageDriver?: TenantProvision['storageDriver']; quotas?: Record<string, number> } = {}): OnboardingRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown onboarding run ${runId}`);
    OnboardingEngine.runCounter += 1;
    const tenant: TenantProvision = {
      tenantId: `tenant-${OnboardingEngine.runCounter.toString().padStart(4, '0')}`,
      namespace: `org_${run.orgName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      region: input.region ?? 'nbo-1',
      storageDriver: input.storageDriver ?? 'memory',
      quotas: { users: 25, storage_gb: 10, api_calls_per_day: 1000, ...(input.quotas ?? {}) },
      provisionedAt: Date.now(),
    };
    run.tenant = tenant;
    this.setStep(runId, 'tenant_provision', 'done');
    this.setStep(runId, 'invitations', 'in_progress');
    return run;
  }

  /** Step 4: user invitations with role assignment. */
  invite(runId: string, input: { email: string; role: string }): OnboardingInvite {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown onboarding run ${runId}`);
    const invite: OnboardingInvite = {
      id: randomUUID(), email: input.email, role: input.role,
      status: 'pending', token: randomUUID().replace(/-/g, '').slice(0, 16),
      createdAt: Date.now(),
    };
    run.invites.push(invite);
    return invite;
  }

  acceptInvite(runId: string, inviteId: string): OnboardingInvite | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const invite = run.invites.find((i) => i.id === inviteId);
    if (!invite) return undefined;
    invite.status = 'accepted';
    invite.acceptedAt = Date.now();
    return invite;
  }

  completeInvitations(runId: string): OnboardingRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown onboarding run ${runId}`);
    this.setStep(runId, 'invitations', 'done');
    this.setStep(runId, 'sample_data', 'in_progress');
    return run;
  }

  /** Step 5: sample data generation (skipable). */
  generateSampleData(runId: string, kinds: string[], seed = Date.now() % 100): OnboardingRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown onboarding run ${runId}`);
    const generated: Record<string, number> = {};
    for (const kind of kinds) {
      const gen = SAMPLE_GENERATORS[kind];
      if (gen) Object.assign(generated, gen(seed));
    }
    run.sampleData = { id: randomUUID(), kind: kinds.join(','), label: `sample-${kinds.join('-')}`, generated, createdAt: Date.now() };
    this.setStep(runId, 'sample_data', 'done');
    this.setStep(runId, 'complete', 'in_progress');
    return run;
  }

  skipSampleData(runId: string): OnboardingRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown onboarding run ${runId}`);
    this.setStep(runId, 'sample_data', 'skipped');
    this.setStep(runId, 'complete', 'in_progress');
    return run;
  }

  /** Step 6: complete the onboarding run. */
  complete(runId: string): OnboardingRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown onboarding run ${runId}`);
    this.setStep(runId, 'complete', 'done');
    run.completedAt = Date.now();
    return run;
  }

  /** Progress of a run: done/total steps. */
  progress(runId: string): { done: number; total: number; pct: number } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const done = run.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    return { done, total: run.steps.length, pct: Math.round((done / run.steps.length) * 100) };
  }

  // ---- Phase 5: customer account lifecycle ---------------------------------

  private accounts = new Map<string, CustomerAccount>();
  private offboardings: OffboardingRecord[] = [];

  /** Create a customer account binding an onboarding run to a billing identity. */
  createCustomerAccount(input: {
    orgName: string; slug: string; adminEmail: string; tenantId?: string;
    customerId: string; planSlug?: string; subscriptionId?: string;
  }): CustomerAccount {
    if (!input.orgName || !input.customerId) throw new Error('orgName and customerId are required');
    if ([...this.accounts.values()].some((a) => a.customerId === input.customerId)) {
      throw new Error(`customer ${input.customerId} already has an account`);
    }
    const account: CustomerAccount = {
      id: randomUUID(), orgName: input.orgName, slug: input.slug,
      tenantId: input.tenantId ?? `tenant-${(OnboardingEngine.runCounter++).toString().padStart(4, '0')}`,
      adminEmail: input.adminEmail, customerId: input.customerId,
      ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
      ...(input.planSlug ? { planSlug: input.planSlug } : {}),
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.accounts.set(account.id, account);
    return account;
  }

  getAccount(id: string): CustomerAccount | undefined { return this.accounts.get(id); }

  accountByCustomer(customerId: string): CustomerAccount | undefined {
    return [...this.accounts.values()].find((a) => a.customerId === customerId);
  }

  listAccounts(filter?: { status?: CustomerAccountStatus }): CustomerAccount[] {
    return [...this.accounts.values()].filter((a) => !filter?.status || a.status === filter.status);
  }

  /** Bind a subscription to an account (plan assignment). */
  assignSubscription(accountId: string, subscriptionId: string, planSlug: string): CustomerAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    account.subscriptionId = subscriptionId;
    account.planSlug = planSlug;
    account.updatedAt = Date.now();
    return account;
  }

  suspendAccount(accountId: string, reason: string): CustomerAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    account.status = 'suspended';
    account.suspension = { reason, at: Date.now() };
    account.updatedAt = Date.now();
    return account;
  }

  reactivateAccount(accountId: string): CustomerAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    account.status = 'active';
    account.suspension = undefined;
    account.updatedAt = Date.now();
    return account;
  }

  /**
   * Start tenant offboarding: records the data-retention policy (retention
   * days, whether data is deleted or retained per policy) and marks the
   * account offboarding.
   */
  startOffboarding(accountId: string, input: { retentionDays?: number; deleteData?: boolean }): CustomerAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    account.status = 'offboarding';
    account.offboarding = {
      retentionDays: input.retentionDays ?? 30,
      deleteData: input.deleteData ?? true,
      startedAt: Date.now(),
    };
    account.updatedAt = Date.now();
    return account;
  }

  /**
   * Execute the offboarding: mark the account offboarded and produce a
   * deletion evidence record (data-retention workflow) with a content hash.
   */
  executeOffboarding(accountId: string): OffboardingRecord {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    const policy = account.offboarding ?? { retentionDays: 30, deleteData: true, startedAt: Date.now() };
    const evidence = `${account.tenantId}:${policy.retentionDays}:${policy.deleteData ? 'deleted' : 'retained'}:${Date.now()}`;
    const record: OffboardingRecord = {
      id: randomUUID(), accountId, orgName: account.orgName, tenantId: account.tenantId,
      retentionDays: policy.retentionDays, deleteData: policy.deleteData,
      startedAt: policy.startedAt, completedAt: Date.now(),
      evidenceHash: createHash('sha256').update(evidence).digest('hex'),
      status: 'completed',
    };
    this.offboardings.push(record);
    account.status = 'offboarded';
    account.offboarding = { ...policy, completedAt: Date.now(), evidenceHash: record.evidenceHash };
    account.updatedAt = Date.now();
    return record;
  }

  offboardingsList(): OffboardingRecord[] {
    return [...this.offboardings].reverse();
  }

  /** Customer lifecycle stats. */
  accountStats(): { accounts: number; active: number; suspended: number; offboarding: number; offboarded: number; offboardingRecords: number } {
    const all = [...this.accounts.values()];
    return {
      accounts: all.length,
      active: all.filter((a) => a.status === 'active').length,
      suspended: all.filter((a) => a.status === 'suspended').length,
      offboarding: all.filter((a) => a.status === 'offboarding').length,
      offboarded: all.filter((a) => a.status === 'offboarded').length,
      offboardingRecords: this.offboardings.length,
    };
  }

  stats(): { runs: number; completed: number; tenants: number; invites: number; acceptedInvites: number; sampleDataSets: number } {
    const runs = [...this.runs.values()];
    return {
      runs: runs.length,
      completed: runs.filter((r) => r.completedAt).length,
      tenants: runs.filter((r) => r.tenant).length,
      invites: runs.reduce((s, r) => s + r.invites.length, 0),
      acceptedInvites: runs.reduce((s, r) => s + r.invites.filter((i) => i.status === 'accepted').length, 0),
      sampleDataSets: runs.filter((r) => r.sampleData).length,
    };
  }
}
