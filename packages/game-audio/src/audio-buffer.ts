// AudioBuffer — multi-channel Float32 sample storage with mix, gain, and
// constant-power stereo panning. The unit of music tracks, SFX, and the master
// mix.

import { clamp1 } from './dsp.js';

export class AudioBuffer {
  /** One Float32Array per channel (mono=1, stereo=2). */
  readonly channels: Float32Array[];
  readonly sampleRate: number;

  constructor(channels: Float32Array[], sampleRate = 44100) {
    if (channels.length < 1) throw new Error('audio buffer needs >= 1 channel');
    this.channels = channels;
    this.sampleRate = sampleRate;
  }

  get channelCount(): number { return this.channels.length; }
  get length(): number { return this.channels[0]!.length; }
  get duration(): number { return this.length / this.sampleRate; }

  /** An empty buffer of `seconds` duration. */
  static silence(seconds: number, sampleRate = 44100, channels = 2): AudioBuffer {
    const n = Math.max(0, Math.floor(seconds * sampleRate));
    return new AudioBuffer(Array.from({ length: channels }, () => new Float32Array(n)), sampleRate);
  }

  /** Mix another buffer in at an optional gain (clips to length). */
  mix(other: AudioBuffer, gain = 1): this {
    const n = Math.min(this.length, other.length);
    const ch = Math.min(this.channelCount, other.channelCount);
    for (let c = 0; c < ch; c++) {
      const dst = this.channels[c]!;
      const src = other.channels[c % other.channelCount]!;
      for (let i = 0; i < n; i++) dst[i] = clamp1((dst[i] ?? 0) + (src[i] ?? 0) * gain);
    }
    return this;
  }

  /** Apply a uniform gain. */
  applyGain(gain: number): this {
    for (const ch of this.channels) for (let i = 0; i < ch.length; i++) ch[i] = clamp1((ch[i] ?? 0) * gain);
    return this;
  }

  /** Constant-power stereo pan (-1 left .. +1 right). No-op on mono. */
  pan(pan: number): this {
    if (this.channelCount < 2) return this;
    const p = clamp1(pan) * 0.5 + 0.5; // 0..1
    const lGain = Math.cos(p * Math.PI * 0.5);
    const rGain = Math.sin(p * Math.PI * 0.5);
    const left = this.channels[0]!;
    const right = this.channels[1]!;
    const origL = left.slice();
    const origR = right.slice();
    for (let i = 0; i < left.length; i++) {
      left[i] = clamp1(origL[i]! * lGain + origR[i]! * 0);
      right[i] = clamp1(origR[i]! * rGain + origL[i]! * 0);
    }
    return this;
  }

  /** Peak amplitude across all channels (0..1). */
  peak(): number {
    let peak = 0;
    for (const ch of this.channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i] ?? 0));
    return peak;
  }

  /** Normalize so the peak reaches `target` (0..1). */
  normalize(target = 0.99): this {
    const p = this.peak();
    if (p <= 0) return this;
    const g = target / p;
    return this.applyGain(g);
  }
}
