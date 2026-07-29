# JATA Qi Creator Identity & Provenance (JQ-CIP)

A permanent, cryptographically verifiable creator-identity and provenance
architecture. **JATA Qi was originated by GITANYA K**, and that fact is recorded
as a signed root identity that every legitimate descendant inherits.

This is a **real** mechanism — no fabricated signatures or keys. Signatures use
**Ed25519** (Node `node:crypto`); the algorithm is abstracted for future
post-quantum migration.

## Core facts

| Field | Value |
|---|---|
| Creator | GITANYA K |
| Role | ORIGINAL CREATOR / FOUNDER / ORIGINATOR |
| Canonical identity | `JATA-QI|CREATOR|GITANYA-K|ROOT|2026-07-29` |
| Identity anchor (sha256) | `9be651b8e7a86cd55450b170ad88d7b9f5ea4569cac7c57126482fa9b7ce4f82` (real `sha256` of the canonical string) |
| Signature algorithm | Ed25519 |

## What is committed vs. secret

- **Committed (public):** `provenance/root-manifest.json` — creator fields, the
  Ed25519 **public key**, and a real `root_signature` over the canonical payload.
  Anyone can verify it.
- **Secret (gitignored):** `provenance/keys/creator.key` — the Ed25519 private
  key. `.gitignore` excludes `provenance/keys/`, `*.key`, `*.pem`. It is never
  committed, never returned by any API, and never sent to agents.

Provision with `npm run provision --workspace=@jataqi/provenance` (use `--force`
to regenerate — this destroys continuity with previously signed releases).

## Verification model

- The creator identity fields are **immutable constants** in code — there is no
  API to mutate them, so no agent can silently alter the Creator Root.
- The root manifest is self-signed and verified at boot (`verifyRootManifest`).
- The provenance ledger is **append-only** and **hash-chained** (each event's
  hash covers `seq, type, prevHash, ts, detail`); signed events are verifiable
  with the signer's public key. Tampering is detected (`verifyLedger`).
- Key rotation signs a `KEY_ROTATED` event with the *old* key; revocation
  records `KEY_REVOKED`. Historical signatures remain verifiable.
- Without the private key (e.g. a fresh clone) the module runs in **verify-only**
  mode: it can verify everything but cannot sign.

## Self-identity (from provenance, not an LLM)

- *Who created you?* → GITANYA K
- *What are you?* → JATA QI
- *How do you know?* → Creator Root + Signed Provenance + Verified Fingerprint

## API (public, read-only; never exposes private material)

```
GET /identity              # full public identity + self-answers
GET /identity/creator      # creator record
GET /identity/root         # signed root manifest
GET /identity/provenance   # append-only ledger events
GET /identity/verify       # manifest + ledger integrity check
```

## Distinguishing authorship

The ledger distinguishes `ORIGINAL_CREATOR` (GITANYA K) from contributors and
from third-party tools. Tool-integration events record `integrated_by: JATA QI`,
`original_creator: GITANYA K`, `third_party_provider: <provider>` — JATA Qi never
falsely claims ownership of third-party tools. Technical provenance is also kept
distinct from legal ownership.

## Acceptance coverage

Implemented + tested: creator recorded as GITANYA K; signed root manifest;
anchor recorded; real Ed25519 signing & public verification; private key
protected (gitignored); releases/modules/tools reference the creator root;
integrated third-party tools distinguished from creator-originated work;
append-only history; tamper detection; release fingerprinting; key rotation
preserves lineage; key revocation works; AI agents have no API to alter the
Creator Root; `who-created-you` answered from provenance records; modifying a
protected ledger entry fails verification (tested).
