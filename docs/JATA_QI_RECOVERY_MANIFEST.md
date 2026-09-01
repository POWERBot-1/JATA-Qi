# JATA QI RECOVERY MANIFEST

Durable provenance record for the dormant Arena patchset recovery and unification audit.
This file exists so the recovered state is reconstructible even if the original agent session disappears.
Full evidence dossier lives outside Git history (large artifacts); this manifest carries the hashes, totals, and procedures.

## Baseline
- Baseline commit (pre-recovery): `5a3e47d2993ac49738b7a4252d1c3aa43812fe37` (branch root of `arena/01a05c22-jata-qi`).
- Rollback checkpoint tag: `recovery/pre-patch-checkpoint` → resolves to the baseline commit above.
- Offline baseline bundle (full repo, incl. all refs): preserved out-of-tree at `/home/user/recovery/real-repo-checkpoint/baseline-5a3e47d.bundle` (sha1 bundle format; verified with `git bundle verify`).

## Recovery source
- Dormant Arena patchset file: `01a04243-3aa4-7940-8121-0fd8322e985c.patch`
- SHA-256: `a516641a06d37fc612d82dc1f4d7af463e7623ecd50c17dd5461e8882e79bf1b` (1,804,639 bytes)
- Applied with `git apply --check && git apply` (2-way only; no merge fuzz; zero rejects).
- Origin: dormant Arena recovery patchset authored against baseline `5a3e47d` (provenance tag retained in the artifact chain of custody).
- Scope: **322 files, +34,945 / −11**; 38 new/expanded `@jataqi/*` packages + 7 docs + 2 scripts + root tooling updates.

## Authorized deviation from the raw patch (exactly one)
- FAIL-01 test-only correction in `packages/orbital-intelligence/test/orbital-intelligence.test.ts`
  (working-file SHA-256: `65ef57e102ddfb9c0214dc8a6b2eefe7b1da5f2e7da603cd14aacd83787ac8af`).
- Rationale: the recovered test asserted authority-inflating semantics (`LOCAL_POLICY_ALLOWED` / `LOCAL_ALLOW`)
  that contradict the package's own conservative safety invariant (a local policy pass cannot verify
  external provider authority or license). The test was corrected to the conservative
  `REVIEW_REQUIRED` / `REVIEW` semantics. **Implementation unchanged.** A two-way forensics pass proved
  every other byte in the tree equals the raw patch (`git apply --reverse --check --exclude=<that file>` = PASS).

## Workspaces
- 45/45 workspace packages build and pass; lockfile consistency enforced by `scripts/check-workspaces.mjs`.
- External dependencies in lockfile: `typescript`, `@types/node`, `undici-types` only.

## Validation (final, on the exact committed tree)
| Check | Result |
|---|---|
| `npm ci` | PASS (0 vulnerabilities) |
| `npm run check:workspaces` | PASS — 45 workspaces consistent |
| Cold build (`rm -rf packages/*/dist && npm run build`) | PASS — topological build, 0 TypeScript errors |
| Strict typecheck (per-package `tsc -p tsconfig.json`) | PASS — 0 errors |
| `npm test` | PASS — **45/45 suites, 300/300 tests, 0 fail** |
| Unified-loop simulation (deterministic, offline) | PASS — **70/70 steps**, failedSteps: [], 358 audit events, 71 distinct event types, 184 correlation-tagged, 40 causation-chained |
| Autonomy-safety audit | PASS — 9/9 non-escalation invariants; adversarial + cross-tenant scenarios green |
| Lint | PASS (no-op by design — no package lint scripts) |

Replication commands: `npm ci && npm run check:workspaces && rm -rf packages/*/dist && npm run build && npm test`.

## Unification verdict
**CONDITIONALLY_UNIFIED** — awarded on executed behavioral evidence (end-to-end unified-loop simulation on the
real fabric, cross-engine event flows, identity/policy/audit continuity), not on tests alone. Do not relabel as UNIFIED.

### Integration classification (45 workspaces)
- **GREEN: 31** — architecturally coherent, exercised, tested (incl. core-kernel, storage, vector-search,
  all knowledge/reasoning/commercial/control-plane engines, payments, billing, action-runtime, venture-lifecycle).
- **AMBER: 9** — structurally coherent, suite-green, but not yet exercised in the unified-loop simulation:
  `agent-runtime`, `autonomous-test-repair`, `commercial-command-center`, `commercial-health`,
  `external-connectors`, `infrastructure-state-registry`, `permanence-fabric`, `temporal-engine`,
  `universal-visibility-fabric`.
- **GRAY: 5** — intentionally inert until external adapters/providers are explicitly registered (no
  implementation defect): `orbital-intelligence`, `github-execution`, `copilot-execution-adapter`,
  `universal-distribution-nervous-system`, `autonomous-deployment`.
- **RED: 0**.

### Safety findings
- P0: 0 · P1: 0 · **P2: 2** · P3: 4 · Info: 3.
- P2-1 (F-01): two-plane event schema split — commercial-plane envelopes (`CommercialEvent{envelope,payload}`)
  vs core/knowledge-plane plain payloads; wildcard consumers cannot infer core-plane event names from payloads.
- P2-2 (F-02): `scripts/run-workspaces.mjs` is fail-fast; a failing suite masks downstream suites in the same run.
- P3: 183/189 declared events are publish-only in-repo (F-03); command-center vs observability snapshot
  overlap (F-04); plus 3 informational notes (F-05..F-07, see risk register in the audit dossier).

### Conditions to move CONDITIONALLY_UNIFIED → UNIFIED
1. C-1: move loop orchestration in-repo — register engine operations as agent-runtime tools behind capability grants
   (agent-runtime's tool registry predates the 38 recovered engines).
2. C-2: exercise the 9 AMBER engines in a unified-loop context (extend the deterministic simulation).
3. C-3: document or unify the two-plane event schema before adding wildcard consumers.
4. C-4: confirm the publish-only event surface intent; nominate in-repo consumers where feedback loops are intended.

## Security posture (verified, not assumed)
- Simulation was deterministic + offline: no external providers, payment networks, GitHub API, cloud, or real customer data.
- No secrets: payments store credentials by reference (`secret://…`); repository scan for keys/tokens/.env = clean.
- Planning ≠ authorization; local policy approval ≠ external/provider authorization (`LOCAL_POLICY_ALLOWED` is a
  reserved enum the implementation cannot produce today); recommendation ≠ execution; memory/history cannot escalate authority.
- Rollback procedure: `git reset --hard recovery/pre-patch-checkpoint` then clean untracked, or restore from the
  baseline bundle; do not rewrite history after publishing.

## Recovery commit
- Recovery commit SHA: `ac8e68d5050c97a91a2d756bf5c091140eb95ef2`
  (parent = baseline `5a3e47d2993ac49738b7a4252d1c3aa43812fe37`; 324 files, +35,092 / −11 —
  322 patch files plus this manifest and the audit summary)
- Remote branch: `arena/01a05c22-jata-qi`
- Remote verification SHA: remote branch head verified via `git ls-remote` after push and matched local HEAD
  `fedce3d533c155b7897e9ad881a11e0b4de37db7` (recovery commit + manifest finalization) with zero divergence;
  this provenance commit itself is pushed and re-verified the same way (LOCAL == REMOTE, tree clean).
- Full audit dossier (out-of-tree, not in Git history): `/home/user/recovery/jata-qi-unification-audit/`
  (01–14 dossier files + `unification-audit.json` machine-readable summary + simulation harness/results + regression logs).
