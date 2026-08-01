// DSP primitives — oscillators, envelopes, and pitch helpers used to synthesize
// audio entirely in code (no samples, no assets). Everything is deterministic.

export const SAMPLE_RATE = 44100;

export type WaveType = 'sine' | 'square' | 'saw' | 'triangle' | 'noise';

/** A periodic sample function given a time (seconds) and frequency (Hz). */
export type Oscillator = (t: number, freq: number) => number;

export const oscillators: Record<WaveType, Oscillator> = {
  sine: (t, f) => Math.sin(2 * Math.PI * f * t),
  square: (t, f) => Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1,
  saw: (t, f) => 2 * ((f * t) % 1) - 1,
  triangle: (t, f) => {
    const p = (f * t) % 1;
    return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
  },
  noise: () => Math.random() * 2 - 1,
};

/** Convert a MIDI note number to frequency (A4=69=440Hz). */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Convert a note name (e.g. 'A4', 'C#5', 'Fb3') to a MIDI number. */
export function noteToMidi(name: string): number {
  const m = name.match(/^([A-G])(#|b)?(-?\d)$/);
  if (!m) throw new Error(`bad note name ${name}`);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semis = base[m[1]!]!;
  if (m[2] === '#') semis += 1;
  if (m[2] === 'b') semis -= 1;
  const octave = Number(m[3]);
  return semis + (octave + 1) * 12;
}

export function noteToFreq(name: string): number { return midiToFreq(noteToMidi(name)); }

/** ADSR envelope: returns a gain (0..1) for time `t` during a note of `duration`. */
export function adsr(t: number, duration: number, a: number, d: number, s: number, r: number): number {
  if (t < 0) return 0;
  const releaseStart = duration;
  if (t < a) return a > 0 ? t / a : 1; // attack
  if (t < a + d) return 1 - (1 - s) * ((t - a) / (d || 1)); // decay to sustain
  if (t < releaseStart) return s; // sustain
  const rt = t - releaseStart;
  return rt < r ? s * (1 - rt / (r || 1)) : 0; // release
}

/** Linear crossfade between two signals by an intensity 0..1. */
export function crossfade(a: number, b: number, mix: number): number {
  return a * (1 - mix) + b * mix;
}

/** Soft clip (tanh approximation) to prevent harsh clipping when mixing. */
export function softClip(x: number): number {
  return x / (1 + Math.abs(x));
}

/** Clamp to [-1,1]. */
export function clamp1(x: number): number { return x < -1 ? -1 : x > 1 ? 1 : x; }

export { SAMPLE_RATE as DEFAULT_SAMPLE_RATE };
