// S-1 (Tenant Boundary Hardening) — tenant-context refusal for the vector layer.
//
// `@jataqi/vector-search` sits BELOW `@jataqi/knowledge-service` in the
// dependency graph, so it cannot import the knowledge guard; this is the same
// refusal type, defined locally, with the same stable `code` and `name` so a
// caller can recognize a tenant refusal uniformly across layers.
//
// The vector layer is deliberately STRICTER than the knowledge layer: it has no
// reserved default-tenant bucket, so no test-compat fallback flag is honoured
// here. A tenant-bound vector search without an unambiguous tenant is refused —
// an unscoped search would span every tenant whose vectors live in the index.

/** Stable machine-readable code for a refused tenant context. */
export const TENANT_CONTEXT_REQUIRED = 'TENANT_CONTEXT_REQUIRED';

/** Thrown when a tenant-bound vector operation is invoked without an unambiguous tenant. */
export class TenantContextError extends Error {
  readonly code = TENANT_CONTEXT_REQUIRED;
  /** Operation that was refused (e.g. `VectorSearchModule.embedAndSearch`). */
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = 'TenantContextError';
    this.operation = operation;
  }
}

/** True when the value is a usable tenant id (present and not blank). */
export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
