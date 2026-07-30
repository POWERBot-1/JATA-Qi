// MFAModule — TOTP enrollment, backup codes, trusted devices, session elevation,
// rate-limiting / brute-force protection, and audit logging for all MFA events.
// Uses Node's built-in crypto (no external dependencies).

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import {
  generateSecret, computeTOTP, verifyTOTP, generateBackupCodes, hashBackupCode,
} from './crypto.js';

const COL_ENROLL = 'mfa.enrollments';
const COL_DEVICES = 'mfa.trusted_devices';
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000; // 5 minutes

export interface MFAEnrollment {
  id: string;
  userId: string;
  /** Base32-encoded TOTP secret (stored — protected by storage layer encryption at rest). */
  secret: string;
  /** Hashed backup codes (consumed on use). */
  backupCodes: string[];
  enabled: boolean;
  enrolledAt: number;
}

export interface TrustedDevice {
  id: string;
  userId: string;
  fingerprint: string; // device fingerprint (user-agent hash, IP, etc.)
  label?: string;
  expiresAt: number;
  createdAt: number;
}

interface AttemptTracker {
  count: number;
  lockedUntil: number;
}

export const MFAEvents = Object.freeze({
  Enrolled: 'mfa.enrolled',
  Verified: 'mfa.verified',
  VerificationFailed: 'mfa.verification_failed',
  LockedOut: 'mfa.locked_out',
  BackupCodeUsed: 'mfa.backup_code_used',
  DeviceTrusted: 'mfa.device_trusted',
  Disabled: 'mfa.disabled',
} as const);

export class MFAModule implements IModule {
  readonly id = 'mfa';
  readonly tags = ['core', 'security'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private enrollments!: ICollection<MFAEnrollment>;
  private devices!: ICollection<TrustedDevice>;
  private readonly attempts = new Map<string, AttemptTracker>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.enrollments = await storage.collection<MFAEnrollment>(COL_ENROLL);
    this.devices = await storage.collection<TrustedDevice>(COL_DEVICES);
    kernel.container.registerValue('mfa', this);
    kernel.logger.info('mfa module initialized');
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> { this.attempts.clear(); }

  // --- enrollment -----------------------------------------------------------

  /**
   * Begin MFA enrollment for a user. Generates a TOTP secret and returns it
   * along with a provisioning URI for authenticator apps. The enrollment is
   * NOT enabled until `confirmEnrollment` verifies an initial code.
   */
  async enroll(userId: string, issuer = 'JATA Qi'): Promise<{ secret: string; qrUri: string; backupCodes: string[] }> {
    // Remove any existing pending enrollment for this user.
    const existing = (await this.enrollments.all()).find((e) => e.userId === userId);
    if (existing?.enabled) throw new Error('mfa: user already has MFA enabled (disable first)');

    const secret = generateSecret(20);
    const backupCodes = generateBackupCodes(10);
    const enrollment: MFAEnrollment = {
      id: existing?.id ?? randomUUID(),
      userId,
      secret,
      backupCodes: backupCodes.map(hashBackupCode),
      enabled: false,
      enrolledAt: Date.now(),
    };
    await this.enrollments.put(enrollment);

    const label = encodeURIComponent(`${issuer}:${userId}`);
    const qrUri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6`;
    await this.audit(userId, 'enrollment_started', {});
    return { secret, qrUri, backupCodes };
  }

  /** Confirm enrollment by verifying an initial TOTP code from the user's authenticator app. */
  async confirmEnrollment(userId: string, code: string): Promise<{ enabled: boolean }> {
    const enr = await this.getEnrollment(userId);
    if (!enr) throw new Error('mfa: no pending enrollment');
    if (enr.enabled) throw new Error('mfa: already enabled');
    if (!verifyTOTP(enr.secret, code)) {
      await this.recordFailure(userId);
      throw new Error('mfa: invalid TOTP code');
    }
    enr.enabled = true;
    await this.enrollments.put(enr);
    await this.api.bus.emit(MFAEvents.Enrolled, { userId });
    await this.audit(userId, 'enrollment_confirmed', {});
    return { enabled: true };
  }

  async getEnrollment(userId: string): Promise<MFAEnrollment | undefined> {
    return (await this.enrollments.all()).find((e) => e.userId === userId);
  }

  async isEnabled(userId: string): Promise<boolean> {
    const e = await this.getEnrollment(userId);
    return e?.enabled ?? false;
  }

  /** Disable MFA for a user (requires a valid code). */
  async disable(userId: string, code: string): Promise<void> {
    const enr = await this.getEnrollment(userId);
    if (!enr?.enabled) throw new Error('mfa: MFA not enabled');
    if (!verifyTOTP(enr.secret, code) && !this.tryBackupCode(enr, code)) {
      await this.recordFailure(userId);
      throw new Error('mfa: invalid code');
    }
    enr.enabled = false;
    await this.enrollments.put(enr);
    await this.api.bus.emit(MFAEvents.Disabled, { userId });
    await this.audit(userId, 'mfa_disabled', {});
  }

  // --- verification ---------------------------------------------------------

  /**
   * Verify a TOTP or backup code. Returns true on success. Enforces rate
   * limiting / brute-force lockout. Resets failure counter on success.
   */
  async verify(userId: string, code: string): Promise<{ verified: boolean; lockedOut?: boolean; reason?: string }> {
    if (this.isLockedOut(userId)) {
      return { verified: false, lockedOut: true, reason: 'account locked — too many failed attempts' };
    }
    const enr = await this.getEnrollment(userId);
    if (!enr?.enabled) return { verified: false, reason: 'MFA not enabled' };

    const totpOk = verifyTOTP(enr.secret, code);
    const backupOk = totpOk ? false : this.tryBackupCode(enr, code);
    if (totpOk || backupOk) {
      this.resetFailures(userId);
      await this.enrollments.put(enr); // persist consumed backup code
      await this.api.bus.emit(MFAEvents.Verified, { userId, method: backupOk ? 'backup_code' : 'totp' });
      if (backupOk) await this.audit(userId, 'backup_code_used', {});
      else await this.audit(userId, 'totp_verified', {});
      return { verified: true };
    }

    await this.recordFailure(userId);
    await this.api.bus.emit(MFAEvents.VerificationFailed, { userId });
    const locked = this.isLockedOut(userId);
    if (locked) {
      await this.api.bus.emit(MFAEvents.LockedOut, { userId });
      await this.audit(userId, 'locked_out', { attempts: MAX_ATTEMPTS });
    }
    return { verified: false, ...(locked ? { lockedOut: true, reason: 'locked out' } : { reason: 'invalid code' }) };
  }

  // --- trusted devices ------------------------------------------------------

  /** Register a trusted device so MFA can be skipped for a period. */
  async trustDevice(userId: string, fingerprint: string, label?: string, ttlMs: number = 30 * 86_400_000): Promise<TrustedDevice> {
    const dev: TrustedDevice = { id: randomUUID(), userId, fingerprint, ...(label ? { label } : {}), expiresAt: Date.now() + ttlMs, createdAt: Date.now() };
    await this.devices.put(dev);
    await this.api.bus.emit(MFAEvents.DeviceTrusted, { userId });
    await this.audit(userId, 'device_trusted', { fingerprint: fingerprint.slice(0, 8) });
    return dev;
  }

  /** Check if a device fingerprint is trusted and not expired. */
  async isDeviceTrusted(userId: string, fingerprint: string): Promise<boolean> {
    const now = Date.now();
    const all = (await this.devices.all()).filter((d) => d.userId === userId && d.expiresAt > now);
    return all.some((d) => d.fingerprint === fingerprint);
  }

  async revokeDevice(id: string): Promise<boolean> {
    return this.devices.delete(id);
  }

  async listTrustedDevices(userId: string): Promise<TrustedDevice[]> {
    const now = Date.now();
    return (await this.devices.all()).filter((d) => d.userId === userId && d.expiresAt > now);
  }

  // --- session elevation ----------------------------------------------------

  /**
   * Elevate a session after MFA verification. Returns an elevation token that
   * other modules can check for privileged operations. The token expires after
   * the configured TTL (default 15 minutes).
   */
  async elevateSession(userId: string, code: string, ttlMs = 15 * 60_000): Promise<{ elevated: boolean; token?: string; expiresAt?: number; reason?: string }> {
    const result = await this.verify(userId, code);
    if (!result.verified) return { elevated: false, reason: result.reason };
    const token = randomUUID();
    const expiresAt = Date.now() + ttlMs;
    // Store elevation in a lightweight in-memory map (the security module can
    // integrate this with sessions in production).
    this.elevations.set(token, { userId, expiresAt });
    await this.audit(userId, 'session_elevated', { ttlMs });
    return { elevated: true, token, expiresAt };
  }

  /** Check if an elevation token is valid for a user. */
  isElevated(token: string, userId: string): boolean {
    const e = this.elevations.get(token);
    if (!e || e.userId !== userId || e.expiresAt < Date.now()) {
      if (e) this.elevations.delete(token);
      return false;
    }
    return true;
  }

  private readonly elevations = new Map<string, { userId: string; expiresAt: number }>();

  // --- rate limiting / brute force ------------------------------------------

  private isLockedOut(userId: string): boolean {
    const t = this.attempts.get(userId);
    return t !== undefined && t.lockedUntil > Date.now();
  }

  private async recordFailure(userId: string): Promise<void> {
    let t = this.attempts.get(userId);
    // Reset only if a previous lockout has expired (lockedUntil > 0 but past).
    if (!t || (t.lockedUntil > 0 && t.lockedUntil < Date.now())) t = { count: 0, lockedUntil: 0 };
    t.count++;
    if (t.count >= MAX_ATTEMPTS) t.lockedUntil = Date.now() + LOCKOUT_MS;
    this.attempts.set(userId, t);
  }

  private resetFailures(userId: string): void { this.attempts.delete(userId); }

  // --- backup codes ---------------------------------------------------------

  /** Try to consume a backup code. Returns true and removes the code if matched. */
  private tryBackupCode(enr: MFAEnrollment, code: string): boolean {
    const hashed = hashBackupCode(code);
    const idx = enr.backupCodes.indexOf(hashed);
    if (idx === -1) return false;
    enr.backupCodes.splice(idx, 1);
    return true;
  }

  /** Get remaining backup code count (for UI display). */
  async remainingBackupCodes(userId: string): Promise<number | undefined> {
    const enr = await this.getEnrollment(userId);
    return enr?.backupCodes.length;
  }

  /** Regenerate backup codes (invalidates old ones). Requires a valid TOTP. */
  async regenerateBackupCodes(userId: string, code: string): Promise<string[]> {
    const enr = await this.getEnrollment(userId);
    if (!enr?.enabled) throw new Error('mfa: MFA not enabled');
    if (!verifyTOTP(enr.secret, code)) throw new Error('mfa: invalid TOTP code');
    const newCodes = generateBackupCodes(10);
    enr.backupCodes = newCodes.map(hashBackupCode);
    await this.enrollments.put(enr);
    await this.audit(userId, 'backup_codes_regenerated', {});
    return newCodes;
  }

  // --- audit ----------------------------------------------------------------

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec?.audit) await sec.audit({ actor, action: `mfa.${action}`, result: 'success', detail });
    } catch {}
  }
}
