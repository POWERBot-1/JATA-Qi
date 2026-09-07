// Canonical serialization + integrity digest for authorization envelopes.
//
// The digest is the tamper-detection primitive: the PDP computes it over the
// canonical form of the envelope (all authoritative fields, `integrity`
// excluded), and every enforcement point recomputes it before trusting the
// envelope. Canonical form is deterministic: keys sorted recursively, arrays
// ordered, `undefined` properties dropped, and any non-finite number rejected
// so no representation can slip past the digest.

import { createHash } from 'node:crypto';

export function canonicalize(value: unknown, path = '$'): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`canonicalize: non-finite number at ${path} (malformed envelope)`);
    }
    return JSON.stringify(value);
  }
  if (type === 'string' || type === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => canonicalize(item, `${path}[${index}]`));
    return `[${items.join(',')}]`;
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonicalize: unsupported value type "${type}" at ${path} (malformed envelope)`);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sha256Of(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/**
 * The exact action fields an approval may bind to. An approval is valid only
 * for the action it was rendered for — any difference in any of these fields
 * is an approval mismatch.
 */
export interface A01ActionDigestFields {
  readonly tenantId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly tool: string;
  readonly operation: string;
  readonly targetSystem: string;
  readonly targetResource: string;
  readonly dataClassification: string;
  readonly impact: string;
}

export function a01ActionDigest(fields: A01ActionDigestFields): string {
  return sha256Hex(
    canonicalize({
      tenantId: fields.tenantId,
      principalId: fields.principalId,
      agentId: fields.agentId,
      runId: fields.runId,
      capabilityId: fields.capabilityId,
      tool: fields.tool,
      operation: fields.operation,
      targetSystem: fields.targetSystem,
      targetResource: fields.targetResource,
      dataClassification: fields.dataClassification,
      impact: fields.impact,
    }),
  );
}

/** Recursively freeze. The returned object is the same reference. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
