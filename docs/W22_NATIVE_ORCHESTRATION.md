# W22 — C-1 Native Unified-Loop Orchestration

**Status:** implemented in-repo (`@jataqi/unified-loop`), validated, not merged.
**Milestone type:** integration milestone — **no new intelligence engine, provider, or external capability added.**
**Baseline:** canonical `main` `7665d25e64f1c6bdd5d523f352be1d7f3d87dca9` (W20).
**Verdict effect:** this addresses unification condition **C-1** (in-repo loop orchestration). It does **not** by itself
retire **F-01** and only partially advances **C-2**; see "Gaps carried forward". The architectural verdict remains
**CONDITIONALLY_UNIFIED**.

## What W22 establishes

JATA Qi now **owns and deterministically executes** a governed cognitive/execution loop from inside the repository.
Previously the only executed full-loop evidence was an **out-of-tree** simulation harness; the in-repo agent
(`agent-runtime`) was a single-turn ReAct loop whose only tools were `knowledge.*`/`graph.*`. W22 adds a native
driver (`UnifiedLoopService`) that advances through the canonical stage state machine and invokes JATA Qi's
**existing** engines through a **governed capability boundary**.

```
WAKE → OBSERVE → INGEST → NORMALIZE → IDENTIFY → ESTABLISH_CONTEXT →
ASSESS_WORLD_STATE → RETRIEVE_KNOWLEDGE → RETRIEVE_MEMORY → BUILD_OR_UPDATE_WORLD_MODEL →
GENERATE_HYPOTHESES → CAUSAL_ANALYSIS → PROBABILISTIC_ASSESSMENT → TEMPORAL_REASONING →
MULTI_AGENT_DELIBERATION → META_REASONING → CONTRADICTION_DETECTION → UNCERTAINTY_ASSESSMENT →
POLICY → SAFETY → AUTHORITY → HUMAN_OR_REGULATORY_GATE → AUTHORIZE → CAPABILITY_SELECTION →
PLAN → VERIFY_PLAN → EXECUTE → OBSERVE_RESULT → VERIFY_RESULT → RECONCILE → UPDATE_STATE →
AUDIT → OUTCOME → CONTINUE_OR_SLEEP   (34 stages, fixed order)
```

## Native state-transition graph (governance ordering)

The driver may only advance one stage at a time, in order (`LoopStateMachine`; illegal jumps throw
`InvalidTransitionError` and fail closed). The governance ordering is deliberate:

- **Reasoning spine** (OBSERVE…UNCERTAINTY_ASSESSMENT) drives the existing engines: cognitive-kernel,
  knowledge-service, knowledge-graph (via the existing `knowledge.document.ingested` subscription), world-model,
  hypothesis-engine → probabilistic-engine (classical Bayesian), causal-engine (explicitly **simulated**
  counterfactuals), temporal-engine (deterministic replay), multi-agent-cognition, meta-reasoning (advisory only).
- **Governance spine** (POLICY → SAFETY → AUTHORITY → HUMAN_OR_REGULATORY_GATE → **AUTHORIZE**) evaluates the
  commercial control plane. The loop **creates no policy** and **grants no authority**.
- **Execution spine** (CAPABILITY_SELECTION → PLAN → VERIFY_PLAN → **EXECUTE** → OBSERVE_RESULT →
  **VERIFY_RESULT**) runs only after `AUTHORIZE` yields `ALLOW`. Planning happens **after** authorization
  because the control plane authorizes at decision/plan time; a plan can never authorize itself.
- When a governance/verification gate holds (deny, gate-required, verification failure, missing adapter), the
  execution-path stages are **skipped fail-closed** while the audit/rationale stages still complete.

Terminal outcomes: `COMPLETED_VERIFIED`, `COMPLETED_DRY_RUN` (reasoning-only or dry-run), `HELD_AT_GATE`,
`DENIED`, `FAILED_CLOSED`, `SLEEP_PENDING`.

## Governed capability interface (Phase 2)

Every callable operation is a `GovernedCapability` registered in a `CapabilityRegistry`, carrying:
`capabilityId`, `operation`, served `stage`, `sideEffect` (`NONE`/`SANDBOX`/`PRODUCTION`),
`authority` (`NONE`/`POLICY_ONLY`/`AUTHORIZED_ACTION`), `requiredGrants`, and a bounded `timeoutMs`. The loop
**never** reaches into package internals — it only calls `registry.invoke(cap, ctx)`. The registry enforces:

- **tenant continuity** (the invocation actor's tenant must equal the loop tenant; otherwise fail-closed),
- a **hard per-capability timeout** (AbortController), and
- caller-cancellation propagation.

External-action capabilities additionally route through the existing **commercial control plane** (propose →
authorize) and **autonomous-action-runtime** (plan → execute → verify), reusing the established default-deny,
verify-before-COMPLETED, and independent-adapter-verification guarantees. No adapter is shipped or activated by
W22; execution only occurs against an explicitly registered **sandbox** adapter.

Typed cognitive state (`types.ts`) keeps the records distinct rather than collapsing them: `BELIEF`, `INTENT`,
`PLAN`, `DECISION`, `AUTHORIZATION`, `ACTION`, `RESULT`, each with provenance.

## Event integration (Phase 6) — F-01 boundary

W22 emits loop lifecycle events on the **existing kernel event bus**:
`unified.loop.stage.entered`, `unified.loop.stage.completed`, `unified.loop.boundary_held`,
`unified.loop.completed`, `unified.loop.failed`, carrying a single structured payload
(`loopId`, `correlationId`, `tenantId`, `stage`, `status`, `at`, `summary`). This is **one** clearly-defined
event shape for orchestration transitions — **no third event plane** is introduced.

The kernel bus remains in-memory/non-durable and the broader two-plane split (commercial envelopes vs
core/knowledge plain payloads, audit finding **F-01**) is **not** unified by W22. The durable event-stream path
remains manual-pump. **F-01 is therefore still OPEN and must not be claimed as retired.** Orchestration
transactions are auditable via the structured trace returned by each run (see below), independent of bus durability.

## Observability & auditability (Phase 7)

Every `runLoop` returns a `LoopRunResult` containing the **ordered stage trace** (`StageTraceEntry`: stage, status,
capability id, timing, correlation id, tenant, boundary reason) and the **typed cognitive ledger**. The trace is
structured data (not console text), privacy-minimized (no raw secrets or large content), and sufficient to
reconstruct invocation, identity, context, selected capabilities, policy evaluation, authorization, execution,
verification, reconciliation, and outcome.

## Failure behavior (Phase 8)

Deterministically tested: capability failure, malformed input (missing objective / tenant / roles), authorization
denial (default-deny with no policy; explicit risk DENY policy), failed result verification, missing adapter
(planning/execution cannot fabricate success), invalid state transitions, and high-autonomy gate holds. All fail
closed; no failed execution is ever reported as successful completion.

## Validation

- Workspace/lockfile integrity: **46 workspaces consistent**.
- Clean cold build (`rm -rf packages/*/dist && npm run build`): **0 TypeScript errors** across 46 workspaces.
- Full test suite: **46/46 workspace suites pass** (the W20 aggregate runner reports every suite).
- `@jataqi/unified-loop`: **15 tests** covering acceptance A–J (native orchestration, governed dispatch,
  unauthorized-denied, policy DENY, plan≠authorize dry-run, real sandbox verified path, failed-verification hold,
  tenant continuity, audit trace, injected-failure fail-closed, malformed input, determinism, invalid transition,
  high-autonomy gate).
- Production bootstrap smoke: `createJataQi()` boots with the native loop registered; a reasoning loop runs
  34/34 stages natively to `COMPLETED_DRY_RUN`.

## Gaps carried forward (do not over-claim)

- **C-1 (native orchestration):** addressed in-repo by this milestone for the deterministic, single-tenant,
  in-process loop. The older single-turn ReAct agent in `agent-runtime` still exists alongside it and is not yet
  replaced; future work can route agent tool-calls through the same governed registry.
- **C-2 (AMBER engines in unified-loop context):** **partially advanced.** The driver natively exercises
  cognitive/world/hypothesis/causal/temporal/multi-agent/meta-reasoning/memory/reconciliation/control-plane in a
  real in-repo loop (several of which were AMBER), but it is a curated path; not every one of the 45 engines is
  invoked by every task, and the agent-runtime ReAct path is separate.
- **F-01 (event fabric):** **still OPEN.** Loop events are well-formed but the bus is in-memory; schema
  unification/durable pump is a future scope (W23 candidate).
- **No autonomy/continuity runtime:** no scheduler, wake/sleep host, durable queue worker, or cross-restart resume
  (`SLEEP_PENDING` is a directive, not a sleeping process). `WAKE` is triggered by an explicit call.
- **No real-world effects:** production `PRODUCTION` side effects are not wired; only registered **sandbox**
  adapters run, and none ship enabled.
- **No quantum execution, no AGI/superintelligence, no production deployment** is claimed or introduced.
