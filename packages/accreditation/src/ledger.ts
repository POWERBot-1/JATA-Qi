// Append-only, tamper-evident ledger for the accreditation audit trail (Part I:
// immutable ledgers). Each entry is SHA-256 chained to the previous entry so
// any retroactive edit or deletion is detectable. Used to record grant
// issuance, suspension, revocation, and operation-mode changes.

import { canonicalJSON, fingerprint } from '@jataqi/provenance';
import type { AccreditationLedgerEntry } from './types.js';

const GENESIS_HASH = '0'.repeat(64);

export class AccreditationLedger {
  private entries: AccreditationLedgerEntry[] = [];
  private nextSeq = 1;

  /** Current length of the chain. */
  get length(): number {
    return this.entries.length;
  }

  /** Append an entry, returning it (with computed hash + prevHash). */
  append(action: string, payload: Record<string, unknown>): AccreditationLedgerEntry {
    const seq = this.nextSeq++;
    const ts = Date.now();
    const prevHash = this.entries.length > 0
      ? this.entries[this.entries.length - 1]!.entryHash
      : GENESIS_HASH;
    // The entry hash covers seq, ts, action, prevHash, and payload — everything
    // except the entryHash itself.
    const entryHash = fingerprint({ seq, ts, action, prevHash, payload });
    const entry: AccreditationLedgerEntry = { seq, ts, action, prevHash, entryHash, payload };
    this.entries.push(entry);
    return entry;
  }

  /** Return a defensive copy of the chain. */
  all(): AccreditationLedgerEntry[] {
    return this.entries.map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  /**
   * Verify the integrity of the entire chain. Returns true iff every entry's
   * recomputed hash matches and every prevHash links correctly.
   */
  verify(): boolean {
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    for (const e of this.entries) {
      if (e.seq !== expectedSeq++) return false;
      if (e.prevHash !== prevHash) return false;
      const recomputed = fingerprint({
        seq: e.seq,
        ts: e.ts,
        action: e.action,
        prevHash: e.prevHash,
        payload: e.payload,
      });
      if (recomputed !== e.entryHash) return false;
      prevHash = e.entryHash;
    }
    return true;
  }

  /** Merkle-style root: the hash of the last entry (or genesis). */
  rootHash(): string {
    return this.entries.length > 0
      ? this.entries[this.entries.length - 1]!.entryHash
      : GENESIS_HASH;
  }
}

/** Canonical, sorted-key JSON of an arbitrary value (re-export for callers). */
export { canonicalJSON };
