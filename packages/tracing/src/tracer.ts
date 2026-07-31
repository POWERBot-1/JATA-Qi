// Span, samplers, Tracer, TracerProvider, and span processors.
// Pure Node (node:crypto for ids), zero deps.

import { randomBytes } from 'node:crypto';
import type {
  Attributes, AttributeValue, SpanContext, SpanKind, SpanStatus, StatusCode,
  SpanEvent, Link, ReadableSpan, SamplingResult,
} from './types.js';

const NS_PER_MS = 1_000_000n;

function randomTraceId(): string {
  // 16 random bytes, but reject the all-zero id (W3C forbids it).
  let b: Buffer;
  do { b = randomBytes(16); } while (b.every((x) => x === 0));
  return b.toString('hex');
}
function randomSpanId(): string {
  let b: Buffer;
  do { b = randomBytes(8); } while (b.every((x) => x === 0));
  return b.toString('hex');
}

/** Wall-clock nanoseconds (ms precision via Date.now). */
function nowUnixNano(): string { return (BigInt(Date.now()) * NS_PER_MS).toString(); }

// --- Span --------------------------------------------------------------------

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Parent context (e.g. extracted from an incoming traceparent). Omit for a root span. */
  parent?: SpanContext;
  links?: Link[];
}

export class Span {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parentSpanId?: string;
  readonly startUnixNano: string;
  private readonly resource: Attributes;
  private readonly scope: string;
  private readonly links: Link[];
  private attributes: Attributes;
  private events: SpanEvent[] = [];
  private status: SpanStatus = { code: 'unset' };
  private endUnixNano?: string;
  /** A non-recording span (not sampled) discards mutations. */
  readonly recording: boolean;
  private readonly onEndCb: (span: ReadableSpan) => void;

  constructor(init: {
    name: string; kind: SpanKind; context: SpanContext; parentSpanId?: string;
    resource: Attributes; scope: string; attributes: Attributes; links: Link[];
    recording: boolean; onEnd: (span: ReadableSpan) => void;
  }) {
    this.name = init.name;
    this.kind = init.kind;
    this.context = init.context;
    this.parentSpanId = init.parentSpanId;
    this.resource = init.resource;
    this.scope = init.scope;
    this.links = init.links;
    this.attributes = { ...init.attributes };
    this.recording = init.recording;
    this.onEndCb = init.onEnd;
    this.startUnixNano = nowUnixNano();
  }

  spanContext(): SpanContext { return this.context; }
  isRecording(): boolean { return this.recording && this.endUnixNano === undefined; }

  setAttribute(key: string, value: AttributeValue): this {
    if (this.isRecording()) this.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: Attributes): this {
    if (this.isRecording()) this.attributes = { ...this.attributes, ...attrs };
    return this;
  }
  addEvent(name: string, attributes?: Attributes): this {
    if (this.isRecording()) this.events.push({ name, timeUnixNano: nowUnixNano(), ...(attributes ? { attributes } : {}) });
    return this;
  }
  setStatus(code: StatusCode, message?: string): this {
    if (this.isRecording()) this.status = { code, ...(message !== undefined ? { message } : {}) };
    return this;
  }
  recordException(err: unknown): this {
    const e = err as Error & { code?: string };
    if (this.isRecording()) {
      this.events.push({ name: 'exception', timeUnixNano: nowUnixNano(), attributes: {
        'exception.type': e?.name ?? 'Error',
        'exception.message': e?.message ?? String(err),
        ...(e?.stack ? { 'exception.stacktrace': e.stack } : {}),
      } });
      this.status = { code: 'error', message: e?.message ?? 'exception' };
    }
    return this;
  }

  end(): void {
    if (!this.recording || this.endUnixNano !== undefined) return;
    this.endUnixNano = nowUnixNano();
    this.onEndCb(this.snapshot());
  }

  private snapshot(): ReadableSpan {
    return {
      name: this.name,
      kind: this.kind,
      context: this.context,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      resource: this.resource,
      instrumentationScope: this.scope,
      startUnixNano: this.startUnixNano,
      endUnixNano: this.endUnixNano!,
      attributes: { ...this.attributes },
      events: [...this.events],
      links: [...this.links],
      status: { ...this.status },
    };
  }
}

// --- Samplers ----------------------------------------------------------------

export interface Sampler {
  shouldSample(parent: SpanContext | undefined, traceId: string, name: string, kind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult;
}

export class AlwaysOnSampler implements Sampler {
  shouldSample(): SamplingResult { return { decision: 'record_and_sample' }; }
}
export class AlwaysOffSampler implements Sampler {
  shouldSample(): SamplingResult { return { decision: 'not_record' }; }
}
/** Deterministic ratio sampler keyed on the trace id (first 52 bits -> [0,1)). */
export class TraceIdRatioBasedSampler implements Sampler {
  constructor(readonly ratio: number) {
    if (ratio < 0 || ratio > 1) throw new Error('tracing: ratio must be in [0,1]');
    this.ratio = ratio;
  }
  shouldSample(_parent: SpanContext | undefined, traceId: string, _name: string, _kind: SpanKind, _attributes: Attributes, _links: Link[]): SamplingResult {
    const prefix = traceId.slice(0, 13); // 52 bits fits in a JS number
    const value = parseInt(prefix, 16) / 2 ** 52;
    return { decision: value < this.ratio ? 'record_and_sample' : 'not_record' };
  }
}
/** Inherits the parent's sampled flag; at a root, delegates to the root sampler. */
export class ParentBasedSampler implements Sampler {
  constructor(readonly root: Sampler = new AlwaysOnSampler()) {}
  shouldSample(parent: SpanContext | undefined, traceId: string, name: string, kind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
    if (parent) return { decision: (parent.traceFlags & 0x01) === 0x01 ? 'record_and_sample' : 'not_record' };
    return this.root.shouldSample(parent, traceId, name, kind, attributes, links);
  }
}

// --- Span processors ---------------------------------------------------------

export interface SpanProcessor {
  onStart(span: Span): void;
  onEnd(span: ReadableSpan): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Exports each span synchronously as it ends. */
export class SimpleSpanProcessor implements SpanProcessor {
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly exporter: SpanExporterLike) {}
  onStart(): void { /* no-op */ }
  onEnd(span: ReadableSpan): void {
    if (this.stopped) return;
    this.pending = this.pending.then(() => this.exporter.export([span])).catch(() => undefined);
  }
  async forceFlush(): Promise<void> { await this.pending; }
  async shutdown(): Promise<void> { this.stopped = true; await this.forceFlush(); await this.exporter.shutdown?.(); }
}

/** Batches spans and flushes on a schedule or when the queue fills. */
export class BatchSpanProcessor implements SpanProcessor {
  private queue: ReadableSpan[] = [];
  private stopped = false;
  private flushing: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly exporter: SpanExporterLike,
    private readonly maxQueueSize = 512,
    private readonly maxExportBatchSize = 128,
    scheduledDelayMs = 5000,
  ) {
    this.timer = setInterval(() => { void this.flush(); }, scheduledDelayMs);
    this.timer.unref?.();
  }
  onStart(): void { /* no-op */ }
  onEnd(span: ReadableSpan): void {
    if (this.stopped) return;
    this.queue.push(span);
    if (this.queue.length >= this.maxQueueSize) void this.flush();
  }
  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      while (this.queue.length > 0 && !this.stopped) {
        const batch = this.queue.splice(0, this.maxExportBatchSize);
        try { await this.exporter.export(batch); } catch { /* best-effort */ }
      }
    });
    return this.flushing;
  }
  forceFlush(): Promise<void> { return this.flush(); }
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.exporter.shutdown?.();
  }
}

// Minimal exporter shape processors depend on.
export interface SpanExporterLike {
  export(spans: ReadableSpan[]): Promise<void>;
  shutdown?(): Promise<void>;
}

// --- Tracer + provider -------------------------------------------------------

export interface TracerProviderOptions {
  serviceName?: string;
  resource?: Attributes;
  sampler?: Sampler;
}

export class TracerProvider {
  readonly resource: Attributes;
  readonly sampler: Sampler;
  private processors: SpanProcessor[] = [];
  private tracers = new Map<string, Tracer>();
  constructor(opts: TracerProviderOptions = {}) {
    this.resource = { 'service.name': opts.serviceName ?? 'jataqi', 'service.version': '0.1.0', ...opts.resource };
    this.sampler = opts.sampler ?? new ParentBasedSampler(new AlwaysOnSampler());
  }
  addSpanProcessor(p: SpanProcessor): this { this.processors.push(p); return this; }
  getTracer(name: string, version = '0.1.0'): Tracer {
    const key = `${name}@${version}`;
    let t = this.tracers.get(key);
    if (!t) { t = new Tracer(this, name); this.tracers.set(key, t); }
    return t;
  }
  /** Internal: invoked by Tracer.startSpan. */
  onStart(span: Span): void { for (const p of this.processors) p.onStart(span); }
  onEnd(span: ReadableSpan): void { for (const p of this.processors) p.onEnd(span); }
  async shutdown(): Promise<void> { await Promise.all(this.processors.map((p) => p.shutdown())); }
  forceFlush(): Promise<void> { return Promise.all(this.processors.map((p) => p.forceFlush())).then(); }
}

export class Tracer {
  constructor(private readonly provider: TracerProvider, readonly name: string) {}
  private get resource(): Attributes { return this.provider.resource; }

  startSpan(name: string, options: SpanOptions = {}): Span {
    const kind = options.kind ?? 'internal';
    const parent = options.parent;
    const traceId = parent ? parent.traceId : randomTraceId();
    const spanId = randomSpanId();
    const result = this.provider.sampler.shouldSample(parent, traceId, name, kind, options.attributes ?? {}, options.links ?? []);
    const sampled = result.decision === 'record_and_sample';
    const traceFlags = sampled ? 0x01 : 0x00;
    const ctx: SpanContext = {
      traceId, spanId, traceFlags,
      ...(parent?.traceState ? { traceState: parent.traceState } : {}),
    };
    const attrs: Attributes = { ...options.attributes, ...result.attributes };
    const span = new Span({
      name, kind, context: ctx,
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      resource: this.resource, scope: this.name, attributes: attrs, links: options.links ?? [],
      recording: sampled,
      onEnd: (s) => this.provider.onEnd(s),
    });
    if (span.recording) this.provider.onStart(span);
    return span;
  }
}
