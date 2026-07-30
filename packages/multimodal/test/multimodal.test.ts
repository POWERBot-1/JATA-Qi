import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SecurityModule } from '@jataqi/security';
import { MultimodalModule } from '../src/index.js';
import type { MultimodalProvider } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

// A custom mock provider for image generation (text → image).
const mockImageGenProvider: MultimodalProvider = {
  id: 'mock-image-gen',
  capabilities: ['text.to_image'],
  inputModalities: ['text'],
  outputModalities: ['image'],
  costPerCall: 5,
  async process(req) {
    return {
      task: 'text.to_image',
      generatedMedia: { modality: 'image', data: `base64(mock_image_for_${req.prompt?.slice(0, 20)})`, mimeType: 'image/png' },
      confidence: 0.8, provider: 'mock-image-gen', durationMs: 0,
    };
  },
};

// A mock provider for audio classification.
const mockAudioProvider: MultimodalProvider = {
  id: 'mock-audio',
  capabilities: ['audio.classify', 'audio.embed'],
  inputModalities: ['audio'],
  outputModalities: ['text'],
  costPerCall: 1,
  async process(req) {
    if (req.task === 'audio.classify') {
      return { task: 'audio.classify', labels: [{ label: 'speech', confidence: 0.95 }, { label: 'music', confidence: 0.3 }], confidence: 0.95, provider: 'mock-audio', durationMs: 0 };
    }
    return { task: 'audio.embed', embedding: [0.1, 0.2, 0.3, 0.4], confidence: 0.9, provider: 'mock-audio', durationMs: 0 };
  },
};

describe('MultimodalModule', () => {
  let kernel: Kernel;
  let mm: MultimodalModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new SecurityModule());
    kernel.register(new MultimodalModule());
    await kernel.boot();
    mm = kernel.getModule<MultimodalModule>('multimodal');
  });

  // --- provider management --------------------------------------------------

  it('initializes with the built-in text provider', () => {
    const providers = mm.listProviders();
    assert.ok(providers.some((p) => p.id === 'builtin-text'));
    const tasks = mm.supportedTasks();
    assert.ok(tasks.includes('image.caption'));
    assert.ok(tasks.includes('cross_modal.reason'));
  });

  it('registers and unregisters custom providers', () => {
    mm.registerProvider(mockImageGenProvider);
    assert.ok(mm.listProviders().some((p) => p.id === 'mock-image-gen'));
    assert.ok(mm.supportedTasks().includes('text.to_image'));
    assert.equal(mm.unregisterProvider('mock-image-gen'), true);
    assert.ok(!mm.listProviders().some((p) => p.id === 'mock-image-gen'));
  });

  it('filters providers by task and input modalities', () => {
    mm.registerProvider(mockAudioProvider);
    const audioProviders = mm.providersForTask('audio.classify', ['audio']);
    assert.equal(audioProviders.length, 1);
    assert.equal(audioProviders[0]!.id, 'mock-audio');
    // No provider for video generation.
    assert.equal(mm.providersForTask('text.to_video').length, 0);
  });

  // --- task processing (built-in provider) ----------------------------------

  it('captions an image using the built-in provider', async () => {
    const caption = await mm.captionImage('base64encodedimagedata');
    assert.ok(caption.length > 0);
    assert.match(caption, /Image input received/);
  });

  it('classifies an image into labels', async () => {
    const labels = await mm.classifyImage('someimagedata');
    assert.ok(labels.length >= 1);
    assert.ok(labels[0]!.confidence > 0);
  });

  it('performs OCR on an image', async () => {
    const text = await mm.ocr('Hello World text in image');
    assert.match(text, /Hello World/);
  });

  it('transcribes audio', async () => {
    const text = await mm.transcribe('The quick brown fox jumps');
    assert.match(text, /quick brown fox/);
  });

  it('describes video content', async () => {
    const result = await mm.process({
      task: 'video.describe',
      inputs: [{ modality: 'video', data: 'base64videodata' }],
    });
    assert.ok(result.text!.includes('Video'));
  });

  it('extracts structured data from documents', async () => {
    const result = await mm.process({
      task: 'document.extract',
      inputs: [{ modality: 'document', data: 'Invoice #12345 Total: $500' }],
      options: { type: 'invoice' },
    });
    const structured = JSON.parse(result.text!);
    assert.equal(structured.type, 'invoice');
  });

  it('performs cross-modal reasoning (image + text)', async () => {
    const answer = await mm.reason(
      [
        { modality: 'image', data: 'base64image' },
        { modality: 'text', data: 'What is in this image?' },
      ],
      'Describe the scene',
    );
    assert.match(answer, /Multimodal reasoning/);
    assert.match(answer, /image.*text/);
  });

  // --- custom providers -----------------------------------------------------

  it('routes text-to-image generation to the registered provider', async () => {
    mm.registerProvider(mockImageGenProvider);
    const result = await mm.process({
      task: 'text.to_image',
      inputs: [{ modality: 'text', data: 'A cat sitting on a mat' }],
      prompt: 'A cat sitting on a mat in the style of Van Gogh',
    });
    assert.ok(result.generatedMedia);
    assert.equal(result.generatedMedia!.modality, 'image');
    assert.match(result.generatedMedia!.data, /mock_image_for_A cat sitting on a/);
  });

  it('routes audio classification to the specialized provider', async () => {
    mm.registerProvider(mockAudioProvider);
    const result = await mm.process({
      task: 'audio.classify',
      inputs: [{ modality: 'audio', data: 'base64audio' }],
    });
    assert.equal(result.provider, 'mock-audio');
    assert.ok(result.labels!.some((l) => l.label === 'speech'));
  });

  it('produces audio embeddings', async () => {
    mm.registerProvider(mockAudioProvider);
    const result = await mm.process({
      task: 'audio.embed',
      inputs: [{ modality: 'audio', data: 'base64audio' }],
    });
    assert.ok(result.embedding!.length > 0);
  });

  // --- caching & storage ----------------------------------------------------

  it('stores results and supports caching by input hash', async () => {
    await mm.captionImage('unique-image-data');
    const results = await mm.listResults();
    assert.ok(results.length >= 1);

    // Cached lookup.
    const cached = await mm.getCached('image.caption', [{ modality: 'image', data: 'unique-image-data' }]);
    assert.ok(cached);
    assert.match(cached.text!, /Image input received/);
  });

  it('filters stored results by task type', async () => {
    await mm.captionImage('img1');
    await mm.transcribe('audio1');
    const captions = await mm.listResults('image.caption');
    assert.ok(captions.every((r) => r.task === 'image.caption'));
  });

  // --- error handling -------------------------------------------------------

  it('throws when no provider supports the task', async () => {
    await assert.rejects(
      () => mm.process({ task: 'hologram.generate', inputs: [{ modality: 'text', data: 'x' }] }),
      /no provider registered/,
    );
  });

  // --- events & audit -------------------------------------------------------

  it('emits lifecycle events', async () => {
    let processed = 0; let failed = 0;
    kernel.bus.on('multimodal.task.processed', () => { processed++; });
    kernel.bus.on('multimodal.task.failed', () => { failed++; });
    await mm.captionImage('test');
    try { await mm.process({ task: 'unsupported.task', inputs: [] }); } catch {}
    assert.ok(processed >= 1);
    assert.ok(failed >= 1);
  });

  it('records audit entries for processed tasks', async () => {
    const sec = kernel.getModule<SecurityModule>('security');
    await mm.captionImage('audit-test', undefined);
    const audit = await sec.getAuditLog().query({ action: 'multimodal.task_processed' });
    assert.ok(audit.length >= 1);
  });
});
