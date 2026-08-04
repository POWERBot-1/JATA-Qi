// W3C Trace Context propagation (https://www.w3.org/TR/trace-context/).
// Parses/injects the `traceparent` and `tracestate` headers on a carrier
// (e.g. HTTP headers), so JATA Qi traces correlate across services.

import type { SpanContext } from './types.js';

const TRACEPARENT = 'traceparent';
const TRACESTATE = 'tracestate';
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A string-keyed carrier (HTTP headers are lower-cased by Node). */
export type Carrier = Record<string, string | string[] | undefined>;

function header(carrier: Carrier, name: string): string | undefined {
  for (const k of Object.keys(carrier)) {
    if (k.toLowerCase() === name) {
      const v = carrier[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/** Parse a `traceparent` header value into a SpanContext, or undefined if invalid. */
export function parseTraceparent(value: string | undefined): SpanContext | undefined {
  if (!value) return undefined;
  const m = value.trim().toLowerCase().match(TRACEPARENT_RE);
  if (!m) return undefined;
  const version = m[1]!;
  const traceId = m[2]!;
  const spanId = m[3]!;
  const flags = m[4]!;
  if (version === 'ff') return undefined; // forbidden version
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return undefined;
  return { traceId, spanId, traceFlags: parseInt(flags, 16) & 0x01 };
}

/** Format a SpanContext as a `traceparent` header value. */
export function formatTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${(ctx.traceFlags & 0x01).toString(16).padStart(2, '0')}`;
}

/** Extract a SpanContext (traceparent + tracestate) from a carrier. */
export function extract(carrier: Carrier): SpanContext | undefined {
  const ctx = parseTraceparent(header(carrier, TRACEPARENT));
  if (!ctx) return undefined;
  const state = header(carrier, TRACESTATE);
  return state ? { ...ctx, traceState: state } : ctx;
}

/** Inject a SpanContext into a carrier (sets traceparent + tracestate headers). */
export function inject(ctx: SpanContext, carrier: Carrier): Carrier {
  carrier[TRACEPARENT] = formatTraceparent(ctx);
  if (ctx.traceState) carrier[TRACESTATE] = ctx.traceState;
  return carrier;
}
