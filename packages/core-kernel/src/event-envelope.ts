// F-01 unified event envelope.
//
// The envelope is deliberately a SUPERSET of the commercial-plane
// `CommercialEvent` shape: every field a `CommercialEvent` carries is present
// with identical meaning, plus `envelopeVersion` and `topic`. Consequences:
//
//   * Existing commercial-plane handlers and the `isCommercialEvent` structural
//     guard keep working unchanged on envelopes (backward compatibility).
//   * Core/knowledge-plane plain payloads are wrapped with `wrapPlainEnvelope`
//     so every bus event becomes classifiable from the envelope alone,
//     closing the F-01 two-plane split without renaming any topic.
//
// The envelope transports authority context (actor/principal references,
// tenant, correlation); it NEVER grants authority. Consumers must treat it as
// an observation, exactly like the payloads it replaces on the wire.
//
// Tenant identity inside an envelope is trusted ONLY when the envelope was
// produced server-side from an authenticated principal (T-01 boundary).
// `wrapPlainEnvelope` marks bridged legacy emits with `legacy: true` so
// downstream stores can distinguish first-class envelopes from best-effort
// bridged ones.

import { randomUUID } from 'node:crypto';
import { CANONICAL_HASH_VERSION, canonicalJson, sha256Hex } from './canonical.js';

/** Current envelope format version. Bump only with migration logic. */
export const EVENT_ENVELOPE_VERSION = 1 as const;

/** Tenant id used for kernel/system-level events that belong to no tenant. */
export const SYSTEM_TENANT = 'system';

/** Privacy classification carried on every envelope. */
export type EnvelopePrivacyClassification =
  | 'PUBLIC'
  | 'INTERNAL'
  | 'CONFIDENTIAL'
  | 'RESTRICTED'
  | 'PERSONAL_DATA';

/** Provenance carried on every envelope. */
export interface EnvelopeProvenance {
  source: string;
  collectedAt: number;
  correlationId?: string;
  causationId?: string;
  sourceReference?: string;
  contentHash?: string;
}

/**
 * Unified event envelope. A superset of `CommercialEvent`: all commercial
 * fields keep their names and semantics.
 */
export interface EventEnvelope<T = unknown> {
  /** Envelope format version (currently 1). */
  envelopeVersion: typeof EVENT_ENVELOPE_VERSION;
  /** Stable event id. */
  id: string;
  /** Event type, e.g. `commercial.decision.proposed`. */
  eventType: string;
  /** Event-type version (default 1). */
  eventVersion: number;
  /** Payload schema version (default 1). */
  schemaVersion: number;
  /** Per-producer/per-tenant sequence when assigned by a sequenced store. */
  sequence?: number;
  /** Tenant that owns the event. `system` for kernel-level events. */
  tenantId: string;
  /** Producing subsystem, e.g. `commercial-control-plane`. */
  source: string;
  /** Actor reference (id) when known. Authority context only, not a grant. */
  actor?: string;
  /** Entity the event is about, when applicable. */
  entityId?: string;
  /** Millisecond timestamp of production. */
  timestamp: number;
  /** Correlation id for the originating flow. */
  correlationId: string;
  /** Causation id (parent event/flow) when known. */
  causationId?: string;
  /** Event payload. For wrapped commercial events this is the original payload. */
  payload: T;
  /** Provenance of the event. */
  provenance: EnvelopeProvenance;
  /** Privacy classification of the event. */
  privacyClassification: EnvelopePrivacyClassification;
  /** Idempotency/dedupe key when the producer assigned one. */
  idempotencyKey?: string;
  /** Bus topic the envelope was emitted under. Preserved across delivery. */
  topic: string;
  /**
   * True when the envelope is a best-effort bridge of a legacy plain-payload
   * emit rather than a first-class produced envelope.
   */
  legacy?: boolean;
  /** Hash-chain link: hash of the previous envelope in the producer chain. */
  previousHash?: string;
  /** Hash-chain link: hash of this envelope's canonical core. */
  hash?: string;
  /** Hash-scheme version for `hash` (see CANONICAL_HASH_VERSION). */
  hashVersion?: number;
}

/** Minimal structural view of a commercial-plane event (mirrors the CCP shape). */
export interface CommercialEventLike {
  id: string;
  eventType: string;
  tenantId: string;
  source: string;
  timestamp: number;
  correlationId: string;
  payload: unknown;
  provenance: EnvelopeProvenance;
  privacyClassification: EnvelopePrivacyClassification;
  sequence?: number;
  eventVersion?: number;
  schemaVersion?: number;
  actor?: string;
  entityId?: string;
  causationId?: string;
  idempotencyKey?: string;
}

/**
 * Structural guard: true for first-class envelopes. Accepts `unknown` so it
 * can be applied to any bus payload.
 */
export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<EventEnvelope>;
  return (
    candidate.envelopeVersion === EVENT_ENVELOPE_VERSION &&
    typeof candidate.id === 'string' &&
    typeof candidate.eventType === 'string' &&
    typeof candidate.tenantId === 'string' &&
    typeof candidate.source === 'string' &&
    typeof candidate.correlationId === 'string' &&
    typeof candidate.timestamp === 'number' &&
    typeof candidate.topic === 'string' &&
    candidate.payload !== undefined &&
    candidate.provenance !== null &&
    typeof candidate.provenance === 'object' &&
    typeof candidate.privacyClassification === 'string'
  );
}

/**
 * Structural guard mirroring the commercial-plane event shape (the same field
 * set `commercial-observability` checks). True for both raw commercial events
 * and unified envelopes (envelopes are a superset).
 */
export function isCommercialEventLike(value: unknown): value is CommercialEventLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<CommercialEventLike>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.eventType === 'string' &&
    typeof candidate.tenantId === 'string' &&
    typeof candidate.source === 'string' &&
    typeof candidate.correlationId === 'string' &&
    typeof candidate.timestamp === 'number' &&
    candidate.payload !== null &&
    typeof candidate.payload === 'object' &&
    typeof candidate.privacyClassification === 'string'
  );
}

/**
 * Lift a commercial-plane event to a first-class envelope under `topic`.
 * Field values are preserved exactly; the envelope is a superset view.
 */
export function toEnvelopeFromCommercial(
  topic: string,
  event: CommercialEventLike,
  options: { legacy?: boolean } = {},
): EventEnvelope {
  assertNonBlank(topic, 'Envelope topic');
  return {
    envelopeVersion: EVENT_ENVELOPE_VERSION,
    id: event.id,
    eventType: event.eventType,
    eventVersion: event.eventVersion ?? 1,
    schemaVersion: event.schemaVersion ?? 1,
    sequence: event.sequence,
    tenantId: event.tenantId,
    source: event.source,
    actor: event.actor,
    entityId: event.entityId,
    timestamp: event.timestamp,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: copy(event.payload),
    provenance: copy(event.provenance),
    privacyClassification: event.privacyClassification,
    idempotencyKey: event.idempotencyKey,
    topic,
    ...(options.legacy === true ? { legacy: true as const } : {}),
  };
}

export interface WrapPlainEnvelopeOptions {
  tenantId?: string;
  source?: string;
  correlationId?: string;
  causationId?: string;
  entityId?: string;
  actor?: string;
  eventVersion?: number;
  schemaVersion?: number;
  privacyClassification?: EnvelopePrivacyClassification;
  idempotencyKey?: string;
  timestamp?: number;
  id?: string;
}

/**
 * Wrap a legacy plain payload in a bridged envelope (`legacy: true`).
 * Tenant is taken from options, then from `payload.tenantId` when present,
 * then falls back to `SYSTEM_TENANT`. The fallback is explicit and visible
 * so no consumer mistakes a bridged envelope for a tenant-attested one.
 */
export function wrapPlainEnvelope<T>(
  topic: string,
  payload: T,
  options: WrapPlainEnvelopeOptions = {},
): EventEnvelope<T> {
  assertNonBlank(topic, 'Envelope topic');
  const now = options.timestamp ?? Date.now();
  const payloadTenant =
    payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>).tenantId
      : undefined;
  const tenantId =
    options.tenantId ?? (typeof payloadTenant === 'string' && payloadTenant.trim() ? payloadTenant : SYSTEM_TENANT);
  // The envelope owns a copy so later mutation of the live payload by a
  // legacy handler cannot corrupt the enveloped view (or vice versa). Payloads
  // that structuredClone cannot represent (e.g. caught Error instances in
  // kernel ModuleError events) fall back to the live reference rather than
  // failing the emission: the envelope stays valid and legacy delivery is
  // unaffected.
  let sealedPayload: T;
  try {
    sealedPayload = copy(payload);
  } catch {
    sealedPayload = payload;
  }
  return {
    envelopeVersion: EVENT_ENVELOPE_VERSION,
    id: options.id ?? `env:${randomUUID()}`,
    eventType: topic,
    eventVersion: options.eventVersion ?? 1,
    schemaVersion: options.schemaVersion ?? 1,
    tenantId,
    source: options.source ?? 'legacy-bridge',
    actor: options.actor,
    entityId: options.entityId,
    timestamp: now,
    correlationId: options.correlationId ?? `bridge:${topic}`,
    causationId: options.causationId,
    payload: sealedPayload,
    provenance: {
      source: options.source ?? 'legacy-bridge',
      collectedAt: now,
      correlationId: options.correlationId,
      causationId: options.causationId,
    },
    privacyClassification: options.privacyClassification ?? 'INTERNAL',
    idempotencyKey: options.idempotencyKey,
    topic,
    legacy: true,
  };
}

/**
 * Best-effort conversion of ANY bus payload to an envelope for enveloped
 * wildcard delivery: envelopes pass through (topic refreshed when it differs),
 * commercial-like payloads lift without the legacy flag, everything else is
 * plain-wrapped and flagged `legacy: true`.
 */
export function toEnvelopedDelivery(topic: string, payload: unknown): EventEnvelope {
  if (isEventEnvelope(payload)) {
    if (payload.topic === topic) return payload;
    return { ...payload, topic };
  }
  if (isCommercialEventLike(payload)) return toEnvelopeFromCommercial(topic, payload);
  return wrapPlainEnvelope(topic, payload);
}

/**
 * Compatibility unwrap: envelopes yield their payload, any other value passes
 * through unchanged. Migrated subscribers use this so they accept both
 * first-class envelopes and legacy plain payloads during the migration window.
 */
export function extractPayload<T = unknown>(maybeEnvelope: unknown): T {
  if (isEventEnvelope(maybeEnvelope)) return maybeEnvelope.payload as T;
  return maybeEnvelope as T;
}

/** Canonical core of an envelope for v1 hashing (excludes the hash itself). */
export function envelopeHashCore(envelope: EventEnvelope): Record<string, unknown> {
  return {
    envelopeVersion: envelope.envelopeVersion,
    id: envelope.id,
    eventType: envelope.eventType,
    eventVersion: envelope.eventVersion,
    schemaVersion: envelope.schemaVersion,
    sequence: envelope.sequence,
    tenantId: envelope.tenantId,
    source: envelope.source,
    actor: envelope.actor,
    entityId: envelope.entityId,
    timestamp: envelope.timestamp,
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    payload: envelope.payload,
    provenance: envelope.provenance,
    privacyClassification: envelope.privacyClassification,
    idempotencyKey: envelope.idempotencyKey,
    topic: envelope.topic,
    previousHash: envelope.previousHash,
  };
}

/** v1 hash of an envelope's canonical core. */
export function hashEnvelopeV1(envelope: EventEnvelope): string {
  return sha256Hex(canonicalJson(envelopeHashCore(envelope)));
}

/**
 * Seal an envelope into a per-producer hash chain. Returns a new envelope
 * carrying `previousHash`, `hash`, and `hashVersion`. The input is not mutated.
 */
export function sealEnvelopeChain(envelope: EventEnvelope, previousHash: string): EventEnvelope {
  const next: EventEnvelope = { ...envelope, previousHash };
  return { ...next, hash: hashEnvelopeV1(next), hashVersion: CANONICAL_HASH_VERSION };
}

/**
 * Verify a hash-chained envelope sequence: linkage (`previousHash` matches the
 * prior `hash`, starting from `genesis`), hash recomputation, and — when both
 * neighbors carry sequences — contiguity. Returns `{ valid: true }` or the
 * first failure with its index. Unchained envelopes (no `hash`) are skipped,
 * never failed: verification is fail-closed on tampering, not on absence.
 */
export function verifyEnvelopeChain(
  envelopes: readonly EventEnvelope[],
  genesis = 'GENESIS',
): { valid: true } | { valid: false; index: number; reason: string } {
  let previousHash = genesis;
  let previousSequence: number | undefined;
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index]!;
    if (envelope.hash === undefined) {
      previousSequence = envelope.sequence;
      continue;
    }
    if ((envelope.previousHash ?? genesis) !== previousHash) {
      return { valid: false, index, reason: 'Envelope previous hash does not match.' };
    }
    if (envelope.hash !== hashEnvelopeV1({ ...envelope, hash: undefined, hashVersion: undefined })) {
      return { valid: false, index, reason: 'Envelope hash does not match its canonical core.' };
    }
    if (
      previousSequence !== undefined &&
      envelope.sequence !== undefined &&
      envelope.sequence !== previousSequence + 1
    ) {
      return { valid: false, index, reason: 'Envelope sequence is discontinuous.' };
    }
    previousHash = envelope.hash;
    previousSequence = envelope.sequence;
  }
  return { valid: true };
}

/**
 * Minimal structural emitter for enveloped delivery (avoids an import cycle
 * with `event-bus.ts`; `EventBus` satisfies this interface).
 */
export interface EnvelopedEmitter {
  emitEnveloped(event: string, envelope: EventEnvelope, opts?: { legacyPayload?: unknown }): Promise<void>;
}

export interface EmitPlainEnvelopedOptions extends WrapPlainEnvelopeOptions {
  /** Producing subsystem; recorded in the envelope and its provenance. */
  source: string;
}

/**
 * Shared F-01b producer helper: wrap a plain service payload in a
 * first-class envelope and emit it with the original payload preserved for
 * legacy subscribers (single emission, no duplicates, no topic renames).
 */
export function emitPlainEnveloped<T>(
  emitter: EnvelopedEmitter,
  topic: string,
  payload: T,
  options: EmitPlainEnvelopedOptions,
): Promise<void> {
  const envelope = wrapPlainEnvelope(topic, payload, options);
  return emitter.emitEnveloped(topic, envelope, { legacyPayload: payload });
}

/**
 * F-01e consumer-nomination governance (C-4 carried forward).
 *
 * The publish-only event intent stands: an event gains an in-repo consumer
 * only through explicit nomination. This table is the machine-readable form
 * of the nominated consumer set documented in EVENT_SURFACE_CONTRACT.md. A
 * `topic` ending in `.*` nominates that namespace (used by
 * `@jataqi/commercial-memory`, which observes the enumerated commercial
 * namespace). `kernel.*` covers the kernel-internal one-shot lifecycle waits.
 * There are NO nominated wildcard (`onAny`) consumers.
 *
 * T-05: nomination is channel-independent. `@jataqi/billing`,
 * `@jataqi/revenue-ledger` and `@jataqi/commercial-memory` consume their
 * nominated topics through the durable unified-outbox inbox (registered
 * durable handlers delivered by `@jataqi/commercial-event-stream`), not
 * through a volatile bus subscription. The only bus subscription the delivery
 * worker itself holds is the post-commit wake-up on
 * `commercial.event.recorded`, which carries no payload authority: the pass
 * re-reads and re-verifies the durable record before any handler runs.
 */
export interface NominatedSubscription {
  /** Workspace package holding the subscription, e.g. `@jataqi/billing`. */
  package: string;
  /** Nominated topic, or `namespace.*` for a nominated namespace. */
  topic: string;
}

export const F01_NOMINATED_SUBSCRIPTIONS: readonly NominatedSubscription[] = Object.freeze([
  { package: '@jataqi/billing', topic: 'payment.verified' },
  { package: '@jataqi/billing', topic: 'payment.refund.verified' },
  { package: '@jataqi/revenue-ledger', topic: 'billing.invoice.paid' },
  { package: '@jataqi/revenue-ledger', topic: 'billing.invoice.refunded' },
  { package: '@jataqi/commercial-memory', topic: 'commercial.*' },
  { package: '@jataqi/commercial-memory', topic: 'payment.verified' },
  { package: '@jataqi/commercial-memory', topic: 'payment.refund.verified' },
  { package: '@jataqi/commercial-memory', topic: 'billing.invoice.paid' },
  { package: '@jataqi/commercial-memory', topic: 'billing.invoice.refunded' },
  { package: '@jataqi/commercial-observability', topic: 'commercial.event.recorded' },
  { package: '@jataqi/commercial-event-stream', topic: 'commercial.event.recorded' },
  { package: '@jataqi/knowledge-graph', topic: 'knowledge.document.ingested' },
  { package: '@jataqi/core-kernel', topic: 'kernel.*' },
]);

/** True when (`packageId`, `topic`) is a nominated in-repo subscription. */
export function isNominatedSubscription(packageId: string, topic: string): boolean {
  return F01_NOMINATED_SUBSCRIPTIONS.some((entry) => {
    if (entry.package !== packageId) return false;
    if (entry.topic === topic) return true;
    if (entry.topic.endsWith('.*')) {
      const namespace = entry.topic.slice(0, -2);
      return topic === namespace || topic.startsWith(`${namespace}.`);
    }
    return false;
  });
}

/**
 * Review-gate audit over a declared subscription inventory: returns the
 * nominated and unnominated entries. New in-repo consumers must appear in the
 * nominated set (via reviewed nomination) — this helper enforces that in
 * tests; it is intentionally NOT a runtime bus block, so transport stays
 * decoupled from governance review.
 */
export function auditSubscriptionCoverage(
  inventory: readonly NominatedSubscription[],
): { nominated: NominatedSubscription[]; unnominated: NominatedSubscription[] } {
  const nominated: NominatedSubscription[] = [];
  const unnominated: NominatedSubscription[] = [];
  for (const entry of inventory) {
    (isNominatedSubscription(entry.package, entry.topic) ? nominated : unnominated).push(entry);
  }
  return { nominated, unnominated };
}

/**
 * Unwrap the content for an enveloped subscriber: the envelope payload.
 * Bridge-synthesized envelopes carry the original plain payload here, so a
 * cut-over consumer accepts both enveloped producers and not-yet-migrated
 * (out-of-scope) producers. Commercial-domain consumers that need the full
 * `CommercialEvent` view must use `commercialEventFromEnvelope` (commercial
 * control plane), which reconstructs it from envelope metadata + payload.
 */
export function payloadOf<T>(envelope: EventEnvelope<unknown>): T {
  return envelope.payload as T;
}

function assertNonBlank(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required.`);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
