# JATA Qi Orbital Intelligence Engine — Authorized-Reference Foundation

## Status

```text
IMPLEMENTED: provider-neutral source metadata registry, upstream authorization
             reference recording, immutable hash-chained observation metadata,
             bounded Earth/other-body spatial references, storage-only
             spatiotemporal query, World Model/Temporal Engine links,
             independent-provider metadata fusion assessment, deterministic
             numeric feature-change comparison, local data-quality /
             license-reference policy assessment, encrypted opaque-reference
             storage through the local BlobStore boundary, integrity checks, and
             non-executing monitoring/information-request plans.

NOT IMPLEMENTED: live satellite, SAR, optical, spectral, weather, marine,
                 aviation, ground-sensor, or open-data provider connection;
                 external object-store access; sensor tasking; imagery download;
                 computer vision; object or person tracking; alert delivery;
                 external API access; military, classified, restricted, or
                 proprietary system access; or physical-system control.
```

No provider is bundled, registered, connected, authenticated, or assumed to be
available at bootstrap. The module has no access to classified satellites,
restricted military systems, proprietary feeds, or any external observation
source merely because the corresponding adapter type exists.

## Provider-neutral boundary

Future providers are represented only by a common declaration contract:

```ts
interface ObservationProviderAdapter {
  id: string;
  providerId: string;
  kind: ObservationProviderKind;
  source: string;
  sensor: string;
  supportedDataClasses: ObservationDataClass[];
  requiredPermissions: string[];
  availability(): Promise<{ available: boolean; observedAt: number }>;
}
```

An adapter is an application-injected, in-process capability and is never
bundled by JATA Qi. Registration does not connect, authenticate, retrieve data,
task a sensor, or invoke a provider. A locally registered adapter can only run
an explicit, bounded **sandbox** contract probe:

```text
connect? → authenticate? → capabilities → availability → disconnect?
```

The probe is blocked for production adapters and always records:

```text
didNotRetrieveData = true
didNotTaskSensor = true
```

After a process restart, persisted adapter descriptors are marked
`runtimeAdapterAvailable = false` until the host re-registers the actual
in-process adapter. This prevents a stale descriptor from being misrepresented
as a live provider connection.

A local source registration begins as:

```text
DECLARED
```

A tenant administrator must attach an upstream authorization reference and
evidence before a supplied observation reference can be recorded:

```text
AUTHORIZED_REFERENCE_RECORDED
```

This is explicitly a locally recorded reference, not independent verification
of provider access, license validity, source quality, data freshness, or feed
availability.

## Local data-quality and license-reference policy

`@jataqi/orbital-intelligence` now supports tenant-administered local data-use
policies. They may constrain declared source IDs, provider IDs, data classes,
license-reference identifiers, confidence thresholds, freshness, privacy class,
and whether a current recorded authorization reference is required.

A quality report is derived only from stored metadata:

```text
source authorization reference current?
license reference recorded?
observation age
observation confidence
attached evidence count and average confidence
```

The report never inspects raw observation bytes or independently validates
provider authorization, license terms, source quality, or legal permission.
When no license-reference allowlist is configured, the policy result is
explicitly `REVIEW`, not a fabricated license approval. A passing result is
`LOCAL_ALLOW`, meaning only that the configured local metadata checks passed.
Every policy evaluation carries:

```text
doesNotGrantProviderAccess = true
doesNotDetermineLicenseValidity = true
```

## Encrypted data-reference boundary

The OIE now provides an opaque-reference encryption boundary using the existing
local `StorageModule` BlobStore. It stores an encrypted envelope and safe
metadata only:

```text
cipher registration (in-process, no key material persisted)
→ AES-256-GCM encrypted locator envelope
→ ciphertext + authenticated-data integrity hashes
→ tenant-bound sealed-reference metadata
→ local integrity check
→ local policy/review assessment
```

A cipher is host-injected and exposes **encryption only** to this package. No
decryption API, plaintext-reference read API, provider-data fetch, provider-data
transmission, or external object-store operation exists in this release. Cipher
implementations are marked unavailable after restart until explicitly
re-registered, so a persisted descriptor never implies that a key is available.

Future external object stores are represented only by a typed adapter boundary.
No object-store adapter is registered or invoked. A sealed reference may be
linked to a new OIE observation; that observation stores only:

```text
sealed-reference:<reference-id>
```

rather than the original locator. Legacy plain-reference observations remain
explicitly labeled `PLAINTEXT_REFERENCE` for compatibility and must not be
mistaken for encrypted storage.

Encrypted-reference assessment returns only:

```text
LOCAL_ALLOW
REVIEW
BLOCK
```

`LOCAL_ALLOW` means the stored ciphertext hash/envelope metadata and linked
local policy metadata passed. The metadata-only verifier does not decrypt and
therefore reports `cryptographicAuthenticationTagVerified = false`; it does not
grant provider access, retrieve/transmit data, or determine license validity.
Missing local policy evidence, unverified license terms, or unverified privacy
suitability remain `REVIEW`; missing/expired source authorization or envelope
corruption is `BLOCK`.

## Non-executing monitoring and information-request plans

The OIE can now record a desired-observation monitoring plan or information
request plan with source, data classes, spatial extent, time/frequency,
objective, privacy classification, provenance, and review reasons. These plans
are intentionally constrained to:

```text
REVIEW_REQUIRED
or
BLOCKED
```

They do not schedule monitoring, task a sensor, contact a provider, retrieve
observation data, or transmit request details. A current locally recorded source
authorization reference is still not independent proof of external provider
permission or license validity.

## Observation contract

The registry retains only high-level, bounded metadata:

```text
source / provider / sensor / data class
geospatial extent / celestial body / coordinate reference system
authoritative acquisition and processing timestamps
quality and license references
content-addressed data reference + SHA-256 digest
observation/detection summaries
processing-chain summaries
evidence / provenance / confidence / epistemic status
```

Raw imagery, raw sensor bytes, credentials, private provider responses, and
unnecessary person-level identifiers are not accepted as registry fields.
Observations are hash-chained per tenant for local integrity checking.

Every interpretation stays explicitly classified:

```text
OBSERVED
DERIVED
INFERRED
PREDICTED
UNKNOWN
CONFLICTING
```

A metadata fusion assessment can only be `DERIVED`, `INFERRED`, `UNKNOWN`, or
`CONFLICTING`; it cannot silently become an observed fact. It requires at least
two observations from independently declared providers. Change assessments are
calculated only from supplied numeric feature values and are always `DERIVED`.
They are not computer-vision, target-identification, or causal conclusions.

## Existing JATA Qi integration

When explicitly requested, an observation can write a safe reference event into
existing tenant-bound modules:

```text
Orbital observation metadata
→ World Model event
→ Temporal Engine event
```

The linked events contain the observation ID, source ID, data class, and content
hash—not the raw data reference or sensor content. This is local persistence,
not live sensor fusion or real-time provider streaming.

## Safety boundary

The OIE is an authorized-data intelligence foundation. It must not autonomously:

- access restricted or classified systems;
- bypass provider authorization, licenses, access controls, rate limits, or
  legal restrictions;
- task a satellite/sensor;
- conduct attacks, select targets for harm, control weapons, or control any
  physical system;
- track people or create unnecessary person-level profiles;
- claim detection, prediction, access, provider health, or operational reach
  without recorded supporting evidence and an actually connected provider.

Any future provider integration must be an explicit, authorized adapter with
credential isolation, capability checks, policy/budget governance where
applicable, external verification, audit records, tenant isolation, and human
oversight. No provider result is live or verified until those requirements are
actually met.

## Next safe increments

```text
Authorized external object-store adapter implementation and contract testing
Independent key-management/HSM integration for encryption ciphers
Explicit model registry and benchmark/reproducibility links
Privacy-preserving aggregate spatial analytics
```
