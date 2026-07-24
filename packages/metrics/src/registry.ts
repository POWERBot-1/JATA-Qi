// Metrics registry — owns a process-wide set of named instruments and renders
// them to a Prometheus-compatible text exposition.

import type { MetricDescriptor, MetricSample } from './types.js';
import { Counter, Gauge, Histogram } from './instruments.js';

export class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  counter(name: string, help?: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter({ name, help });
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, help?: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge({ name, help });
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, help?: string, buckets?: readonly number[]): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram({ name, help, buckets });
      this.histograms.set(name, h);
    }
    return h;
  }

  has(name: string): boolean {
    return this.counters.has(name) || this.gauges.has(name) || this.histograms.has(name);
  }

  /** Every sample across every instrument. */
  samples(): MetricSample[] {
    const out: MetricSample[] = [];
    for (const c of this.counters.values()) out.push(...c.samples());
    for (const g of this.gauges.values()) out.push(...g.samples());
    for (const h of this.histograms.values()) out.push(...h.samples());
    return out;
  }

  /** Prometheus text exposition (content-type: text/plain; version=0.0.4). */
  format(): string {
    const lines: string[] = [];
    for (const c of this.counters.values()) {
      if (c.help) lines.push(`# HELP ${c.name} ${c.help}`);
      lines.push(`# TYPE ${c.name} counter`);
      for (const s of c.samples()) lines.push(`${c.name}${labelStr(s.labels)} ${s.value}`);
      if (c.samples().length === 0) lines.push(`${c.name} 0`);
    }
    for (const g of this.gauges.values()) {
      if (g.help) lines.push(`# HELP ${g.name} ${g.help}`);
      lines.push(`# TYPE ${g.name} gauge`);
      for (const s of g.samples()) lines.push(`${g.name}${labelStr(s.labels)} ${s.value}`);
      if (g.samples().length === 0) lines.push(`${g.name} 0`);
    }
    for (const h of this.histograms.values()) {
      if (h.help) lines.push(`# HELP ${h.name} ${h.help}`);
      lines.push(`# TYPE ${h.name} histogram`);
      for (const s of h.samples()) {
        const snap = s.histogram!;
        for (const b of snap.buckets) {
          lines.push(`${h.name}_bucket{le="${b.le}"${labelStr(s.labels, ',')}} ${b.count}`);
        }
        lines.push(`${h.name}_bucket{le="+Inf"${labelStr(s.labels, ',')}} ${snap.count}`);
        lines.push(`${h.name}_sum${labelStr(s.labels)} ${snap.sum}`);
        lines.push(`${h.name}_count${labelStr(s.labels)} ${snap.count}`);
      }
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }
}

function labelStr(labels: Record<string, string>, lead = ''): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}="${labels[k]}"`);
  return `{${lead}${parts.join(',')}}`.replace('{,', '{');
}
