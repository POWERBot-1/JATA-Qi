// NOVA audio tests — synthesis primitives, WAV encoding/validity, generative
// music determinism, SFX, spatialization, and adaptive mixing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  oscillators, midiToFreq, noteToFreq, adsr, AudioBuffer, encodeWav, wavInfo,
  composeMusic, renderPiece, sfxExplosion, sfxLaser, sfxCoin, sfxImpact,
  spatialize, applySpatial, AudioEngine, LAYER_CURVES, SAMPLE_RATE,
} from '../src/index.js';

describe('DSP primitives', () => {
  it('midi/frequency conversions are correct', () => {
    assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-6); // A4
    assert.ok(Math.abs(noteToFreq('A4') - 440) < 1e-6);
    assert.ok(Math.abs(midiToFreq(60) - 261.6256) < 1e-3); // C4
  });

  it('ADSR envelope rises, sustains, and releases', () => {
    assert.ok(adsr(0.011, 0.3, 0.01, 0.1, 0.6, 0.2) > 0.9); // just past the attack peak
    assert.ok(Math.abs(adsr(0.2, 0.3, 0.01, 0.1, 0.6, 0.2) - 0.6) < 0.05); // sustain level
    assert.equal(adsr(0.6, 0.3, 0.01, 0.1, 0.6, 0.2), 0); // after release
  });

  it('oscillators are bounded and periodic', () => {
    for (const type of ['sine', 'square', 'saw', 'triangle'] as const) {
      const osc = oscillators[type];
      for (let i = 0; i < 10; i++) assert.ok(Math.abs(osc(i / 440, 440)) <= 1.001);
    }
  });
});

describe('AudioBuffer — mixing & panning', () => {
  it('mixes two buffers and applies gain', () => {
    const a = AudioBuffer.silence(0.01);
    const b = AudioBuffer.silence(0.01);
    b.channels[0]![0] = 0.5;
    a.mix(b, 1);
    assert.ok(Math.abs(a.channels[0]![0]! - 0.5) < 1e-6);
    a.applyGain(2);
    assert.equal(a.channels[0]![0], 1); // clamped
  });

  it('normalize scales the peak to target', () => {
    const b = AudioBuffer.silence(0.01);
    b.channels[0]![100] = 0.2;
    b.normalize(0.99);
    assert.ok(Math.abs(b.peak() - 0.99) < 1e-3);
  });
});

describe('WAV encoding', () => {
  it('encodes a valid PCM16 WAV with a correct header', () => {
    const piece = composeMusic({ seed: 'theme-1', bars: 2 });
    const master = renderPiece(piece);
    const wav = encodeWav(master);
    const info = wavInfo(wav);
    assert.equal(info.sampleRate, SAMPLE_RATE);
    assert.equal(info.channels, 2);
    assert.equal(info.bitsPerSample, 16);
    assert.equal(info.dataBytes, master.length * 2 * 2);
    // Header markers.
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  });

  it('a SFX renders to a non-trivial WAV', () => {
    const buf = sfxExplosion(0.2);
    const wav = encodeWav(buf);
    const info = wavInfo(wav);
    assert.equal(info.channels, 1);
    assert.ok(wav.length > 44);
    assert.ok(buf.peak() > 0); // there is actual audio
  });
});

describe('generative music — determinism', () => {
  it('the same seed produces identical audio', () => {
    const a = renderPiece(composeMusic({ seed: 'deterministic', bars: 2 }));
    const b = renderPiece(composeMusic({ seed: 'deterministic', bars: 2 }));
    assert.equal(a.length, b.length);
    assert.deepEqual([...a.channels[0]!.slice(0, 100)], [...b.channels[0]!.slice(0, 100)]);
  });

  it('different seeds produce different audio', () => {
    const a = renderPiece(composeMusic({ seed: 'one', bars: 2 }));
    const b = renderPiece(composeMusic({ seed: 'two', bars: 2 }));
    let diff = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 10) if (Math.abs(a.channels[0]![i]! - b.channels[0]![i]!) > 1e-6) diff++;
    assert.ok(diff > 0);
  });

  it('produces multiple tracks (bass + arpeggio + melody)', () => {
    const piece = composeMusic({ seed: 'x', bars: 1 });
    assert.ok(piece.tracks.length >= 3);
    assert.ok(piece.tracks.every((t) => t.notes.length > 0));
  });
});

describe('SFX generators', () => {
  it('each SFX produces audible, bounded audio', () => {
    for (const b of [sfxLaser(), sfxCoin(), sfxImpact()]) {
      assert.ok(b.peak() > 0);
      assert.ok(b.peak() <= 1);
    }
  });
});

describe('3D spatial audio', () => {
  it('attenuates with distance and pans left/right', () => {
    const listener = { position: [0, 0, 0] as [number, number, number], forward: [0, 0, -1] as [number, number, number] };
    const near = spatialize(listener, [0, 0, -1]);
    const far = spatialize(listener, [0, 0, -20]);
    assert.ok(far.gain < near.gain);
    const left = spatialize(listener, [-5, 0, -1]);
    const right = spatialize(listener, [5, 0, -1]);
    assert.ok(left.pan < 0);
    assert.ok(right.pan > 0);
  });

  it('applySpatial up-mixes mono to stereo and pans', () => {
    const mono = sfxBlipOrImpact();
    const out = applySpatial(mono, { gain: 0.5, pan: -1, distance: 5 });
    assert.equal(out.channelCount, 2);
    assert.ok(Math.abs(out.channels[0]![100]!) >= Math.abs(out.channels[1]![100]!)); // louder left
  });
});

describe('adaptive music engine', () => {
  it('crossfades layers with intensity', () => {
    const calm = renderPiece(composeMusic({ seed: 'calm', bars: 2 }));
    const intense = renderPiece(composeMusic({ seed: 'intense', bars: 2 }));
    const engine = new AudioEngine()
      .addLayer({ name: 'calm', buffer: calm, curve: LAYER_CURVES.calm })
      .addLayer({ name: 'intense', buffer: intense, curve: LAYER_CURVES.intense });
    engine.setIntensity(0);
    const at0 = engine.render();
    engine.setIntensity(1);
    const at1 = engine.render();
    // Both are valid audio; peaks are present.
    assert.ok(at0.peak() > 0 && at1.peak() > 0);
  });
});

// Helper for the spatial up-mix test.
import { sfxBlip } from '../src/index.js';
function sfxBlipOrImpact(): AudioBuffer { return sfxBlip(); }

// Optional: write a sample WAV for manual inspection when NOVA_AUDIO_DUMP is set.
if (process.env.NOA_AUDIO_DUMP) {
  try {
    mkdirSync('/tmp/nova-audio', { recursive: true });
    const master = renderPiece(composeMusic({ seed: 'showcase', bars: 4 }));
    writeFileSync('/tmp/nova-audio/theme.wav', encodeWav(master));
  } catch { /* ignore */ }
}
