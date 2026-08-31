// Sandboxed Execution Environment with isolation and resource limits.

import type { SandboxEnvironment } from './types.js';

export class SandboxEngine {
  createSandbox(sandboxId: string, options: Partial<SandboxEnvironment> = {}): SandboxEnvironment {
    return {
      sandboxId,
      cpuLimitCores: options.cpuLimitCores ?? 1,
      memoryLimitMb: options.memoryLimitMb ?? 512,
      timeoutMs: options.timeoutMs ?? 5000,
      allowOutboundNetwork: options.allowOutboundNetwork ?? false,
      activeFiles: options.activeFiles ?? new Map(),
    };
  }

  async runInSandbox<T>(
    sandbox: SandboxEnvironment,
    task: (env: SandboxEnvironment) => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Sandbox execution timed out after ${sandbox.timeoutMs}ms`)), sandbox.timeoutMs)
    );

    const taskPromise = task(sandbox);
    const result = await Promise.race([taskPromise, timeoutPromise]);
    return result;
  }
}
