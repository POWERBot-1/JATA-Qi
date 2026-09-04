# JATA Qi Unification Audit — Summary (in-repo digest)

> **Current status note — 2026-09-03:** This is a historical unification digest,
> not a current production-readiness assessment. Its historical `P0=0` statement
> is superseded for filesystem persistence by
> [`PERSISTENCE_ARCHITECTURE.md`](PERSISTENCE_ARCHITECTURE.md): filesystem mode is
> development-only/single-process and the transactional production replacement is
> still a design, not an implementation.
>
> **Status note — 2026-09-04 (W20):** Of the carry-forward items below:
> **F-02** (runner fail-fast semantics) is retired — the workspace runner now
> aggregates every test-suite result and exits non-zero on any failure while
> build mode stays fail-fast; the **F-03** publish-only intent is confirmed and
> the two-plane schema (**F-01**) is documented by
> [`EVENT_SURFACE_CONTRACT.md`](EVENT_SURFACE_CONTRACT.md) — documentation only,
> F-01 remains open; **C-1** (loop orchestration) and **C-2** (AMBER engines in
> unified-loop context) remain open. Verdict unchanged:
> **CONDITIONALLY_UNIFIED**.
>
> **Status note — 2026-09-04 (W22):** Condition **C-1** (native in-repo loop
> orchestration) is **addressed** by the new `@jataqi/unified-loop` package — a
> deterministic 34-stage governed orchestrator that drives the existing engines
> through a governed capability boundary (see
> [`W22_NATIVE_ORCHESTRATION.md`](W22_NATIVE_ORCHESTRATION.md)). The loop is
> in-repo, in-process, and single-task; it adds no engine and activates no
> external side effect (sandbox adapters only). **C-2** is partially advanced
> (multiple formerly-AMBER engines are now exercised natively) but not closed;
> the older single-turn ReAct path in `agent-runtime` remains separate. **F-01**
> remains open (loop events are well-formed on the in-memory bus, but the
> two-plane split is not unified and there is no durable pump). Verdict unchanged:
> **CONDITIONALLY_UNIFIED**.

Companion to `docs/JATA_QI_RECOVERY_MANIFEST.md`. Full 14-part dossier + machine-readable
`unification-audit.json` are preserved out-of-tree at `/home/user/recovery/jata-qi-unification-audit/`.

## Verdict: CONDITIONALLY_UNIFIED

Awarded on executed evidence from a deterministic, offline, unified reasoning-loop simulation that ran
against the real system factories (65-module container, zero-dependency fabric). Not awarded on tests alone.

## What the simulation executed (scenario set A–J, 70/70 steps, 358 audit events)
- **A** knowledge → world-model → causal → probabilistic chain; knowledge ingest auto-propagated into the graph
  (`knowledge.document.ingested → graph.entity.added`); hypothesis posterior reached 73% via evidence.
- **B** intent → capability routing → policy decision → human authorization → sandbox execution → verification;
  `EXECUTED_UNDER_AUTHORITY` (8/8 engines).
- **C** payments truth lifecycle: provider-reported success stays `SUCCEEDED_UNVERIFIED`; independent
  `verifyPayment` upgrades to `VERIFIED`; only then does billing mark the invoice `PAID`
  (`payment.verified → billing → revenue-ledger`, 72 audit events). Commercial intent ≠ settlement.
- **D** venture governance: ungated transition `DISCOVERED → APPROVED` was **BLOCKED**; human approval quorum
  approved; final state `APPROVED`. Recommendation ≠ execution.
- **E** regulatory gate: `SATISFIED_FOR_REVIEW` with `localRequirementsSatisfied=true`, human quorum=1,
  physical execution authorization `NOT_AUTHORIZED`, assessment `CONDITIONALLY_SUPPORTED`.
  Research evidence ≠ legal permission.
- **F** failure/recovery: action failed, retried (attempts=2), verified `COMPLETED`.
- **G** adversarial: execute-without-plan, unverified-payment-as-paid, self-approval, scope escalation —
  `ALL_BOUNDARIES_HELD`.
- **H** cross-tenant isolation: `ISOLATION HOLDS` (single tenant `acme` in trace; cross-tenant probes denied).
- **I** conflicting agents: synthesis = `INSUFFICIENT_EVIDENCE` → no autonomous action. Consensus ≠ permission.
- **J** longitudinal (3 loop iterations): memory + knowledge compounding; authority escalation = NONE.

## Architecture decisions preserved
- Engines integrate at three layers: (1) shared composition root + lifecycle, (2) commercial contract surfaces
  (actor/tenantId/roles, money minor units, ISO timestamps, idempotency, correlationId/causationId),
  (3) event subscriptions. Six wiring edges + memory fan-in are declared and six were proven flowing.
- Two-plane event schema (F-01) is a documented contract choice pending unification (condition C-3).
- GRAY engines stay inert until external adapters are explicitly registered — this is a safety feature.

## Known limitations (carry-forward backlog)
- Loop orchestration is external to the packages (C-1); agent-runtime tools predate the recovered engines.
- 9 AMBER engines unexercised in loop context (C-2).
- 183/189 events publish-only (F-03); runner fail-fast semantics (F-02); snapshot-surface overlap (F-04).

## Validation snapshot (commit tree)
`npm ci` ✓ · workspaces 45/45 ✓ · cold build 0 TS errors ✓ · tests 300/300 (45 suites) ✓ ·
simulation 70/70 ✓ · autonomy-safety PASS ✓ · P0=0 P1=0 P2=2.

## Rollback
Checkpoint tag `recovery/pre-patch-checkpoint` (= baseline `5a3e47d`). Full baseline bundle preserved
out-of-tree. Procedure in the recovery manifest.
