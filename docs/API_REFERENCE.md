# JATA Qi — API Reference (Gateway v1)

The gateway exposes every module through authenticated REST endpoints. Auth:
`Authorization: Bearer <token>` from `/auth/login` (or IdP rotation).
Every route is also reachable under `/v1/...`. OpenAPI: `GET /openapi.json`.

## System

| Method | Path | Perm | Description |
| ------ | ---- | ---- | ----------- |
| GET | /health · /livez · /readyz | public | health probes |
| GET | /openapi.json | public | OpenAPI 3.0 spec |
| POST | /auth/register · /auth/login | public | identity |
| GET | /whoami · /auth/session | auth | session |
| GET | /readiness | auth | capability matrix |
| GET | /metrics · /stats | metrics:read | observability |

## Intelligence & agents

| Method | Path | Perm |
| ------ | ---- | ---- |
| POST | /qil · /objective | qil:run |
| GET | /workflows · /workflow | qil:run |
| POST | /ask | agent:run |
| POST | /tanya/chat · /tanya/share ... | tanya:write |
| GET | /tanya/conversations · /tanya/personas | tanya:read |

## Security pillar

| Method | Path | Perm |
| ------ | ---- | ---- |
| GET | /defense/posture · /defense/report | defense:read |
| POST | /defense/contain · /defense/bans · /defense/risk/signal | defense:write |
| GET | /soc/report · /soc/lake · /soc/incidents | soc:read |
| POST | /soc/telemetry · /soc/hunt · /soc/campaigns | soc:write |
| GET | /supplychain/stats · /supplychain/repos | supplychain:read |
| POST | /supplychain/audit · /supplychain/releases | supplychain:write |
| GET | /infra/stats · /infra/assets · /infra/drift | infra:read |
| POST | /infra/firmware/validate · /infra/provisioning | infra:write |
| GET | /resilience/regions · /resilience/health | resilience:read |
| POST | /resilience/failover · /resilience/tests | resilience:write |
| GET | /privacy/pia · /privacy/posture | audit:read |
| POST | /privacy/secure-delete · /privacy/minimize | audit:read |
| GET | /review · /review/findings | review:read |
| POST | /review/schedule · /review/scan | review:write |
| GET | /security-automation/correlations · /security-automation/compliance-report | secauto:read |
| POST | /security-automation/hunts/run | secauto:write |
| GET | /dlp/rules · /dlp/incidents | dlp:read |
| POST | /dlp/scan | dlp:write |
| GET | /pqc/algorithms · /pqc/keys/public | pqc:read |
| POST | /pqc/keys · /pqc/sign · /pqc/phase | pqc:write |

## Commercial & operations (Phase 4)

| Method | Path | Perm | Description |
| ------ | ---- | ---- | ----------- |
| GET | /products/catalog · /products/installed | product:read | product marketplace |
| POST | /products/install · /products/upgrade · /products/uninstall | product:write | one-click lifecycle |
| GET | /products/dependencies · /products/stats | product:read | dependency graph |
| POST | /onboarding/start | onboarding:write | guided org setup |
| POST | /onboarding/tenant · /onboarding/invite | onboarding:write | tenant + invites |
| GET | /onboarding/run · /onboarding/stats | onboarding:read | progress |
| POST | /ops/rotations · /ops/escalation-slas | ops:write | on-call + SLAs |
| POST | /ops/backup/verify · /ops/drills | ops:write | backup verification + drills |
| GET | /ops/oncall · /ops/health · /ops/stats | ops:read | operations reporting |
| GET | /commerce/* · /payments/* | commerce:read | plans, subscriptions, invoices |
| POST | /payments/webhook/stripe · /payments/webhook/mpesa | public (provider signature/HMAC is the auth) | payment callbacks → invoice PAID + subscription reactivation |
| POST | /payments/mpesa/stk-push | payments:write | M-Pesa STK Push initiation (Daraja) |

## SDKs

- TypeScript: `@jataqi/sdk` — `client.products`, `client.onboarding`,
  `client.ops`, plus every other namespace.
- Python: `clients/python` — same surface.
- Streaming: `/ws` WebSocket (`tanya.chunk`, `qil.step`, realtime bus events).
