// JATA Qi Multimodal — types (#8). Cross-modal intelligence abstraction.
// Supports text, image, audio, video, document, and sensor modalities with
// adapter-based routing (no real model providers wired by default).

export type Modality = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sensor';

export type MultimodalTask =
  | 'image.caption'         // image → text
  | 'image.classify'        // image → labels
  | 'image.detect'          // image → bounding boxes
  | 'image.ocr'             // image → text (OCR)
  | 'image.embed'           // image → vector
  | 'text.to_image'         // text → image (generation)
  | 'image.edit'            // image + prompt → image
  | 'audio.transcribe'      // audio → text (STT)
  | 'audio.classify'        // audio → labels (sound classification)
  | 'text.to_speech'        // text → audio (TTS)
  | 'audio.embed'           // audio → vector
  | 'video.describe'        // video → text
  | 'video.detect'          // video → temporal detections
  | 'document.extract'      // document → structured data
  | 'document.classify'     // document → category
  | 'cross_modal.reason'    // multi-input → text (multimodal reasoning)
  | string;

export interface MediaInput {
  modality: Modality;
  /** Raw content (base64 for binary, text for text). */
  data: string;
  mimeType?: string;
  /** Optional pre-computed hash for dedup. */
  hash?: string;
}

export interface MultimodalRequest {
  task: MultimodalTask;
  inputs: MediaInput[];
  prompt?: string;
  options?: Record<string, unknown>;
  organizationId?: string;
}

export interface Detection {
  label: string;
  confidence: number;
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface MultimodalResult {
  task: MultimodalTask;
  text?: string;             // text output (caption, transcription, reasoning)
  labels?: { label: string; confidence: number }[];
  detections?: Detection[];
  embedding?: number[];
  generatedMedia?: { modality: Modality; data: string; mimeType?: string };
  structured?: Record<string, unknown>;
  confidence: number;        // overall result confidence 0..1
  provider: string;
  durationMs: number;
}

export interface MultimodalProvider {
  readonly id: string;
  readonly capabilities: MultimodalTask[];
  readonly inputModalities: Modality[];
  readonly outputModalities: Modality[];
  readonly costPerCall?: number;
  process(request: MultimodalRequest): Promise<MultimodalResult>;
  healthCheck?(): Promise<boolean>;
}

export const MultimodalEvents = Object.freeze({
  TaskProcessed: 'multimodal.task.processed',
  TaskFailed: 'multimodal.task.failed',
  ProviderRegistered: 'multimodal.provider.registered',
} as const);
