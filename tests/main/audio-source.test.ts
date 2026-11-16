import { describe, expect, it } from 'vitest';
import { createAudioCapturePlan, createSystemAudioDisplayMediaOptions } from '../../src/shared/audio-source.js';

describe('audio source planning', () => {
  it('plans microphone and system capture when the user wants full meeting audio', () => {
    const plan = createAudioCapturePlan('both');

    expect(plan.requests).toEqual([
      { source: 'mic', required: true },
      { source: 'system', required: false },
    ]);
    expect(plan.statusSource).toBe('both');
  });

  it('plans only system capture when the user wants meeting audio from speakers', () => {
    const plan = createAudioCapturePlan('system');

    expect(plan.requests).toEqual([
      { source: 'system', required: true },
    ]);
    expect(plan.statusSource).toBe('system');
  });

  it('requests display capture with system audio included', () => {
    expect(createSystemAudioDisplayMediaOptions()).toEqual({
      video: { displaySurface: 'monitor' },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        channelCount: 1,
        sampleRate: 16000,
        systemAudio: 'include',
        suppressLocalAudioPlayback: false,
      },
      systemAudio: 'include',
    });
  });
});
