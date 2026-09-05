// F-01 shared deterministic canonicalization (hash-scheme v1).
//
// This module is the single canonical JSON + SHA-256 helper for NEW F-01
// event-fabric hashing (envelopes, unified outbox). It deliberately does NOT
// replace the existing commercial-ledger, capability-fabric-audit, or
// loop-host-checkpoint hash inputs: those historical chains keep their exact
// byte format and existing verifiers (dual verification). New chains use
// this canonicalizer and are tagged with CANONICAL_HASH_VERSION.

import { createHash } from 'node:crypto';

/** Version tag for hashes produced through this module. */
export const CANONICAL_HASH_VERSION = 1;

/**
 * Deterministic canonical JSON: object keys sorted, `undefined` object
 * properties dropped (matching JSON persistence semantics, so a
 * persisted/reloaded record hashes identically), arrays in order.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 hex digest of the canonical JSON of a value. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
