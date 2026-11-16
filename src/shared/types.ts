// ---- IPC Channels ----

export const IPC = {
  AUTH_GET_STATUS: 'auth:get-status',
  OVERLAY_TOGGLE: 'overlay:toggle',

  TRANSCRIPT_SEGMENT: 'meeting:transcript-segment',
  TRANSCRIPT_PARTIAL: 'meeting:transcript-partial',
  MEETING_CARD_CREATED: 'meeting:card-created',
  MEETING_CARD_UPDATED: 'meeting:card-updated',
  MEETING_CARD_CANCEL: 'meeting:card-cancel',
  MEETING_CARD_REMOVE: 'meeting:card-remove',
  MEETING_CLEAR: 'meeting:clear',
  MEETING_CARD_REMOVED: 'meeting:card-removed',
  MEETING_CARD_SIGNAL: 'meeting:card-signal',

  AUDIO_TOGGLE: 'audio:toggle',
  AUDIO_GET_STATUS: 'audio:get-status',
  AUDIO_SET_LISTENING: 'audio:set-listening',
  STT_TRANSCRIBE_SEGMENT: 'stt:transcribe-segment',
  STT_GET_AZURE_SPEECH_TOKEN: 'stt:get-azure-speech-token',

  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
  LIST_MODELS: 'settings:list-models',

  PROFILES_GET: 'profiles:get',
  PROFILES_SAVE: 'profiles:save',
  PROFILES_SET_ACTIVE: 'profiles:set-active',
  PROFILES_CHANGED: 'profiles:changed',
  WORKIQ_AUTH_STATUS: 'workiq:auth-status',
  WORKIQ_AUTH_CONNECT: 'workiq:auth-connect',
  WORKIQ_AUTH_DISCONNECT: 'workiq:auth-disconnect',

  VISUAL_CAPTURE_SCREEN: 'visual:capture-screen',

  OPEN_EXTERNAL_URL: 'shell:open-external-url',
} as const;

// ---- Auth ----

export interface AuthStatus {
  authenticated: boolean;
  username?: string;
  error?: string;
}

// ---- Meeting transcript ----

export type AudioSource = 'mic' | 'system';

export interface TranscriptSegment {
  text: string;
  source: AudioSource;
  confidence: number;
  startedAt: number;
  endedAt: number;
  visualContext?: VisualContextPayload;
}

export interface PartialTranscriptSegment {
  text: string;
  source: AudioSource;
  updatedAt: number;
}

// ---- Meeting cards ----

export type MeetingCardKind = 'answer' | 'context';
export type MeetingCardStatus = 'running' | 'ready' | 'failed' | 'cancelled';

/** A link cited by a card's answer. Rendered as a clickable source under the card body. */
export interface LearnDoc {
  title: string;
  url: string;
  description?: string;
}

export interface MeetingCard {
  id: string;
  kind: MeetingCardKind;
  status: MeetingCardStatus;
  title: string;
  body?: string;
  docs?: LearnDoc[];
  sourceText: string;
  createdAt: number;
  updatedAt: number;
}

export interface MeetingCardEvent {
  card: MeetingCard;
}

export interface MeetingCardRemovedEvent {
  cardId: string;
}

/**
 * How the user reacted to a card. Fed back into profile learning so a profile can quietly adapt to
 * what actually proved useful in real meetings.
 */
export type MeetingCardSignal = 'opened' | 'dismissed' | 'link_opened' | 'cancelled';

/**
 * Deliberately carries only the card id — the main process resolves the derived concept term itself
 * so no transcript text ever crosses the IPC boundary or reaches disk.
 */
export interface MeetingCardSignalEvent {
  cardId: string;
  signal: MeetingCardSignal;
}

// ---- Audio ----

export interface AudioStatus {
  listening: boolean;
  source: 'mic' | 'system' | 'both';
  modelLoaded: boolean;
}

export type SttProvider = 'local_vosk' | 'azure_mai_transcribe' | 'azure_speech_realtime';
export type AzureTranscribeModel = 'mai-transcribe-1.5' | 'mai-transcribe-2';
export type AzureTranscribeStyle = 'readable' | 'verbatim';

export interface AzureSttSettings {
  endpoint: string;
  model: AzureTranscribeModel;
  locales: string;
  transcribeStyle: AzureTranscribeStyle;
  segmentDurationSeconds: number;
  realtimeLanguage: string;
}

/**
 * Optional fast gate in front of the LLM triage. A decision model (Microsoft-Decision-1 on Microsoft
 * Foundry) answers "is anything here worth surfacing?" in a few hundred milliseconds rather than the
 * ~3s an LLM needs, so the LLM only wakes up when the answer is probably yes. With no endpoint the gate
 * does nothing and the LLM decides every tick.
 */
export interface DecisionGateSettings {
  enabled: boolean;
  /**
   * The resource's Foundry endpoint (`https://<resource>.services.ai.azure.com`). It is not the Speech
   * endpoint, which the same resource also has: that host does not serve the decision route. Blank means
   * not configured.
   */
  endpoint: string;
  /** Deployment name, which is what the request's `model` field takes — not the model's own name. */
  deployment: string;
}

export interface WorkIqAuthSettings {
  clientId: string;
  tenantId: string;
}

export type SttTranscriptionStatus = 'ready' | 'no_speech' | 'failed';

export interface SttTranscriptionRequest {
  source: AudioSource;
  audioData: ArrayBuffer;
  mimeType: 'audio/wav';
  startedAt: number;
  endedAt: number;
}

export interface SttTranscriptionResponse {
  provider: SttProvider;
  source: AudioSource;
  status: SttTranscriptionStatus;
  startedAt: number;
  endedAt: number;
  text?: string;
  confidence?: number;
  locale?: string;
  error?: string;
}

export interface AzureSpeechTokenResponse {
  ok: boolean;
  token?: string;
  expiresOnTimestamp?: number;
  error?: string;
}

export type TriageCadenceMode = 'final_transcript' | 'interval' | 'both';

export interface TriageCadenceSettings {
  mode: TriageCadenceMode;
  intervalSeconds: number;
}

// ---- Meeting profiles ----

export type ProfileMcpTransport = 'stdio' | 'http' | 'sse';
export type ProfileMcpAuthProvider = 'workiq';

export interface ProfileMcpServer {
  id: string;
  name: string;
  transport: ProfileMcpTransport;
  enabled: boolean;
  /** Tool allow-list handed to the agent. `['*']` means every tool on the server. */
  tools: string[];
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  /** Main-process token provider used to hydrate this server at session creation time. */
  authProvider?: ProfileMcpAuthProvider;
  /** Public OAuth application identifiers for an Entra-backed Work IQ server. */
  workIqAuth?: WorkIqAuthSettings;
}

export type WorkIqAuthState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WorkIqAuthStatus {
  state: WorkIqAuthState;
  username?: string;
  error?: string;
  /** False means Azure Identity's shared development client is in use. */
  configuredClient: boolean;
}

export interface ProfileSkill {
  id: string;
  name: string;
  /** Drives the agent's decision about whether to load the skill. */
  description: string;
  /** SKILL.md body; frontmatter is generated from `id`/`description`. */
  body: string;
  enabled: boolean;
}

/**
 * Per-term signal weights derived from card interactions. Only terms the user already curated in
 * `profile.vocabulary` are ever stored. Triage topics are model-generated from transcript text, so
 * they are matched against that vocabulary and discarded when they do not appear in it — transcript
 * text never reaches disk.
 */
export interface ProfileTermStat {
  term: string;
  /** Decayed cumulative engagement score. Negative means the term is proving noisy. */
  weight: number;
  surfaced: number;
  engaged: number;
  rejected: number;
  updatedAt: number;
}

export interface ProfileLearningState {
  terms: ProfileTermStat[];
  lastDecayedAt: number;
  /** Signals recorded since the last evolution proposal, used to decide when a review is worthwhile. */
  signalsSinceProposal: number;
}

export type ProfileProposalKind =
  | 'vocabulary_add'
  | 'vocabulary_remove'
  | 'system_prompt';

export interface ProfileProposalChange {
  id: string;
  kind: ProfileProposalKind;
  summary: string;
  rationale: string;
  /** Term to add/remove, or the full replacement text for a prompt change. */
  value: string;
}

/** An agent-drafted profile update awaiting explicit user approval. Never applied automatically. */
export interface ProfileProposal {
  id: string;
  createdAt: number;
  changes: ProfileProposalChange[];
}

export interface MeetingProfile {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  /**
   * The single authority over this profile's behaviour. It drives the triage pass that decides what
   * is worth surfacing, the passive context cards, and the explicit answer agent.
   */
  systemPrompt: string;
  answerModel: string;
  /**
   * Model for the triage pass that decides whether anything is worth surfacing. Separate from
   * {@link answerModel} because triage only classifies, and it sits in front of every card.
   */
  triageModel: string;
  /** Every source a profile can reach is an MCP server, including official documentation. */
  mcpServers: ProfileMcpServer[];
  skills: ProfileSkill[];
  /** Terms this profile always cares about. Passed to triage, and the only learnable term set. */
  vocabulary: string[];
  triageCadence: TriageCadenceSettings;
  /** Kill switch for unprompted cards. Triage streams transcript to a model, so this stays hard. */
  passiveCardsEnabled: boolean;
  explicitAnswersEnabled: boolean;
  /** Opt-in: when false the profile records no signals and drafts no proposals. */
  learningEnabled: boolean;
  learning: ProfileLearningState;
  pendingProposal?: ProfileProposal;
  createdAt: number;
  updatedAt: number;
}

/** Id of the profile Aura seeds on first run and always keeps present. */
export const DEFAULT_PROFILE_ID = 'azure-docs';

/** Pre-uniform-profiles id of the seeded profile, migrated to {@link DEFAULT_PROFILE_ID}. */
export const LEGACY_GENERAL_PROFILE_ID = 'general';

/** Upper bound on a profile's vocabulary list, enforced on both manual edits and learned promotions. */
export const MAX_VOCABULARY_TERMS = 64;

/** Payload exchanged over the profile IPC channels. */
export interface ProfilesState {
  profiles: MeetingProfile[];
  activeProfileId: string;
}

/**
 * Structural mirrors of the Copilot SDK MCP config union. Declared here rather than imported so
 * shared profile logic stays free of the SDK (and therefore testable without Electron/Node deps).
 */
export interface AgentMcpLocalServerConfig {
  tools: string[];
  type?: 'local' | 'stdio';
  timeout?: number;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface AgentMcpRemoteServerConfig {
  tools: string[];
  type: 'http' | 'sse';
  timeout?: number;
  url: string;
  headers?: Record<string, string>;
}

export type AgentMcpServerConfig = AgentMcpLocalServerConfig | AgentMcpRemoteServerConfig;

/** Everything a profile contributes to a single Copilot SDK session. */
export interface AgentSessionConfig {
  model: string;
  systemPrompt: string;
  mcpServers: Record<string, AgentMcpServerConfig>;
  skillDirectories: string[];
}

// ---- Settings ----

export interface AuraSettings {
  schemaVersion: number;
  sttProvider: SttProvider;
  localSttModelUrl: string;
  azureStt: AzureSttSettings;
  decisionGate: DecisionGateSettings;
  audioSource: 'mic' | 'system' | 'both';
  visualContext: VisualContextSettings;
  profiles: MeetingProfile[];
  activeProfileId: string;
}

/** Pre-profiles settings shape, retained so `normalizeSettings()` can migrate existing installs. */
export interface LegacyAuraSettings {
  answerModel?: string;
  docsCadence?: TriageCadenceSettings;
  implicitDocsEnabled?: boolean;
  explicitAnswersEnabled?: boolean;
  mcpConnections?: McpConnection[];
}

export const SETTINGS_SCHEMA_VERSION = 3;
export const DEFAULT_WORKIQ_CLIENT_ID = 'ba081686-5d24-4bc6-a0d6-d034ecffed87';
export const DEFAULT_WORKIQ_TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

/** What the Foundry portal names a Microsoft-Decision-1 deployment unless the user renames it. */
export const DEFAULT_DECISION_DEPLOYMENT = 'Microsoft-Decision-1';

export const DEFAULT_SETTINGS: AuraSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  sttProvider: 'local_vosk',
  localSttModelUrl: '/vosk-model-small-en-us.tar.gz',
  azureStt: {
    // Resource-specific: every user supplies their own in Settings, so no default ships.
    endpoint: '',
    model: 'mai-transcribe-2',
    locales: '',
    transcribeStyle: 'readable',
    segmentDurationSeconds: 10,
    realtimeLanguage: 'en-US',
  },
  decisionGate: {
    enabled: true,
    // Resource-specific, like the Azure Speech endpoint: blank until the user sets their own.
    endpoint: '',
    deployment: DEFAULT_DECISION_DEPLOYMENT,
  },
  audioSource: 'both',
  visualContext: {
    mode: 'off',
    captureTarget: 'primary_screen',
    trigger: 'transcript_segment',
    ocrLanguage: 'eng',
    maxImageWidth: 1280,
    jpegQuality: 0.72,
  },
  // Populated by normalizeSettings() so the built-in profile lives in one place.
  profiles: [],
  activeProfileId: DEFAULT_PROFILE_ID,
};

export const DEFAULT_ANSWER_MODEL = 'claude-sonnet-5.5';

/**
 * Triage runs on every cadence tick and only ever emits a small JSON array, so it is a classification
 * task rather than a reasoning one. Measured on the same transcript, a frontier model spends ~8.2s on
 * it against ~3.3s here — five seconds added to every card for no gain in the decision quality.
 */
export const DEFAULT_TRIAGE_MODEL = 'gpt-4.1';

/**
 * Triage is an LLM call, not a regex, so the interval is a cost dial rather than a free poll.
 * `meeting-intelligence` additionally enforces a hard floor between passes.
 */
export const DEFAULT_TRIAGE_CADENCE: TriageCadenceSettings = {
  mode: 'both',
  intervalSeconds: 20,
};

export type VisualContextMode = 'off' | 'agent_image' | 'local_ocr' | 'both';
export type VisualCaptureTarget = 'primary_screen';
export type VisualCaptureTrigger = 'transcript_segment';
export type McpConnectionStatus = 'connected' | 'configured' | 'error';
export type McpTransport = 'builtin' | 'http';

export interface VisualContextSettings {
  mode: VisualContextMode;
  captureTarget: VisualCaptureTarget;
  trigger: VisualCaptureTrigger;
  ocrLanguage: string;
  maxImageWidth: number;
  jpegQuality: number;
}

export interface VisualCaptureRequest {
  target: VisualCaptureTarget;
  maxImageWidth: number;
  jpegQuality: number;
}

export interface VisualContextPayload {
  capturedAt: number;
  mode: VisualContextMode;
  screenshot?: {
    dataUrl: string;
    width: number;
    height: number;
  };
  ocr?: {
    text: string;
    confidence?: number;
    language: string;
  };
  error?: string;
}

export interface McpConnection {
  id: string;
  name: string;
  status: McpConnectionStatus;
  transport: McpTransport;
  url?: string;
  description?: string;
}

/** Seed entry for the legacy `mcpConnections` list; kept for migration and back-compat helpers. */
export const LEGACY_DOCS_MCP_CONNECTION: McpConnection = {
  id: 'microsoft-docs',
  name: 'Microsoft Docs',
  status: 'connected',
  description: 'Used for technical documentation cards surfaced during meetings.',
  transport: 'builtin',
};

export const AUDIO_SOURCE_OPTIONS = [
  { label: 'Microphone + system meeting audio', value: 'both' },
  { label: 'Microphone only', value: 'mic' },
  { label: 'System meeting audio only', value: 'system' },
] as const;

export const TRIAGE_CADENCE_MODE_OPTIONS = [
  {
    label: 'Final transcript only',
    value: 'final_transcript',
    description: 'Run the triage pass when speech recognition finalizes an utterance.',
  },
  {
    label: 'Every few seconds',
    value: 'interval',
    description: 'Run the triage pass over the rolling meeting context on a fixed interval.',
  },
  {
    label: 'Final transcript + interval',
    value: 'both',
    description: 'Run the triage pass on finalized utterances and on the configured interval.',
  },
] as const;

export const VISUAL_CONTEXT_MODE_OPTIONS = [
  {
    label: 'Off',
    value: 'off',
    description: 'Do not capture screen context.',
  },
  {
    label: 'Screenshot to agent',
    value: 'agent_image',
    description: 'Capture screenshots for image-capable agent paths when available.',
  },
  {
    label: 'Local OCR',
    value: 'local_ocr',
    description: 'Run local OCR and attach extracted screen text to meeting intelligence.',
  },
  {
    label: 'Screenshot + local OCR',
    value: 'both',
    description: 'Capture screenshots and attach local OCR text for all meeting intelligence.',
  },
] as const;

export const LOCAL_STT_MODEL_OPTIONS = [
  { label: 'English Small (40MB)', value: '/vosk-model-small-en-us.tar.gz' },
  { label: 'English US (128MB)', value: 'https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.tar.gz' },
  { label: 'Spanish Small (39MB)', value: 'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.tar.gz' },
  { label: 'French Small (41MB)', value: 'https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.tar.gz' },
  { label: 'German Small (45MB)', value: 'https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.tar.gz' },
  { label: 'Portuguese Small (39MB)', value: 'https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.tar.gz' },
];

export const STT_PROVIDER_OPTIONS = [
  {
    label: 'Local Vosk',
    value: 'local_vosk',
    description: 'Transcribe on-device with cached local speech models.',
  },
  {
    label: 'Azure MAI-Transcribe (preview)',
    value: 'azure_mai_transcribe',
    description: 'Use Azure Speech LLM Speech with buffered meeting audio segments.',
  },
  {
    label: 'Azure Speech real-time',
    value: 'azure_speech_realtime',
    description: 'Use Azure Speech SDK continuous recognition for low-latency meeting transcription.',
  },
] as const;

export const AZURE_TRANSCRIBE_MODEL_OPTIONS = [
  { label: 'MAI-Transcribe-2', value: 'mai-transcribe-2' },
  { label: 'MAI-Transcribe-1.5', value: 'mai-transcribe-1.5' },
] as const;

export const AZURE_TRANSCRIBE_STYLE_OPTIONS = [
  {
    label: 'Readable',
    value: 'readable',
    description: 'Optimize punctuation and readability.',
  },
  {
    label: 'Verbatim',
    value: 'verbatim',
    description: 'Preserve more of the original spoken content.',
  },
] as const;

export const LLM_MODEL_OPTIONS = [
  { label: 'Claude Sonnet 5.5', value: 'claude-sonnet-5.5' },
  { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4.6' },
  { label: 'Claude Opus 4.6', value: 'claude-opus-4.6' },
  { label: 'GPT-5', value: 'openai/gpt-5' },
  { label: 'GPT-4.1', value: 'openai/gpt-4.1' },
  { label: 'GPT-4o', value: 'openai/gpt-4o' },
  { label: 'GPT-4o Mini', value: 'openai/gpt-4o-mini' },
];

// ---- Preload API ----

export interface AuraAPI {
  getAuthStatus: () => Promise<AuthStatus>;

  sendTranscript: (segment: TranscriptSegment) => void;
  sendPartialTranscript: (segment: PartialTranscriptSegment) => void;
  onMeetingCardCreated: (cb: (event: MeetingCardEvent) => void) => () => void;
  onMeetingCardUpdated: (cb: (event: MeetingCardEvent) => void) => () => void;
  cancelMeetingCard: (cardId: string) => void;
  removeMeetingCard: (cardId: string) => void;
  clearMeetingHistory: () => void;
  /** Records how the user reacted to a card, so the active profile can learn from it. */
  sendMeetingCardSignal: (cardId: string, signal: MeetingCardSignal) => void;
  onMeetingCardRemoved: (cb: (event: MeetingCardRemovedEvent) => void) => () => void;

  getAudioStatus: () => Promise<AudioStatus>;
  setAudioListeningState: (listening: boolean) => void;
  onAudioToggle: (cb: (listening: boolean) => void) => () => void;
  transcribeAudioSegment: (request: SttTranscriptionRequest) => Promise<SttTranscriptionResponse>;
  getAzureSpeechToken: () => Promise<AzureSpeechTokenResponse>;

  getSettings: () => Promise<AuraSettings>;
  saveSettings: (settings: AuraSettings) => Promise<AuraSettings>;
  listModels: () => Promise<string[]>;
  capturePrimaryScreen: (request: VisualCaptureRequest) => Promise<VisualContextPayload>;
  openExternalUrl: (url: string) => Promise<boolean>;

  getProfiles: () => Promise<ProfilesState>;
  saveProfiles: (profiles: MeetingProfile[]) => Promise<ProfilesState>;
  setActiveProfile: (profileId: string) => Promise<ProfilesState>;
  onProfilesChanged: (cb: (state: ProfilesState) => void) => () => void;

  getWorkIqAuthStatus: (settings: WorkIqAuthSettings) => Promise<WorkIqAuthStatus>;
  connectWorkIq: (settings: WorkIqAuthSettings) => Promise<WorkIqAuthStatus>;
  disconnectWorkIq: () => Promise<WorkIqAuthStatus>;
}

declare global {
  interface Window {
    aura: AuraAPI;
  }
}
