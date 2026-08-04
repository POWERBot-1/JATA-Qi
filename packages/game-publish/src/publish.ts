// PublishModule — kernel module wrapping the build pipeline and publishing
// store. One-call build + submit (§14 "one-click deployment") produces signed
// artifacts and store submissions, with events for analytics/notifications.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { BuildPipeline, type PipelineSigner } from './pipeline.js';
import { PublishingStore } from './publishing.js';
import { bump } from './version.js';
import type { BuildResult, BuildSpec, BuildArtifact, Submission, SubmissionStatus } from './types.js';

export const PublishEvents = Object.freeze({
  BuildCompleted: 'publish.build.completed',
  ArtifactSigned: 'publish.artifact.signed',
  SubmissionUpdated: 'publish.submission.updated',
} as const);

export class PublishModule implements IModule {
  readonly id = 'game-publish';
  readonly tags = ['core', 'game'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly pipeline: BuildPipeline;
  readonly store = new PublishingStore();

  constructor(signer?: PipelineSigner) { this.pipeline = new BuildPipeline(signer); }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('game-publish', this);
    kernel.logger.info('game-publish initialized');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  /** Build a spec into signed per-platform artifacts. */
  build(spec: BuildSpec): BuildResult {
    const result = this.pipeline.run(spec);
    void this.api.bus.emit(PublishEvents.BuildCompleted, { project: spec.projectId, fingerprint: result.fingerprint });
    for (const a of result.artifacts) void this.api.bus.emit(PublishEvents.ArtifactSigned, { platform: a.platform, checksum: a.checksum });
    return result;
  }

  /** One-click: build then submit every artifact to its store. */
  buildAndSubmit(spec: BuildSpec): { build: BuildResult; submissions: Submission[] } {
    const build = this.build(spec);
    const submissions = build.artifacts.map((a) => this.store.submit(spec.projectId, a));
    for (const s of submissions) void this.api.bus.emit(PublishEvents.SubmissionUpdated, { id: s.id, status: s.status });
    return { build, submissions };
  }

  /** Advance a submission through review/approval/publish. */
  advance(submissionId: string, to: SubmissionStatus, note?: string): Submission {
    const sub = this.store.transition(submissionId, to, note);
    void this.api.bus.emit(PublishEvents.SubmissionUpdated, { id: sub.id, status: to });
    return sub;
  }

  /** Verify a build artifact's signature. */
  verify(artifact: BuildArtifact): boolean { return this.pipeline.verifyArtifact(artifact); }

  /** Bump a version (helper). */
  bumpVersion(version: string, kind: 'major' | 'minor' | 'patch'): string { return bump(version, kind); }
}

export { BuildPipeline, PublishingStore, bump };
export type { BuildSpec, BuildResult, BuildArtifact, Submission, SubmissionStatus };
