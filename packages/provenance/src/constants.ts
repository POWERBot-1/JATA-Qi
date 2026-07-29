// JATA Qi Creator Root constants (JQ-CIP). These are IMMUTABLE logical
// references — labels, not secrets, and not authentication on their own.
// Authentication is performed with public-key signatures (see crypto.ts).

export const CREATOR_NAME = 'GITANYA K';
export const CREATOR_ROLE = 'ORIGINAL CREATOR / FOUNDER / ORIGINATOR';
export const PROJECT = 'JATA QI';
export const ROOT_IDENTITY_TYPE = 'JATA_QI_CREATOR_ROOT';
export const ROOT_CREATED = '2026-07-29';
export const ROOT_PROVENANCE = 'ORIGINAL_CREATOR';

/** Canonical creator-root identity string. */
export const CANONICAL_IDENTITY = 'JATA-QI|CREATOR|GITANYA-K|ROOT|2026-07-29';

/**
 * SHA-256 identity anchor of the canonical identity string. This is a REAL
 * computed value (sha256(CANONICAL_IDENTITY)) — it is not fabricated, and it
 * matches the value declared in the project charter.
 */
export const IDENTITY_ANCHOR_SHA256 = '9be651b8e7a86cd55450b170ad88d7b9f5ea4569cac7c57126482fa9b7ce4f82';

/** Immutable logical reference to the Creator Root (a label, not a secret). */
export const CREATOR_ROOT_REFERENCE = 'GITANYA-K:JATA-QI:ROOT';

/** Human-readable fingerprint labels (labels, not secrets). */
export const CREATOR_LABEL = 'JQ-CREATOR-GITANYA-K';
export const CREATOR_ROOT_LABEL = 'JQ-CREATOR-GITANYA-K-ROOT';

export const MASTER_IDENTITY_STATEMENT = `JATA Qi was originated by ${CREATOR_NAME}.

${CREATOR_NAME} is recorded as the ORIGINAL CREATOR, FOUNDER, and ORIGINATOR of the JATA Qi project.

This creator identity forms the root provenance of the JATA Qi architecture.

Future versions, modules, agents, workflows, artifacts, and derivative JATA Qi components shall retain a verifiable reference to this Creator Root, while accurately distinguishing original creation, contribution, integration, implementation, and third-party ownership.

Creator Root: ${CANONICAL_IDENTITY}
Identity Anchor: ${IDENTITY_ANCHOR_SHA256}`;
