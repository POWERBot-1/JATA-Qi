// FeatureFlagsModule — deployment/testing rollout switches. Deterministic
// percentage rollout: for a given user id, the same flag is consistently on/off.

import { createHash } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { FeatureFlagEvents } from './types.js';
import type { FeatureFlag } from './types.js';

const COL_FLAGS = 'feature_flags.flags';

export class FeatureFlagsModule implements IModule {
  readonly id = 'feature-flags';
  readonly tags = ['core', 'platform'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private flags!: ICollection<FeatureFlag>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.flags = await storage.collection<FeatureFlag>(COL_FLAGS);
    kernel.container.registerValue('feature-flags', this);
    kernel.logger.info('feature-flags module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  /** Set (or update) a flag. */
  async set(key: string, enabled: boolean, rolloutPct = 100, description?: string): Promise<FeatureFlag> {
    const flag: FeatureFlag = { id: key, key, enabled, rolloutPct: Math.max(0, Math.min(100, rolloutPct)), ...(description ? { description } : {}), updatedAt: Date.now() };
    await this.flags.put(flag);
    await this.api.bus.emit(FeatureFlagEvents.FlagSet, { key, enabled, rolloutPct });
    return flag;
  }

  async get(key: string): Promise<FeatureFlag | undefined> { return this.flags.get(key); }
  async list(): Promise<FeatureFlag[]> { return this.flags.all(); }

  /**
   * Is `key` on? With a userId, applies a deterministic percentage rollout so
   * each user sees a stable value. Without a userId, the flag is on only when
   * enabled at full (100%) rollout.
   */
  async isEnabled(key: string, userId?: string): Promise<boolean> {
    const flag = await this.flags.get(key);
    if (!flag || !flag.enabled) return false;
    if (userId === undefined) return flag.rolloutPct >= 100;
    if (flag.rolloutPct >= 100) return true;
    if (flag.rolloutPct <= 0) return false;
    const bucket = Number.parseInt(createHash('sha256').update(`${key}:${userId}`).digest('hex').slice(0, 8), 16) % 100;
    return bucket < flag.rolloutPct;
  }
}
