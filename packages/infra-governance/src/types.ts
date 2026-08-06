// Secure Infrastructure Governance — types.

export type HardwareStatus = 'provisioned' | 'active' | 'degraded' | 'eol' | 'decommissioned';
export type FirmwareStatus = 'validated' | 'mismatch' | 'untrusted';

export interface HardwareAsset {
  id: string;
  /** Serial number / asset tag. */
  serial: string;
  model: string;
  role: 'server' | 'network' | 'storage' | 'security' | 'edge';
  status: HardwareStatus;
  /** Current firmware version. */
  firmwareVersion: string;
  /** Expected firmware SHA-256 (validated at boot / inventory). */
  firmwareSha256?: string;
  firmwareStatus: FirmwareStatus;
  /** TPM/measured-boot attestation record (base64 quote). */
  measuredBoot?: string;
  location?: string;
  purchasedAt: number;
  /** End-of-life date — assets past EOL are flagged. */
  eolAt?: number;
  provisionedAt?: number;
  decommissionedAt?: number;
}

export interface ProvisioningRecord {
  id: string;
  serial: string;
  /** One-time provisioning token (hash stored). */
  tokenHash: string;
  enrolledBy: string;
  method: 'tpm' | 'serial' | 'network';
  approved: boolean;
  createdAt: number;
  completedAt?: number;
}

export interface ConfigDrift {
  id: string;
  assetId: string;
  /** Golden config key that drifted. */
  key: string;
  expected: string;
  actual: string;
  severity: 'low' | 'medium' | 'high';
  detectedAt: number;
  remediated?: boolean;
}

export interface ComplianceCheck {
  id: string;
  category: 'baseline' | 'hardening' | 'physical';
  name: string;
  passed: boolean;
  detail?: string;
  checkedAt: number;
}

export interface PhysicalAccessRecord {
  id: string;
  facility: string;
  zone: string;
  person: string;
  action: 'entry' | 'exit' | 'escort' | 'denied';
  reason?: string;
  ts: number;
}
