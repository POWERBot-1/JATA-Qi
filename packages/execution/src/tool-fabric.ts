// Universal Tool Fabric with normalized execution, rate limiting, and risk policies.

import type { ToolDefinition, RiskLevel } from './types.js';

export class UniversalToolFabric {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly callCounts = new Map<string, { count: number; windowStart: number }>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  async executeTool(name: string, input: Record<string, unknown>, userPermissions: string[] = []): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`UniversalToolFabric: tool '${name}' not found`);

    // Check permissions
    for (const perm of tool.permissions) {
      if (!userPermissions.includes(perm) && !userPermissions.includes('admin')) {
        throw new Error(`UniversalToolFabric: execution denied for '${name}': missing permission '${perm}'`);
      }
    }

    // Rate limit check
    if (tool.rateLimitPerMin) {
      const now = Date.now();
      let record = this.callCounts.get(name);
      if (!record || now - record.windowStart > 60000) {
        record = { count: 0, windowStart: now };
        this.callCounts.set(name, record);
      }
      record.count++;
      if (record.count > tool.rateLimitPerMin) {
        throw new Error(`UniversalToolFabric: rate limit exceeded for tool '${name}' (${tool.rateLimitPerMin}/min)`);
      }
    }

    // Timeout execution wrapper
    const timeoutMs = tool.timeoutMs ?? 10000;
    const executePromise = tool.handler(input);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`UniversalToolFabric: tool '${name}' timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    return Promise.race([executePromise, timeoutPromise]);
  }
}
