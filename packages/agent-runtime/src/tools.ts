// Tool abstraction — typed, JSON-schema-described callable units agents can invoke.
//
// A-01: when a ToolRegistry is constructed with (or given) an authorization
// gate, EVERY call is routed through the authoritative boundary BEFORE the
// tool executes: the call must carry a sealed envelope rendered for exactly
// this tool/operation/target, and the gate re-verifies it (integrity,
// decision, freshness, replay, credential) before the side effect. A tool
// without an `authorization` declaration cannot run behind an installed gate
// (UNDECLARED_TOOL_AUTHORIZATION) — declaration is how a tool states what it
// is allowed to be, and the decision is what the boundary allows.

import type {
  A01AuthorizationEnvelope,
  A01DataClassification,
  A01ImpactLevel,
  AuthorizationGate,
} from '@jataqi/authorization-boundary';

export interface ToolInputSchema {
  /** JSON Schema describing parameters. Simplified to required/properties for our runtime. */
  type: string;
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

/**
 * A-01 declaration of what this tool is allowed to be. The registry checks
 * the envelope against this declaration before invoking the tool; the
 * boundary (gate + manifest) decides whether that is allowed.
 */
export interface ToolAuthorizationDeclaration {
  /** Capability the tool executes under (must be a registered manifest). */
  capabilityId: string;
  capabilityVersion: string;
  /** Operation within the capability (must be in the manifest allow-list). */
  operation: string;
  /** Declared impact of a successful call. */
  impact: A01ImpactLevel;
  /** Declared data classification handled by the call. */
  dataClassification: A01DataClassification;
  /** Target system the call touches. */
  targetSystem: string;
  /** When set, the envelope target audience must equal it. */
  audience?: string;
  /**
   * Derive the concrete target resource from the (validated) input. The
   * envelope's target resource must equal the derived value, so a tool call
   * cannot be executed against a different resource than the one the
   * decision authorized (target substitution is denied).
   */
  targetFromInput?: (input: unknown) => string | undefined;
}

export interface Tool<Input = unknown, Output = unknown> {
  /** Unique tool name (e.g. 'knowledge.search', 'graph.traverse'). */
  name: string;
  /** Human-readable description — used by the planner to decide when to call. */
  description: string;
  /** JSON schema for inputs. */
  inputSchema: ToolInputSchema;
  /** A-01 authorization declaration (required to run behind an installed gate). */
  authorization?: ToolAuthorizationDeclaration;
  /** Execute the tool. */
  execute(input: Input, ctx: ToolContext): Promise<Output>;
}

export interface ToolAuthorizationContext {
  /** The sealed envelope for this call, rendered by the gate for this tool. */
  envelope: A01AuthorizationEnvelope;
}

export interface ToolContext {
  /** Agent/session id */
  runId: string;
  /** Signal for cancellation. */
  signal?: AbortSignal;
  /** Logger scoped to this tool call. */
  logger: { info: (m: string, d?: unknown) => void; debug: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
  /** Per-run metadata bag. */
  metadata: Record<string, unknown>;
  /** A-01: the authoritative envelope for this call (set by the gate-wired registry/agent). */
  authorization?: ToolAuthorizationContext;
}

export interface ToolCallResult<Output = unknown> {
  tool: string;
  input: unknown;
  output: Output;
  error?: string;
  durationMs: number;
}

export interface ToolRegistryOptions {
  /**
   * A-01: the authoritative authorization boundary. When set, every call is
   * enforced through it; there is no per-call opt-out.
   */
  authorizationGate?: AuthorizationGate;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private gate: AuthorizationGate | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.gate = options.authorizationGate;
  }

  /** Install/replace the A-01 boundary for this registry. */
  setAuthorizationGate(gate: AuthorizationGate): void {
    this.gate = gate;
  }

  /** The installed boundary, if any (diagnostics; never grants anything). */
  getAuthorizationGate(): AuthorizationGate | undefined {
    return this.gate;
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async call(name: string, input: unknown, ctx: ToolContext): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`ToolRegistry: unknown tool "${name}"`);
    const start = Date.now();
    // A-01: behind an installed boundary, the gate is the only path to the
    // tool. Denial is returned as a tool error result — the side effect is
    // never invoked.
    if (this.gate) {
      const gate = this.gate;
      try {
        const decl = tool.authorization;
        if (!decl) {
          return {
            tool: name,
            input,
            output: undefined,
            error: 'AUTHORIZATION_DENIED: UNDECLARED_TOOL_AUTHORIZATION — the tool declares no A-01 authorization metadata and cannot run behind an installed boundary',
            durationMs: Date.now() - start,
          };
        }
        const targetResource = typeof decl.targetFromInput === 'function' ? decl.targetFromInput(input) : undefined;
        const envelope = ctx.authorization?.envelope;
        if (!envelope) {
          return {
            tool: name,
            input,
            output: undefined,
            error: 'AUTHORIZATION_DENIED: AUTHORIZATION_ENVELOPE_MISSING — the call carries no sealed authorization envelope and cannot run behind an installed boundary',
            durationMs: Date.now() - start,
          };
        }
        // Verify the envelope is intact, an ALLOW, fresh, and bound to THIS
        // tool/operation/target — all BEFORE any side effect.
        const verified = gate.assertEnvelope(envelope, {
          tool: name,
          operation: decl.operation,
          ...(targetResource !== undefined ? { targetResource } : {}),
        });
        const output = await gate.executeAuthorized(
          verified,
          (scoped) => {
            validateInput(tool, input);
            return tool.execute(input, { ...ctx, authorization: { envelope: scoped.envelope } });
          },
          { tool: name, operation: decl.operation, ...(targetResource !== undefined ? { targetResource } : {}) },
        );
        return { tool: name, input, output, durationMs: Date.now() - start };
      } catch (err: any) {
        return {
          tool: name,
          input,
          output: undefined,
          error: err?.message ?? String(err),
          durationMs: Date.now() - start,
        };
      }
    }
    try {
      validateInput(tool, input);
      const output = await tool.execute(input, ctx);
      return { tool: name, input, output, durationMs: Date.now() - start };
    } catch (err: any) {
      return {
        tool: name,
        input,
        output: undefined,
        error: err?.message ?? String(err),
        durationMs: Date.now() - start,
      };
    }
  }
}

function validateInput(tool: Tool, input: unknown): void {
  if (input === null || typeof input !== 'object') {
    throw new Error(`Tool "${tool.name}": input must be an object`);
  }
  const schema = tool.inputSchema;
  for (const req of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(input as object, req)) {
      throw new Error(`Tool "${tool.name}": missing required parameter "${req}"`);
    }
  }
}
