import { useState, useEffect, useRef, useCallback } from 'react';
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import { createModel, KaldiRecognizer, Model } from 'vosk-browser';
import { resolveCachedSttModelUrl } from '../audio/stt-model-cache';
import { formatLocalSttFailure } from '../audio/stt-errors';
import { encodeMonoPcm16Wav } from '../audio/wav-encoder';
import { createAudioCapturePlan, createSystemAudioDisplayMediaOptions } from '../../shared/audio-source';
import type { AudioSource, AuraSettings } from '../../shared/types';

interface UseAudioCaptureOptions {
  onTranscript: (text: string, source: AudioSource) => void;
  onPartial?: (text: string, source: AudioSource) => void;
  onError?: (error: string) => void;
}

type AudioCaptureStatus = 'idle' | 'loading-model' | 'listening' | 'error';

interface BaseCapturePipeline {
  source: AudioSource;
  stream: MediaStream;
}

interface ProcessorCapturePipeline extends BaseCapturePipeline {
  audioContext: AudioContext;
  processor: ScriptProcessorNode;
  mediaSource: MediaStreamAudioSourceNode;
}

interface LocalCapturePipeline extends ProcessorCapturePipeline {
  kind: 'local';
  recognizer: KaldiRecognizer;
}

interface AzureMaiCapturePipeline extends ProcessorCapturePipeline {
  kind: 'azure_mai';
  sampleRate: number;
  segmentDurationSeconds: number;
  segmentStartedAt: number;
  chunks: Float32Array[];
  bufferedSamples: number;
  inFlight: boolean;
  stopped: boolean;
  onTranscript: (text: string, source: AudioSource) => void;
  onProviderFailure: (reason: string) => Promise<void>;
}

interface AzureRealtimeCapturePipeline extends BaseCapturePipeline {
  kind: 'azure_realtime';
  speechConfig: SpeechSDK.SpeechConfig;
  audioConfig: SpeechSDK.AudioConfig;
  recognizer: SpeechSDK.SpeechRecognizer;
  tokenRefreshTimer: ReturnType<typeof setInterval>;
  stopped: boolean;
}

type CapturePipeline = LocalCapturePipeline | AzureMaiCapturePipeline | AzureRealtimeCapturePipeline;

export function useAudioCapture({ onTranscript, onPartial, onError }: UseAudioCaptureOptions) {
  const [listening, setListening] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [activeSources, setActiveSources] = useState<AudioSource[]>([]);
  const [status, setStatus] = useState<AudioCaptureStatus>('idle');

  const modelRef = useRef<Model | null>(null);
  const pipelinesRef = useRef<CapturePipeline[]>([]);
  const azureFallbackStartedRef = useRef(false);
  const azureFallbackReasonRef = useRef<string | null>(null);

  const loadModel = useCallback(async () => {
    if (modelRef.current || modelLoading) return modelRef.current;

    setModelLoading(true);
    setStatus('loading-model');

    try {
      const settings = await window.aura.getSettings();
      const modelUrl = await resolveCachedSttModelUrl(settings.localSttModelUrl);
      console.log('[Vosk] Loading model from', modelUrl.startsWith('blob:') ? 'local cache' : modelUrl);
      const model = await createModel(modelUrl);
      modelRef.current = model;
      setModelReady(true);
      console.log('[Vosk] Model loaded successfully');
      return model;
    } catch (err) {
      const message = formatUnknownError(err);
      console.error('[Vosk] Model load failed:', message);
      onError?.(formatLocalSttFailure(
        `Failed to load Vosk model: ${message}`,
        azureFallbackReasonRef.current ?? undefined,
      ));
      setStatus('error');
      return null;
    } finally {
      setModelLoading(false);
    }
  }, [modelLoading, onError]);

  const startLocalListening = useCallback(async (settings: AuraSettings) => {
    try {
      const model = modelRef.current ?? await loadModel();
      if (!model) return;

      const plan = createAudioCapturePlan(settings.audioSource);
      const pipelines: CapturePipeline[] = [];

      for (const request of plan.requests) {
        try {
          const stream = await captureMediaStream(request.source);
          const pipeline = createLocalPipeline({
            model,
            source: request.source,
            stream,
            onTranscript,
            onPartial,
          });
          pipelines.push(pipeline);
        } catch (err) {
          const message = formatUnknownError(err);
          if (request.required) throw new Error(message);
          console.warn(`[Audio] Optional ${request.source} capture unavailable:`, message);
          onError?.(`${sourceLabel(request.source)} capture unavailable; continuing with available audio.`);
        }
      }

      if (pipelines.length === 0) {
        throw new Error('No meeting audio sources were captured.');
      }

      pipelinesRef.current = pipelines;
      setActiveSources(pipelines.map((pipeline) => pipeline.source));
      setListening(true);
      setStatus('listening');
      console.log('[Vosk] Listening to', pipelines.map((pipeline) => pipeline.source).join(', '));
    } catch (err) {
      stopPipelines(pipelinesRef.current);
      pipelinesRef.current = [];
      setActiveSources([]);
      const message = formatUnknownError(err);
      console.error('[Vosk] Start failed:', message);
      onError?.(formatLocalSttFailure(message, azureFallbackReasonRef.current ?? undefined));
      setStatus('error');
    }
  }, [loadModel, onTranscript, onPartial, onError]);

  const fallbackToLocal = useCallback(async (reason: string) => {
    if (azureFallbackStartedRef.current) return;
    azureFallbackStartedRef.current = true;
    azureFallbackReasonRef.current = reason;

    console.warn('[Azure STT] Falling back to local Vosk:', reason);
    onError?.(`Azure transcription unavailable; falling back to local Vosk. ${reason}`);
    stopPipelines(pipelinesRef.current);
    pipelinesRef.current = [];
    setActiveSources([]);
    setListening(false);

    const settings = await window.aura.getSettings();
    await startLocalListening({ ...settings, sttProvider: 'local_vosk' });
  }, [onError, startLocalListening]);

  const startAzureMaiListening = useCallback(async (settings: AuraSettings) => {
    const plan = createAudioCapturePlan(settings.audioSource);
    const pipelines: CapturePipeline[] = [];

    for (const request of plan.requests) {
      try {
        const stream = await captureMediaStream(request.source);
        const pipeline = createAzureMaiPipeline({
          source: request.source,
          stream,
          segmentDurationSeconds: settings.azureStt.segmentDurationSeconds,
          onTranscript,
          onProviderFailure: fallbackToLocal,
        });
        pipelines.push(pipeline);
      } catch (err) {
        const message = formatUnknownError(err);
        if (request.required) throw new Error(message);
        console.warn(`[Audio] Optional ${request.source} capture unavailable:`, message);
        onError?.(`${sourceLabel(request.source)} capture unavailable; continuing with available audio.`);
      }
    }

    if (pipelines.length === 0) {
      throw new Error('No meeting audio sources were captured.');
    }

    pipelinesRef.current = pipelines;
    setActiveSources(pipelines.map((pipeline) => pipeline.source));
    setListening(true);
    setStatus('listening');
    console.log('[Azure MAI STT] Listening to', pipelines.map((pipeline) => pipeline.source).join(', '));
  }, [onTranscript, onError, fallbackToLocal]);

  const startAzureRealtimeListening = useCallback(async (settings: AuraSettings) => {
    const plan = createAudioCapturePlan(settings.audioSource);
    const pipelines: CapturePipeline[] = [];

    for (const request of plan.requests) {
      try {
        const stream = await captureMediaStream(request.source);
        const pipeline = await createAzureRealtimePipeline({
          source: request.source,
          stream,
          settings,
          onTranscript,
          onPartial,
          onProviderFailure: fallbackToLocal,
        });
        pipelines.push(pipeline);
      } catch (err) {
        const message = formatUnknownError(err);
        if (request.required) throw new Error(message);
        console.warn(`[Audio] Optional ${request.source} capture unavailable:`, message);
        onError?.(`${sourceLabel(request.source)} capture unavailable; continuing with available audio.`);
      }
    }

    if (pipelines.length === 0) {
      throw new Error('No meeting audio sources were captured.');
    }

    pipelinesRef.current = pipelines;
    setActiveSources(pipelines.map((pipeline) => pipeline.source));
    setListening(true);
    setStatus('listening');
    console.log('[Azure Speech realtime] Listening to', pipelines.map((pipeline) => pipeline.source).join(', '));
  }, [onTranscript, onPartial, onError, fallbackToLocal]);

  const stopListening = useCallback(() => {
    console.log('[Audio] Stopping...');
    stopPipelines(pipelinesRef.current);
    pipelinesRef.current = [];
    azureFallbackStartedRef.current = false;
    azureFallbackReasonRef.current = null;
    setActiveSources([]);
    setListening(false);
    setStatus('idle');
  }, []);

  const startListening = useCallback(async () => {
    if (listening) return;

    azureFallbackStartedRef.current = false;
    azureFallbackReasonRef.current = null;

    try {
      const settings = await window.aura.getSettings();
      if (settings.sttProvider === 'azure_mai_transcribe') {
        try {
          await startAzureMaiListening(settings);
        } catch (err) {
          await fallbackToLocal(formatUnknownError(err));
        }
        return;
      }

      if (settings.sttProvider === 'azure_speech_realtime') {
        try {
          await startAzureRealtimeListening(settings);
        } catch (err) {
          await fallbackToLocal(formatUnknownError(err));
        }
        return;
      }

      await startLocalListening(settings);
    } catch (err) {
      stopPipelines(pipelinesRef.current);
      pipelinesRef.current = [];
      setActiveSources([]);
      const message = formatUnknownError(err);
      console.error('[Audio] Start failed:', message);
      onError?.(message);
      setStatus('error');
    }
  }, [listening, startAzureMaiListening, startAzureRealtimeListening, startLocalListening, fallbackToLocal, onError]);

  useEffect(() => {
    return () => {
      stopPipelines(pipelinesRef.current);
      if (modelRef.current) modelRef.current.terminate();
    };
  }, []);

  return { listening, modelLoading, modelReady, activeSources, status, startListening, stopListening };
}

async function captureMediaStream(source: AudioSource): Promise<MediaStream> {
  if (source === 'mic') {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: 16000,
      },
    });
  }

  const stream = await navigator.mediaDevices.getDisplayMedia(createSystemAudioDisplayMediaOptions());

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('No system audio track was selected.');
  }

  return stream;
}

function createLocalPipeline(input: {
  model: Model;
  source: AudioSource;
  stream: MediaStream;
  onTranscript: (text: string, source: AudioSource) => void;
  onPartial?: (text: string, source: AudioSource) => void;
}): LocalCapturePipeline {
  const recognizer = new input.model.KaldiRecognizer(16000);

  recognizer.on('result', (message: unknown) => {
    const text = parseRecognizerText(message, 'text');
    if (text) {
      console.log(`[Vosk] ${input.source} result:`, text);
      input.onTranscript(text, input.source);
    }
  });

  recognizer.on('partialresult', (message: unknown) => {
    const partial = parseRecognizerText(message, 'partial');
    if (partial) {
      input.onPartial?.(partial, input.source);
    }
  });

  const audioContext = new AudioContext({ sampleRate: 16000 });
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    try {
      recognizer.acceptWaveform(event.inputBuffer);
    } catch (err) {
      console.error(`[Vosk] ${input.source} acceptWaveform failed`, err);
    }
  };

  const mediaSource = audioContext.createMediaStreamSource(input.stream);
  mediaSource.connect(processor);
  processor.connect(audioContext.destination);

  return {
    kind: 'local',
    source: input.source,
    stream: input.stream,
    audioContext,
    processor,
    mediaSource,
    recognizer,
  };
}

function createAzureMaiPipeline(input: {
  source: AudioSource;
  stream: MediaStream;
  segmentDurationSeconds: number;
  onTranscript: (text: string, source: AudioSource) => void;
  onProviderFailure: (reason: string) => Promise<void>;
}): AzureMaiCapturePipeline {
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mediaSource = audioContext.createMediaStreamSource(input.stream);
  const pipeline: AzureMaiCapturePipeline = {
    kind: 'azure_mai',
    source: input.source,
    stream: input.stream,
    audioContext,
    processor,
    mediaSource,
    sampleRate: audioContext.sampleRate,
    segmentDurationSeconds: input.segmentDurationSeconds,
    segmentStartedAt: Date.now() / 1000,
    chunks: [],
    bufferedSamples: 0,
    inFlight: false,
    stopped: false,
    onTranscript: input.onTranscript,
    onProviderFailure: input.onProviderFailure,
  };

  processor.onaudioprocess = (event) => {
    if (pipeline.stopped) return;

    const samples = event.inputBuffer.getChannelData(0);
    pipeline.chunks.push(new Float32Array(samples));
    pipeline.bufferedSamples += samples.length;

    if (pipeline.bufferedSamples >= pipeline.sampleRate * pipeline.segmentDurationSeconds) {
      void flushAzureSegment(pipeline);
    }
  };

  mediaSource.connect(processor);
  processor.connect(audioContext.destination);
  return pipeline;
}

async function createAzureRealtimePipeline(input: {
  source: AudioSource;
  stream: MediaStream;
  settings: AuraSettings;
  onTranscript: (text: string, source: AudioSource) => void;
  onPartial?: (text: string, source: AudioSource) => void;
  onProviderFailure: (reason: string) => Promise<void>;
}): Promise<AzureRealtimeCapturePipeline> {
  const endpoint = input.settings.azureStt.endpoint.trim();
  if (!endpoint) {
    throw new Error('Azure Speech endpoint is not set. Enter it in Settings.');
  }

  const token = await getAzureSpeechTokenOrThrow();
  const speechConfig = SpeechSDK.SpeechConfig.fromEndpoint(new URL(endpoint));
  speechConfig.authorizationToken = token;
  speechConfig.speechRecognitionLanguage = input.settings.azureStt.realtimeLanguage.trim() || 'en-US';

  const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(input.stream);
  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
  const pipeline: AzureRealtimeCapturePipeline = {
    kind: 'azure_realtime',
    source: input.source,
    stream: input.stream,
    speechConfig,
    audioConfig,
    recognizer,
    tokenRefreshTimer: setInterval(() => {
      void refreshAzureRealtimeToken(pipeline);
    }, 45 * 60 * 1000),
    stopped: false,
  };

  recognizer.recognizing = (_sender, event) => {
    const text = event.result.text.trim();
    if (text) input.onPartial?.(text, input.source);
  };

  recognizer.recognized = (_sender, event) => {
    if (event.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
      const text = event.result.text.trim();
      if (text) input.onTranscript(text, input.source);
    }
  };

  recognizer.canceled = (_sender, event) => {
    if (pipeline.stopped) return;
    const details = event.errorDetails ? ` ${event.errorDetails}` : '';
    void input.onProviderFailure(`Azure Speech real-time recognition canceled: ${event.reason}.${details}`);
  };

  recognizer.sessionStopped = () => {
    if (!pipeline.stopped) {
      void input.onProviderFailure('Azure Speech real-time session stopped unexpectedly.');
    }
  };

  await startContinuousRecognition(recognizer);
  return pipeline;
}

async function flushAzureSegment(pipeline: AzureMaiCapturePipeline): Promise<void> {
  if (pipeline.inFlight || pipeline.bufferedSamples === 0 || pipeline.stopped) return;

  const chunks = pipeline.chunks;
  const sampleCount = pipeline.bufferedSamples;
  const startedAt = pipeline.segmentStartedAt;
  const endedAt = startedAt + sampleCount / pipeline.sampleRate;
  pipeline.chunks = [];
  pipeline.bufferedSamples = 0;
  pipeline.segmentStartedAt = endedAt;
  pipeline.inFlight = true;

  try {
    const wav = encodeMonoPcm16Wav(chunks, pipeline.sampleRate);
    const response = await window.aura.transcribeAudioSegment({
      source: pipeline.source,
      audioData: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      mimeType: 'audio/wav',
      startedAt: Math.floor(startedAt),
      endedAt: Math.ceil(endedAt),
    });

    if (pipeline.stopped) return;

    if (response.status === 'ready') {
      const text = response.text?.trim();
      if (text) pipeline.onTranscript(text, pipeline.source);
      return;
    }

    if (response.status === 'no_speech') {
      return;
    }

    await pipeline.onProviderFailure(response.error ?? 'Azure transcription returned no text.');
  } catch (err) {
    if (!pipeline.stopped) {
      await pipeline.onProviderFailure(formatUnknownError(err));
    }
  } finally {
    pipeline.inFlight = false;
    if (
      !pipeline.stopped
      && pipeline.bufferedSamples >= pipeline.sampleRate * pipeline.segmentDurationSeconds
    ) {
      void flushAzureSegment(pipeline);
    }
  }
}

async function getAzureSpeechTokenOrThrow(): Promise<string> {
  const response = await window.aura.getAzureSpeechToken();
  if (!response.ok || !response.token) {
    throw new Error(response.error ?? 'Azure Speech token request failed.');
  }

  return response.token;
}

async function refreshAzureRealtimeToken(pipeline: AzureRealtimeCapturePipeline): Promise<void> {
  try {
    const token = await getAzureSpeechTokenOrThrow();
    pipeline.speechConfig.authorizationToken = token;
    pipeline.recognizer.authorizationToken = token;
  } catch (err) {
    console.warn('[Azure Speech realtime] Failed to refresh token:', err);
  }
}

async function startContinuousRecognition(recognizer: SpeechSDK.SpeechRecognizer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    recognizer.startContinuousRecognitionAsync(resolve, reject);
  });
}

async function stopContinuousRecognition(recognizer: SpeechSDK.SpeechRecognizer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    recognizer.stopContinuousRecognitionAsync(resolve, reject);
  });
}

async function closeSpeechRecognizer(recognizer: SpeechSDK.SpeechRecognizer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    recognizer.close(resolve, reject);
  });
}

function parseRecognizerText(message: unknown, field: 'text' | 'partial'): string {
  if (!message || typeof message !== 'object') return '';
  const result = (message as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return '';
  const value = (result as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}

function stopPipelines(pipelines: CapturePipeline[]): void {
  for (const pipeline of pipelines) {
    if (pipeline.kind === 'azure_mai') {
      pipeline.stopped = true;
      pipeline.chunks = [];
      pipeline.bufferedSamples = 0;
    }

    if (pipeline.kind === 'azure_realtime') {
      pipeline.stopped = true;
      clearInterval(pipeline.tokenRefreshTimer);
      stopContinuousRecognition(pipeline.recognizer)
        .catch((err: unknown) => {
          console.warn('[Azure Speech realtime] Failed to stop recognition:', err);
        })
        .finally(() => {
          closeSpeechRecognizer(pipeline.recognizer).catch((err: unknown) => {
            console.warn('[Azure Speech realtime] Failed to close recognizer:', err);
          });
          pipeline.audioConfig.close();
          pipeline.speechConfig.close();
        });
      pipeline.stream.getTracks().forEach((track) => track.stop());
      continue;
    }

    pipeline.processor.disconnect();
    pipeline.mediaSource.disconnect();
    pipeline.audioContext.close().catch((err: unknown) => {
      console.warn('[Audio] Failed to close AudioContext:', err);
    });
    pipeline.stream.getTracks().forEach((track) => track.stop());

    if (pipeline.kind === 'local') {
      pipeline.recognizer.remove();
    }
  }
}

function sourceLabel(source: AudioSource): string {
  return source === 'mic' ? 'Microphone' : 'System audio';
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
