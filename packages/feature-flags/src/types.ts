// JATA Qi Feature Flags — types. Feature flags control deployment/testing
// rollout and are deliberately SEPARATE from commercial entitlements (which
// control what a customer has purchased). (master directive #30)

export interface FeatureFlag {
  /** Storage key (equals `key`). */
  id: string;
  key: string;
  enabled: boolean;
  /** Percentage rollout 0..100 (100 = on for everyone). */
  rolloutPct: number;
  description?: string;
  updatedAt: number;
}

export const FeatureFlagEvents = Object.freeze({
  FlagSet: 'feature_flag.set',
} as const);
