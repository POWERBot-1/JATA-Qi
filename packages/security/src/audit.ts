// Append-only audit ledger. Records are persisted (via a storage namespace) and
// published on the kernel event bus so the rest of the platform can react to
// security-relevant events.

import { randomUUID } from 'node:crypto';
import type { INamespace } from '@jataqi/storage';
import type { AuditRecord } from './types.js';

export interface AuditQuery {
  actor?: string;
  action?: string;
  result?: AuditRecord['result'];
  since?: number;
  limit?: number;
}

/** Escape a field per RFC 4180 (quotes doubled; wrap when containing , " \n \r). */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Render audit records as CSV (RFC 4180) with a stable header row. */
export function auditCsv(records: AuditRecord[]): string {
  const header = ['id', 'ts', 'actor', 'action', 'result', 'resource', 'detail'];
  const rows = records.map((r) => [
    csvField(r.id),
    csvField(r.ts),
    csvField(r.actor),
    csvField(r.action),
    csvField(r.result),
    csvField(r.resource),
    csvField(r.detail),
  ]);
  return [header.join(','), ...rows.map((row) => row.join(','))].join('\r\n') + '\r\n';
}

/** Render audit records as a JSON array (pretty-printed for readability). */
export function auditJson(records: AuditRecord[]): string {
  return JSON.stringify(records, null, 2) + '\n';
}

export class AuditLog {
  constructor(private readonly ns: INamespace) {}

  /** Append a record. The ledger is append-only — there is no update/delete. */
  async record(rec: Omit<AuditRecord, 'id' | 'ts'> & { ts?: number }): Promise<AuditRecord> {
    const full: AuditRecord = {
      id: randomUUID(),
      ts: rec.ts ?? Date.now(),
      actor: rec.actor,
      action: rec.action,
      result: rec.result,
      ...(rec.resource !== undefined ? { resource: rec.resource } : {}),
      ...(rec.detail !== undefined ? { detail: rec.detail } : {}),
    };
    await this.ns.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<AuditRecord | undefined> {
    return this.ns.get<AuditRecord>(id);
  }

  /** Query records, newest first. */
  async query(q: AuditQuery = {}): Promise<AuditRecord[]> {
    const limit = q.limit ?? 100;
    const all = await this.ns.list<AuditRecord>({ limit: 10_000 });
    let items = all.items.map((e) => e.value);
    if (q.actor) items = items.filter((r) => r.actor === q.actor);
    if (q.action) items = items.filter((r) => r.action === q.action);
    if (q.result) items = items.filter((r) => r.result === q.result);
    if (q.since) items = items.filter((r) => r.ts >= q.since!);
    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, limit);
  }

  async count(): Promise<number> {
    return this.ns.size();
  }
}
