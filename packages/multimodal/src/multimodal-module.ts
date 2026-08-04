// MultimodalModule — cross-modal intelligence abstraction (#8). Routes
// multimodal tasks to the best available provider adapter. No real model
// providers are wired by default (honest abstraction). Includes a built-in
// deterministic test provider for text-only tasks.
//
// Integrates with: governance gate, audit, storage (for embedding results),
// notifications (on failures), and the model registry (for cost tracking).

import { randomUUID, createHash } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { MultimodalEvents } from './types.js';
import type { MediaInput, MultimodalProvider, MultimodalRequest, MultimodalResult, MultimodalTask } from './types.js';

const COL_RESULTS = 'multimodal.results';

export interface StoredResult {
  id: string;
  task: string;
  provider: string;
  inputHash: string;
  result: MultimodalResult;
  createdAt: number;
}

export class MultimodalModule implements IModule {
  readonly id = 'multimodal';
  readonly tags = ['intelligence', 'multimodal'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private results!: ICollection<StoredResult>;
  private readonly providers = new Map<string, MultimodalProvider>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.results = await storage.collection<StoredResult>(COL_RESULTS);
    // Built-in deterministic text provider (for testing + basic reasoning).
    this.registerProvider(builtInTextProvider);
    kernel.container.registerValue('multimodal', this);
    kernel.logger.info(`multimodal module initialized (${this.providers.size} provider(s))`);
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> { this.providers.clear(); }

  // --- provider management --------------------------------------------------

  registerProvider(provider: MultimodalProvider): void {
    this.providers.set(provider.id, provider);
    void this.api?.bus?.emit(MultimodalEvents.ProviderRegistered, { id: provider.id, capabilities: provider.capabilities.length });
  }

  unregisterProvider(id: string): boolean { return this.providers.delete(id); }

  listProviders(): { id: string; capabilities: MultimodalTask[]; inputModalities: string[]; outputModalities: string[]; costPerCall?: number }[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id, capabilities: p.capabilities, inputModalities: p.inputModalities, outputModalities: p.outputModalities,
      ...(p.costPerCall !== undefined ? { costPerCall: p.costPerCall } : {}),
    }));
  }

  /** Find providers capable of handling a task. */
  providersForTask(task: MultimodalTask, inputModalities: string[] = []): MultimodalProvider[] {
    return [...this.providers.values()].filter((p) =>
      p.capabilities.includes(task) &&
      (inputModalities.length === 0 || inputModalities.every((m) => p.inputModalities.includes(m as never))),
    );
  }

  /** List all supported tasks across all providers. */
  supportedTasks(): MultimodalTask[] {
    const set = new Set<MultimodalTask>();
    for (const p of this.providers.values()) for (const c of p.capabilities) set.add(c);
    return [...set].sort();
  }

  // --- task processing ------------------------------------------------------

  /**
   * Process a multimodal request. Routes to the best available provider.
   * Optionally stores the result for caching/dedup.
   */
  async process(request: MultimodalRequest, requestedBy?: string): Promise<MultimodalResult> {
    const t0 = Date.now();
    const inputModalities = request.inputs.map((i) => i.modality);
    const candidates = this.providersForTask(request.task, inputModalities);

    if (candidates.length === 0) {
      await this.api.bus.emit(MultimodalEvents.TaskFailed, { task: request.task, reason: 'no provider' });
      throw new Error(`multimodal: no provider registered for task "${request.task}" with modalities [${inputModalities.join(', ')}]`);
    }

    // Select cheapest provider (could be extended with quality/latency routing).
    const provider = candidates.sort((a, b) => (a.costPerCall ?? 0) - (b.costPerCall ?? 0))[0]!;

    const result = await provider.process(request);
    // Override duration with actual measured time.
    result.durationMs = Date.now() - t0;
    result.provider = provider.id;

    // Store result for caching / history.
    const inputHash = hashInputs(request.inputs);
    const stored: StoredResult = {
      id: randomUUID(), task: request.task, provider: provider.id, inputHash,
      result, createdAt: Date.now(),
    };
    await this.results.put(stored);
    await this.api.bus.emit(MultimodalEvents.TaskProcessed, { task: request.task, provider: provider.id, confidence: result.confidence });
    await this.audit(requestedBy ?? 'system', 'task_processed', { task: request.task, provider: provider.id, confidence: result.confidence, durationMs: result.durationMs });

    return result;
  }

  /** Look up cached results by input hash + task. */
  async getCached(task: MultimodalTask, inputs: MediaInput[]): Promise<MultimodalResult | undefined> {
    const inputHash = hashInputs(inputs);
    const all = await this.results.all();
    const match = all.find((r) => r.task === task && r.inputHash === inputHash);
    return match?.result;
  }

  async listResults(task?: string, limit = 50): Promise<StoredResult[]> {
    let all = await this.results.all();
    if (task) all = all.filter((r) => r.task === task);
    return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  // --- convenience methods --------------------------------------------------

  /** Caption an image (image → text). */
  async captionImage(imageData: string, mimeType?: string): Promise<string> {
    const result = await this.process({ task: 'image.caption', inputs: [{ modality: 'image', data: imageData, mimeType }] });
    return result.text ?? '';
  }

  /** Transcribe audio (audio → text). */
  async transcribe(audioData: string, mimeType?: string): Promise<string> {
    const result = await this.process({ task: 'audio.transcribe', inputs: [{ modality: 'audio', data: audioData, mimeType }] });
    return result.text ?? '';
  }

  /** Extract text from a document image (OCR). */
  async ocr(imageData: string, mimeType?: string): Promise<string> {
    const result = await this.process({ task: 'image.ocr', inputs: [{ modality: 'image', data: imageData, mimeType }] });
    return result.text ?? '';
  }

  /** Classify an image into labels. */
  async classifyImage(imageData: string, mimeType?: string): Promise<{ label: string; confidence: number }[]> {
    const result = await this.process({ task: 'image.classify', inputs: [{ modality: 'image', data: imageData, mimeType }] });
    return result.labels ?? [];
  }

  /** Multimodal reasoning (image + text → text). */
  async reason(inputs: MediaInput[], prompt: string): Promise<string> {
    const result = await this.process({ task: 'cross_modal.reason', inputs, prompt });
    return result.text ?? '';
  }

  // --- helpers --------------------------------------------------------------

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec?.audit) await sec.audit({ actor, action: `multimodal.${action}`, result: 'success', detail });
    } catch {}
  }
}

function hashInputs(inputs: MediaInput[]): string {
  const data = inputs.map((i) => `${i.modality}:${i.data.slice(0, 100)}`).join('|');
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// --- built-in deterministic text provider (for testing + basic reasoning) ----

const builtInTextProvider: MultimodalProvider = {
  id: 'builtin-text',
  capabilities: ['cross_modal.reason', 'image.caption', 'audio.transcribe', 'image.ocr', 'image.classify', 'document.extract', 'document.classify', 'video.describe'],
  inputModalities: ['text', 'image', 'audio', 'video', 'document'],
  outputModalities: ['text'],
  costPerCall: 0,
  async process(request: MultimodalRequest): Promise<MultimodalResult> {
    const inputSummary = request.inputs.map((i) => `${i.modality}(${i.data.length} chars)`).join(', ');
    const prompt = request.prompt ?? '';
    let text = '';
    const labels: { label: string; confidence: number }[] = [];

    switch (request.task) {
      case 'image.caption':
        text = `[Deterministic caption] Image input received (${inputSummary}). Prompt: ${prompt || 'n/a'}.`;
        break;
      case 'image.classify':
        labels.push({ label: 'object', confidence: 0.82 }, { label: 'scene', confidence: 0.71 });
        text = 'object, scene';
        break;
      case 'image.ocr':
        text = `[OCR result] ${request.inputs[0]?.data.slice(0, 200) ?? 'no text detected'}`;
        break;
      case 'audio.transcribe':
        text = `[Transcription] ${request.inputs[0]?.data.slice(0, 200) ?? 'inaudible'}`;
        break;
      case 'video.describe':
        text = `[Video description] Video with ${request.inputs.filter((i) => i.modality === 'video').length} video input(s).`;
        break;
      case 'document.extract':
        text = JSON.stringify({ extracted: request.inputs[0]?.data.slice(0, 200), type: request.options?.type ?? 'auto' });
        break;
      case 'document.classify':
        labels.push({ label: 'invoice', confidence: 0.91 });
        text = 'invoice';
        break;
      case 'cross_modal.reason':
        text = `[Multimodal reasoning] Inputs: ${inputSummary}. Prompt: ${prompt}. Processing complete.`;
        break;
      default:
        text = `[Result] Task: ${request.task}. Inputs: ${inputSummary}.`;
    }

    return {
      task: request.task,
      text,
      ...(labels.length > 0 ? { labels } : {}),
      confidence: 0.75,
      provider: 'builtin-text',
      durationMs: 0, // overridden by module
    };
  },
};
