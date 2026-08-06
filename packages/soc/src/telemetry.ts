// Telemetry pipeline + security data lake.
//
// The pipeline accepts high-throughput security events from any source
// (gateway, auth, network, AI, cloud, ...), normalizes them, and appends them
// to a hash-chained, append-only lake for retention, forensics, compliance
// export, and historical analytics. The chain makes tampering detectable:
// each entry commits to the previous entry's hash.

import { createHash, randomUUID } from 'node:crypto';
import type { LakeEntry, SecurityEvent, TelemetrySource } from './types.js';

export interface TelemetryPipelineOptions {
  /** Max in-memory events (ring buffer). 0 = unlimited. */
  retention?: number;
}

export class TelemetryPipeline {
  private lake: LakeEntry[] = [];
  private lastHash = 'GENESIS';
  private readonly retention: number;

  constructor(opts: TelemetryPipelineOptions = {}) {
    this.retention = opts.retention ?? 0;
  }

  /**
   * Ingest a raw security event; returns the chained lake entry.
   * Missing ids are synthesized; timestamps default to now.
   */
  ingest(input: Omit<SecurityEvent, 'id' | 'ts'> & { id?: string; ts?: number }): LakeEntry {
    const event: SecurityEvent = {
      id: input.id ?? randomUUID(),
      ts: input.ts ?? Date.now(),
      source: input.source,
      type: input.type,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.data ? { data: input.data } : {}),
    };
    const canonical = canonicalJson({ ...event, prevHash: this.lastHash });
    const entry: LakeEntry = {
      ...event,
      prevHash: this.lastHash,
      hash: createHash('sha256').update(canonical).digest('hex'),
    };
    this.lake.push(entry);
    this.lastHash = entry.hash;
    if (this.retention > 0 && this.lake.length > this.retention) {
      this.lake = this.lake.slice(-this.retention);
    }
    return entry;
  }

  /** Batch ingestion (high-throughput path). */
  ingestBatch(inputs: Array<Omit<SecurityEvent, 'id' | 'ts'> & { id?: string; ts?: number }>): LakeEntry[] {
    return inputs.map((i) => this.ingest(i));
  }

  count(): number {
    return this.lake.length;
  }

  entries(): LakeEntry[] {
    return [...this.lake];
  }

  /** Query the lake by type (exact or prefix), actor, origin, time range. */
  query(filter: { type?: string; actor?: string; origin?: string; since?: number; until?: number; limit?: number } = {}): LakeEntry[] {
    const type = filter.type;
    let out = this.lake.filter((e) =>
      (!type || e.type === type || e.type.startsWith(type)) &&
      (!filter.actor || e.actor === filter.actor) &&
      (!filter.origin || e.origin === filter.origin) &&
      (filter.since === undefined || e.ts >= filter.since) &&
      (filter.until === undefined || e.ts <= filter.until));
    if (filter.limit !== undefined) out = out.slice(-filter.limit);
    return out;
  }

  /** Verify the entire hash chain (tamper evidence). */
  verifyChain(): { valid: boolean; brokenAt?: string } {
    let prev = 'GENESIS';
    for (const entry of this.lake) {
      if (entry.prevHash !== prev) return { valid: false, brokenAt: entry.id };
      const { hash, ...rest } = entry;
      // The stored hash commits to every field EXCEPT the hash itself.
      const expect = createHash('sha256').update(canonicalJson(rest)).digest('hex');
      if (hash !== expect) return { valid: false, brokenAt: entry.id };
      prev = hash;
    }
    return { valid: true };
  }

  /** Forensic / compliance export (JSON lines). */
  exportJsonl(): string {
    return this.lake.map((e) => JSON.stringify(e)).join('\n');
  }

  /** Compliance export (CSV). */
  exportCsv(): string {
    const header = 'id,ts,source,type,actor,origin,severity,detail,hash';
    const rows = this.lake.map((e) =>
      [e.id, e.ts, e.source, e.type, e.actor ?? '', e.origin ?? '', e.severity ?? '', (e.detail ?? '').replace(/,/g, ' '), e.hash]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    return [header, ...rows].join('\n');
  }

  /** Historical analytics: event counts per source/type in a window. */
  analytics(since?: number): { bySource: Record<string, number>; byType: Record<string, number> } {
    const bySource: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const e of this.lake) {
      if (since !== undefined && e.ts < since) continue;
      bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      byType[e.type] = (byType[e.type] ?? 0) + 1;
    }
    return { bySource, byType };
  }
}

export function canonicalJson(value: unknown): string {
  // Deterministic serialization: objects are serialized with sorted keys.
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = (v as Record<string, unknown>)[key];
      }
      return out;
    }
    return v;
  });
}

export type { TelemetrySource };
