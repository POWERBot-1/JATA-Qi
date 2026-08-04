import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SecurityModule } from '@jataqi/security';
import {
  MFAModule, computeTOTP, generateSecret, verifyTOTP, generateBackupCodes,
  base32Decode, base32Encode,
} from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('TOTP crypto (RFC 6238)', () => {
  it('generates and verifies a TOTP code', () => {
    const secret = generateSecret(20);
    const code = computeTOTP(secret);
    assert.equal(code.length, 6);
    assert.equal(verifyTOTP(secret, code), true);
    assert.equal(verifyTOTP(secret, '000000'), false);
  });

  it('accepts codes within ±1 time window (clock drift)', () => {
    const secret = generateSecret();
    const now = Date.now();
    // Code from 30s ago.
    const oldCode = computeTOTP(secret, now - 30_000);
    assert.equal(verifyTOTP(secret, oldCode, now), true);
    // Code from 30s in the future.
    const futureCode = computeTOTP(secret, now + 30_000);
    assert.equal(verifyTOTP(secret, futureCode, now), true);
    // Code from 60s ago — rejected (outside ±1 window).
    const farCode = computeTOTP(secret, now - 60_000);
    assert.equal(verifyTOTP(secret, farCode, now), false);
  });

  it('base32 round-trips correctly', () => {
    const buf = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    const encoded = base32Encode(buf);
    const decoded = base32Decode(encoded);
    assert.deepEqual(decoded, buf);
  });

  it('generates backup codes in the correct format', () => {
    const codes = generateBackupCodes(10);
    assert.equal(codes.length, 10);
    assert.ok(codes.every((c) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)));
    // All unique.
    assert.equal(new Set(codes).size, 10);
  });
});

describe('MFAModule (kernel integration)', () => {
  let kernel: Kernel;
  let mfa: MFAModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new SecurityModule());
    kernel.register(new MFAModule());
    await kernel.boot();
    mfa = kernel.getModule<MFAModule>('mfa');
  });

  it('enrolls, confirms, and verifies TOTP', async () => {
    const { secret, qrUri, backupCodes } = await mfa.enroll('user-1');
    assert.ok(secret);
    assert.match(qrUri, /otpauth:\/\/totp/);
    assert.equal(backupCodes.length, 10);
    assert.equal(await mfa.isEnabled('user-1'), false); // not confirmed yet

    // Confirm with a valid code.
    const code = computeTOTP(secret);
    const confirmed = await mfa.confirmEnrollment('user-1', code);
    assert.equal(confirmed.enabled, true);
    assert.equal(await mfa.isEnabled('user-1'), true);

    // Verify a fresh code.
    const code2 = computeTOTP(secret);
    const result = await mfa.verify('user-1', code2);
    assert.equal(result.verified, true);
  });

  it('rejects enrollment confirmation with invalid code', async () => {
    await mfa.enroll('user-2');
    await assert.rejects(() => mfa.confirmEnrollment('user-2', '000000'), /invalid TOTP code/);
    assert.equal(await mfa.isEnabled('user-2'), false);
  });

  it('supports backup codes as alternative verification', async () => {
    const { secret, backupCodes } = await mfa.enroll('user-3');
    await mfa.confirmEnrollment('user-3', computeTOTP(secret));

    // Use a backup code (not a TOTP).
    const result = await mfa.verify('user-3', backupCodes[0]!);
    assert.equal(result.verified, true);

    // Same backup code can't be reused.
    const reuse = await mfa.verify('user-3', backupCodes[0]!);
    assert.equal(reuse.verified, false);

    // Remaining count decreased.
    assert.equal(await mfa.remainingBackupCodes('user-3'), 9);
  });

  it('locks out after 5 failed attempts', async () => {
    const { secret } = await mfa.enroll('user-4');
    await mfa.confirmEnrollment('user-4', computeTOTP(secret));

    for (let i = 0; i < 5; i++) {
      await mfa.verify('user-4', '999999'); // invalid
    }
    const locked = await mfa.verify('user-4', computeTOTP(secret));
    assert.equal(locked.verified, false);
    assert.equal(locked.lockedOut, true);
    assert.match(locked.reason!, /locked/);
  });

  it('resets failure counter on success', async () => {
    const { secret } = await mfa.enroll('user-5');
    await mfa.confirmEnrollment('user-5', computeTOTP(secret));

    // 3 failures.
    for (let i = 0; i < 3; i++) await mfa.verify('user-5', '000000');
    // Success resets.
    const ok = await mfa.verify('user-5', computeTOTP(secret));
    assert.equal(ok.verified, true);
    // 3 more failures should NOT lock (counter was reset).
    for (let i = 0; i < 3; i++) await mfa.verify('user-5', '000000');
    const stillOk = await mfa.verify('user-5', computeTOTP(secret));
    assert.equal(stillOk.verified, true);
  });

  it('trusts and checks devices', async () => {
    const dev = await mfa.trustDevice('user-6', 'fp-hash-abc', 'My Laptop');
    assert.equal(await mfa.isDeviceTrusted('user-6', 'fp-hash-abc'), true);
    assert.equal(await mfa.isDeviceTrusted('user-6', 'unknown'), false);
    const list = await mfa.listTrustedDevices('user-6');
    assert.equal(list.length, 1);
    await mfa.revokeDevice(dev.id);
    assert.equal(await mfa.isDeviceTrusted('user-6', 'fp-hash-abc'), false);
  });

  it('elevates sessions after MFA verification', async () => {
    const { secret } = await mfa.enroll('user-7');
    await mfa.confirmEnrollment('user-7', computeTOTP(secret));

    const elev = await mfa.elevateSession('user-7', computeTOTP(secret));
    assert.equal(elev.elevated, true);
    assert.ok(elev.token);
    assert.ok(elev.expiresAt! > Date.now());
    assert.equal(mfa.isElevated(elev.token!, 'user-7'), true);
    assert.equal(mfa.isElevated(elev.token!, 'wrong-user'), false);
  });

  it('disables MFA with a valid code', async () => {
    const { secret } = await mfa.enroll('user-8');
    await mfa.confirmEnrollment('user-8', computeTOTP(secret));
    assert.equal(await mfa.isEnabled('user-8'), true);
    await mfa.disable('user-8', computeTOTP(secret));
    assert.equal(await mfa.isEnabled('user-8'), false);
  });

  it('regenerates backup codes (requires valid TOTP)', async () => {
    const { secret, backupCodes: original } = await mfa.enroll('user-9');
    await mfa.confirmEnrollment('user-9', computeTOTP(secret));

    const newCodes = await mfa.regenerateBackupCodes('user-9', computeTOTP(secret));
    assert.equal(newCodes.length, 10);
    // Old backup codes are invalidated.
    const oldResult = await mfa.verify('user-9', original[0]!);
    assert.equal(oldResult.verified, false);
    // New ones work.
    const newResult = await mfa.verify('user-9', newCodes[0]!);
    assert.equal(newResult.verified, true);
  });

  it('emits MFA lifecycle events', async () => {
    let enrolled = 0; let verified = 0; let failed = 0;
    kernel.bus.on('mfa.enrolled', () => { enrolled++; });
    kernel.bus.on('mfa.verified', () => { verified++; });
    kernel.bus.on('mfa.verification_failed', () => { failed++; });

    const { secret } = await mfa.enroll('user-10');
    await mfa.confirmEnrollment('user-10', computeTOTP(secret));
    assert.equal(enrolled, 1);
    await mfa.verify('user-10', computeTOTP(secret));
    assert.equal(verified, 1);
    await mfa.verify('user-10', '000000');
    assert.ok(failed >= 1);
  });

  it('rejects double enrollment without disabling first', async () => {
    const { secret } = await mfa.enroll('user-11');
    await mfa.confirmEnrollment('user-11', computeTOTP(secret));
    await assert.rejects(() => mfa.enroll('user-11'), /already has MFA enabled/);
  });

  it('records audit events for all MFA operations', async () => {
    const { secret } = await mfa.enroll('user-12');
    await mfa.confirmEnrollment('user-12', computeTOTP(secret));
    await mfa.verify('user-12', computeTOTP(secret));
    const sec = kernel.getModule<SecurityModule>('security');
    const audit = await sec.getAuditLog().query({ action: 'mfa.totp_verified' });
    assert.ok(audit.length >= 1);
  });
});
