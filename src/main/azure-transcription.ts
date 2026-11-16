import {
  AZURE_COGNITIVE_SERVICES_SCOPE,
  defaultAzureCredential,
  type TokenProvider,
} from './azure-credential.js';
import type {
  AzureSpeechTokenResponse,
  AzureSttSettings,
  AzureTranscribeModel,
} from '../shared/types.js';

const AZURE_SPEECH_API_VERSION = '2025-10-15';
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_DELAYS_MS = [250, 500] as const;
const MAX_RETRY_AFTER_MS = 5_000;

interface AzureTranscriptionDependencies {
  credential?: TokenProvider;
  fetchFn?: typeof fetch;
  sleepFn?: (delayMs: number) => Promise<void>;
}

interface AzureMaiEnhancedModeDefinition {
  enabled: true;
  task: 'transcribe';
  model: AzureTranscribeModel;
  transcribeStyle?: 'verbatim';
}

interface AzureMaiTranscriptionDefinition {
  locales?: string[];
  enhancedMode: AzureMaiEnhancedModeDefinition;
}

export interface AzureMaiTranscriptionRequest {
  settings: AzureSttSettings;
  audioBytes: Uint8Array;
  mimeType: 'audio/wav';
  abortSignal?: AbortSignal;
}

export interface AzureMaiTranscriptionSuccess {
  ok: true;
  text: string;
  confidence?: number;
  locale?: string;
  durationInMs?: number;
}

export interface AzureMaiTranscriptionNoSpeech {
  ok: true;
  text: null;
  durationInMs?: number;
}

export interface AzureMaiTranscriptionFailure {
  ok: false;
  error: string;
}

export type AzureMaiTranscriptionResult =
  | AzureMaiTranscriptionSuccess
  | AzureMaiTranscriptionNoSpeech
  | AzureMaiTranscriptionFailure;

interface ParsedAzureTranscriptionPayload {
  text: string;
  confidence?: number;
  locale?: string;
  durationInMs?: number;
}

export async function getAzureSpeechToken(
  dependencies: Pick<AzureTranscriptionDependencies, 'credential'> = {},
): Promise<AzureSpeechTokenResponse> {
  const credential = dependencies.credential ?? defaultAzureCredential;

  try {
    const token = await credential.getToken(AZURE_COGNITIVE_SERVICES_SCOPE);
    if (!token?.token) {
      return {
        ok: false,
        error: 'Azure authentication did not return an access token.',
      };
    }

    return {
      ok: true,
      token: token.token,
      expiresOnTimestamp: token.expiresOnTimestamp,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Azure Speech token request failed: ${formatUnknownError(err)}`,
    };
  }
}

export async function transcribeWithAzureMai(
  request: AzureMaiTranscriptionRequest,
  dependencies: AzureTranscriptionDependencies = {},
): Promise<AzureMaiTranscriptionResult> {
  const endpointUrl = buildAzureTranscriptionUrl(request.settings.endpoint);
  if (!endpointUrl) {
    return failed(
      request.settings.endpoint.trim()
        ? 'Azure Speech endpoint must be a valid HTTPS URL.'
        : 'Azure Speech endpoint is not set. Enter it in Settings.',
    );
  }

  if (request.audioBytes.byteLength === 0) {
    return failed('Azure transcription requires a non-empty audio segment.');
  }

  const credential = dependencies.credential ?? defaultAzureCredential;
  const fetchFn = dependencies.fetchFn ?? fetch;
  const sleepFn = dependencies.sleepFn ?? sleep;

  let token: Awaited<ReturnType<TokenProvider['getToken']>>;
  try {
    token = await credential.getToken(AZURE_COGNITIVE_SERVICES_SCOPE);
  } catch (err) {
    return failed(`Azure Speech token request failed: ${formatUnknownError(err)}`);
  }

  if (!token?.token) {
    return failed('Azure authentication did not return an access token.');
  }

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await fetchFn(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
        },
        body: createAzureTranscriptionFormData(request),
        signal: request.abortSignal,
      });
    } catch (err) {
      if (request.abortSignal?.aborted || isAbortError(err)) {
        return failed(`Azure transcription request was cancelled: ${formatUnknownError(err)}`);
      }

      if (attempt < MAX_TRANSIENT_RETRIES) {
        await sleepFn(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      return failed(
        `Azure transcription request failed after ${attempt + 1} attempts: ${formatUnknownError(err)}`,
      );
    }

    if (!response.ok) {
      const errorBody = await readResponseText(response);
      const error = formatHttpError(response.status, errorBody);
      if (isTransientHttpStatus(response.status) && attempt < MAX_TRANSIENT_RETRIES) {
        await sleepFn(resolveRetryDelayMs(response, attempt));
        continue;
      }

      return failed(
        isTransientHttpStatus(response.status)
          ? `${error} Retry limit reached after ${attempt + 1} attempts.`
          : error,
      );
    }

    try {
      const payload: unknown = await response.json();
      const parsed = parseAzureTranscriptionPayload(payload);
      if (!parsed) {
        return failed('Azure transcription returned an invalid response payload.');
      }

      if (!parsed.text) {
        return {
          ok: true,
          text: null,
          ...(parsed.durationInMs !== undefined ? { durationInMs: parsed.durationInMs } : {}),
        };
      }

      return {
        ok: true,
        text: parsed.text,
        ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
        ...(parsed.locale ? { locale: parsed.locale } : {}),
        ...(parsed.durationInMs !== undefined ? { durationInMs: parsed.durationInMs } : {}),
      };
    } catch (err) {
      return failed(`Azure transcription returned an invalid response: ${formatUnknownError(err)}`);
    }
  }

  return failed('Azure transcription failed unexpectedly.');
}

export function buildAzureTranscriptionUrl(endpoint: string): string | null {
  try {
    const url = new URL(endpoint.trim());
    if (url.protocol !== 'https:') return null;

    const pathPrefix = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    url.pathname = `${pathPrefix}/speechtotext/transcriptions:transcribe`;
    url.search = '';
    url.searchParams.set('api-version', AZURE_SPEECH_API_VERSION);
    return url.toString();
  } catch {
    return null;
  }
}

export function buildAzureMaiTranscriptionDefinition(
  settings: AzureSttSettings,
): AzureMaiTranscriptionDefinition {
  const locales = parseAzureLocales(settings.locales);
  const enhancedMode: AzureMaiEnhancedModeDefinition = {
    enabled: true,
    task: 'transcribe',
    model: settings.model,
    ...(settings.transcribeStyle === 'verbatim' ? { transcribeStyle: 'verbatim' } : {}),
  };

  return {
    ...(locales.length > 0 ? { locales } : {}),
    enhancedMode,
  };
}

export function parseAzureLocales(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((locale) => locale.trim())
    .filter((locale) => locale.length > 0);
}

export function parseAzureTranscriptionPayload(
  payload: unknown,
): ParsedAzureTranscriptionPayload | null {
  const root = asRecord(payload);
  if (!root) return null;
  if (!Array.isArray(root.combinedPhrases) && !Array.isArray(root.phrases)) return null;

  const combinedTexts = getRecords(root.combinedPhrases)
    .map((phrase) => readString(phrase, 'text'))
    .filter((text) => text.length > 0);

  const phrases = getRecords(root.phrases);
  const phraseTexts = phrases
    .map((phrase) => readString(phrase, 'text'))
    .filter((text) => text.length > 0);
  const text = (combinedTexts.length > 0 ? combinedTexts : phraseTexts).join(' ').trim();

  const confidences = phrases
    .map((phrase) => readNumber(phrase, 'confidence'))
    .filter((confidence): confidence is number => confidence !== undefined);
  const confidence = confidences.length > 0
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : undefined;
  const locale = phrases
    .map((phrase) => readString(phrase, 'locale'))
    .find((value) => value.length > 0);
  const durationInMs = readNumber(root, 'durationInMs');

  return {
    text,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(locale ? { locale } : {}),
    ...(durationInMs !== undefined ? { durationInMs } : {}),
  };
}

function createAzureTranscriptionFormData(request: AzureMaiTranscriptionRequest): FormData {
  const body = new FormData();
  const audio = new Blob([copyToArrayBuffer(request.audioBytes)], { type: request.mimeType });
  body.append('audio', audio, 'meeting-segment.wav');
  body.append('definition', JSON.stringify(buildAzureMaiTranscriptionDefinition(request.settings)));
  return body;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return truncate(await response.text());
  } catch (err) {
    return `Unable to read error body: ${formatUnknownError(err)}`;
  }
}

function formatHttpError(status: number, body: string): string {
  const suffix = body ? ` ${body}` : '';
  return `Azure transcription failed with HTTP ${status}.${suffix}`;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function resolveRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_AFTER_MS);
    }
  }

  return RETRY_DELAYS_MS[attempt];
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

function failed(error: string): AzureMaiTranscriptionFailure {
  return { ok: false, error };
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((record): record is Record<string, unknown> => record !== null);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
