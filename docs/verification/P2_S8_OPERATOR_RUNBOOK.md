# P2-S8 — Operator Runbook: Distributed Failure / Recovery

| Field | Value |
|---|---|
| Scope | P2 identity/privileged plane (packages `authentication`, `authorization-boundary`) on the shared PostgreSQL substrate |
| Spec | `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` §15 (A-17…A-23), §24 P2-S8 acceptance |
| Assurance | Each class below is pinned by a committed executable suite; suite paths + results are in `docs/verification/P2_S8_IMPLEMENTATION_REPORT.md` |
| Standing rule | **Fail closed, never fall back to process memory.** All identity/privilege state is store-mediated (R2 rule). Any decision taken while the store is unreachable must DENY. |

---

## 1. Host process killed / restarted (A-17)

**Symptoms:** identity-plane process dies (OOM, crash, deploy restart, `SIGKILL`); in-flight requests drop.

**Recovery steps:**
1. Restart the process against the SAME PostgreSQL primary. No state transfer, no cache warm-up, no replay queue: every row class (identity, session + token, MFA factor, privilege elevation, delegation grant, break-glass record) is re-read from the store on demand.
2. Clients retry in-flight work; the server re-validates each request against current durable state (an in-flight request HELDs or resumes by re-validation — it is never resumed from the dead process's memory).
3. Verify: re-read digests of all P2 row classes must equal pre-restart digests (the A-17 suite asserts exactly this with a fresh OS process).

**What NOT to do:** do not restore "session state" from a memory snapshot, core dump, or log tail. There is no process-local session/token/elevation/grant authority by architecture; anything reconstructed from memory is untrusted by definition.

**Kill during a transaction:** PostgreSQL rolls back the uncommitted transaction when the connection drops. The uncommitted row will be absent; pre-existing committed state is unaffected. No manual cleanup is required — but do confirm the postmaster is healthy and row digests match (A-17 suite step 2–3).

## 2. Contended multi-process load / duplicate-submit storms (A-18, A-23)

**Symptoms:** many processes (or retried clients) hammer auth/rotation/revocation/enrollment paths concurrently; duplicate submissions arrive.

**Expected behavior (no operator action):**
- Session-token acceptance is exactly-once per token: concurrent accepts of the same token yield exactly one success; rotation ordering stays consistent (per-event monotonic fingerprint chain); no revocation is lost.
- Double enrollment → second submission DENIED (`ALREADY_ENROLLED`).
- Double token import → idempotent skip (`imported: 0, skipped: 1`); rebind to a different owner is REFUSED.
- Double break-glass activation → one-shot failure (`BG_ONE_SHOT`); exactly one durable record per case.
- One-time codes (MFA, break-glass): first use succeeds, every concurrent/duplicate use fails closed (`CONSUMED`, `MFA_CODE_REPLAYED`) via compare-and-swap.

**Operator action:** none for correctness. If duplicates are unexpected (client bug vs. attack), correlate `identity.events` for the affected principal before rotating their credentials. Issuance paths carry NO idempotency key — double-execution prevention lives at USE time (one-shot CAS); do not "reconcile" by deleting consumed envelopes (S4 A-25 dedup depends on them).

## 3. Store unreachable mid-decision — node loss / outage (A-19)

**Symptoms:** connection errors from the identity plane; decisions failing; PostgreSQL primary unreachable (network partition, host loss, failover in progress).

**Expected behavior (automatic):** every authentication check and every authorization decision taken while the store is unreachable DENIES fail-closed with `SECURITY_STATE_UNAVAILABLE`. There is deliberately NO memory fallback, NO cached-ALLOW, NO degraded-allow. An outage therefore presents as a deny storm, not as unauthorized access.

**Recovery steps:**
1. Restore PostgreSQL connectivity (network, primary, or promoted standby — see §4).
2. Decisions resume automatically on the next request; no plane restart or cache flush is needed (there is no decision cache to flush).
3. Verify: confirm decisions succeed again for a known-good principal AND that the outage window contains deny-only records (no ALLOW decided while the store was down).

**What NOT to do:** do not "restore service" by enabling any bypass, static allow-list, or cached-decision mode. A-19 exists precisely to prove the plane cannot be talked into allowing without the store.

## 4. Primary loss / failover to a new primary (A-20)

**Symptoms:** primary declared dead; traffic must move to a promoted standby (production HA is P7 territory — this section covers the P2 contract the plane guarantees).

**Recovery steps:**
1. Promote the standby per the P7/infrastructure failover procedure (outside P2 scope).
2. Repoint the plane's PostgreSQL connection to the new primary and restart plane processes (or let the connector pick up the new endpoint — either way, processes re-read all state from the new primary; nothing is carried over in memory).
3. Verify before declaring recovery complete:
   - Row counts + statuses on the new primary equal the last known-good primary snapshot (pre/post row digests identical — the A-20 suite asserts zero divergence).
   - A known-good authentication AND a known-good authorization decision both succeed against the new primary.
   - No divergence window is accepted: any row present on the old primary but missing on the new one is a data-loss incident, not a "sync delay" — escalate.

## 5. Clock skew (A-21)

**Symptoms:** tokens/elevations expiring "early" or accepted "late"; step-up/MFA assurance rejected across hosts.

**Contract (exact boundaries, all relative to the STORE clock):**
- Session verify and elevation recheck: `now ≤ expiresAt − 300000ms` VALID; `now ≥ expiresAt − 299999ms`… precisely: the flip is between E−300001 (VALID) and E−300000 (EXPIRED) — the E−300000 boundary is EXPIRED (inclusive).
- Step-up and MFA assurance: strict age — `maxAge` VALID, `maxAge + 1` STALE; future-dated evidence (`now < satisfiedAt`) is MISMATCH (never accepted).
- Delegation sweep: per-tenant flip at E−300000.

**Recovery steps:**
1. The authoritative clock is the STORE's clock. Skewed APP hosts do not corrupt decisions (every check injects `now` against durable `expiresAt`), but a skewed STORE host shifts every boundary — fix NTP on the database host first.
2. Do not "fix" skew by widening windows, accepting future-dated evidence, or re-issuing longer-lived tokens. The boundaries above are security properties with executable pins (A-21 suite); any change requires a spec amendment + re-verification.

## 6. Suspected audit tampering (A-22)

**Symptoms:** `identity.events` (or delegation/audit) rows look wrong; digest mismatch cited in a denial; unknown fields appear in rows.

**Contract and response:**
1. In-app writes use pick-construction over closed schemas: unknown fields are DROPPED, never persisted; shape-invalid writes are REFUSED; terminal states (consumed, revoked, expired) are immutable.
2. If a directly-mutated row is suspected (DB-level bypass of the app): any decision citing the tampered event DENIES (row-digest mismatch). Treat this as an integrity incident: freeze the affected rows (do not delete — append-only), snapshot the database, and investigate the DB-access path (the app cannot produce such a row through its own writes).
3. Secret material must NEVER appear in any audit/event row (14-collection sweep asserts this). If material is found in a row, treat it as a compromise of that credential: rotate/revoke the credential, then purge per the retention procedure — and file a finding, because a committed suite asserts this cannot happen through app writes.
4. **Honest limitation (standing):** shape-VALID direct DB mutation is NOT cryptographically detected (closed schema + CAS + RLS + append-only only; envelope integrity is unkeyed SHA-256 — P1-GAP-12, recorded adjacent in spec §25 AG-5). DB-level write access remains a trust boundary: restrict it, audit it, and do not claim detection the mechanism cannot provide.

## 7. Break-glass (emergency access)

Covered by the S6 break-glass contract; S8 adds only the distributed pins: activation is one-shot across processes (concurrent double activation yields exactly one record + `BG_ONE_SHOT` for the loser), activation records survive restart (§1), and activation during an outage is impossible (the decision DENIES per §3 — break-glass cannot open during a store outage; restore the store first).

---

## Quick-reference: failure class → expected plane behavior

| Failure | Plane behavior | Operator's first move |
|---|---|---|
| Process killed/restarted | State re-read from store; in-flight work re-validated | Restart vs same primary; verify digests |
| Contended/duplicate load | Exactly-once accepts; duplicates denied/skipped/one-shot-failed | None (correlate events if anomalous) |
| Store unreachable | DENY `SECURITY_STATE_UNAVAILABLE`, no fallback | Restore connectivity; verify deny-only window |
| Primary loss | Re-read from new primary after repoint | Promote per P7; verify pre/post digests |
| Clock skew | Exact documented boundary flips vs store clock | Fix NTP on DB host; never widen windows |
| Suspected tamper | Tampered-event decisions DENY; material never in rows | Freeze + snapshot; investigate DB-access path |
| Kill inside a transaction | Atomic rollback; postmaster healthy | None (verify digests) |

**Escalation invariant:** if any observed behavior contradicts this runbook, that is a FINDING against the P2-S8 assurance (file it with the observed command output; do not work around it by weakening a check).
