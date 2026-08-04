// NOVA netcode — wire protocol. Authoritative server ↔ clients exchange joins,
// inputs, snapshots, deltas, and RPCs over a transport (loopback for tests,
// WebSocket/UDP in production).

/** Replicated state: entityId -> component -> value. */
export type SnapshotData = Record<string, Record<string, unknown>>;

export type NetMessage =
  | { t: 'join'; peer: string; name?: string }
  | { t: 'joined'; peer: string; entity: number; seq: number }
  | { t: 'leave'; peer: string }
  | { t: 'input'; peer: string; seq: number; payload: unknown }
  | { t: 'ack'; peer: string; seq: number }
  | { t: 'snapshot'; seq: number; tick: number; state: SnapshotData }
  | { t: 'delta'; seq: number; base: number; tick: number; changes: SnapshotData; removed: string[] }
  | { t: 'rpc'; peer: string; name: string; args: unknown };

/** Diff two snapshots into a delta (changed/added entities only). */
export function diffSnapshots(prev: SnapshotData, next: SnapshotData): { changes: SnapshotData; removed: string[] } {
  const changes: SnapshotData = {};
  const removed: string[] = [];
  for (const id of Object.keys(next)) {
    const after = next[id]!;
    const before = prev[id];
    if (!before) { changes[id] = after; continue; }
    if (!shallowEqual(before, after)) changes[id] = after;
  }
  for (const id of Object.keys(prev)) if (!(id in next)) removed.push(id);
  return { changes, removed };
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k], bv = b[k];
    if (typeof av === 'object' && av !== null) {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
    } else if (av !== bv) return false;
  }
  return true;
}
