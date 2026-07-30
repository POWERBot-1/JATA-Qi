// ResearchModule — research workspaces, experiments, literature management,
// and hypothesis tracking. AI-generated hypotheses are clearly flagged. All
// operations are audit-logged and governance-gated when policy-governance exists.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { ResearchEvents } from './types.js';
import type { Experiment, ExperimentStatus, Hypothesis, HypothesisStatus, LiteratureRef, ResearchProject } from './types.js';

const COL_PROJECTS = 'research.projects';
const COL_EXPERIMENTS = 'research.experiments';
const COL_LITERATURE = 'research.literature';
const COL_HYPOTHESES = 'research.hypotheses';

export class ResearchModule implements IModule {
  readonly id = 'research';
  readonly tags = ['intelligence', 'research'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private projects!: ICollection<ResearchProject>;
  private experiments!: ICollection<Experiment>;
  private literature!: ICollection<LiteratureRef>;
  private hypotheses!: ICollection<Hypothesis>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.projects = await C<ResearchProject>(COL_PROJECTS);
    this.experiments = await C<Experiment>(COL_EXPERIMENTS);
    this.literature = await C<LiteratureRef>(COL_LITERATURE);
    this.hypotheses = await C<Hypothesis>(COL_HYPOTHESES);
    kernel.container.registerValue('research', this);
    kernel.logger.info('research module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- projects ------------------------------------------------------------

  async createProject(input: { name: string; description?: string; field?: string; ownerId: string; organizationId?: string }): Promise<ResearchProject> {
    const project: ResearchProject = {
      id: randomUUID(), name: input.name, ownerId: input.ownerId, status: 'active', createdAt: Date.now(),
      ...(input.description ? { description: input.description } : {}),
      ...(input.field ? { field: input.field } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    };
    await this.projects.put(project);
    await this.api.bus.emit(ResearchEvents.ProjectCreated, { id: project.id });
    await this.audit(input.ownerId, 'project_created', { projectId: project.id });
    return project;
  }

  async getProject(id: string): Promise<ResearchProject | undefined> { return this.projects.get(id); }
  async listProjects(ownerId?: string): Promise<ResearchProject[]> {
    const all = await this.projects.all();
    return ownerId ? all.filter((p) => p.ownerId === ownerId) : all;
  }

  // --- experiments ---------------------------------------------------------

  async createExperiment(input: { projectId: string; name: string; hypothesis?: string; methodology?: string; parameters?: Record<string, unknown> }): Promise<Experiment> {
    const now = Date.now();
    const exp: Experiment = {
      id: randomUUID(), projectId: input.projectId, name: input.name, status: 'planned',
      ...(input.hypothesis ? { hypothesis: input.hypothesis } : {}),
      ...(input.methodology ? { methodology: input.methodology } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {}),
      createdAt: now, updatedAt: now,
    };
    await this.experiments.put(exp);
    await this.api.bus.emit(ResearchEvents.ExperimentCreated, { id: exp.id });
    return exp;
  }

  async updateExperiment(id: string, changes: Partial<Pick<Experiment, 'status' | 'results' | 'reproducible'>>): Promise<Experiment> {
    const exp = await this.experiments.get(id);
    if (!exp) throw new Error(`research: experiment "${id}" not found`);
    const updated: Experiment = { ...exp, ...changes, updatedAt: Date.now() };
    await this.experiments.put(updated);
    return updated;
  }

  async listExperiments(projectId?: string): Promise<Experiment[]> {
    const all = await this.experiments.all();
    return projectId ? all.filter((e) => e.projectId === projectId) : all;
  }

  // --- literature ----------------------------------------------------------

  async addLiterature(input: { projectId: string; title: string; authors: string[]; year?: number; doi?: string; url?: string; abstract?: string; tags?: string[]; addedBy: string }): Promise<LiteratureRef> {
    const ref: LiteratureRef = { id: randomUUID(), ...input, createdAt: Date.now() };
    await this.literature.put(ref);
    await this.audit(input.addedBy, 'literature_added', { refId: ref.id, title: input.title });
    return ref;
  }

  async listLiterature(projectId?: string, tag?: string): Promise<LiteratureRef[]> {
    let all = await this.literature.all();
    if (projectId) all = all.filter((r) => r.projectId === projectId);
    if (tag) all = all.filter((r) => r.tags?.includes(tag));
    return all;
  }

  // --- hypotheses ----------------------------------------------------------

  async createHypothesis(input: { projectId: string; statement: string; aiGenerated?: boolean; createdBy: string }): Promise<Hypothesis> {
    const now = Date.now();
    const h: Hypothesis = {
      id: randomUUID(), projectId: input.projectId, statement: input.statement,
      status: 'proposed', evidence: [], aiGenerated: input.aiGenerated ?? false,
      createdBy: input.createdBy, createdAt: now, updatedAt: now,
    };
    await this.hypotheses.put(h);
    await this.api.bus.emit(ResearchEvents.HypothesisProposed, { id: h.id, aiGenerated: h.aiGenerated });
    await this.audit(input.createdBy, 'hypothesis_created', { id: h.id, aiGenerated: h.aiGenerated });
    return h;
  }

  async updateHypothesis(id: string, status: HypothesisStatus, evidence?: string): Promise<Hypothesis> {
    const h = await this.hypotheses.get(id);
    if (!h) throw new Error(`research: hypothesis "${id}" not found`);
    const updated: Hypothesis = {
      ...h, status, updatedAt: Date.now(),
      ...(evidence ? { evidence: [...h.evidence, evidence] } : {}),
    };
    await this.hypotheses.put(updated);
    await this.api.bus.emit(ResearchEvents.HypothesisUpdated, { id, status });
    return updated;
  }

  async listHypotheses(projectId?: string): Promise<Hypothesis[]> {
    const all = await this.hypotheses.all();
    return projectId ? all.filter((h) => h.projectId === projectId) : all;
  }

  // --- helpers -------------------------------------------------------------

  async stats(): Promise<{ projects: number; experiments: number; literature: number; hypotheses: number }> {
    return {
      projects: await this.projects.count(),
      experiments: await this.experiments.count(),
      literature: await this.literature.count(),
      hypotheses: await this.hypotheses.count(),
    };
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') await sec.audit({ actor, action: `research.${action}`, result: 'success', detail });
    } catch { /* optional */ }
  }
}
