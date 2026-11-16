import { BrowserWindow, ipcMain, shell } from 'electron';
import { IPC } from '../shared/types.js';
import type {
  AudioSource,
  AudioStatus,
  AuraSettings,
  AzureSpeechTokenResponse,
  MeetingProfile,
  MeetingCardSignalEvent,
  ProfilesState,
  SttTranscriptionRequest,
  SttTranscriptionResponse,
  TranscriptSegment,
  VisualCaptureRequest,
} from '../shared/types.js';
import { validateAuth } from './auth.js';
import { getAzureSpeechToken, transcribeWithAzureMai } from './azure-transcription.js';
import { getAvailableModels } from './copilot.js';
import { normalizeExternalUrl } from './external-links.js';
import { getOverlayWindow } from './overlay.js';
import {
  getSettings,
  getProfilesState,
  saveProfiles,
  saveSettings,
  setActiveProfile,
} from './settings.js';
import { capturePrimaryScreen } from './visual-capture.js';
import { pruneProfileSkills } from './profile-skills.js';
import {
  cancelMeetingCard,
  clearMeetingHistory,
  handlePartialTranscript,
  handleTranscriptSegment,
  recordMeetingCardSignal,
  refreshMeetingIntelligenceSettings,
  removeMeetingCard,
  setMeetingListeningState,
  setMeetingCallbacks,
} from './meeting-intelligence.js';
import { reviewProfileAfterMeeting } from './profile-evolution.js';
import {
  connectWorkIq,
  disconnectWorkIq,
  getWorkIqAuthStatus,
} from './workiq-auth.js';

let audioListening = false;

export function isAudioListening(): boolean {
  return audioListening;
}

export function toggleAudioListening(): boolean {
  audioListening = !audioListening;
  setMeetingListeningState(audioListening);
  const overlay = getOverlayWindow();
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send(IPC.AUDIO_TOGGLE, audioListening);
  }
  return audioListening;
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.AUTH_GET_STATUS, async () => {
    return await validateAuth();
  });

  ipcMain.on(IPC.TRANSCRIPT_SEGMENT, (_event, segment: TranscriptSegment) => {
    handleTranscriptSegment(segment);
  });

  ipcMain.on(IPC.TRANSCRIPT_PARTIAL, (_event, segment) => {
    handlePartialTranscript(segment);
  });

  ipcMain.handle(IPC.AUDIO_GET_STATUS, (): AudioStatus => {
    return { listening: audioListening, source: getSettings().audioSource, modelLoaded: true };
  });

  ipcMain.on(IPC.AUDIO_SET_LISTENING, (_event, nextListening: boolean) => {
    audioListening = nextListening;
    setMeetingListeningState(nextListening);
  });

  ipcMain.handle(
    IPC.STT_TRANSCRIBE_SEGMENT,
    async (_event, rawRequest: unknown): Promise<SttTranscriptionResponse> => {
      const request = parseSttTranscriptionRequest(rawRequest);
      if (!request) {
        return failedSttResponse('mic', 'local_vosk', 'Invalid transcription request.', 0, 0);
      }

      const settings = getSettings();
      if (settings.sttProvider !== 'azure_mai_transcribe') {
        return failedSttResponse(
          request.source,
          settings.sttProvider,
          'Azure transcription is not enabled.',
          request.startedAt,
          request.endedAt,
        );
      }

      const result = await transcribeWithAzureMai({
        settings: settings.azureStt,
        audioBytes: new Uint8Array(request.audioData),
        mimeType: request.mimeType,
      });

      if (!result.ok) {
        return failedSttResponse(
          request.source,
          settings.sttProvider,
          result.error,
          request.startedAt,
          request.endedAt,
        );
      }

      if (result.text === null) {
        return {
          provider: settings.sttProvider,
          source: request.source,
          status: 'no_speech',
          startedAt: request.startedAt,
          endedAt: request.endedAt,
        };
      }

      return {
        provider: settings.sttProvider,
        source: request.source,
        status: 'ready',
        startedAt: request.startedAt,
        endedAt: request.endedAt,
        text: result.text,
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        ...(result.locale ? { locale: result.locale } : {}),
      };
    },
  );

  ipcMain.handle(IPC.STT_GET_AZURE_SPEECH_TOKEN, async (): Promise<AzureSpeechTokenResponse> => {
    const settings = getSettings();
    if (settings.sttProvider !== 'azure_speech_realtime') {
      return {
        ok: false,
        error: 'Azure Speech real-time transcription is not enabled.',
      };
    }

    return await getAzureSpeechToken();
  });

  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings());
  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, settings: AuraSettings): AuraSettings => {
    const savedSettings = saveSettings(settings);
    refreshMeetingIntelligenceSettings();
    return savedSettings;
  });

  ipcMain.handle(IPC.LIST_MODELS, () => getAvailableModels());

  ipcMain.handle(IPC.PROFILES_GET, (): ProfilesState => getProfilesState());

  ipcMain.handle(IPC.PROFILES_SAVE, (_event, profiles: MeetingProfile[]): ProfilesState => {
    const state = saveProfiles(profiles);
    pruneProfileSkills(state.profiles);
    refreshMeetingIntelligenceSettings();
    broadcastProfilesChanged(state);
    return state;
  });

  ipcMain.handle(IPC.PROFILES_SET_ACTIVE, (_event, profileId: string): ProfilesState =>
    activateProfile(profileId)
  );

  ipcMain.handle(IPC.WORKIQ_AUTH_STATUS, (_event, settings) => getWorkIqAuthStatus(settings));
  ipcMain.handle(IPC.WORKIQ_AUTH_CONNECT, async (_event, settings) => await connectWorkIq(settings));
  ipcMain.handle(IPC.WORKIQ_AUTH_DISCONNECT, () => disconnectWorkIq());

  ipcMain.handle(IPC.VISUAL_CAPTURE_SCREEN, async (_event, request: VisualCaptureRequest) => {
    return await capturePrimaryScreen(request);
  });

  ipcMain.handle(IPC.OPEN_EXTERNAL_URL, async (_event, rawUrl: string): Promise<boolean> => {
    const url = normalizeExternalUrl(rawUrl);
    if (!url) {
      console.warn('[External links] Blocked non-web URL:', rawUrl);
      return false;
    }

    await shell.openExternal(url);
    return true;
  });

  ipcMain.on(IPC.MEETING_CARD_CANCEL, (_event, cardId: string) => {
    cancelMeetingCard(cardId);
  });

  ipcMain.on(IPC.MEETING_CARD_REMOVE, (_event, cardId: string) => {
    removeMeetingCard(cardId);
  });

  ipcMain.on(IPC.MEETING_CLEAR, () => {
    clearMeetingHistory();
  });

  ipcMain.on(IPC.MEETING_CARD_SIGNAL, (_event, payload: MeetingCardSignalEvent) => {
    if (!payload || typeof payload.cardId !== 'string') return;
    recordMeetingCardSignal(payload.cardId, payload.signal);
  });

  setMeetingCallbacks({
    onCardCreated: (event) => {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send(IPC.MEETING_CARD_CREATED, event);
      }
    },
    onCardUpdated: (event) => {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send(IPC.MEETING_CARD_UPDATED, event);
      }
    },
    onCardRemoved: (event) => {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send(IPC.MEETING_CARD_REMOVED, event);
      }
    },
    onMeetingEnded: async () => {
      await reviewProfileAfterMeeting();
      broadcastProfilesChanged(getProfilesState());
    },
  });
}

export function activateProfile(profileId: string): ProfilesState {
  const state = setActiveProfile(profileId);
  refreshMeetingIntelligenceSettings();
  broadcastProfilesChanged(state);
  return state;
}

function broadcastProfilesChanged(state: ProfilesState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(IPC.PROFILES_CHANGED, state);
  }
}

function parseSttTranscriptionRequest(value: unknown): SttTranscriptionRequest | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const source = parseAudioSource(record.source);
  const audioData = parseArrayBuffer(record.audioData);
  const mimeType = record.mimeType;
  const startedAt = parseTimestamp(record.startedAt);
  const endedAt = parseTimestamp(record.endedAt);

  if (!source || !audioData || mimeType !== 'audio/wav' || startedAt === null || endedAt === null) {
    return null;
  }

  return {
    source,
    audioData,
    mimeType,
    startedAt,
    endedAt,
  };
}

function parseAudioSource(value: unknown): AudioSource | null {
  return value === 'mic' || value === 'system' ? value : null;
}

function parseArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }
  return null;
}

function parseTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function failedSttResponse(
  source: AudioSource,
  provider: SttTranscriptionResponse['provider'],
  error: string,
  startedAt: number,
  endedAt: number,
): SttTranscriptionResponse {
  return {
    provider,
    source,
    status: 'failed',
    startedAt,
    endedAt,
    error,
  };
}
