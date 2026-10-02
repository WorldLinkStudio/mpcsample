/**
 * encodeWav.test.ts — Unit tests for the 16-bit PCM WAV encoder.
 *
 * Test coverage:
 *  - correct RIFF/WAVE/fmt/data header fields for mono and stereo
 *  - correct data length and total file length
 *  - round-trips through the existing WAV-parsing convention (wavFrameCount)
 *  - sample values round-trip through int16 quantization within tolerance
 *  - throws on empty channels / mismatched channel lengths
 */

import { describe, expect, it } from "vitest";
import { wavFrameCount } from "../../xpj/buildXpj";
import { encodeWavPCM16 } from "../encodeWav";

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

describe("encodeWavPCM16", () => {
  it("writes correct RIFF/WAVE/fmt/data headers for mono", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = encodeWavPCM16([samples], 44100);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(readAscii(bytes, 0, 4)).toBe("RIFF");
    expect(readAscii(bytes, 8, 4)).toBe("WAVE");
    expect(readAscii(bytes, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(32, true)).toBe(2); // blockAlign (1 ch * 2 bytes)
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(readAscii(bytes, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(bytes.length).toBe(44 + samples.length * 2);
  });

  it("writes correct headers + interleaving for stereo", () => {
    const left = new Float32Array([1, -1, 0]);
    const right = new Float32Array([-1, 1, 0.5]);
    const bytes = encodeWavPCM16([left, right], 48000);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(32, true)).toBe(4); // blockAlign (2 ch * 2 bytes)
    expect(view.getUint32(28, true)).toBe(48000 * 4); // byteRate
    expect(view.getUint32(40, true)).toBe(left.length * 4);

    // Frame 0: left=1 (max), right=-1 (min), interleaved L,R.
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });

  it("round-trips frame count through the existing wavFrameCount parser", () => {
    const samples = new Float32Array(1000).fill(0.25);
    const bytes = encodeWavPCM16([samples], 44100);
    expect(wavFrameCount(bytes)).toBe(1000);
  });

  it("quantizes float samples to int16 within tolerance", () => {
    const samples = new Float32Array([0.1, -0.3, 0.999]);
    const bytes = encodeWavPCM16([samples], 44100);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let i = 0; i < samples.length; i++) {
      const written = view.getInt16(44 + i * 2, true) / 0x8000;
      expect(written).toBeCloseTo(samples[i], 3);
    }
  });

  it("throws on an empty channel list", () => {
    expect(() => encodeWavPCM16([], 44100)).toThrow(RangeError);
  });

  it("throws when channels have mismatched lengths", () => {
    expect(() => encodeWavPCM16([new Float32Array(10), new Float32Array(5)], 44100)).toThrow(
      RangeError,
    );
  });
});
