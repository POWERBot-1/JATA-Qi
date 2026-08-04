// @jataqi/game-audio — NOVA Sound & Music AI Engine (section 12). Public API.

export { SAMPLE_RATE, oscillators, midiToFreq, noteToMidi, noteToFreq, adsr, crossfade, softClip, clamp1 } from './dsp.js';
export type { WaveType, Oscillator } from './dsp.js';
export { AudioBuffer } from './audio-buffer.js';
export { encodeWav, wavInfo } from './wav.js';
export {
  SCALES, INSTRUMENTS, composeMusic, renderNote, renderTrack, renderPiece,
} from './music.js';
export type { Instrument, Note, Track, ComposeOptions } from './music.js';
export { sfxExplosion, sfxLaser, sfxCoin, sfxFootstep, sfxImpact, sfxBlip } from './sfx.js';
export { spatialize, applySpatial } from './spatial.js';
export type { Listener, SpatialParams } from './spatial.js';
export { AudioEngine, LAYER_CURVES } from './audio.js';
export type { AdaptiveLayer, OneShot } from './audio.js';
