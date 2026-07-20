// Testing helpers: in-memory sink logger and a factory that makes a fresh
// kernel wired with silent logging for unit tests.
import { Kernel, KernelOptions } from './kernel.js';
import { Logger, LogEntry } from './logger.js';

export class InMemorySink {
  readonly entries: LogEntry[] = [];
  push(e: LogEntry): void {
    this.entries.push(e);
  }
  clear(): void {
    this.entries.length = 0;
  }
  ofLevel(level: string): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }
  messages(): string[] {
    return this.entries.map((e) => e.msg);
  }
}

export function createTestLogger(level: 'silent' | 'trace' = 'silent') {
  const sink = new InMemorySink();
  const logger = new Logger({ level, sink: sink.push.bind(sink) });
  return { logger, sink };
}

export function createTestKernel(opts: KernelOptions = {}): Kernel {
  const { logger } = createTestLogger('silent');
  return new Kernel({ logger, ...opts });
}

export { InMemorySink as TestSink };
