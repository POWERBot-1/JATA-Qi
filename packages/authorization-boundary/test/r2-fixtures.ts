// Shared fixtures for the R2 durable-security suites: a fully durable world
// (PG storage + SecurityStateStore + session store + durable broker + gate)
// with a controllable clock, plus manifest/session/request builders.

import {
  AuthenticationEventStore,
  type AuthenticationEventDoc,
} from '@jataqi/authentication';
import { StorageModule } from '@jataqi/storage';
import {
  AuthorizationGate,
  DurableCredentialBroker,
  InMemoryAuditSink,
  InMemoryCredentialMaterialProvider,
  SecurityStateStore,
  type A01AuthorizationRequest,
  type A01CapabilityManifest,
  type A01PrincipalBinding,
  type ManifestRegistrar,
} from '../src/index.js';
import { bootR2StorageKernel } from './r2-pg.js';
import { baseRequest, manifest, principal } from './helpers.js';

export interface R2World {
  storage: StorageModule;
  store: SecurityStateStore;
  sessions: AuthenticationEventStore;
  broker: DurableCredentialBroker;
  provider: InMemoryCredentialMaterialProvider;
  gate: AuthorizationGate;
  audit: InMemoryAuditSink;
  now(): number;
  advance(ms: number): void;
}

let worldSeq = 0;

export async function buildR2World(
  connectionString: string,
  startTime: number,
): Promise<R2World> {
  worldSeq += 1;
  let now = startTime;
  const clock = (): number => now;
  const { storage } = await bootR2StorageKernel(connectionString);
  const store = await SecurityStateStore.open(storage, { now: clock });
  const sessions = await AuthenticationEventStore.open(storage);
  const provider = new InMemoryCredentialMaterialProvider();
  const broker = new DurableCredentialBroker(store, provider, { now: clock });
  const audit = new InMemoryAuditSink();
  const gate = new AuthorizationGate({ store, durableBroker: broker, audit, now: clock });
  return {
    storage,
    store,
    sessions,
    broker,
    provider,
    gate,
    audit,
    now: clock,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

export function uniqueCapability(prefix: string): string {
  worldSeq += 1;
  return `${prefix}.cap.${process.pid}.${worldSeq}`;
}

export function durableManifest(
  capabilityId: string,
  overrides: Record<string, unknown> = {},
): A01CapabilityManifest {
  // R2 enforcement deny-earlies freshness by the 300s skew bound, so R2
  // fixtures use a 1h envelope lifetime by default; override explicitly
  // when a test needs a different lifetime.
  return manifest({ capabilityId, maxLifetimeMs: 3_600_000, ...overrides });
}

export function registrar(tenantId = 'acme'): ManifestRegistrar {
  return { principalId: 'user:registrar', tenantId, authenticationEventId: 'evt-registrar-1' };
}

export interface MintedSession {
  eventId: string;
  tenantId: string;
  principalId: string;
  row: AuthenticationEventDoc;
}

export async function mintSession(
  world: R2World,
  overrides: {
    tenantId?: string;
    principalId?: string;
    lifetimeMs?: number;
  } = {},
): Promise<MintedSession> {
  const tenantId = overrides.tenantId ?? 'acme';
  const principalId = overrides.principalId ?? 'user:alice';
  const eventId = `evt-${process.pid}-${++worldSeq}`;
  const row = await world.sessions.recordEvent(
    {
      eventId,
      tenantId,
      principalId,
      method: 'STATIC_TOKEN',
      verifiedAt: world.now(),
      expiresAt: world.now() + (overrides.lifetimeMs ?? 3_600_000),
    },
    world.now(),
  );
  return { eventId, tenantId, principalId, row };
}

export function sessionPrincipal(session: MintedSession): A01PrincipalBinding {
  return principal({
    id: session.principalId,
    tenantId: session.tenantId,
    authenticationMethod: 'STATIC_TOKEN',
    authenticationEventId: session.eventId,
  });
}

export function durableRequest(
  capabilityId: string,
  session: MintedSession,
  overrides: Record<string, unknown> = {},
): A01AuthorizationRequest {
  return baseRequest({
    principal: sessionPrincipal(session),
    tenantId: session.tenantId,
    capability: { capabilityId, capabilityVersion: '1' },
    ...overrides,
  });
}
