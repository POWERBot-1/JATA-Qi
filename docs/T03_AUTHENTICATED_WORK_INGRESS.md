# T-03 — Authenticated Work Ingress

**Status:** implemented in-repo, validated in-memory and against a real
PostgreSQL backend, awaiting review merge.
**Milestone type:** reachability/authority milestone — **no new cognitive
stage, no new engine, no new capability adapter, no external side effect, no
second orchestrator.**
**Baseline / rollback point:** canonical `main`
`97fe7ffc558a6824fe18b194986195b091443e11` (the T-02 merge).
**Series:** continues `T` (Transactional/Trust). T-01 installed the
server-side principal boundary; T-02 carried authenticated authority durably;
**T-03 makes both reachable from a running process.**

## The problem T-03 solves

The post-T-02 gap assessment recorded two findings that turned out to be one
broken link seen from both ends:

- **GAP-1 — the durable host had no work source.** `enqueue` had exactly one
  non-test call site in the whole repository: `host-service.ts` delegating to
  its own queue. 99 other call sites were all under `test/`. There was no HTTP
  surface, and no CLI verb that created work. `jataqi host` booted, asserted
  durable storage, ran boot recovery, and then ticked an **always-empty**
  queue.
- **GAP-2 — nothing could produce an `AuthenticatedPrincipal`.**
  `@jataqi/authentication` was not a dependency of `@jataqi/cli`, was not
  imported by `bootstrap.ts`, and had no `IModule`. Authenticator construction
  in non-test source: **zero** occurrences. So T-02's
  `enqueue(actor, input, principal)` demanded a principal no shipped code path
  could mint.

Two supporting findings are closed alongside them:

- **GAP-5 — the T-02 policy knobs were unreachable.** `JataQiConfig.loopHost`
  carried no `principalPolicy` and no `maxPrincipalAgeMs`, so
  `jataqi host` ran on the loop-host *library* default
  `allowTestMethod: true` — admitting `DETERMINISTIC_TEST` authority with no
  way for an operator to change it.

This is the same failure mode R-01 was created to fix. R-01's problem
statement reads: *"O-01 and P-01 were both **built and unreachable**."* R-01
closed that for *process* reachability; T-03 closes it for *work*
reachability.

## What T-03 delivers

```text
jataqi host:enqueue --objective "..."          <- NEW: authenticated ingress verb
   │   credential material from JATAQI_AUTH_TOKEN (never argv)
   │   authentication METHOD from JATAQI_AUTH_MODE (never from the caller)
   ▼
PrincipalBoundary.authenticate()               <- NEW: T-03 fail-closed boundary
   │   policy admission  ->  T-01 AuthenticatorRegistry  ->  principal validation
   ▼
AuthenticatedPrincipal
   │   tenant continuity check (authenticated tenant is authoritative)
   ▼
projectToActor()                               <- T-01, unchanged (narrowing only)
   ▼
WorkIngressService.submit()                    <- NEW: the only write it performs
   ▼
LoopHostService.enqueue(actor, input, principal)   <- T-02, UNCHANGED
   ▼
persisted T-02 principal snapshot (durable queue)
   ▼
LoopHostService dispatch -> T-02 re-authorization -> unified 34-stage loop
```

### 1. `AuthenticationModule` — the boundary in the composition root

`packages/authentication/src/authentication-module.ts` gives
`@jataqi/authentication` its first `IModule` (`id = 'authentication'`, a leaf
with no `dependsOn`). `bootstrap.ts` now registers it **unconditionally**, so
every real composition — CLI, `jataqi host`, embedders — has a principal
boundary.

By default it is constructed with **no authenticators** and the production
admission policy. A JATA Qi process that has not been told how to authenticate
callers therefore authenticates nobody and fails closed. That is the honest
state of an unconfigured process, and it is reported as such rather than
papered over with a permissive default.

### 2. `PrincipalBoundary` — one enforcement wrapper, not a second system

`packages/authentication/src/principal-boundary.ts` wraps the **existing T-01
`AuthenticatorRegistry`**. It adds exactly two things:

1. **Policy admission, checked before any authenticator is consulted** — so a
   registered authenticator can never widen the boundary.
2. **Independent validation of whatever an authenticator returns** — so a
   buggy or hostile authenticator cannot hand a malformed principal, or a
   mislabelled method, to the durable boundary.

Construction is itself fail-closed: an authenticator that supports a method
the policy does not admit is **rejected at startup**. Dropping a
`DeterministicTestAuthenticator` into a production root is therefore a boot
error, not a latent authority hole.

It never mints authority, never persists anything, never holds credentials,
and never falls back: there is no `SYSTEM` actor, no anonymous actor, and no
default principal anywhere in the file.

### 3. Explicit, auditable admission policy

`packages/authentication/src/authentication-policy.ts` resolves policy input
into a frozen `ResolvedAuthenticationPolicy` whose `describe()` is suitable for
an audit line, so an operator can answer *"what would this process accept as
authority?"* without reading code.

`PRODUCTION_AUTHENTICATION_METHODS` is `['STATIC_TOKEN','OIDC','MTLS']`. It
excludes `DETERMINISTIC_TEST` by construction, and `KERNEL_INTERNAL` because a
kernel-internal system actor must never be obtainable from an external request.

**The test-authority rule** is exported as a machine-checkable constant,
`PRINCIPAL_AUTHENTICATION_TEST_METHODS_GUARD`: admitting
`DETERMINISTIC_TEST` requires **two** deliberate acts — selecting the
`test-only` mode *and* setting `allowTestMethod: true`. Requesting it under
the production policy **throws**.

### 4. `WorkIngressService` — the production front door

`packages/loop-host/src/work-ingress.ts`. It authenticates, checks tenant
continuity, derives the actor through **T-01's own `projectToActor`**, and
calls **`LoopHostService.enqueue`**. That enqueue is the only write it
performs.

It deliberately does **not** duplicate anything:

| Concern | Owner (unchanged) |
|---|---|
| Credential verification | T-01 `AuthenticatorRegistry` |
| Role-narrowing rule | T-01 `projectToActor` |
| Snapshot construction | T-02 `freezePrincipalSnapshot` (via `enqueue`) |
| Actor-derivation check | T-02 `assertActorDerivedFromPrincipal` (via `enqueue`) |
| Dispatch authorization | T-02 `authorizeDispatch` |
| Scheduling, leases, checkpoints, retry, DLQ | O-01 loop-host |
| Reasoning, policy, gates, execution | W22/W23 unified 34-stage loop |

It is a **separate class** from `LoopHostService` on purpose: acceptance **O16**
asserts the host's own prototype exposes no method named like `authoriz`,
`policy`, `grant`, `execut`, `verif`, and so on. Adding the ingress as its own
class keeps that invariant true, and the O16 test still passes unmodified.

`WorkIngressModule` (`id = 'work-ingress'`, `dependsOn = ['authentication','loop-host']`)
is registered only alongside the host — there is no orphan ingress.

### 5. `jataqi host:enqueue`

```bash
JATAQI_AUTH_MODE=static-token \
JATAQI_AUTH_PRINCIPALS=/etc/jataqi/principals.json \
JATAQI_AUTH_TOKEN=... \
  jataqi host:enqueue --objective "Analyze churn signals." --idempotency-key run-42
```

Two deliberate properties:

- The **authentication method is never taken from the command line**. It is
  derived from the configured posture, so a caller cannot claim a method the
  deployment did not configure. Only the credential *material* is supplied, and
  it is read from `JATAQI_AUTH_TOKEN` (never argv), so it does not land in
  process listings or shell history.
- With no method configured the command **fails closed** and prints the
  limitation. It never falls back to a test principal, a `SYSTEM` actor, or a
  caller-supplied tenant.

`--tenant` is a **consistency check only**: it must equal the authenticated
tenant or the request is refused. It can never override it.

The command creates durable work and nothing else. It never starts the host,
ticks, dispatches, resumes, approves, or settles.

### 6. Policy plumbed to the entrypoint (GAP-5)

`JataQiConfig.loopHost` now carries `maxPrincipalAgeMs` and `principalPolicy`,
and `createJataQiFromEnv` forwards `JATAQI_MAX_PRINCIPAL_AGE_MS`.

`allowTestMethod` is **derived** from the authentication posture, so the
loop-host library default is never inherited by a real process:

| Composition | `allowTestMethod` |
|---|---|
| `createJataQi({ loopHost: { enabled: true } })` (production) | **`false`** |
| `... authentication: { policy: { mode: 'test-only', allowTestMethod: true } }` | `true` |
| production policy **plus** `principalPolicy: { allowTestMethod: true }` | **throws at composition** |
| test-only posture **plus** `principalPolicy: { allowTestMethod: false }` | `false` (narrowing allowed) |

The loop-host library default of `true` is unchanged — unit tests still mint
authority without ceremony. What changed is that a real composition always
states the value explicitly.

## Security behaviour

Fails closed, with **no work created and no receipt returned**, on:

| Condition | Outcome |
|---|---|
| Missing credential | `UnauthenticatedRequestError` |
| Unrecognized credential method | `UnauthenticatedRequestError` |
| Method not admitted by policy | `AuthenticationPolicyError` (before any authenticator runs) |
| Invalid / expired / unknown material | `PrincipalValidationError` |
| Malformed principal from an authenticator | `PrincipalValidationError` |
| Authenticator mislabels its method | `PrincipalValidationError` |
| Caller tenant ≠ authenticated tenant | `PrincipalValidationError` |
| Role widening | `PrincipalValidationError` (T-01 `projectToActor`) |
| Blank objective | `LoopHostError` |
| Persistence failure | the underlying error propagates; no receipt |
| Test authority in a production root | `AuthenticationPolicyError` |
| `system` role in a CLI principal file | `CliAuthenticationConfigError` |

Nothing ever downgrades to `SYSTEM`, anonymous, a caller-supplied actor, a
caller-supplied tenant, or a test principal.

**No secret is persisted.** The ingress stores only the existing T-02 approved
snapshot (`version`, `principalId`, `tenantId`, `roles`,
`authenticationMethod`, `verifiedAt`, `authenticationEventId`) via
`freezePrincipalSnapshot`, which is untouched by T-03. Test **T03-15b** scans
the persisted row for `token`, `password`, `secret`, `material`, `credential`
and for the literal credential material, and asserts none are present. Test
**T03-PG6** asserts the same across an OS-process boundary.

## Validation

| Suite | Result |
|---|---|
| `@jataqi/authentication` | 38 tests (16 pre-existing + 22 new) |
| `@jataqi/loop-host` | 155 tests (122 pre-existing + 27 new memory + 6 new real-PG) |
| `@jataqi/cli` | 50 tests (25 pre-existing + 25 new) |
| Full monorepo | see the PR description |
| Build / lint | green / 0 errors |

New acceptance coverage: T03-09 … T03-25b (in-memory), T03-PG1 … T03-PG6 (real
PostgreSQL, including a genuine two-process authority-continuity check).
The PostgreSQL suites boot a real embedded server and report
`skipped 0` — they did not skip.

Regression notes: the O16 host-surface test, the O17/O19/O20 governance
negatives, the T-01 and T-02 suites, and the R-01 two-process suite all pass
**unmodified**. `test/helpers.ts` gained an **opt-in** `withIngress` option
that is off by default, so every pre-T-03 suite is untouched.

## Gaps carried forward (do not over-claim)

- **Action origination is still open, deliberately.** No stage originates a
  `proposedAction`; the ingress forwards one only if a caller supplies it,
  exactly as `EnqueueWorkInput` already allowed. T-03 adds no action
  generation.
- **No adapters.** The action runtime still boots with *"no adapters
  registered"*. T-03 activates no M-Pesa, payment, maps, messaging, cloud, or
  device capability.
- **No live identity provider.** OIDC and mTLS remain type-only contracts.
  `STATIC_TOKEN` is the only non-test method a CLI process can configure, and
  its own contract scopes it to development/staging. A deployment needing real
  identity must embed JATA Qi and register its own `ServerAuthenticator`.
- **No HTTP surface.** T-03 adds a CLI verb and an embeddable service; it does
  not add a network listener, and deliberately so — an HTTP service that
  executed tasks independently would be a second execution path.
- **P-01 durability honesty is unchanged:** no backup, restore, PITR,
  replication, or failover; RPO and RTO remain UNDEFINED.
