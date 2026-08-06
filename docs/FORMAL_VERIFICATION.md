# Formal Verification & Property-Based Validation

The directive asks for **formal verification and mathematically rigorous
validation of selected security-critical components where practical**. JATA Qi
applies property-based testing (QuickCheck-style, zero external deps) to the
platform's security-critical invariants. Each suite generates randomized
inputs across hundreds of trials and asserts structural invariants — catching
edge cases that example-based tests miss.

## Coverage map

| Component | Property suite | Invariants verified | Trials |
| --------- | -------------- | ------------------- | ------ |
| SOC security data lake (`@jataqi/soc`) | `verifyChain` | Every append extends a valid SHA-256 chain; **any** single-entry mutation breaks verification and identifies the exact broken entry | 3-entry chains + tamper |
| DLP policy engine (`@jataqi/dlp`) | `dlp.test.ts` | **Redaction idempotence**: re-scanning redacted content is always clean (50 trials); **evidence invariant**: incidents never contain raw sensitive values; **action monotonicity**: worst action (block > quarantine > redact > notify > allow) always wins under mixed content (25 trials); **rule determinism**: identical rules + content → identical decisions (20 trials) | ~95 |
| PQC envelope layer (`@jataqi/pqc`) | `pqc.test.ts` | **Round-trip**: sign→verify holds for every provider under any payload (125 trials across 5 algorithms); **unforgeability**: any payload mutation fails verification (100 trials); **phase monotonicity**: migration order inventory→dual_run→hybrid→pq_only is total and strictly sequential; **no private leakage**: public-key export never contains private material | ~225 |
| Incident lifecycle (`@jataqi/soc` + `@jataqi/active-defense`) | state-machine suites | Forward-only status transitions (detected→…→closed rejects regressions); sign-off blocked while critical/high findings remain open; SLA escalation is monotonic and bounded by severity | deterministic |
| Resilience DR (`@jataqi/resilience-engineering`) | RPO/RTO | RPO measured from the newest real DR snapshot; executions either complete within RTO or are flagged violated — never both | deterministic |

## QuickCheck-style harness

Property suites use a simple loop harness (no external dependency):

```ts
// dlp.test.ts
it('property: redaction is idempotent (second scan finds nothing)', () => {
  const e = new DlpEngine();
  for (let i = 0; i < 50; i++) {
    const card = `411111111111111${i % 10}`;
    const first = e.scan({ content: `card ${card}`, channel: 'api_response' });
    assert.equal(first.action, 'redact');
    const redacted = first.results[0]!.redacted;
    const again = e.scan({ content: redacted, channel: 'api_response' });
    assert.equal(again.action, 'allow', `iteration ${i}: redacted content must be clean`);
  }
});
```

## Running

```bash
npm test --workspace @jataqi/dlp          # 12 tests incl. 4 property suites
npm test --workspace @jataqi/pqc          # 13 tests incl. 4 property suites
npm test --workspace @jataqi/soc          # hash-chain + incident lifecycle
npm test --workspace @jataqi/infra-governance  # root-of-trust state properties
```

Full-suite regression: `npm test` (all workspaces, 0 failures required).

## Honesty note

Property testing is *testing*, not theorem proving: it samples the input space
rather than exhaustively proving invariants. For the components above the
sample sizes (20–125 trials per property) plus deterministic structural checks
give high confidence at a practical cost. Formal verification of the SOC
hash-chain construction (e.g. via a proof assistant) remains a future
enhancement tracked in the readiness matrix (`security.formal-verification`).
