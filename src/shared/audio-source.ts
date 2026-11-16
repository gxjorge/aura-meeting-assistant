import type { AudioSource } from './types.js';

export type AudioCaptureMode = AudioSource | 'both';

export interface AudioCaptureRequest {
  source: AudioSource;
  required: boolean;
}

export interface AudioCapturePlan {
  requests: AudioCaptureRequest[];
  statusSource: AudioCaptureMode;
}

export interface SystemAudioDisplayMediaOptions extends DisplayMediaStreamOptions {
  video: MediaTrackConstraints & {
    displaySurface: 'monitor';
  };
  audio: MediaTrackConstraints & {
    systemAudio: 'include';
    suppressLocalAudioPlayback: false;
  };
  systemAudio: 'include';
}

export function createAudioCapturePlan(mode: AudioCaptureMode): AudioCapturePlan {
  if (mode === 'both') {
    return {
      requests: [
        { source: 'mic', required: true },
        { source: 'system', required: false },
      ],
      statusSource: 'both',
    };
  }

  return {
    requests: [{ source: mode, required: true }],
    statusSource: mode,
  };
}

export function createSystemAudioDisplayMediaOptions(): SystemAudioDisplayMediaOptions {
  return {
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
  };
}
