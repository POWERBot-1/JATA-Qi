// TracingModule — the kernel module that owns a TracerProvider, configures
// samplers/exporters from config, and exposes a tracer to the rest of the
// platform (the gateway uses it to trace HTTP requests; outbound clients can
// propagate the W3C trace context).

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { AlwaysOffSampler, AlwaysOnSampler, BatchSpanProcessor, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, TracerProvider, type Sampler, type SpanProcessor } from './tracer.js';
import { ConsoleSpanExporter, InMemorySpanExporter, OTLPHTTPExporter, type SpanExporter } from './exporters.js';
import type { Tracer } from './tracer.js';

export type ExporterKind = 'none' | 'memory' | 'console' | 'otlp';
export type SamplerKind = 'always_on' | 'always_off' | 'traceidratio' | 'parentbased_always_on';

export interface TracingModuleConfig {
  serviceName?: string;
  /** OTLP/HTTP collector endpoint (required when exporter is 'otlp'). */
  otlpEndpoint?: string;
  /** Extra OTLP headers (e.g. Authorization). */
  otlpHeaders?: Record<string, string>;
  exporter?: ExporterKind;
  sampler?: SamplerKind;
  /** Sampling ratio for 'traceidratio' (0..1). */
  ratio?: number;
  /** Use a batch processor (default true) vs simple (export on each end). */
  batch?: boolean;
  /** Keep the in-memory exporter reachable for tests/introspection even when another exporter is configured. */
  exposeInMemory?: boolean;
}

export class TracingModule implements IModule {
  readonly id = 'tracing';
  readonly tags = ['core', 'observability'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly provider: TracerProvider;
  private readonly inMemory = new InMemorySpanExporter();

  constructor(cfg: TracingModuleConfig = {}) {
    this.provider = new TracerProvider({
      serviceName: cfg.serviceName,
      sampler: TracingModule.buildSampler(cfg),
    });
    const exporters = TracingModule.buildExporters(cfg, this.inMemory);
    const processors: SpanProcessor[] = [];
    for (const ex of exporters) processors.push(cfg.batch === false ? new SimpleSpanProcessor(ex) : new BatchSpanProcessor(ex));
    if (processors.length === 0 && cfg.exposeInMemory) processors.push(new SimpleSpanProcessor(this.inMemory));
    for (const p of processors) this.provider.addSpanProcessor(p);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('tracing', this);
    kernel.container.registerValue('tracing.provider', this.provider);
    kernel.logger.info('tracing module initialized (OpenTelemetry-compatible)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* exporters flush on schedule */ }
  async stop(_kernel: KernelApi): Promise<void> { await this.provider.shutdown(); }

  /** The platform-wide tracer (the gateway + outbound clients use this). */
  getTracer(name = 'jataqi'): Tracer { return this.provider.getTracer(name); }

  /** Spans captured by the in-memory exporter (tests / introspection). */
  getFinishedSpans(): ReadableSpanLike[] { return this.inMemory.spans; }

  private static buildSampler(cfg: TracingModuleConfig): Sampler {
    switch (cfg.sampler ?? 'parentbased_always_on') {
      case 'always_on': return new AlwaysOnSampler();
      case 'always_off': return new AlwaysOffSampler();
      case 'traceidratio': return new TraceIdRatioBasedSampler(cfg.ratio ?? 1);
      case 'parentbased_always_on':
      default: return new ParentBasedSampler(new TraceOnRoot(cfg.ratio ?? 1));
    }
  }

  private static buildExporters(cfg: TracingModuleConfig, inMemory: InMemorySpanExporter): SpanExporter[] {
    const out: SpanExporter[] = [];
    if (cfg.exposeInMemory || cfg.exporter === 'memory') out.push(inMemory);
    if (cfg.exporter === 'console') out.push(new ConsoleSpanExporter());
    if (cfg.exporter === 'otlp' && cfg.otlpEndpoint) out.push(new OTLPHTTPExporter({ endpoint: cfg.otlpEndpoint, headers: cfg.otlpHeaders }));
    return out;
  }
}

type ReadableSpanLike = import('./types.js').ReadableSpan;

/** ParentBased whose root is ratio-based (the OTel default). */
class TraceOnRoot extends ParentBasedSampler {
  constructor(ratio: number) { super(ratio >= 1 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(ratio)); }
}
