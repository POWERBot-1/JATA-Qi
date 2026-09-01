# JATA Qi Permanence Fabric — Classical Continuity Foundation

## Scientific and operational status

```text
IMPLEMENTED: classical Ed25519 public-key identity records, portable signed
             JQ-UIP prints, root-signed runtime authorization, runtime-key
             attestation, signed opaque state checkpoints, conflict detection,
             root-key rotation, runtime revocation, local discovery and
             manifestation declarations, handover planning, and hash-chained
             identity lineage.

NOT IMPLEMENTED: quantum hardware, quantum-native computation, quantum-safe
                 cryptography, a guarantee of permanent availability, external
                 DNS/network discovery, process migration, cloud/VPS creation,
                 backup replication, secret-manager integration, or automatic
                 recovery execution.
```

"Quantum JATA Qi" is used only as the requested architectural name for
heterogeneous, future-compatible continuity. The implementation is classical
Node.js and Ed25519; it makes no quantum-computation, quantum-advantage, or
quantum-security claim.

## Architectural boundary

```text
JQ-ID (canonical public-key identity)
→ JQ-UIP (portable signed identity print)
→ root-signed runtime authorization
→ runtime-key attestation
→ signed opaque state checkpoint
→ optional discovery / manifestation declarations
→ locally verifiable handover plan
```

The identity is not defined by a domain, IP address, VPS, cloud account,
container, database, or user interface. Those may be declared as optional
locators or temporary runtime manifestations, but none is accepted as canonical
identity authority.

## Key handling

`@jataqi/permanence-fabric` accepts an application-injected signer boundary:

```ts
interface JqExternalSigner {
  keyId: string;
  algorithm: 'ED25519';
  publicKeyPem: string;
  sign(canonicalPayload: string): Promise<string> | string;
}
```

It verifies each produced signature with the public key, but it never persists,
loads, logs, or exports private keys. A production integration should implement
the signer through an approved secret-management, HSM, or operating-system key
boundary. That integration is not included here.

## State and runtime continuity

State records are intentionally opaque metadata:

```text
state reference
+ canonical SHA-256 digest
+ parent checkpoint reference
+ signed runtime authorization
+ runtime signature
+ explicit status
```

The package does not store or reconstruct state bytes. It prevents silent
last-writer-wins behavior: a checkpoint whose parent/version does not extend the
current authoritative checkpoint is marked `CONFLICTING`, not authoritative.

A `READY_TO_RESUME` handover is a root-signed local plan whose target runtime
has a valid available attestation and whose state checkpoint verifies. It does
**not** migrate a process, connect to the target, publish an endpoint, or claim
that execution resumed.

## Trust and resolution

A `JQ-UIP` can be checked for cryptographic self-consistency without the
network. Self-consistency alone is not proof of canonical identity: an
arbitrary actor can create a different self-signed print. Use
`verifyIdentityPrintAgainstIdentity()` with a locally trusted JQ-ID root record
to validate a print against the expected identity lineage.

The local resolver returns only stored, valid, unexpired, non-revoked records.
It always states:

```text
doesNotProveReachability = true
```

because this package does not perform DNS, endpoint, cloud, or network checks.

## Governance boundary

Permanence metadata does not authorize commercial, financial, infrastructure,
credential, legal, or external-communication actions. Any such action must
still follow the Commercial Control Plane's policy, authorization, budget,
consent, approval, connector, verification, audit, and kill-switch controls.

## Next safe increments

```text
Secure signer/HSM or secret-manager adapter boundary
Authorized encrypted state-store/reference adapters
Offline event journal and governed synchronization protocol
Independent runtime-health verification adapters
Network/discovery adapters with explicit capability and authorization checks
Recovery drill harness using isolated, non-production runtimes
```
