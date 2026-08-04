// Span exporters: in-memory (tests), console, and OTLP/HTTP (POST to a collector).

import type { ReadableSpan } from './types.js';
import { toOTLP } from './otlp.js';

/** A span exporter receives ended spans. */
export interface SpanExporter {
  export(spans: ReadableSpan[]): Promise<void>;
  shutdown?(): Promise<void>;
}

/** Collects spans in memory for assertions (tests / introspection). */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  async export(spans: ReadableSpan[]): Promise<void> { this.spans.push(...spans); }
  reset(): void { this.spans.length = 0; }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

/** Logs each span to the console (human-readable). */
export class ConsoleSpanExporter implements SpanExporter {
  async export(spans: ReadableSpan[]): Promise<void> {
    for (const s of spans) {
      const ms = (Number(BigInt(s.endUnixNano) - BigInt(s.startUnixNano)) / 1e6).toFixed(2);
      // eslint-disable-next-line no-console
      console.log(`span ${s.name} kind=${s.kind} status=${s.status.code} ${ms}ms trace=${s.context.traceId.slice(0, 8)}… span=${s.context.spanId}`);
    }
  }
}

export interface OTLPHTTPExporterOptions {
  /** Collector endpoint, e.g. http://otel-collector:4318/v1/traces */
  endpoint: string;
  /** Extra headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Fetch timeout ms (default 5000). */
  timeoutMs?: number;
  /** Max retries on transient failure (default 2). */
  maxRetries?: number;
}

/**
 * Exports spans to an OpenTelemetry collector over OTLP/HTTP JSON.
 * Uses the global fetch (built into Node) — no external dependencies.
 */
export class OTLPHTTPExporter implements SpanExporter {
  private stopped = false;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly headers: Record<string, string>;
  constructor(private readonly opts: OTLPHTTPExporterOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  }
  async export(spans: ReadableSpan[]): Promise<void> {
    if (this.stopped || spans.length === 0) return;
    const body = JSON.stringify(toOTLP(spans));
    let attempt = 0;
    // Exponential backoff with jitter; never throws (tracing must not break the app).
    while (attempt <= this.maxRetries) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await fetch(this.opts.endpoint, { method: 'POST', headers: this.headers, body, signal: controller.signal });
          if (res.status >= 200 && res.status < 300) return;
          if (res.status >= 400 && res.status < 500) return; // drop on client errors (no retry helps)
        } finally {
          clearTimeout(timer);
        }
      } catch { /* network/abort — retry */ }
      attempt++;
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
  shutdown(): Promise<void> { this.stopped = true; return Promise.resolve(); }
}
