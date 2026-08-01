// 3D spatial audio (§12 "3D spatial audio"). Given a listener (position +
// orientation) and a source position, compute a distance attenuation and a
// stereo pan, then apply it to a buffer — modeling how sound falls off and
// moves left/right as the source moves through the world.

import { v3dot, v3len, v3norm, v3sub, type Vec3 } from '@jataqi/game-engine';
import { AudioBuffer } from './audio-buffer.js';

export interface Listener { position: Vec3; forward: Vec3; up?: Vec3; }

export interface SpatialParams {
  /** 0..1 attenuation (distance-based). */
  gain: number;
  /** -1 (left) .. +1 (right). */
  pan: number;
  /** Source-listener distance (world units). */
  distance: number;
}

/**
 * Compute spatial mixing parameters for a source relative to a listener.
 * Attenuation uses an inverse model with a reference distance; pan derives from
 * the source's projection onto the listener's right axis.
 */
export function spatialize(listener: Listener, source: Vec3, opts: { referenceDistance?: number; rolloff?: number; maxDistance?: number } = {}): SpatialParams {
  const ref = opts.referenceDistance ?? 1;
  const rolloff = opts.rolloff ?? 1;
  const max = opts.maxDistance ?? 100;
  const delta = v3sub(source, listener.position);
  const distance = Math.min(max, v3len(delta));
  const gain = clamp01(ref / (ref + rolloff * Math.max(0, distance - ref)));
  // Right axis = forward × up (up defaults to world +Y).
  const up = listener.up ?? [0, 1, 0];
  const right = v3norm(v3cross(listener.forward, up));
  const dir = distance > 1e-6 ? v3norm(delta) : [0, 0, 0] as Vec3;
  const pan = clamp11(v3dot(dir, right));
  return { gain, pan, distance };
}

/** Apply spatial params to a buffer (mono→stereo with pan + gain). */
export function applySpatial(buffer: AudioBuffer, params: SpatialParams): AudioBuffer {
  // Up-mix mono to stereo for panning.
  let stereo = buffer;
  if (buffer.channelCount === 1) {
    stereo = new AudioBuffer([buffer.channels[0]!.slice(), buffer.channels[0]!.slice()], buffer.sampleRate);
  }
  stereo.applyGain(params.gain);
  stereo.pan(params.pan);
  return stereo;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp11(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }
function v3cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export { v3dot, v3len, v3norm, v3sub };
