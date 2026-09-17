// P2-S8 multiprocess worker (A-17 / A-18 / A-20). Compiled to
// dist/test/p2-s8-worker.js by tsconfig.test.json (no .mjs copy step).
//
// Modes:
//   reread <connectionString> <base64url-payload>
//     Fresh OS process, fresh memory: re-opens the full P2 store stack over
//     the SAME PostgreSQL and re-reads every seeded row. Whatever this
//     process prints could only have come from the durable store — it shares
//     no memory with the seeder. This is the A-17 no-memory-reconstruction
//     proof mechanism.
//   hold-tx <connectionString>
//     Opens a raw transaction, inserts one probe row, prints IN_TX, then
//     sleeps. The parent SIGKILLs this process mid-transaction (A-17
//     kill-9-during-transaction); the probe row must then be absent
//     (server-side rollback on connection drop).
//   race-bg <connectionString> <base64url-payload>
//     Attempts ONE break-glass activation on SHARED step-up evidence (A-18
//     cross-process one-shot race). Prints { ok:true, won, code?, id? }.
//   verify-load <connectionString> <base64url-payload>
//     Verifies the same session token N times (A-18 load). Prints
//     { ok:true, verified }.
//   race-revoke <connectionString> <base64url-payload>
//     Revokes the same elevation (A-18 idempotent-revoke race). Prints
//     { ok:true, status }.
//   xproc-mfa <connectionString> <base64url-payload>
//     Attempts an MFA verify from a fresh process (A-18 boundary probe).
//     With the dev in-memory key seam the parent-sealed TOTP secret is
//     unopenable here, so this MUST fail closed (never verify). Prints
//     { ok:true, verified:false, code } on closed failure.
//
// Output contract: exactly one JSON document on the LAST stdout line:
//   { "ok": true, ... }  or  { "ok": false, "workerError": "<message>" }.
// The hold-tx IN_TX line is a prefix line, not the result document.

import { Client } from 'pg';
import { bootR2StorageKernel } from './r2-pg.js';
import {
  AuthenticationEventStore,
  BreakGlassStore,
  DelegationStore,
  DEV_SECRET_SEAM_KEY_ID,
  IdentityStore,
  InMemoryKeyManagementSeam,
  MfaFactorStore,
  PrivilegeStore,
  SecretMaterialStore,
  SessionTokenService,
} from '../src/index.js';

interface RereadPayload {
  readonly tenant: string;
  readonly principalId: string;
  readonly delegateePrincipalId: string;
  readonly sessionToken: string;
  readonly eventId: string;
  readonly delegationId: string;
  readonly breakGlassId: string;
}

function fail(message: string): never {
  console.log(JSON.stringify({ ok: false, workerError: message }));
  process.exitCode = 1;
  throw new Error(message);
}

async function modeReread(connectionString: string, payloadB64: string): Promise<void> {
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as RereadPayload;
  const { storage } = await bootR2StorageKernel(connectionString);
  const sessions = await AuthenticationEventStore.open(storage);
  const identity = await IdentityStore.open(storage);
  const service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: () => Date.now() });
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  const mfa = await MfaFactorStore.open(storage, secrets);
  const privileges = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, strictStepUp: true });
  const delegation = await DelegationStore.open(storage);
  const bg = await BreakGlassStore.open(storage, secrets, mfa, privileges);

  const principal = await service.verify(payload.sessionToken, payload.tenant, Date.now());
  const event = await sessions.getEvent(payload.eventId, payload.tenant);
  const identityDoc = await identity.getPrincipal(payload.principalId, payload.tenant);
  const roles = await identity.getActiveRoles(payload.principalId, payload.tenant, Date.now());
  const grant = await delegation.getDelegation(payload.tenant, payload.delegationId);
  const factors = await mfa.listFactors({
    tenantId: payload.tenant,
    principalId: payload.principalId,
    actorPrincipalId: payload.principalId,
  });
  const bgDoc = await bg.assertActive(payload.breakGlassId, payload.tenant, 'tenant', Date.now());
  const bounds = await privileges.assertActiveElevationsWithinBounds(Date.now());

  console.log(
    JSON.stringify({
      ok: true,
      workerPid: process.pid,
      sessionPrincipal: principal.id,
      sessionTenant: principal.tenantId,
      sessionEventId: principal.authenticationEventId,
      eventStatus: event?.status ?? null,
      identityState: identityDoc?.state ?? null,
      activeRoles: [...roles].sort(),
      delegationStatus: grant?.status ?? null,
      delegationDelegatee: grant?.delegateePrincipalId ?? null,
      factorCount: factors.length,
      factorStatuses: factors.map((f) => f.status).sort(),
      bgStatus: bgDoc.status,
      activeElevations: bounds.active,
    }),
  );
}

async function modeHoldTx(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS s8_kill_probe(pid bigint PRIMARY KEY, marker text NOT NULL)');
    await client.query('BEGIN');
    await client.query('INSERT INTO s8_kill_probe(pid, marker) VALUES ($1, $2)', [process.pid, `hold-${process.pid}`]);
    console.log(`IN_TX ${process.pid}`);
    // Hold the open transaction until the parent kills us. A-17 asserts the
    // probe row is absent afterwards (rollback on connection drop).
    await new Promise((resolve) => setTimeout(resolve, 120_000));
    console.log(JSON.stringify({ ok: false, workerError: 'hold-tx worker survived its sleep (parent never killed it)' }));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

interface RaceBgPayload {
  readonly tenant: string;
  readonly principalId: string;
  readonly sessionEventId: string;
  readonly stepUpEventId: string;
  readonly stepUpAt: number;
  readonly racer: number;
}

async function modeRaceBg(connectionString: string, payloadB64: string): Promise<void> {
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as RaceBgPayload;
  const { storage } = await bootR2StorageKernel(connectionString);
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  const mfa = await MfaFactorStore.open(storage, secrets);
  const privileges = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, strictStepUp: true });
  const bg = await BreakGlassStore.open(storage, secrets, mfa, privileges);
  try {
    const doc = await bg.activate({
      principalId: payload.principalId,
      tenantId: payload.tenant,
      scope: 'tenant',
      operationClasses: ['operator'],
      sessionEventId: payload.sessionEventId,
      stepUpEventId: payload.stepUpEventId,
      stepUpAt: payload.stepUpAt,
      reason: `p2-s8 fan-out racer ${payload.racer}`,
      actorPrincipalId: payload.principalId,
      correlationId: `s8-race-${payload.racer}`,
    });
    console.log(JSON.stringify({ ok: true, won: true, id: doc.id, racer: payload.racer }));
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'NO_CODE';
    console.log(JSON.stringify({ ok: true, won: false, code, racer: payload.racer }));
  }
}

interface VerifyLoadPayload {
  readonly tenant: string;
  readonly sessionToken: string;
  readonly rounds: number;
}

async function modeVerifyLoad(connectionString: string, payloadB64: string): Promise<void> {
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as VerifyLoadPayload;
  const { storage } = await bootR2StorageKernel(connectionString);
  const sessions = await AuthenticationEventStore.open(storage);
  const identity = await IdentityStore.open(storage);
  const service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: () => Date.now() });
  let verified = 0;
  for (let i = 0; i < payload.rounds; i += 1) {
    const principal = await service.verify(payload.sessionToken, payload.tenant, Date.now());
    if (principal.id) verified += 1;
  }
  console.log(JSON.stringify({ ok: true, verified }));
}

interface RaceRevokePayload {
  readonly tenant: string;
  readonly elevationId: string;
  readonly revokedBy: string;
  readonly revokerSessionEventId: string;
  readonly racer: number;
}

async function modeRaceRevoke(connectionString: string, payloadB64: string): Promise<void> {
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as RaceRevokePayload;
  const { storage } = await bootR2StorageKernel(connectionString);
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  const mfa = await MfaFactorStore.open(storage, secrets);
  const privileges = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, strictStepUp: true });
  const result = await privileges.revokeElevation(
    {
      elevationId: payload.elevationId,
      tenantId: payload.tenant,
      scope: 'tenant',
      revokedBy: payload.revokedBy,
      revokerSessionEventId: payload.revokerSessionEventId,
      reason: `p2-s8 revoke racer ${payload.racer}`,
      correlationId: `s8-revoke-${payload.racer}`,
    },
    Date.now(),
  );
  console.log(JSON.stringify({ ok: true, status: result.status, racer: payload.racer }));
}

interface XprocMfaPayload {
  readonly tenant: string;
  readonly principalId: string;
  readonly factorId: string;
  readonly code: string;
  readonly sessionId: string;
}

async function modeXprocMfa(connectionString: string, payloadB64: string): Promise<void> {
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as XprocMfaPayload;
  const { storage } = await bootR2StorageKernel(connectionString);
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  const mfa = await MfaFactorStore.open(storage, secrets);
  try {
    await mfa.verify({
      tenantId: payload.tenant,
      principalId: payload.principalId,
      actorPrincipalId: payload.principalId,
      factorId: payload.factorId,
      code: payload.code,
      sessionId: payload.sessionId,
      level: 'step-up',
      correlationId: 's8-xproc-mfa',
    });
    console.log(JSON.stringify({ ok: true, verified: true }));
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'NO_CODE';
    const name = error instanceof Error ? error.name : 'NO_NAME';
    console.log(JSON.stringify({ ok: true, verified: false, code, name }));
  }
}

async function main(): Promise<void> {
  const [mode, connectionString, payloadB64] = process.argv.slice(2);
  try {
    if (mode === 'reread') {
      if (!connectionString || !payloadB64) fail('reread requires <connectionString> <payload>');
      await modeReread(connectionString as string, payloadB64 as string);
    } else if (mode === 'hold-tx') {
      if (!connectionString) fail('hold-tx requires <connectionString>');
      await modeHoldTx(connectionString as string);
    } else if (mode === 'race-bg') {
      if (!connectionString || !payloadB64) fail('race-bg requires <connectionString> <payload>');
      await modeRaceBg(connectionString as string, payloadB64 as string);
    } else if (mode === 'verify-load') {
      if (!connectionString || !payloadB64) fail('verify-load requires <connectionString> <payload>');
      await modeVerifyLoad(connectionString as string, payloadB64 as string);
    } else if (mode === 'race-revoke') {
      if (!connectionString || !payloadB64) fail('race-revoke requires <connectionString> <payload>');
      await modeRaceRevoke(connectionString as string, payloadB64 as string);
    } else if (mode === 'xproc-mfa') {
      if (!connectionString || !payloadB64) fail('xproc-mfa requires <connectionString> <payload>');
      await modeXprocMfa(connectionString as string, payloadB64 as string);
    } else {
      fail(`unknown p2-s8-worker mode: ${String(mode)}`);
    }
  } catch (error) {
    fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

void main();
