// Procedural sound effects — synthesized entirely in code (§12 "sound
// effects"). Each generator returns an AudioBuffer; all are deterministic.

import { SAMPLE_RATE, softClip } from './dsp.js';
import { AudioBuffer } from './audio-buffer.js';

function mono(seconds: number, fn: (t: number, i: number) => number, sampleRate = SAMPLE_RATE): AudioBuffer {
  const n = Math.max(1, Math.floor(seconds * sampleRate));
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = softClip(fn(i / sampleRate, i));
  return new AudioBuffer([data], sampleRate);
}

/** An explosion: noise burst with exponential decay + low rumble. */
export function sfxExplosion(seconds = 1.0, sampleRate = SAMPLE_RATE): AudioBuffer {
  return mono(seconds, (t) => {
    const noise = Math.random() * 2 - 1;
    const rumble = Math.sin(2 * Math.PI * 60 * t);
    const decay = Math.exp(-t * 4);
    return (noise * 0.7 + rumble * 0.5) * decay;
  }, sampleRate);
}

/** A laser/weapon shot: a descending frequency sweep. */
export function sfxLaser(seconds = 0.35, sampleRate = SAMPLE_RATE): AudioBuffer {
  const f0 = 1200, f1 = 200;
  return mono(seconds, (t) => {
    const u = t / seconds;
    const f = f0 + (f1 - f0) * u;
    return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 8) * 0.8;
  }, sampleRate);
}

/** A coin pickup: two quick ascending tones. */
export function sfxCoin(sampleRate = SAMPLE_RATE): AudioBuffer {
  const a = mono(0.08, (t) => Math.sin(2 * Math.PI * 988 * t) * Math.exp(-t * 30), sampleRate);
  const b = mono(0.12, (t) => Math.sin(2 * Math.PI * 1319 * t) * Math.exp(-t * 20), sampleRate);
  const buf = AudioBuffer.silence(0.2, sampleRate, 1);
  buf.mix(a, 1);
  const bShifted = AudioBuffer.silence(0.2, sampleRate, 1);
  for (let i = 0; i < b.length; i++) bShifted.channels[0]![Math.floor(0.08 * sampleRate) + i] = b.channels[0]![i]!;
  buf.mix(bShifted, 1);
  return buf;
}

/** A footstep: a short low thump. */
export function sfxFootstep(sampleRate = SAMPLE_RATE): AudioBuffer {
  return mono(0.09, (t) => {
    const noise = (Math.random() * 2 - 1) * 0.4;
    const body = Math.sin(2 * Math.PI * 90 * t);
    return (noise + body) * Math.exp(-t * 40) * 0.6;
  }, sampleRate);
}

/** An impact/hit: noise click + body. */
export function sfxImpact(seconds = 0.2, sampleRate = SAMPLE_RATE): AudioBuffer {
  return mono(seconds, (t) => {
    const click = (Math.random() * 2 - 1) * Math.exp(-t * 60);
    const body = Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 18);
    return (click + body) * 0.7;
  }, sampleRate);
}

/** A UI blip/click. */
export function sfxBlip(sampleRate = SAMPLE_RATE): AudioBuffer {
  return mono(0.06, (t) => Math.sin(2 * Math.PI * 660 * t) * Math.exp(-t * 40) * 0.5, sampleRate);
}
