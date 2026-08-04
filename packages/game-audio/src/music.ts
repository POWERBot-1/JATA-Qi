// Generative music — a deterministic composer (seeded) writes a multi-instrument
// loop (bass + arpeggio + melody) over a scale and chord progression, then
// renders it to an AudioBuffer. This is the "background music" capability of
// §12; the same machinery powers adaptive layers.

import { adsr, oscillators, type WaveType, SAMPLE_RATE } from './dsp.js';
import { AudioBuffer } from './audio-buffer.js';

/** Common scales as semitone offsets from the root. */
export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

export interface Instrument {
  wave: WaveType;
  attack: number; decay: number; sustain: number; release: number;
  gain: number;
}

export const INSTRUMENTS = {
  lead: { wave: 'triangle' as WaveType, attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.2, gain: 0.5 },
  bass: { wave: 'saw' as WaveType, attack: 0.01, decay: 0.15, sustain: 0.5, release: 0.15, gain: 0.4 },
  pad: { wave: 'sine' as WaveType, attack: 0.2, decay: 0.2, sustain: 0.7, release: 0.4, gain: 0.25 },
  pluck: { wave: 'triangle' as WaveType, attack: 0.005, decay: 0.2, sustain: 0.0, release: 0.1, gain: 0.35 },
};

export interface Note { midi: number; start: number; duration: number; velocity: number; }
export interface Track { notes: Note[]; bpm: number; instrument: Instrument; }

/** A tiny seeded PRNG (mulberry32) for deterministic composition. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface ComposeOptions {
  seed: string;
  bars?: number;
  bpm?: number;
  scale?: keyof typeof SCALES | string;
  rootMidi?: number;
}

/** Compose a deterministic multi-track piece (returns separate tracks). */
export function composeMusic(opts: ComposeOptions): { tracks: Track[]; bpm: number; seed: string } {
  const r = rng(hashStr(opts.seed));
  const bpm = opts.bpm ?? 90 + Math.floor(r() * 60); // 90..150
  const scaleName = opts.scale ?? (r() > 0.5 ? 'major' : 'minor');
  const scale = SCALES[scaleName] ?? SCALES.major!;
  const root = opts.rootMidi ?? 48 + Math.floor(r() * 12); // C3..B3
  const bars = opts.bars ?? 4;
  const beatsPerBar = 4;

  // Chord progression by scale degree (I-V-vi-IV and variants).
  const progressions = [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 4, 0]];
  const prog = progressions[Math.floor(r() * progressions.length)]!;

  const bass: Note[] = [];
  const arp: Note[] = [];
  const melody: Note[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const degree = prog[bar % prog.length]!;
    const chordRoot = root + scale[degree % scale.length]!;
    // Triad: root, third, fifth (within the scale).
    const triad = [0, 2, 4].map((s) => root + scale[(degree + s) % scale.length]! + (degree + s >= scale.length ? 12 : 0));
    const barStart = bar * beatsPerBar;

    // Bass: one long note per bar on the chord root (one octave down).
    bass.push({ midi: chordRoot - 12, start: barStart, duration: beatsPerBar, velocity: 0.9 });

    // Arpeggio: eighth-note cycling of the triad across the bar.
    for (let beat = 0; beat < beatsPerBar * 2; beat++) {
      const note = triad[beat % triad.length]!;
      arp.push({ midi: note + 12, start: barStart + beat * 0.5, duration: 0.4, velocity: 0.6 });
    }

    // Melody: a couple of scale steps per bar, emphasizing chord tones.
    const steps = 1 + Math.floor(r() * 2);
    for (let k = 0; k < steps; k++) {
      const idx = (degree + Math.floor(r() * 4)) % scale.length;
      const m = root + 12 + scale[idx]!;
      const startBeat = barStart + Math.floor(r() * 3) + r() * 0.5;
      melody.push({ midi: m, start: startBeat, duration: 0.75 + r() * 0.5, velocity: 0.5 + r() * 0.4 });
    }
  }

  return {
    tracks: [
      { notes: bass, bpm, instrument: INSTRUMENTS.bass },
      { notes: arp, bpm, instrument: INSTRUMENTS.pluck },
      { notes: melody, bpm, instrument: INSTRUMENTS.lead },
    ],
    bpm,
    seed: opts.seed,
  };
}

/** Render a single note to a mono Float32Array of samples. */
export function renderNote(note: Note, instrument: Instrument, sampleRate = SAMPLE_RATE): Float32Array {
  const beatSec = 60 / 4; // quarter-note beats (bpm applied at track level)
  void beatSec;
  const durSec = note.duration; // interpreted as seconds at the track level
  const total = Math.floor((durSec + instrument.release) * sampleRate);
  const out = new Float32Array(total);
  const freq = 440 * Math.pow(2, (note.midi - 69) / 12);
  const osc = oscillators[instrument.wave];
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const env = adsr(t, durSec, instrument.attack, instrument.decay, instrument.sustain, instrument.release);
    out[i] = osc(t, freq) * env * note.velocity * instrument.gain;
  }
  return out;
}

/** Render a full track to a stereo AudioBuffer. */
export function renderTrack(track: Track, sampleRate = SAMPLE_RATE, channels = 2): AudioBuffer {
  const secPerBeat = 60 / track.bpm;
  let endBeat = 0;
  for (const n of track.notes) endBeat = Math.max(endBeat, n.start + n.duration);
  const totalSamples = Math.ceil((endBeat * secPerBeat + track.instrument.release + 0.1) * sampleRate);
  const buf = AudioBuffer.silence(totalSamples / sampleRate, sampleRate, channels);
  for (const n of track.notes) {
    const samples = renderNote({ ...n, duration: n.duration * secPerBeat }, track.instrument, sampleRate);
    const startSample = Math.floor(n.start * secPerBeat * sampleRate);
    for (let c = 0; c < channels; c++) {
      const dst = buf.channels[c]!;
      for (let i = 0; i < samples.length; i++) {
        const idx = startSample + i;
        if (idx < dst.length) dst[idx] = (dst[idx] ?? 0) + samples[i]! * 0.5;
      }
    }
  }
  return buf;
}

/** Render all tracks of a composed piece and mix them into a master buffer. */
export function renderPiece(piece: { tracks: Track[] }, sampleRate = SAMPLE_RATE): AudioBuffer {
  const rendered = piece.tracks.map((t) => renderTrack(t, sampleRate, 2));
  const maxLen = Math.max(...rendered.map((b) => b.length));
  const master = AudioBuffer.silence(maxLen / sampleRate, sampleRate, 2);
  for (const b of rendered) master.mix(b, 1);
  return master.normalize(0.95);
}
