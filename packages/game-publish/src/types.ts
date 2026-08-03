// NOVA Publishing — types (section 14). The build pipeline turns a game spec
// into per-platform build artifacts (deterministic, checksummed, signed) and a
// publishing store tracks each store submission through its lifecycle.

export type Platform =
  | 'android' | 'ios' | 'windows' | 'mac' | 'linux'
  | 'playstation' | 'xbox' | 'nintendo' | 'web' | 'cloud' | 'vr';

/** Canonical platform → store mapping for submission. */
export const PLATFORM_STORE: Record<Platform, string> = {
  android: 'Google Play',
  ios: 'App Store',
  windows: 'Microsoft Store',
  mac: 'Mac App Store',
  linux: 'Steam',
  playstation: 'PlayStation Store',
  xbox: 'Microsoft Store',
  nintendo: 'Nintendo eShop',
  web: 'Web (hosted)',
  cloud: 'Cloud Gaming',
  vr: 'VR Storefront',
};

export interface BuildTargetSpec {
  platform: Platform;
  /** App/bundle identifier, e.g. 'com.nova.mygame'. */
  bundleId: string;
  /** Optional signing-profile name. */
  signingProfile?: string;
}

export interface BuildSpec {
  projectId: string;
  title: string;
  /** Semantic version string. */
  version: string;
  /** Build channel. */
  channel: 'dev' | 'beta' | 'stable';
  targets: BuildTargetSpec[];
  /** Canonical contents fingerprint inputs (entrypoint + asset manifest). */
  contents: { entrypoint: string; assetCount: number; seed: string };
}

export interface BuildArtifact {
  platform: Platform;
  bundleId: string;
  version: string;
  channel: BuildSpec['channel'];
  /** Deterministic artifact name. */
  artifact: string;
  /** Pseudo size derived from contents (bytes). */
  sizeBytes: number;
  /** SHA-256 of the canonical build inputs for this target. */
  checksum: string;
  /** Ed25519 signature over the checksum. */
  signature: string;
  signedBy: string;
  store: string;
  builtAt: number;
}

export interface StageResult { stage: string; status: 'ok' | 'failed'; detail?: string }

export interface BuildResult {
  projectId: string;
  version: string;
  channel: BuildSpec['channel'];
  artifacts: BuildArtifact[];
  stages: StageResult[];
  startedAt: number;
  finishedAt: number;
  /** Aggregated build fingerprint. */
  fingerprint: string;
}

export type SubmissionStatus = 'draft' | 'submitted' | 'in-review' | 'approved' | 'rejected' | 'published';

export interface Submission {
  id: string;
  projectId: string;
  platform: Platform;
  store: string;
  version: string;
  artifactChecksum: string;
  status: SubmissionStatus;
  history: Array<{ status: SubmissionStatus; at: number; note?: string }>;
  createdAt: number;
}
