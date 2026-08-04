// AudioEngine — adaptive music layers (§12 "dynamic adaptive music") + a master
// bus. Music is split into layers (e.g. calm / intense); an intensity value
// (driven by gameplay) crossfades them. One-shot SFX are mixed onto the same
// bus. The final master is normalized to prevent clipping.

import { crossfade } from './dsp.js';
import { AudioBuffer } from './audio-buffer.js';

export interface AdaptiveLayer {
  name: string;
  buffer: AudioBuffer;
  /** Maps intensity (0..1) to this layer's gain (0..1). */
  curve: (intensity: number) => number;
}

export const LAYER_CURVES = {
  /** Fades out as intensity rises (the "calm" bed). */
  calm: (i: number) => 1 - i,
  /** Fades in as intensity rises (the "action" bed). */
  intense: (i: number) => i,
  /** Always on (the rhythmic backbone). */
  constant: () => 1,
  /** Bell curve peaking at mid intensity. */
  tension: (i: number) => 1 - Math.abs(i - 0.5) * 2,
};

/** A scheduled one-shot SFX on the master bus. */
export interface OneShot { buffer: AudioBuffer; atSeconds: number; gain?: number }

export class AudioEngine {
  private layers: AdaptiveLayer[] = [];
  private oneShots: OneShot[] = [];
  private _intensity = 0;
  masterGain = 0.9;

  addLayer(layer: AdaptiveLayer): this { this.layers.push(layer); return this; }
  get intensity(): number { return this._intensity; }
  setIntensity(i: number): void { this._intensity = i < 0 ? 0 : i > 1 ? 1 : i; }

  /** Schedule a one-shot SFX at an absolute time. */
  play(oneShot: OneShot): this { this.oneShots.push(oneShot); return this; }

  /** Render the master mix at the current intensity. */
  render(sampleRate = 44100): AudioBuffer {
    // Determine total length (longest layer or any one-shot beyond it).
    let maxLen = 0;
    for (const l of this.layers) maxLen = Math.max(maxLen, l.buffer.length);
    for (const s of this.oneShots) maxLen = Math.max(maxLen, Math.floor(s.atSeconds * sampleRate) + s.buffer.length);
    const master = AudioBuffer.silence((maxLen || 1) / sampleRate, sampleRate, 2);

    // Adaptive music layers.
    for (const layer of this.layers) {
      const g = layer.curve(this._intensity) * this.masterGain;
      if (g <= 0) continue;
      this.mixAt(master, layer.buffer, 0, g);
    }
    // One-shot SFX.
    for (const s of this.oneShots) {
      this.mixAt(master, s.buffer, Math.floor(s.atSeconds * sampleRate), (s.gain ?? 1) * this.masterGain);
    }
    return master.normalize(0.98);
  }

  private mixAt(master: AudioBuffer, src: AudioBuffer, startSample: number, gain: number): void {
    for (let c = 0; c < master.channelCount; c++) {
      const dst = master.channels[c]!;
      const s = src.channels[c % src.channelCount]!;
      for (let i = 0; i < s.length; i++) {
        const idx = startSample + i;
        if (idx < dst.length) dst[idx] = (dst[idx] ?? 0) + (s[i] ?? 0) * gain;
      }
    }
  }
}

export { crossfade };
