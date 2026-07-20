// Tool abstraction — typed, JSON-schema-described callable units agents can invoke.

export interface ToolInputSchema {
  /** JSON Schema describing parameters. Simplified to required/properties for our runtime. */
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

export interface Tool<Input = unknown, Output = unknown> {
  /** Unique tool name (e.g. 'knowledge.search', 'graph.traverse'). */
  name: string;
  /** Human-readable description — used by the planner to decide when to call. */
  description: string;
  /** JSON schema for inputs. */
  inputSchema: ToolInputSchema;
  /** Execute the tool. */
  execute(input: Input, ctx: ToolContext): Promise<Output>;
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
}

export interface ToolCallResult<Output = unknown> {
  tool: string;
  input: unknown;
  output: Output;
  error?: string;
  durationMs: number;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

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
