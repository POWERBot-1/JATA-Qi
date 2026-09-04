// Deterministic, collision-resistant PostgreSQL identifier derivation.
//
// Logical collection/namespace/blob names in JATA Qi may contain characters
// that are awkward as bare SQL identifiers ('.', '-', etc.). We map every
// logical name to a stable identifier composed only of [a-z0-9_], suffixed
// with a short hash so two distinct logical names can never map to the same
// table even if they sanitize to the same slug.

import { createHash } from 'node:crypto';

const KIND_PREFIX: Record<'collection' | 'namespace' | 'blob', string> = {
  collection: 'col',
  namespace: 'ns',
  blob: 'blob',
};

export function deriveTableName(kind: 'collection' | 'namespace' | 'blob', logicalName: string): string {
  const shortHash = createHash('sha1').update(`${kind}:${logicalName}`).digest('hex').slice(0, 12);
  const slug = logicalName
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 42) || 'store';
  const identifier = `jata_${KIND_PREFIX[kind]}_${slug}_${shortHash}`;
  // PostgreSQL identifiers are limited to 63 bytes.
  return identifier.slice(0, 63);
}

export function schemaMetaKey(kind: 'collection' | 'namespace' | 'blob', logicalName: string): string {
  return `${deriveTableName(kind, logicalName)}:${logicalName}`;
}
