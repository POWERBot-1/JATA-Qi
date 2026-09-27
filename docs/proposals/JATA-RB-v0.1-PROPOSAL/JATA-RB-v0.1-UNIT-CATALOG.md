# JATA-RB-v0.1-PROPOSED — Complete 60-Unit Catalog

| Field | Value |
|---|---|
| Proposal | **JATA-RB-v0.1-PROPOSED** |
| Status | **NOT ADOPTED — PROPOSAL ONLY** |
| Date | 2026-09-27 (UTC) |
| Companion spec | `JATA-RB-v0.1-PROPOSAL-SPEC.md` (§§4–6, 9) |
| Historical score | **9.484375% — FROZEN, v1.0-basis; not an input; not rescored** |
| Current score | **NONE — no score calculated** |

> Every unit entry except the D07b aggregation rule is **NEW / PROPOSED** in full.
> D07b's aggregation rule is **PRESERVED from v1.1 §1–§5**. This catalog awards no
> points, assesses no artifact, and qualifies nothing for production.

**Weight reference [NEW / PROPOSED except D07b]:** standard units in
D01–D06/D08–D15 weigh `13/8 = 1.625` points; D07 units weigh `9/4 = 2.25` points
(D07b weight PRESERVED). D07b modality shares are `1/4 = 0.25` points (PRESERVED).

**How to read each entry:** Scope = what "complete" (C4) means. Integration =
what "fully integrated" (I4) means. Evidence guidance = the minimum class the
assessor should normally expect for full consideration (the actual grade is always
the best qualifying class per SPEC §7; guidance never upgrades a grade). Gates =
linked release gates (gates never convert to points).

---

## D01 — Security (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D01a — Authorization boundary [NEW / PROPOSED; 13/8 pts]
- **Scope:** ordered fail-closed decision pipeline (structure→principal→tenant→
  agent/run→capability→tool/operation→target→classification/impact→approval→
  credential→budget/rate→engine→audit) plus enforcement-point integrity, replay,
  idempotency, and consumption-before-await semantics.
- **C4:** every decision/enforcement branch executable with positive + negative
  coverage; tamper/substitution/stale/replay cases green; discretionary-engine
  ambiguity fails closed and is tested.
- **I4:** enforced on all applicable invocation paths (A-list) with the B-list
  proven non-consequential and documented; unauthorized paths fail closed in tests.
- **Evidence guidance:** E4 (separate-party adversarial authorization suite on the
  exact artifact). **Gates:** CG-02, CG-03, HG-07.

### D01b — Tenant isolation at the data plane [NEW / PROPOSED; 13/8 pts]
- **Scope:** tenant-scoped reads/writes/deletes across all durable planes;
  no-context blindness; quarantined untagged rows; enumerated system-scope
  exceptions only.
- **C4:** isolation enforced in the storage/RLS layer (not prompts/inputs);
  canary cross-tenant refusal + no-context-zero-rows green; exception registry
  machine-readable and test-asserted.
- **I4:** every durable consumer uses tenant-scoped handles; cached-handle and
  standalone-op paths migrated; multi-process contention green.
- **Evidence guidance:** E4. **Gates:** CG-01, CG-03.

### D01c — Credential and secrets hygiene [NEW / PROPOSED; 13/8 pts]
- **Scope:** credential bindings (never material) in decisions/envelopes/audit;
  broker fail-closed semantics; no secrets in repo, logs, audit, or durable state.
- **C4:** acquire/validate/consume/replay/expiry/revocation all enforced and
  tested; material appears in no captured record (asserted by test).
- **I4:** all credential-requiring paths bound through the broker; rotation and
  revocation propagate; production provider seam contracted.
- **Evidence guidance:** E4 (includes clean secret-scan on the exact tree).
  **Gates:** CG-07, CG-03.

### D01d — Adversarial agent-authorization resistance [NEW / PROPOSED; 13/8 pts]
- **Scope:** prompt-injection, confused-deputy, tool-abuse, indirect-instruction,
  and cross-tenant RAG/cache isolation probes under contained execution.
- **C4:** adversarial matrix green covering all five classes with named
  non-bypass assertions; containment (sandbox/workload) evidenced, not assumed.
- **I4:** probes run in the canonical composition against the enforced boundary;
  failures deny before side effects; results committed per assessment.
- **Evidence guidance:** E4. **Gates:** CG-02, CG-03.

---

## D02 — Identity / access (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D02a — Identity lifecycle and authentication [NEW / PROPOSED; 13/8 pts]
- **Scope:** principals/memberships/roles/recovery; OIDC (JWKS-pinned,
  provider-neutral) claims pipeline (kid/iss/aud/exp/nbf/iat/jti); enrollment/
  deprovisioning cascades; JTI replay single-use.
- **C4:** lifecycle state machine fully transitioned in tests; OIDC boundary
  tables (4-case skew) green; cascade revocation durable and cross-process.
- **I4:** wired into the principal boundary and Phase-B decision transaction;
  production posture invariants declare and enforce the wiring.
- **Evidence guidance:** E4. **Gates:** CG-01, CG-03.

### D02b — Sessions and tokens [NEW / PROPOSED; 13/8 pts]
- **Scope:** opaque server-minted session tokens (no derivation); rotation with
  old-invalidated; fixation defense; concurrent-session policy; durable revocation.
- **C4:** mint/verify/rotate/expire enforced; 100-id non-derivation assertion;
  rotation-chain monotonicity; revocation cascades live.
- **I4:** session state checked inside the decision transaction; fan-out
  (32-process class) green; restart preserves safety.
- **Evidence guidance:** E4. **Gates:** CG-01, CG-02.

### D02c — Privilege plane, delegation, and step-up [NEW / PROPOSED; 13/8 pts]
- **Scope:** plane-role vocabulary; privilege stage; operation register (data +
  code + test-asserted); delegation chain (subset/bounded/chained/refused
  cross-tenant/consumed); MFA/step-up recency in the privilege decision.
- **C4:** register completeness tested (every entry enforced); hierarchy
  non-transitivity matrix green; delegation widening tables green; step-up
  staleness boundaries tested.
- **I4:** stages live in the canonical pipeline; production posture declares
  stage-presence invariants; R2 regression unchanged.
- **Evidence guidance:** E4. **Gates:** HG-01, CG-03.

### D02d — Break-glass and key-management seam [NEW / PROPOSED; 13/8 pts]
- **Scope:** break-glass state machine (activation one-shot, terminal records,
  review deadline); sealed credentials via the key-management seam; seam contract
  (sign/encrypt separation, rotation/versioning/revocation, dev-double refusal
  under production).
- **C4:** all break-glass sub-cases + activation one-shot green; seam contract
  tests green; no KMS/HSM availability claimed (contract + honest double only).
- **I4:** break-glass and seal integrated with audit and the privilege plane;
  production invariants refuse dev providers.
- **Evidence guidance:** E4. **Gates:** HG-02, CG-03.

---

## D03 — Core architecture (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D03a — Kernel lifecycle and composition [NEW / PROPOSED; 13/8 pts]
- **Scope:** event bus; DI container; topological module lifecycle
  (init/start/stop/dependsOn); boot ordering; sealed posture at boot.
- **C4:** lifecycle transitions asserted; dependency cycles refused; boot
  failures abort with named errors; posture matrix green.
- **I4:** all modules compose through the kernel; no out-of-band singletons for
  security state; multi-package boot suites green.
- **Evidence guidance:** E3 normally; E4 for release-relevant claims. **Gates:** CG-04.

### D03b — Event-surface contracts [NEW / PROPOSED; 13/8 pts]
- **Scope:** commercial vs core/knowledge plane envelopes; schema validation;
  nominated consumers; publish-only intent register.
- **C4:** every emitted event validates against its schema; wildcard consumers
  resolve names on both planes; publish-only vs consumed intent is explicit per event.
- **I4:** producers/consumers wired through the canonical bus; contract
  violations fail closed in tests.
- **Evidence guidance:** E3. **Gates:** —.

### D03c — Durable delivery and sequencing [NEW / PROPOSED; 13/8 pts]
- **Scope:** at-least-once delivery with idempotent consumers; bounded retry;
  replay; dead-letter records; CAS sequence integrity.
- **C4:** redelivery never re-executes side effects (per-attempt keys asserted);
  DLQ records terminal with reason; sequence gaps detected.
- **I4:** delivery integrated with the action state machine and durable stores;
  multi-process redelivery green.
- **Evidence guidance:** E3. **Gates:** —.

### D03d — Storage abstraction integrity [NEW / PROPOSED; 13/8 pts]
- **Scope:** KV/collections/blobs with CAS; driver parity (memory/dev-FS/
  authoritative); versioned schema guard; transaction semantics where claimed.
- **C4:** CAS atomicity asserted under contention; schema-version mismatch
  refuses; driver capabilities honestly advertised (dev-only labels intact).
- **I4:** all durable state flows through the abstraction; no direct-driver
  bypass in product paths.
- **Evidence guidance:** E3. **Gates:** CG-04.

---

## D04 — Agent / execution (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D04a — Governed execution loop [NEW / PROPOSED; 13/8 pts]
- **Scope:** staged governed loop (policy/safety/authority/human-or-regulatory
  gates) over capability contracts; fail-closed at every gate.
- **C4:** all stages executable with gate-trip tests; policy denial stops the run
  before external I/O; stage coverage matrix green.
- **I4:** loop is the canonical execution path; engines invoked only through
  governed contracts; loop-host leases/queue/checkpoints integrated.
- **Evidence guidance:** E4. **Gates:** CG-02.

### D04b — Tool boundary enforcement [NEW / PROPOSED; 13/8 pts]
- **Scope:** tool registry authorization (declared tools only; envelope
  required; tenant authoritative); denial as model-visible error.
- **C4:** undeclared-tool, missing-envelope, identity-conflict, and
  operation/target-substitution cases green.
- **I4:** all tools (including built-ins) traverse the registry gate; run
  context supplies the verified principal.
- **Evidence guidance:** E4. **Gates:** CG-02.

### D04c — Budgets, rate limits, and leases [NEW / PROPOSED; 13/8 pts]
- **Scope:** per-run budget ceilings; per-capability rate windows; durable
  leases with GC; checkpoint resume-or-fail-closed.
- **C4:** exhaustion/limit/lease-expiry cases deny or resume correctly;
  crash detection + resume verified by restart harness.
- **I4:** enforcement integrated at decision and enforcement points;
  multi-process lease contention green.
- **Evidence guidance:** E3. **Gates:** —.

### D04d — Worker containment [NEW / PROPOSED; 13/8 pts]
- **Scope:** bounded worker execution (test/repair, deployment, copilot,
  venture) through the action/verification boundary; no raw external I/O from
  workers; envelope-wrapped tasks.
- **C4:** workers perform deterministic in-repo behavior; external execution
  fails closed without a verified principal (asserted, not assumed).
- **I4:** worker external calls route via the action runtime adapters;
  per-attempt decisions + idempotency keys verified.
- **Evidence guidance:** E4. **Gates:** CG-02.

---

## D05 — AI / model intelligence (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D05a — Production model adapters [NEW / PROPOSED; 13/8 pts]
- **Scope:** real provider adapters (key/config-gated) with error mapping,
  timeouts, retries, and cost/latency accounting; doubles honestly labeled.
- **C4:** adapter executes against the real provider in the evidenced
  configuration; failure modes mapped and tested; no live-access claim without
  live evidence.
- **I4:** adapters registered behind capability grants; tenant-scoped invocation;
  egress governed (P3 plane where applicable).
- **Evidence guidance:** E5 for production-provider claims; E3 for
  interface-only (which caps C at C1). **Gates:** HG-07 (egress allowlist where applicable).

### D05b — Evaluation harness [NEW / PROPOSED; 13/8 pts]
- **Scope:** task evals with pinned inputs/outputs, scoring rubric, and
  regression thresholds; eval results committed per assessment.
- **C4:** eval suite green with non-vacuous assertions (failure injected ⇒ eval
  fails, proven by negative control).
- **I4:** evals run in CI on the exact artifact; regressions block promotion per
  the required-checks list.
- **Evidence guidance:** E3. **Gates:** CG-05.

### D05c — Cross-model deliberation [NEW / PROPOSED; 13/8 pts]
- **Scope:** structured critique/synthesis across models/reviewers with retained
  disagreement and evidence/consistency/safety assessment.
- **C4:** deliberation sessions persist inputs/critiques/synthesis; disagreement
  retained (never averaged away); non-executing synthesis enforced.
- **I4:** deliberation outputs feed governed decisions; tenant-bound; audited.
- **Evidence guidance:** E3. **Gates:** —.

### D05d — Hallucination and uncertainty controls [NEW / PROPOSED; 13/8 pts]
- **Scope:** uncertainty-aware assessment; calibration registry; contradiction
  markers; provenance for generated claims.
- **C4:** calibration tracked with explicit uncertainty; contradictions retained
  and queryable; generated claims carry provenance or are labeled ungrounded.
- **I4:** controls integrated into the agent loop and retrieval paths.
- **Evidence guidance:** E3. **Gates:** —.

---

## D06 — Model Fabric (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D06a — Router and registry [NEW / PROPOSED; 13/8 pts]
- **Scope:** model registry (capabilities/cost/latency/policy) and request router
  with deterministic selection rules.
- **C4:** registry schema-validated; router selection asserted across a decision
  table including tie/unknown-model cases.
- **I4:** all model calls route through the fabric; bypass refused in tests.
- **Evidence guidance:** E3. **Gates:** —.

### D06b — Cost/latency-aware routing [NEW / PROPOSED; 13/8 pts]
- **Scope:** routing policy honoring cost/latency budgets with measured
  accounting per request.
- **C4:** budget-exceeded requests deny or degrade per policy (tested); accounting
  reconciles to provider records or committed fixtures.
- **I4:** budgets integrated with the authorization budget ceiling; overruns audited.
- **Evidence guidance:** E3. **Gates:** HG-06.

### D06c — Fallback and provider health [NEW / PROPOSED; 13/8 pts]
- **Scope:** health tracking per provider/model; ordered fallback on failure;
  no silent quality collapse.
- **C4:** fallback matrix green (failure ⇒ next healthy provider or named
  denial); health flaps debounced and audited.
- **I4:** fallback integrated into the governed loop; user-visible fallback
  labeling asserted.
- **Evidence guidance:** E3. **Gates:** —.

### D06d — Routing evaluation [NEW / PROPOSED; 13/8 pts]
- **Scope:** routing-decision evals (cost/latency/quality trade-offs) with
  committed baselines.
- **C4:** routing evals green with negative controls; baseline drift alerts.
- **I4:** evals run on the exact artifact; results feed the model registry.
- **Evidence guidance:** E3. **Gates:** —.

---

## D07 — Autonomous Prompt Compiler (weight 9; units × 9/4 = 2.25)

### D07a — Compilation pipeline [NEW / PROPOSED; 9/4 pts]
- **Scope:** prompt→plan→refinement pipeline (decomposition, constraint
  extraction, tool selection, output assembly) distinct from the governed
  orchestrator.
- **C4:** pipeline stages executable end-to-end on committed fixtures; stage
  I/O schemas validated; failure at any stage fails closed with reason.
- **I4:** pipeline invoked through governed capability contracts; outputs enter
  the execution loop only via the authorization boundary.
- **Evidence guidance:** E4. **Gates:** —.

### D07b — Nine-modality breadth [PRESERVED rule; 9/4 pts]
- **Rule:** `q_07b = (1/9) × Σ[m=1..9] (C_m × I_m × Q_m)` with `Q_m = E_m × f_m`;
  fixed denominator 9; missing ⇒ zeros; never renormalized; per-modality shares
  `1/4 = 0.25` points. **[PRESERVED from v1.1 §1–§5]**.
- **Modalities (PRESERVED):** 1 Coding, 2 Architecture, 3 Website/building,
  4 Image, 5 Video, 6 Copy, 7 Voice, 8 Marketing, 9 General agent tasks.
- **Grading vocabularies:** RB C/I/E/f scales (SPEC §§6–8) as NEW / PROPOSED
  gap-fillers for the irrecoverable "existing scale" references. The aggregation
  rule itself is unchanged.
- **Evidence guidance:** per-modality E4 for release-relevant breadth claims;
  unevidenced modalities score exactly zero (WE4 preserved). **Gates:** — (breadth
  is scored, not gated).

### D07c — Refinement and verification loop [NEW / PROPOSED; 9/4 pts]
- **Scope:** iterative output refinement with verification (self-critique +
  tool-verified checks) bounded by budgets and approvals.
- **C4:** refinement converges or exhausts budget with a named outcome; every
  iteration verified before acceptance; loops bounded and tested.
- **I4:** refinement integrated with the governed loop and human-approval gates
  where required.
- **Evidence guidance:** E3. **Gates:** —.

### D07d — Compiler safety and provenance [NEW / PROPOSED; 9/4 pts]
- **Scope:** compiler output provenance (inputs/prompts/tools/models pinned);
  safety filters (injection/containment) on compiler I/O.
- **C4:** every compiled artifact carries provenance sufficient to reproduce it;
  filter bypass attempts denied in adversarial tests.
- **I4:** provenance recorded in the audit chain; filters enforced at the tool
  boundary.
- **Evidence guidance:** E4. **Gates:** CG-02.

---

## D08 — Knowledge / memory (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D08a — Ingestion and chunking [NEW / PROPOSED; 13/8 pts]
- **Scope:** document/chunk model; paragraph+sentence+fixed chunker; metadata
  filters; tenant attribution at ingest.
- **C4:** chunker deterministic on fixtures; metadata preserved and queryable;
  unattributed rows quarantined with report.
- **I4:** ingestion events attested + tenant-bound + re-read authoritatively
  before indexing (no forged-event indexing).
- **Evidence guidance:** E3. **Gates:** CG-01.

### D08b — Retrieval quality and isolation [NEW / PROPOSED; 13/8 pts]
- **Scope:** semantic retrieval with context expansion; per-tenant vector/graph
  isolation; retrieval-poisoning resistance.
- **C4:** retrieval evals green with isolation probes (cross-tenant RAG returns
  nothing); poisoning fixtures refused or labeled.
- **I4:** retrieval serves only the execution tenant; caches tenant-scoped.
- **Evidence guidance:** E4 for isolation claims. **Gates:** CG-01.

### D08c — Memory lifecycle [NEW / PROPOSED; 13/8 pts]
- **Scope:** commercial/episodic memory with retention, forgetting/deletion
  semantics, and correlation/causation discipline.
- **C4:** deletion/forgetting honored and asserted (deleted ⇒ unretrievable);
  retention GC tested; correlation never presented as causation.
- **I4:** lifecycle integrated with tenant boundary and audit.
- **Evidence guidance:** E3. **Gates:** HG-03 (retention).

### D08d — Graph reasoning (Graph-RAG) [NEW / PROPOSED; 13/8 pts]
- **Scope:** entities/relations/SPO store; BFS traversal; heuristic extraction;
  Graph-RAG fusion with provenance.
- **C4:** traversal bounded and cycle-safe; extraction precision/recall baselined;
  fused answers cite graph + chunk provenance.
- **I4:** graph queries tenant-scoped; untagged-row quarantine honored.
- **Evidence guidance:** E3. **Gates:** CG-01.

---

## D09 — Commerce / economics (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D09a — Money integrity [NEW / PROPOSED; 13/8 pts]
- **Scope:** per-currency money, wallets, injected FX; arithmetic exactness;
  no float money.
- **C4:** money ops exact (integer minor units or rational); FX injection
  pinned and audited; negative/overflow cases refused.
- **I4:** money module is the sole money authority; no parallel money math in
  product paths.
- **Evidence guidance:** E4 for ledger-affecting claims. **Gates:** CG-03.

### D09b — Revenue ledger and reconciliation [NEW / PROPOSED; 13/8 pts]
- **Scope:** per-tenant hash-chained recognized revenue; refund reversal;
  read-only provider-state reconciliation (pending-external/disputed explicit).
- **C4:** chain integrity asserted; reversals linked; reconciliation disputes
  surfaced, never auto-resolved to revenue.
- **I4:** ledger writes transactional with the money module; verified-payment-
  only activation enforced.
- **Evidence guidance:** E4. **Gates:** —.

### D09c — Billing and PSP integration [NEW / PROPOSED; 13/8 pts]
- **Scope:** plans/subscriptions/invoices; provider-neutral PSP intents gated by
  the action runtime; simulated payments never verifiable as real revenue.
- **C4:** intents record VERIFYING until independent verification; PSP absence
  honestly reported; invoice state machine fully transitioned.
- **I4:** PSP calls traverse governed egress with credential binding; webhooks
  verified before ledger effects.
- **Evidence guidance:** E5 for real-money claims; E3 caps simulated-only.
  **Gates:** CG-08 (production-money claims).

### D09d — Commercial analytics integrity [NEW / PROPOSED; 13/8 pts]
- **Scope:** evidence-classified funnel/MRR/ARR/cost/CAC/ROAS/churn/retention/
  contribution-margin calculations.
- **C4:** metrics recompute exactly from ledger inputs; evidence classes carried
  per input; unqualified inputs labeled, never silently included.
- **I4:** analytics read from the authoritative ledger; tenant-filtered.
- **Evidence guidance:** E3. **Gates:** —.

---

## D10 — Product / UX (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D10a — Product surface [NEW / PROPOSED; 13/8 pts]
- **Scope:** user-facing surface (web/API/CLI parity where claimed) with
  authenticated, tenant-scoped access.
- **C4:** claimed user journeys executable end-to-end in tests; unauthenticated/
  cross-tenant access refused.
- **I4:** surface calls the canonical API gateway; no direct-store bypass.
- **Evidence guidance:** E3. **Gates:** CG-01.

### D10b — API gateway [NEW / PROPOSED; 13/8 pts]
- **Scope:** versioned production API with auth, validation, rate limits, and
  compatibility guarantees.
- **C4:** contract tests green per version; breaking changes versioned;
  invalid inputs rejected with stable errors.
- **I4:** gateway fronts all product operations; OpenAPI/spec matches implementation
  (verified by test).
- **Evidence guidance:** E3. **Gates:** —.

### D10c — Operator workflows [NEW / PROPOSED; 13/8 pts]
- **Scope:** approval/budget/health/delivery/financial/readiness aggregation
  (read-only command-center class) with mutations delegating to the control plane.
- **C4:** projections recompute from authoritative sources; tenant-filtered;
  no direct-mutation bypass.
- **I4:** workflows integrated with approvals/budgets/alerts; audited.
- **Evidence guidance:** E3. **Gates:** HG-08.

### D10d — Usability and accessibility baselines [NEW / PROPOSED; 13/8 pts]
- **Scope:** baseline usability checks and accessibility conformance for the
  claimed surface, with committed criteria.
- **C4:** criteria green on the exact artifact; regressions named and tracked.
- **I4:** checks run in the required pipeline; failures block promotion.
- **Evidence guidance:** E2/E3. **Gates:** CG-05 (if on the required list).

---

## D11 — Production infrastructure (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D11a — Provisioned environment [NEW / PROPOSED; 13/8 pts]
- **Scope:** DNS/TLS/compute/network provisioned by recorded configuration;
  environment parity (dev/staging/prod) explicit.
- **C4:** provisioned resources match the committed inventory (expected-vs-
  observed diff clean); TLS valid and asserted.
- **I4:** deployments target the inventoried environment; drift detected and
  surfaced.
- **Evidence guidance:** E5 (real infra). **Gates:** CG-08.

### D11b — Deployment pipeline [NEW / PROPOSED; 13/8 pts]
- **Scope:** build→test→promote→deploy with health verification and confirmed
  rollback recording; no live mutation outside the pipeline.
- **C4:** pipeline green on the exact artifact; health verification required;
  rollback drill recorded.
- **I4:** pipeline is the sole production-mutation path; adapter-only lifecycle
  with explicit production enablement.
- **Evidence guidance:** E5. **Gates:** CG-04, CG-08.

### D11c — Data durability (PITR/backups/DR) [NEW / PROPOSED; 13/8 pts]
- **Scope:** backups, point-in-time recovery, and disaster-recovery posture with
  tested restores.
- **C4:** restore drill green within the freshness window; RTO/RPO stated and met.
- **I4:** durability integrated with the authoritative store; backup integrity
  verified, not assumed.
- **Evidence guidance:** E5. **Gates:** HG-04, CG-08.

### D11d — Secret-provider wiring [NEW / PROPOSED; 13/8 pts]
- **Scope:** production secret provider (vault/KMS-backed) wired through the
  credential seam; no env/file secrets in production.
- **C4:** production boots only with the provider; provider outage fails closed;
  rotation exercised.
- **I4:** seam is the sole production credential path; dev doubles refused under
  production posture.
- **Evidence guidance:** E5. **Gates:** CG-07, CG-08.

---

## D12 — Reliability / distributed systems (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D12a — Contention safety [NEW / PROPOSED; 13/8 pts]
- **Scope:** multi-process contention (8-/32-process classes) over leases/queue/
  CAS with exactly-once and no-loss semantics.
- **C4:** contention suites green with zero serialization/deadlock anomalies
  unaccounted; exhaustion fails closed with a documented profile.
- **I4:** contention exercised on the shared authoritative substrate, not doubles.
- **Evidence guidance:** E4 (E5 where prod-substrate proof is claimed). **Gates:** —.

### D12b — Restart and crash recovery [NEW / PROPOSED; 13/8 pts]
- **Scope:** kill-9 mid-transaction, orphan-lease GC, checkpoint resume-or-fail-
  closed, restart harnesses.
- **C4:** kill-9-in-tx + restart suites green; orphaned work GC'd or resumed
  without loss/duplication.
- **I4:** recovery integrated with durable leases/queue/checkpoints on the exact
  artifact.
- **Evidence guidance:** E4. **Gates:** —.

### D12c — Outage and failover [NEW / PROPOSED; 13/8 pts]
- **Scope:** outage injection (DB/network/provider) and failover behavior with
  explicit test-class vs production qualification.
- **C4:** outage matrix green; failover contract pinned; test-class doubles
  honestly labeled (A-20 class).
- **I4:** failover integrated with health surfacing and runbooks.
- **Evidence guidance:** E4 (test-class); E5 only with real prod failover proof.
  **Gates:** CG-08 (for prod-failover claims).

### D12d — Time, tamper, and duplication [NEW / PROPOSED; 13/8 pts]
- **Scope:** clock-skew matrices; audit/shape tamper detection posture; duplicate-
  event idempotency.
- **C4:** skew boundary tables green; tamper posture stated with limits (e.g.
  unkeyed-digest limits preserved, not overstated); duplicates deduped.
- **I4:** checks integrated into the decision and delivery paths.
- **Evidence guidance:** E4. **Gates:** HG-03 (audit).

---

## D13 — Observability / operations (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D13a — Metrics and traces [NEW / PROPOSED; 13/8 pts]
- **Scope:** exporter-backed metrics/traces (OTel/Prometheus class) with
  evidence-classified, privacy-minimized projections.
- **C4:** exporters emit on the exact artifact; dashboards/projections recompute
  from emitted series; no automatic remediation.
- **I4:** instrumentation integrated across planes with correlation traces.
- **Evidence guidance:** E3 (E5 for prod-exporter proof). **Gates:** HG-05.

### D13b — Alerting and incidents [NEW / PROPOSED; 13/8 pts]
- **Scope:** alert rules with firing proof; local incidents; no-alert-failure
  detection posture.
- **C4:** alert-firing proof committed (rule ⇒ fired ⇒ recorded); incident
  lifecycle (open→mitigated→reviewed) exercised.
- **I4:** alerts fed by production exporters; incidents linked to audit/findings.
- **Evidence guidance:** E3. **Gates:** HG-05.

### D13c — Health surfacing [NEW / PROPOSED; 13/8 pts]
- **Scope:** boot invariants, posture reports, degradation signals, and
  operator-readable health endpoints.
- **C4:** health reflects authoritative checks (not cached optimism); degraded
  states tested and distinct from healthy.
- **I4:** health integrated with deployment gates and runbooks.
- **Evidence guidance:** E3. **Gates:** HG-08.

### D13d — Runbooks andDiag hygiene [NEW / PROPOSED; 13/8 pts]
- **Scope:** operator runbooks per failure class; secret-free diagnostics.
- **C4:** runbooks committed and sufficient (a fresh operator can recover per
  drill); diagnostics carry no secret material (asserted).
- **I4:** runbooks referenced from alerts/incidents; drill records retained.
- **Evidence guidance:** E3. **Gates:** HG-08.

---

## D14 — Testing / assurance (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D14a — Suite completeness and zero-skip [NEW / PROPOSED; 13/8 pts]
- **Scope:** full suite green with zero fail and zero skipped/cancelled on the
  exact artifact; fail-hard harnesses (no false-negative green).
- **C4:** suite green with skip-detector enforced; harness readiness races
  remediated with bounded retry; flake forensics committed for any red.
- **I4:** suite is the required check on the exact SHA; promotion blocked on red.
- **Evidence guidance:** E3 (implementer run) + CI-class corroboration; E4 for
  release-relevant assurance claims. **Gates:** CG-05, CG-06.

### D14b — Adversarial matrices [NEW / PROPOSED; 13/8 pts]
- **Scope:** committed adversarial case lists with observable pass criteria per
  case, covering security/tenant/isolation/authorization boundaries.
- **C4:** matrix cases all green with non-vacuous assertions (each case fails
  when its control is disabled — proven by negative control or mutation).
- **I4:** matrices run on the exact artifact in the canonical composition.
- **Evidence guidance:** E4. **Gates:** CG-02, CG-06.

### D14c — Mutation and vacuity hygiene [NEW / PROPOSED; 13/8 pts]
- **Scope:** mutation-proven regression tests; vacuous-test detection; coverage
  honesty (no covered-but-unasserted credit).
- **C4:** mutation gate green (seeded faults killed); vacuity probes green;
  unasserted coverage explicitly excluded from claims.
- **I4:** hygiene gates integrated into the required pipeline.
- **Evidence guidance:** E3. **Gates:** CG-05 (if required).

### D14d — Reproducibility records [NEW / PROPOSED; 13/8 pts]
- **Scope:** versioned experiment/simulation metadata; canonical input/output
  hashes; replication outcomes; deterministic replay where claimed.
- **C4:** records sufficient for an independent party to reproduce the result;
  hashes pinned; non-reproduced results labeled as such.
- **I4:** records committed under the durability convention; linked from
  assessments.
- **Evidence guidance:** E3 (E4/E6 for replicated claims). **Gates:** CG-06.

---

## D15 — Governance / autonomy (weight 13/2 = 6.5; units × 13/8 = 1.625) [NEW / PROPOSED]

### D15a — Merge and review gates [NEW / PROPOSED; 13/8 pts]
- **Scope:** branch protection (approvals, required checks, thread resolution,
  deletion/force-push controls) with committed read-back records.
- **C4:** ruleset matches the committed specification (read-back green);
  required checks include build·lint·test (or the committed required list);
  bypass actors enumerated (normally none).
- **I4:** gates enforced on the canonical branch; promotion blocked on red.
- **Evidence guidance:** E3 (live read-back) + E4 for governance assurance.
  **Gates:** CG-04, CG-05.

### D15b — Report durability [NEW / PROPOSED; 13/8 pts]
- **Scope:** implementation evidence + independent-verification reports +
  assertion-level results + post-merge records committed before merge
  authorization (P2 §19 durability rule, preserved in wording).
- **C4:** every merged slice has its rule-1 artifacts in the tree; naming
  convention honored; losses recorded as losses (never re-attested).
- **I4:** durability checked as a merge precondition; missing reports block
  authorization.
- **Evidence guidance:** E3. **Gates:** CG-04, CG-06.

### D15c — Decision and audit chains [NEW / PROPOSED; 13/8 pts]
- **Scope:** tamper-evident action/decision ledgers with WHO/AUTHORITY coverage;
  approval binding (digest-bound, unexpired, exact-match).
- **C4:** ledger append-only with integrity asserted; approvals verified
  (missing/mismatch/expired denied in tests).
- **I4:** chains integrated with the control plane and privilege plane.
- **Evidence guidance:** E4. **Gates:** HG-03.

### D15d — Autonomy bounds and human authorization [NEW / PROPOSED; 13/8 pts]
- **Scope:** autonomy limits (planning ≠ authorization; recommendation ≠
  execution); human-approval gates for consequential actions; no implicit
  production enablement.
- **C4:** consequential actions require bound approvals; autonomous paths stop
  at human gates in tests; production enablement explicit and audited.
- **I4:** bounds enforced in the canonical composition; overrides impossible
  without the defined approval path.
- **Evidence guidance:** E4. **Gates:** CG-02, CG-08.

---

*End of 60-unit catalog. 60 entries. No assessment. NOT ADOPTED.*
