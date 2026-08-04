// WAV encoding — render an AudioBuffer to a 16-bit PCM RIFF/WAVE file (a real,
// playable .wav). Stereo or mono, little-endian, standard fmt chunk.

import { AudioBuffer } from './audio-buffer.js';

/** Encode an AudioBuffer to PCM16 WAV bytes. */
export function encodeWav(buffer: AudioBuffer): Buffer {
  const numChannels = buffer.channelCount;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const numSamples = buffer.length;
  const dataSize = numSamples * numChannels * 2;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;

  const out = Buffer.alloc(44 + dataSize);
  // RIFF header.
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8);
  // fmt chunk.
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); // PCM chunk size
  out.writeUInt16LE(1, 20); // PCM format
  out.writeUInt16LE(numChannels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(bitsPerSample, 34);
  // data chunk.
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);

  // Interleaved PCM16 samples (dither-free, hard clip).
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = buffer.channels[c]![i] ?? 0;
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      out.writeInt16LE(Math.round(clamped * 32767), offset);
      offset += 2;
    }
  }
  return out;
}

/** Decode just enough of a WAV header to validate it. */
export function wavInfo(buf: Buffer): { sampleRate: number; channels: number; bitsPerSample: number; dataBytes: number } {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  return {
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bitsPerSample: buf.readUInt16LE(34),
    dataBytes: buf.readUInt32LE(40),
  };
}
