/**
 * encodeWav.ts — Hand-rolled 16-bit PCM WAV encoder.
 *
 * Mirror image of the hand-rolled WAV *parsing* already done in
 * `electron/sampleLibrary.ts` (`parseAudioFormat`) — no new dependency.
 * 16-bit PCM is chosen over 32-bit float for the widest compatibility with
 * the existing sample-loading path and the physical MPC hardware.
 *
 * Used by the sample recorder (`SampleRecorder.ts`) to turn captured
 * `Float32Array` channel buffers into real WAV bytes.
 */

const BYTES_PER_SAMPLE = 2; // 16-bit PCM

function clampToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/**
 * Encode one or more channels of float PCM (each in [-1, 1], all the same
 * length) into a standard 16-bit PCM WAV file.
 *
 * @throws {RangeError} If `channels` is empty, or channels have mismatched lengths.
 */
export function encodeWavPCM16(channels: Float32Array[], sampleRate: number): Uint8Array {
  if (channels.length === 0) {
    throw new RangeError("encodeWavPCM16: at least one channel is required");
  }
  const frameCount = channels[0].length;
  for (const ch of channels) {
    if (ch.length !== frameCount) {
      throw new RangeError("encodeWavPCM16: all channels must have the same length");
    }
  }

  const numChannels = channels.length;
  const blockAlign = numChannels * BYTES_PER_SAMPLE;
  const dataSize = frameCount * blockAlign;
  const byteRate = sampleRate * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeAscii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");

  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true); // bits per sample

  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setInt16(offset, clampToInt16(channels[ch][frame]), true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return bytes;
}
