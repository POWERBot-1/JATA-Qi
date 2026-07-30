// JATA Qi Multimedia — domain types. The suite covers music, story, image,
// video and film production. All operations are governed, tenant-aware, and
// flow through async rendering queues with versioned assets.

export type MediaKind =
  | 'music' | 'vocal' | 'lyrics' | 'story' | 'screenplay'
  | 'image' | 'video' | 'film' | 'edit' | 'sfx';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export type LicenseType =
  | 'all-rights-reserved' | 'cc-by' | 'cc-by-sa' | 'cc-by-nc'
  | 'royalty-free' | 'public-domain' | 'custom';

export interface MediaProject {
  id: string;
  name: string;
  kind: MediaKind;
  organizationId?: string;
  ownerId: string;
  genre?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreativeJob {
  id: string;
  projectId: string;
  kind: MediaKind;
  title: string;
  prompt: string;
  params?: Record<string, unknown>;
  status: JobStatus;
  organizationId?: string;
  createdBy: string;
  resultAssetId?: string;
  error?: string;
  governanceDecision?: string;
  governanceEvaluationId?: string;
  consentRequired?: boolean;
  consentGranted?: boolean;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface MediaAsset {
  id: string;
  projectId: string;
  jobId?: string;
  kind: MediaKind;
  title: string;
  /** The actual content — text for lyrics/story/screenplay; a descriptor/ref for audio/video/image. */
  content: string;
  format?: string;
  license: LicenseType;
  attribution?: string;
  watermark?: boolean;
  aiGenerated: boolean;
  provenance?: { tool?: string; model?: string; jobId?: string };
  version: number;
  parentId?: string;
  organizationId?: string;
  createdAt: number;
}

export interface ConsentRecord {
  id: string;
  subjectType: 'voice-clone' | 'likeness' | 'data-use';
  subjectId: string;
  grantedBy: string;
  purpose: string;
  status: 'granted' | 'revoked';
  createdAt: number;
}

/** A pluggable renderer — turns a CreativeJob into asset content. */
export interface Renderer {
  readonly kind: MediaKind;
  render(job: CreativeJob): Promise<{ content: string; format?: string }>;
}

export const MultimediaEvents = Object.freeze({
  ProjectCreated: 'media.project.created',
  JobQueued: 'media.job.queued',
  JobCompleted: 'media.job.completed',
  JobFailed: 'media.job.failed',
  AssetPublished: 'media.asset.published',
  ConsentRequired: 'media.consent.required',
} as const);
