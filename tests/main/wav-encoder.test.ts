import { describe, expect, it } from 'vitest';
import { encodeMonoPcm16Wav } from '../../src/renderer/audio/wav-encoder.js';

describe('WAV encoder', () => {
  it('encodes mono Float32 samples as 16-bit PCM WAV', () => {
    const wav = encodeMonoPcm16Wav([
      new Float32Array([-1, 0, 1]),
    ], 16000);
    const view = new DataView(wav.buffer);

    expect(readAscii(wav, 0, 4)).toBe('RIFF');
    expect(readAscii(wav, 8, 12)).toBe('WAVE');
    expect(readAscii(wav, 12, 16)).toBe('fmt ');
    expect(readAscii(wav, 36, 40)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32767);
  });
});

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}
