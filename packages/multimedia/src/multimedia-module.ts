// MultimediaModule — the JATA Qi Multimedia Intelligence Suite. Manages media
// projects, creative jobs, async rendering via pluggable Renderer adapters,
// versioned assets with licensing/provenance/watermarking, consent records for
// voice cloning / likeness, and full integration with the governance gate,
// organisations, audit, notifications and billing.
//
// Actual media synthesis is via registered Renderer adapters. The built-in
// TextRenderer produces deterministic structured output for text-based kinds
// (lyrics, story, screenplay). Audio/video/image synthesis requires an external
// adapter (none wired by default — honest abstraction).

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { MultimediaEvents } from './types.js';
import type {
  ConsentRecord, CreativeJob, MediaAsset, MediaKind, MediaProject, Renderer, LicenseType,
} from './types.js';

const COL_PROJECTS = 'media.projects';
const COL_JOBS = 'media.jobs';
const COL_ASSETS = 'media.assets';
const COL_CONSENT = 'media.consent';

export interface CreateProjectInput {
  name: string;
  kind: MediaKind;
  organizationId?: string;
  ownerId: string;
  genre?: string;
  description?: string;
}

export interface CreateJobInput {
  projectId: string;
  kind: MediaKind;
  title: string;
  prompt: string;
  params?: Record<string, unknown>;
  consentRequired?: boolean;
}

const CONSENT_KINDS: ReadonlySet<MediaKind> = new Set(['vocal']);

export class MultimediaModule implements IModule {
  readonly id = 'multimedia';
  readonly tags = ['intelligence', 'multimedia'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private projects!: ICollection<MediaProject>;
  private jobs!: ICollection<CreativeJob>;
  private assets!: ICollection<MediaAsset>;
  private consent!: ICollection<ConsentRecord>;
  private readonly renderers = new Map<MediaKind, Renderer>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.projects = await C<MediaProject>(COL_PROJECTS);
    this.jobs = await C<CreativeJob>(COL_JOBS);
    this.assets = await C<MediaAsset>(COL_ASSETS);
    this.consent = await C<ConsentRecord>(COL_CONSENT);
    // Built-in text renderer for text-based kinds (lyrics, story, screenplay).
    for (const kind of ['story', 'lyrics', 'screenplay'] as const) {
      this.renderers.set(kind, textRenderer);
    }
    kernel.container.registerValue('multimedia', this);
    kernel.logger.info('multimedia module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { this.renderers.clear(); }

  // --- renderers -----------------------------------------------------------

  registerRenderer(renderer: Renderer): void {
    this.renderers.set(renderer.kind, renderer);
  }

  // --- projects ------------------------------------------------------------

  async createProject(input: CreateProjectInput): Promise<MediaProject> {
    if (!input.name || !input.ownerId) throw new Error('multimedia: name and ownerId are required');
    const now = Date.now();
    const project: MediaProject = {
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ownerId: input.ownerId,
      ...(input.genre ? { genre: input.genre } : {}),
      ...(input.description ? { description: input.description } : {}),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.projects.put(project);
    await this.api.bus.emit(MultimediaEvents.ProjectCreated, { id: project.id, kind: project.kind });
    await this.audit(input.ownerId, 'media.project_created', { projectId: project.id });
    return project;
  }

  async getProject(id: string): Promise<MediaProject | undefined> { return this.projects.get(id); }
  async listProjects(ownerId?: string, organizationId?: string): Promise<MediaProject[]> {
    let all = await this.projects.all();
    if (ownerId) all = all.filter((p) => p.ownerId === ownerId);
    if (organizationId) all = all.filter((p) => p.organizationId === organizationId);
    return all;
  }

  // --- consent (voice cloning / likeness) ---------------------------------

  async grantConsent(input: { subjectType: ConsentRecord['subjectType']; subjectId: string; grantedBy: string; purpose: string }): Promise<ConsentRecord> {
    const rec: ConsentRecord = { id: randomUUID(), ...input, status: 'granted', createdAt: Date.now() };
    await this.consent.put(rec);
    await this.audit(input.grantedBy, 'media.consent_granted', { subjectType: input.subjectType, subjectId: input.subjectId });
    return rec;
  }

  async hasConsent(subjectType: string, subjectId: string): Promise<boolean> {
    const all = await this.consent.all();
    return all.some((c) => c.subjectType === subjectType && c.subjectId === subjectId && c.status === 'granted');
  }

  // --- creative jobs + async rendering ------------------------------------

  async createJob(ownerId: string, input: CreateJobInput, organizationId?: string): Promise<CreativeJob> {
    const project = await this.projects.get(input.projectId);
    if (!project) throw new Error(`multimedia: project "${input.projectId}" not found`);

    // Governance gate: evaluate 'media.create' (and 'media.voiceclone' for vocal).
    const action = input.kind === 'vocal' ? 'media.voiceclone' : 'media.create';
    const gov = await this.governanceGate(ownerId, action, organizationId);
    if (gov && !gov.allowed) {
      throw new Error(`multimedia: governance ${gov.decision} — ${gov.reason}`);
    }

    // Consent check for voice cloning / vocal jobs.
    const consentRequired = CONSENT_KINDS.has(input.kind) || input.consentRequired === true;
    if (consentRequired && !(await this.hasConsent('voice-clone', ownerId))) {
      await this.api.bus.emit(MultimediaEvents.ConsentRequired, { ownerId, kind: input.kind });
      throw new Error('multimedia: voice-clone consent required but not granted');
    }

    const now = Date.now();
    const job: CreativeJob = {
      id: randomUUID(),
      projectId: input.projectId,
      kind: input.kind,
      title: input.title,
      prompt: input.prompt,
      ...(input.params ? { params: input.params } : {}),
      status: 'queued',
      ...(organizationId ? { organizationId } : {}),
      createdBy: ownerId,
      consentRequired,
      ...(consentRequired ? { consentGranted: true } : {}),
      ...(gov ? { governanceDecision: gov.decision, governanceEvaluationId: gov.evaluationId } : {}),
      createdAt: now,
    };
    await this.jobs.put(job);
    await this.api.bus.emit(MultimediaEvents.JobQueued, { id: job.id, kind: job.kind });
    await this.notify(ownerId, 'media', `Creative job "${input.title}" queued`, `Kind: ${input.kind}`);
    await this.audit(ownerId, 'media.job_created', { jobId: job.id, kind: input.kind });
    return job;
  }

  /** Process all queued jobs synchronously (for testing / batch processing). */
  async processQueue(): Promise<CreativeJob[]> {
    const queued = (await this.jobs.all()).filter((j) => j.status === 'queued');
    const processed: CreativeJob[] = [];
    for (const job of queued) {
      try {
        const renderer = this.renderers.get(job.kind);
        if (!renderer) {
          job.status = 'failed';
          job.error = `no renderer registered for kind "${job.kind}"`;
          await this.jobs.put(job);
          await this.api.bus.emit(MultimediaEvents.JobFailed, { id: job.id });
          processed.push(job);
          continue;
        }
        job.status = 'processing';
        job.startedAt = Date.now();
        await this.jobs.put(job);
        const { content, format } = await renderer.render(job);
        const now = Date.now();
        // Create asset.
        const asset: MediaAsset = {
          id: randomUUID(), projectId: job.projectId, jobId: job.id, kind: job.kind,
          title: job.title, content, ...(format ? { format } : {}),
          license: 'all-rights-reserved', aiGenerated: true,
          provenance: { jobId: job.id }, version: 1,
          ...(job.organizationId ? { organizationId: job.organizationId } : {}),
          createdAt: now,
        };
        await this.assets.put(asset);
        job.status = 'completed';
        job.resultAssetId = asset.id;
        job.completedAt = now;
        await this.jobs.put(job);
        await this.api.bus.emit(MultimediaEvents.JobCompleted, { id: job.id, assetId: asset.id });
        processed.push(job);
      } catch (err) {
        job.status = 'failed';
        job.error = (err as Error).message;
        await this.jobs.put(job);
        await this.api.bus.emit(MultimediaEvents.JobFailed, { id: job.id });
        processed.push(job);
      }
    }
    return processed;
  }

  async getJob(id: string): Promise<CreativeJob | undefined> { return this.jobs.get(id); }
  async listJobs(projectId?: string): Promise<CreativeJob[]> {
    const all = await this.jobs.all();
    return projectId ? all.filter((j) => j.projectId === projectId) : all;
  }

  // --- assets --------------------------------------------------------------

  async getAsset(id: string): Promise<MediaAsset | undefined> { return this.assets.get(id); }
  async listAssets(projectId?: string): Promise<MediaAsset[]> {
    const all = await this.assets.all();
    return projectId ? all.filter((a) => a.projectId === projectId) : all;
  }

  async setLicense(assetId: string, license: LicenseType, attribution?: string): Promise<MediaAsset> {
    const a = await this.assets.get(assetId);
    if (!a) throw new Error(`multimedia: asset "${assetId}" not found`);
    const updated: MediaAsset = { ...a, license, ...(attribution !== undefined ? { attribution } : {}) };
    await this.assets.put(updated);
    await this.audit(a.organizationId ?? 'system', 'media.license_set', { assetId, license });
    return updated;
  }

  async setWatermark(assetId: string, watermark: boolean): Promise<MediaAsset> {
    const a = await this.assets.get(assetId);
    if (!a) throw new Error(`multimedia: asset "${assetId}" not found`);
    const updated: MediaAsset = { ...a, watermark };
    await this.assets.put(updated);
    return updated;
  }

  /** Create a new version of an asset (e.g. after editing). */
  async newVersion(assetId: string, content: string, format?: string): Promise<MediaAsset> {
    const parent = await this.assets.get(assetId);
    if (!parent) throw new Error(`multimedia: asset "${assetId}" not found`);
    const child: MediaAsset = {
      ...parent,
      id: randomUUID(),
      content,
      ...(format ? { format } : {}),
      version: parent.version + 1,
      parentId: parent.id,
      createdAt: Date.now(),
    };
    await this.assets.put(child);
    return child;
  }

  async publishToMarketplace(assetId: string, price: number, currency: string, commissionPct: number): Promise<{ asset: MediaAsset; marketplaceItem: Record<string, unknown> }> {
    const a = await this.assets.get(assetId);
    if (!a) throw new Error(`multimedia: asset "${assetId}" not found`);
    const item = {
      id: randomUUID(),
      name: a.title,
      sellerId: a.organizationId ?? 'media',
      price: { amount: price, currency },
      platformCommissionPct: commissionPct,
      pricingModel: 'ONE_TIME',
      status: 'LISTED',
      metadata: { mediaAssetId: a.id, kind: a.kind, license: a.license },
    };
    // Publish via the commerce module if present.
    try {
      const commerce = this.api.getModule('commerce') as unknown as { listItem: (i: Record<string, unknown>) => unknown };
      if (commerce) await commerce.listItem(item);
    } catch { /* commerce optional */ }
    await this.api.bus.emit(MultimediaEvents.AssetPublished, { assetId });
    await this.audit(a.organizationId ?? 'system', 'media.published', { assetId });
    return { asset: a, marketplaceItem: item };
  }

  // --- governance + integration helpers -----------------------------------

  private async governanceGate(userId: string, action: string, organizationId?: string): Promise<{ allowed: boolean; decision: string; reason: string; evaluationId?: string } | undefined> {
    let gov: { evaluate: (s: { userId: string; organizationId?: string }, a: string, c?: Record<string, unknown>) => Promise<{ decision: string; reason: string; evaluationId: string }> };
    try {
      gov = this.api.getModule('policy-governance') as unknown as typeof gov;
    } catch {
      return undefined;
    }
    try {
      const res = await gov.evaluate({ userId, ...(organizationId ? { organizationId } : {}) }, action);
      return { allowed: res.decision === 'ALLOW', decision: res.decision, reason: res.reason, evaluationId: res.evaluationId };
    } catch {
      return undefined;
    }
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') await sec.audit({ actor, action: `media.${action}`, result: 'success', detail });
    } catch { /* security optional */ }
  }

  private async notify(recipient: string, type: string, title: string, body: string): Promise<void> {
    try {
      const notifications = this.api.getModule('notifications') as unknown as { notify: (r: string, p: { type: string; title: string; body?: string }) => Promise<unknown> } | undefined;
      if (notifications && typeof notifications.notify === 'function') await notifications.notify(recipient, { type, title, body });
    } catch { /* notifications optional */ }
  }
}

// --- built-in text renderer -----------------------------------------------

const textRenderer: Renderer = {
  kind: 'story',
  async render(job) {
    const lines: string[] = [
      `# ${job.title}`,
      '',
      `Prompt: ${job.prompt}`,
      '',
      '--- Generated Content ---',
      '',
    ];
    if (job.kind === 'lyrics') {
      lines.push('[Verse 1]', job.prompt, '', '[Chorus]', `${job.prompt} — again`, '', '[Outro]', 'Fade out.');
    } else if (job.kind === 'screenplay') {
      lines.push('FADE IN:', '', `INT. SCENE — DAY`, '', `CHARACTER: ${job.prompt}`, '', 'CUT TO BLACK.');
    } else if (job.kind === 'music') {
      lines.push(`Genre: ${job.params?.genre ?? 'unspecified'}`, `Tempo: ${job.params?.tempo ?? 120} BPM`, `Key: ${job.params?.key ?? 'C major'}`, '', `Arrangement: ${job.prompt}`);
    } else {
      lines.push(job.prompt, '', '— End —');
    }
    return { content: lines.join('\n'), format: 'text/plain' };
  },
};
