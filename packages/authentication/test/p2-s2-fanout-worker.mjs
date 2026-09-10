// P2-S2 32-process fan-out worker (A-18 / multiprocess A-05): a SEPARATE OS
// process that reopens the same PostgreSQL security state and performs ONE
// session-token operation (mint / verify / rotate / revoke). No
// process-local security state is shared with the parent — every verdict
// below comes from the durable store. Prints one JSON line on stdout.
//
// Usage:
//   node p2-s2-fanout-worker.mjs <op> <connectionString> <base64urlPayload>
//
// Payload: { principalId, tenantId, roles?, staticMaterial?, material?,
//            reason?, now }. `now` is explicit (deterministic clocks).
//
// Output: { ok: true, ... } on success; { ok: false, code } on a CLOSED
// lifecycle denial (the parent asserts these); { ok: false, workerError }
// on an unexpected worker failure (the parent fails the test).

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import {
  AuthenticationEventStore,
  AutoLinkedStaticTokenAuthenticator,
  IdentityStore,
  PrincipalBoundary,
  PrincipalValidationError,
  SessionTokenService,
  StaticTokenAuthenticator,
  TokenRegistryStore,
} from '@jataqi/authentication';

const [op, connectionString, payloadB64] = process.argv.slice(2);

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, workerError: String(message) })}\n`);
  process.exit(0);
}

function deny(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'AUTHENTICATION_ERROR';
  process.stdout.write(`${JSON.stringify({ ok: false, code, message: String(error && error.message ? error.message : error) })}\n`);
  process.exit(0);
}

if (!['mint', 'verify', 'rotate', 'revoke'].includes(op) || !connectionString || !payloadB64) {
  fail('usage: mint|verify|rotate|revoke <connectionString> <base64urlPayload>');
} else {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    fail('payload is not base64url JSON');
  }
  if (payload !== undefined) {
    try {
      const driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max: 2 });
      const kernel = createTestKernel();
      const storage = new StorageModule({ driverInstance: driver });
      kernel.register(storage);
      await kernel.boot();
      const eventStore = await AuthenticationEventStore.open(storage);
      const tokenRegistry = await TokenRegistryStore.open(storage);
      const identityStore = await IdentityStore.open(storage);
      const now = typeof payload.now === 'number' ? payload.now : Date.now();
      const service = new SessionTokenService({ eventStore, identityStore, now: () => now });

      if (op === 'mint') {
        const boundary = new PrincipalBoundary({
          authenticators: [
            new AutoLinkedStaticTokenAuthenticator(
              new StaticTokenAuthenticator([], { registry: tokenRegistry }),
              identityStore,
              'p2-s2-fanout',
            ),
          ],
          policy: { mode: 'production' },
          now: () => now,
          eventStore,
          sessionTokenService: service,
        });
        const minted = await boundary.authenticateWithSessionToken({
          method: 'STATIC_TOKEN',
          material: payload.staticMaterial,
        });
        process.stdout.write(
          `${JSON.stringify({ ok: true, eventId: minted.principal.authenticationEventId, material: minted.sessionToken, principalId: minted.principal.id, tenantId: minted.principal.tenantId })}\n`,
        );
      } else if (op === 'verify') {
        const principal = await service.verify(payload.material, payload.tenantId, now);
        process.stdout.write(
          `${JSON.stringify({ ok: true, principalId: principal.id, tenantId: principal.tenantId, eventId: principal.authenticationEventId })}\n`,
        );
      } else if (op === 'rotate') {
        const rotated = await service.rotate(payload.material, payload.tenantId, now);
        process.stdout.write(
          `${JSON.stringify({ ok: true, eventId: rotated.event.id, material: rotated.material, rotationCount: rotated.event.rotationCount })}\n`,
        );
      } else {
        const revoked = await service.revoke(payload.material, payload.tenantId, payload.reason ?? 'fanout', now);
        process.stdout.write(
          `${JSON.stringify({ ok: true, eventId: revoked.id, status: revoked.status })}\n`,
        );
      }
      process.exit(0);
    } catch (error) {
      if (error instanceof PrincipalValidationError) {
        deny(error);
      } else {
        fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
    }
  }
}
