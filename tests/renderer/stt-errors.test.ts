import { describe, expect, it } from 'vitest';
import { formatLocalSttFailure } from '../../src/renderer/audio/stt-errors.js';

describe('STT fallback errors', () => {
  it('reports a standalone local model failure', () => {
    expect(formatLocalSttFailure('Failed to load Vosk model: Failed to fetch')).toBe(
      'Failed to load Vosk model: Failed to fetch',
    );
  });

  it('preserves the Azure failure when the local fallback also fails', () => {
    expect(formatLocalSttFailure(
      'Failed to load Vosk model: Failed to fetch',
      'Azure transcription failed with HTTP 503. Unavailable',
    )).toBe(
      'Azure transcription failed with HTTP 503. Unavailable '
      + 'Local Vosk fallback also failed: Failed to load Vosk model: Failed to fetch',
    );
  });
});
