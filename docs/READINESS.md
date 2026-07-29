# JATA Qi Readiness Status

> **Overall: ALPHA — core platform implemented and tested; NOT production-ready.**

This document is the human-readable companion to the machine-readable readiness
registry exposed at `GET /readiness` and `GET /readiness/summary`
(`@jataqi/readiness`). Per the master build directive (#64, #100, #102), no
capability is marked production-ready without evidence, and partial / planned /
simulation-only / research-only work is labelled honestly.

Statuses in use: `NOT_IMPLEMENTED`, `PLANNED`, `PARTIALLY_IMPLEMENTED`,
`IMPLEMENTED`, `INTEGRATED`, `TESTED`, `SECURITY_REVIEWED`, `STAGING_READY`,
`PRODUCTION_READY`, `SIMULATION_ONLY`, `RESEARCH_ONLY`, `DEPRECATED`.

## What is real and tested today (TESTED)

The foundation + intelligence layers are implemented, integrated through the
kernel, and covered by automated tests (250 tests across 22 packages):

- **Foundation:** core kernel, storage (memory + filesystem), vector search,
  identity & authentication (scrypt), RBAC + permission enforcement, immutable
  audit ledger, HTTP API gateway (auth, rate limiting, OpenAPI).
- **Intelligence:** QiL language (lexer/parser/compiler), knowledge fabric
  (ingest/chunk/retrieve + graph), agent runtime (ReAct loop + tools + LLMs),
  workflow engine (durable history), model registry + selector, multi-agent
  teams, **Universal AI Tool Intelligence Layer** (registry, adapters, risk
  gating, approvals, fallback), compute (stats/regression/optimization),
  simulation (Monte-Carlo), compute scheduler + adaptive router.
- **Physical/abstraction:** robotics device registry, digital twins.
- **Governance:** human-approval engine for high-risk (R4/R5) tool actions.

## Honest partial implementations (PARTIALLY_IMPLEMENTED)

- **Observability** — metrics/counters/gauges/histograms + Prometheus + audit
  exist; no distributed tracing or dashboards.
- **Model abstraction** — catalog + cost/latency/quality selector implemented
  and tested; not yet auto-wired into the agent's per-call LLM choice.
- **Module registry** — plugin registry exists; a formal module-manifest
  registry is planned.
- **AI safety** — agent iteration caps + tool risk gating exist; no dedicated
  prompt-injection scanner.

## Explicitly NOT implemented (NOT_IMPLEMENTED) — major gaps

Multi-tenancy/organizations, MFA/SSO/OAuth, billing/subscriptions, marketplace,
enterprise OS (CRM/ERP/HR), financial intelligence (wallets/ledgers/payments —
requires regulated providers), supply chain, education, health (clinical use
requires validation & oversight), research platform, communication, creative
generation (no live generative providers), multimodal backends, IoT, cloud/DevOps
automation, smart cities, environment, governance/compliance registry,
cyberdefense, disaster recovery, sovereign deployment, localization, SDKs (Python),
web/mobile UIs, AI evaluation platform, self-evolution engine.

## Research / simulation only (RESEARCH_ONLY / SIMULATION_ONLY)

- **Quantum** — the scheduler models a `quantum` compute target as a tag only;
  no real quantum hardware is integrated.
- **Space / interplanetary intelligence** — research-only.
- **Simulation engine** — real Monte-Carlo engine, but its outputs are always
  flagged as modeled scenarios, not predictions.

## Production blockers (honest)

1. No tenant isolation / multi-tenancy.
2. No MFA/SSO; password + API-key auth only.
3. No real external AI provider wiring in CI (tests use deterministic `EchoLLM`).
4. No compliance/governance control registry or security review process.
5. No backups / disaster recovery.
6. No payment / billing providers (regulated).

## How to inspect programmatically

```bash
curl http://127.0.0.1:7400/readiness           # full capability matrix
curl http://127.0.0.1:7400/readiness/summary   # counts + overall verdict
```
