import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types.js';
import type {
  AuraAPI,
  AuraSettings,
  AzureSpeechTokenResponse,
  AudioStatus,
  MeetingCardEvent,
  MeetingCardRemovedEvent,
  MeetingCardSignal,
  MeetingProfile,
  PartialTranscriptSegment,
  ProfilesState,
  SttTranscriptionRequest,
  SttTranscriptionResponse,
  TranscriptSegment,
  VisualCaptureRequest,
  VisualContextPayload,
} from '../shared/types.js';

const api: AuraAPI = {
  getAuthStatus: () => ipcRenderer.invoke(IPC.AUTH_GET_STATUS),

  sendTranscript: (segment: TranscriptSegment) => {
    ipcRenderer.send(IPC.TRANSCRIPT_SEGMENT, segment);
  },
  sendPartialTranscript: (segment: PartialTranscriptSegment) => {
    ipcRenderer.send(IPC.TRANSCRIPT_PARTIAL, segment);
  },

  onMeetingCardCreated: (cb: (event: MeetingCardEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: MeetingCardEvent) => cb(data);
    ipcRenderer.on(IPC.MEETING_CARD_CREATED, handler);
    return () => ipcRenderer.removeListener(IPC.MEETING_CARD_CREATED, handler);
  },

  onMeetingCardUpdated: (cb: (event: MeetingCardEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: MeetingCardEvent) => cb(data);
    ipcRenderer.on(IPC.MEETING_CARD_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC.MEETING_CARD_UPDATED, handler);
  },

  cancelMeetingCard: (cardId: string) => {
    ipcRenderer.send(IPC.MEETING_CARD_CANCEL, cardId);
  },
  removeMeetingCard: (cardId: string) => {
    ipcRenderer.send(IPC.MEETING_CARD_REMOVE, cardId);
  },
  clearMeetingHistory: () => {
    ipcRenderer.send(IPC.MEETING_CLEAR);
  },
  sendMeetingCardSignal: (cardId: string, signal: MeetingCardSignal) => {
    ipcRenderer.send(IPC.MEETING_CARD_SIGNAL, { cardId, signal });
  },

  onMeetingCardRemoved: (cb: (event: MeetingCardRemovedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: MeetingCardRemovedEvent) => cb(data);
    ipcRenderer.on(IPC.MEETING_CARD_REMOVED, handler);
    return () => ipcRenderer.removeListener(IPC.MEETING_CARD_REMOVED, handler);
  },

  getAudioStatus: (): Promise<AudioStatus> => ipcRenderer.invoke(IPC.AUDIO_GET_STATUS),
  setAudioListeningState: (listening: boolean) => {
    ipcRenderer.send(IPC.AUDIO_SET_LISTENING, listening);
  },
  transcribeAudioSegment: (
    request: SttTranscriptionRequest,
  ): Promise<SttTranscriptionResponse> => ipcRenderer.invoke(IPC.STT_TRANSCRIBE_SEGMENT, request),
  getAzureSpeechToken: (): Promise<AzureSpeechTokenResponse> => (
    ipcRenderer.invoke(IPC.STT_GET_AZURE_SPEECH_TOKEN)
  ),

  onAudioToggle: (cb: (listening: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, listening: boolean) => cb(listening);
    ipcRenderer.on(IPC.AUDIO_TOGGLE, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_TOGGLE, handler);
  },

  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  saveSettings: (settings: AuraSettings) => ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings),
  getProfiles: (): Promise<ProfilesState> => ipcRenderer.invoke(IPC.PROFILES_GET),
  saveProfiles: (profiles: MeetingProfile[]): Promise<ProfilesState> => (
    ipcRenderer.invoke(IPC.PROFILES_SAVE, profiles)
  ),
  setActiveProfile: (profileId: string): Promise<ProfilesState> => (
    ipcRenderer.invoke(IPC.PROFILES_SET_ACTIVE, profileId)
  ),
  onProfilesChanged: (cb: (state: ProfilesState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ProfilesState) => cb(state);
    ipcRenderer.on(IPC.PROFILES_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.PROFILES_CHANGED, handler);
  },
  getWorkIqAuthStatus: (settings) => ipcRenderer.invoke(IPC.WORKIQ_AUTH_STATUS, settings),
  connectWorkIq: (settings) => ipcRenderer.invoke(IPC.WORKIQ_AUTH_CONNECT, settings),
  disconnectWorkIq: () => ipcRenderer.invoke(IPC.WORKIQ_AUTH_DISCONNECT),
  listModels: () => ipcRenderer.invoke(IPC.LIST_MODELS),
  capturePrimaryScreen: (request: VisualCaptureRequest): Promise<VisualContextPayload> => (
    ipcRenderer.invoke(IPC.VISUAL_CAPTURE_SCREEN, request)
  ),
  openExternalUrl: (url: string) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL_URL, url),
};

contextBridge.exposeInMainWorld('aura', api);
