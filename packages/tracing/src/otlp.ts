// Convert ReadableSpans to OTLP/HTTP JSON (ExportTraceServiceRequest) and provide
// span exporters: in-memory (tests), console, and OTLP/HTTP (POST to a collector).
// https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding

import type { Attributes, AttributeValue, ReadableSpan } from './types.js';
import { OTLP_SPAN_KIND, OTLP_STATUS_CODE } from './types.js';

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

function anyValue(v: AttributeValue): AnyValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

function toKvList(attrs: Attributes | undefined): { key: string; value: AnyValue }[] {
  if (!attrs) return [];
  return Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) }));
}

/** Build the OTLP/HTTP JSON body for a batch of spans. */
export function toOTLP(spans: ReadableSpan[]): Record<string, unknown> {
  // Group by resource + scope so the export is well-formed.
  const groups = new Map<string, { resource: Attributes; scope: string; spans: ReadableSpan[] }>();
  for (const span of spans) {
    const resourceKey = JSON.stringify(span.resource) + '|' + span.instrumentationScope;
    let g = groups.get(resourceKey);
    if (!g) { g = { resource: span.resource, scope: span.instrumentationScope, spans: [] }; groups.set(resourceKey, g); }
    g.spans.push(span);
  }
  const resourceSpans = [...groups.values()].map((g) => ({
    resource: { attributes: toKvList(g.resource) },
    scopeSpans: [{
      scope: { name: g.scope },
      spans: g.spans.map((s) => ({
        traceId: s.context.traceId,
        spanId: s.context.spanId,
        ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
        name: s.name,
        kind: OTLP_SPAN_KIND[s.kind],
        startTimeUnixNano: s.startUnixNano,
        endTimeUnixNano: s.endUnixNano,
        attributes: toKvList(s.attributes),
        events: s.events.map((e) => ({
          name: e.name,
          timeUnixNano: e.timeUnixNano,
          ...(e.attributes ? { attributes: toKvList(e.attributes) } : {}),
        })),
        ...(s.links.length ? { links: s.links.map((l) => ({ traceId: l.context.traceId, spanId: l.context.spanId, ...(l.attributes ? { attributes: toKvList(l.attributes) } : {}) })) } : {}),
        status: { code: OTLP_STATUS_CODE[s.status.code], ...(s.status.message ? { message: s.status.message } : {}) },
        ...(s.context.traceFlags & 0x01 ? { flags: 1 } : {}),
      })),
    }],
  }));
  return { resourceSpans };
}
