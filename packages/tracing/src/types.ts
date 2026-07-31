// JATA Qi Tracing — OpenTelemetry-compatible distributed tracing types.
// Zero external dependencies; mirrors OTel semantics (SpanContext, spans,
// sampling, exporters) so JATA Qi participates in W3C distributed traces.

/** A scalar attribute value (OTel also allows arrays; scalars cover our needs). */
export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

/** W3C trace-context identifier (https://www.w3.org/TR/trace-context/). */
export interface SpanContext {
  /** 32 lower-hex characters. */
  readonly traceId: string;
  /** 16 lower-hex characters. */
  readonly spanId: string;
  /** Bit flags; bit 0 = sampled. */
  readonly traceFlags: number;
  /** Optional tracestate header value (vendor-specific). */
  readonly traceState?: string;
}

/** true when this span context's trace is sampled (flag bit 0 set). */
export function isSampled(ctx: SpanContext): boolean {
  return (ctx.traceFlags & 0x01) === 0x01;
}

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type StatusCode = 'unset' | 'ok' | 'error';

export interface SpanStatus {
  code: StatusCode;
  message?: string;
}

export interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes?: Attributes;
}

export interface Link {
  context: SpanContext;
  attributes?: Attributes;
}

/** An immutable, ended snapshot of a span handed to exporters. */
export interface ReadableSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parentSpanId?: string;
  readonly resource: Attributes;
  readonly instrumentationScope: string;
  readonly startUnixNano: string;
  readonly endUnixNano: string;
  readonly attributes: Attributes;
  readonly events: SpanEvent[];
  readonly links: Link[];
  readonly status: SpanStatus;
}

export type SamplingDecision = 'record_and_sample' | 'not_record';

export interface SamplingResult {
  decision: SamplingDecision;
  attributes?: Attributes;
}

/** OTel span-kind numeric codes (OTLP): internal=1, server=2, client=3, producer=4, consumer=5. */
export const OTLP_SPAN_KIND: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

/** OTel status numeric codes (OTLP). */
export const OTLP_STATUS_CODE: Record<StatusCode, number> = { unset: 0, ok: 1, error: 2 };
