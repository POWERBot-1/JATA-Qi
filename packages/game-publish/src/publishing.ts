// Publishing store — tracks each store submission through its lifecycle
// (draft → submitted → in-review → approved/rejected → published) with enforced
// transitions and a full history. Mirrors how real app-store submissions work.

import { randomUUID } from 'node:crypto';
import type { BuildArtifact, Platform, Submission, SubmissionStatus } from './types.js';
import { PLATFORM_STORE } from './types.js';

/** Allowed status transitions. */
const ALLOWED: Record<SubmissionStatus, SubmissionStatus[]> = {
  draft: ['submitted'],
  submitted: ['in-review', 'rejected'],
  'in-review': ['approved', 'rejected'],
  approved: ['published'],
  rejected: ['submitted'],
  published: [],
};

export class PublishingStore {
  private submissions = new Map<string, Submission>();

  /** Create a submission for an artifact (starts as 'submitted'). */
  submit(projectId: string, artifact: BuildArtifact): Submission {
    const sub: Submission = {
      id: randomUUID(), projectId, platform: artifact.platform, store: artifact.store,
      version: artifact.version, artifactChecksum: artifact.checksum, status: 'submitted',
      history: [{ status: 'submitted', at: Date.now() }], createdAt: Date.now(),
    };
    this.submissions.set(sub.id, sub);
    return sub;
  }

  get(id: string): Submission | undefined { return this.submissions.get(id); }

  /** Transition a submission; throws if the transition is not allowed. */
  transition(id: string, to: SubmissionStatus, note?: string): Submission {
    const sub = this.submissions.get(id);
    if (!sub) throw new Error(`submission ${id} not found`);
    if (!ALLOWED[sub.status].includes(to)) throw new Error(`invalid transition: ${sub.status} -> ${to}`);
    sub.status = to;
    sub.history.push({ status: to, at: Date.now(), ...(note ? { note } : {}) });
    return sub;
  }

  list(projectId?: string): Submission[] {
    const all = [...this.submissions.values()];
    return projectId ? all.filter((s) => s.projectId === projectId) : all;
  }

  byPlatform(project: string, platform: Platform): Submission | undefined {
    return this.list(project).find((s) => s.platform === platform);
  }

  /** Convenience: whether any submission for a project/platform is published. */
  isPublished(projectId: string, platform: Platform): boolean {
    return this.list(projectId).some((s) => s.platform === platform && s.status === 'published');
  }
}

export { PLATFORM_STORE };
