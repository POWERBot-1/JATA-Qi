// CloudDevopsModule — deployments, infrastructure resources, deployment logs (#15).
import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';

export type DeploymentEnv = 'dev' | 'staging' | 'prod';
export type DeploymentStatus = 'planned' | 'deploying' | 'deployed' | 'failed' | 'rolled_back';
export type ResourceType = 'container' | 'vm' | 'database' | 'queue' | 'cache' | 'function';

export interface Deployment {
  id: string; name: string; environment: DeploymentEnv; status: DeploymentStatus;
  version: string; manifest?: Record<string, unknown>; createdBy: string;
  organizationId?: string; createdAt: number; deployedAt?: number; rolledBackAt?: number;
}
export interface InfrastructureResource {
  id: string; name: string; type: ResourceType; provider: string;
  spec?: Record<string, unknown>; status: 'provisioned' | 'running' | 'stopped' | 'failed';
  organizationId?: string; createdAt: number;
}
export interface DeploymentLogEntry {
  id: string; deploymentId: string; level: 'info' | 'warn' | 'error'; message: string; timestamp: number;
}
export const CloudDevopsEvents = Object.freeze({
  DeploymentStarted: 'cloud.deployment.started', DeploymentCompleted: 'cloud.deployment.completed',
  DeploymentRolledBack: 'cloud.deployment.rolled_back',
} as const);

export class CloudDevopsModule implements IModule {
  readonly id = 'cloud-devops'; readonly tags = ['core', 'devops'] as const; readonly dependsOn = ['storage'] as const;
  private api!: KernelApi; private deployments!: ICollection<Deployment>;
  private resources!: ICollection<InfrastructureResource>; private logs!: ICollection<DeploymentLogEntry>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>> };
    this.deployments = await storage.collection<Deployment>('cloud.deployments');
    this.resources = await storage.collection<InfrastructureResource>('cloud.resources');
    this.logs = await storage.collection<DeploymentLogEntry>('cloud.logs');
    kernel.container.registerValue('cloud-devops', this);
    kernel.logger.info('cloud-devops module initialized');
  }
  async start(_k: KernelApi): Promise<void> {} async stop(_k: KernelApi): Promise<void> {}

  async createDeployment(input: { name: string; environment: DeploymentEnv; version: string; manifest?: Record<string, unknown>; createdBy: string; organizationId?: string }): Promise<Deployment> {
    const d: Deployment = { id: randomUUID(), name: input.name, environment: input.environment, status: 'planned', version: input.version, createdBy: input.createdBy, createdAt: Date.now(), ...(input.manifest ? { manifest: input.manifest } : {}), ...(input.organizationId ? { organizationId: input.organizationId } : {}) };
    await this.deployments.put(d);
    await this.audit(input.createdBy, 'deployment_created', { id: d.id, env: input.environment });
    return d;
  }

  async deploy(id: string): Promise<Deployment> {
    const d = await this.deployments.get(id); if (!d) throw new Error(`cloud-devops: deployment "${id}" not found`);
    if (d.status !== 'planned') throw new Error(`cloud-devops: deployment status is ${d.status}`);
    d.status = 'deploying'; await this.deployments.put(d);
    await this.api.bus.emit(CloudDevopsEvents.DeploymentStarted, { id });
    await this.addLog(id, 'info', `Deploying version ${d.version} to ${d.environment}`);
    // Simulate deployment completion (in production this would be async).
    d.status = 'deployed'; d.deployedAt = Date.now(); await this.deployments.put(d);
    await this.addLog(id, 'info', `Deployment completed successfully`);
    await this.api.bus.emit(CloudDevopsEvents.DeploymentCompleted, { id });
    await this.audit(d.createdBy, 'deployment_completed', { id, version: d.version });
    return d;
  }

  async rollback(id: string, reason?: string): Promise<Deployment> {
    const d = await this.deployments.get(id); if (!d) throw new Error(`cloud-devops: deployment "${id}" not found`);
    if (d.status !== 'deployed') throw new Error(`cloud-devops: can only rollback deployed deployments`);
    d.status = 'rolled_back'; d.rolledBackAt = Date.now(); await this.deployments.put(d);
    await this.addLog(id, 'warn', `Rolled back: ${reason ?? 'no reason given'}`);
    await this.api.bus.emit(CloudDevopsEvents.DeploymentRolledBack, { id });
    await this.audit(d.createdBy, 'deployment_rolled_back', { id, reason });
    return d;
  }

  async listDeployments(env?: DeploymentEnv, status?: DeploymentStatus): Promise<Deployment[]> {
    let all = await this.deployments.all();
    if (env) all = all.filter((d) => d.environment === env);
    if (status) all = all.filter((d) => d.status === status);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async registerResource(input: { name: string; type: ResourceType; provider: string; spec?: Record<string, unknown>; organizationId?: string }): Promise<InfrastructureResource> {
    const r: InfrastructureResource = { id: randomUUID(), name: input.name, type: input.type, provider: input.provider, status: 'provisioned', createdAt: Date.now(), ...(input.spec ? { spec: input.spec } : {}), ...(input.organizationId ? { organizationId: input.organizationId } : {}) };
    await this.resources.put(r); return r;
  }
  async listResources(type?: ResourceType): Promise<InfrastructureResource[]> {
    const all = await this.resources.all(); return type ? all.filter((r) => r.type === type) : all;
  }

  async addLog(deploymentId: string, level: 'info' | 'warn' | 'error', message: string): Promise<DeploymentLogEntry> {
    const e: DeploymentLogEntry = { id: randomUUID(), deploymentId, level, message, timestamp: Date.now() };
    await this.logs.put(e); return e;
  }
  async getLogs(deploymentId: string): Promise<DeploymentLogEntry[]> {
    return (await this.logs.all()).filter((l) => l.deploymentId === deploymentId).sort((a, b) => a.timestamp - b.timestamp);
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try { const s = this.api.getModule('security') as unknown as { audit: (r: Record<string, unknown>) => Promise<unknown> } | undefined; if (s?.audit) await s.audit({ actor, action: `cloud.${action}`, result: 'success', detail }); } catch {}
  }
}
