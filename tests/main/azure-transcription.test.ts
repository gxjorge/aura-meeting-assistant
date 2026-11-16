import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/types.js';
import {
  buildAzureMaiTranscriptionDefinition,
  buildAzureTranscriptionUrl,
  getAzureSpeechToken,
  parseAzureLocales,
  parseAzureTranscriptionPayload,
  transcribeWithAzureMai,
} from '../../src/main/azure-transcription.js';

const AZURE_SETTINGS = {
  ...DEFAULT_SETTINGS.azureStt,
  endpoint: 'https://your-resource.cognitiveservices.azure.com/',
};

describe('Azure MAI transcription service', () => {
  it('builds the documented LLM Speech transcription URL', () => {
    expect(buildAzureTranscriptionUrl('https://example.cognitiveservices.azure.com/')).toBe(
      'https://example.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
    );
    expect(buildAzureTranscriptionUrl('http://example.cognitiveservices.azure.com/')).toBeNull();
  });

  it('builds the MAI-Transcribe enhanced mode definition', () => {
    expect(buildAzureMaiTranscriptionDefinition({
      ...DEFAULT_SETTINGS.azureStt,
      locales: 'en, es; fr',
      transcribeStyle: 'verbatim',
    })).toEqual({
      locales: ['en', 'es', 'fr'],
      enhancedMode: {
        enabled: true,
        task: 'transcribe',
        model: 'mai-transcribe-2',
        transcribeStyle: 'verbatim',
      },
    });
  });

  it('parses optional locale lists', () => {
    expect(parseAzureLocales(' en,es; fr  ')).toEqual(['en', 'es', 'fr']);
    expect(parseAzureLocales('')).toEqual([]);
  });

  it('normalizes Azure transcription payloads', () => {
    expect(parseAzureTranscriptionPayload({
      durationInMs: 1200,
      combinedPhrases: [{ text: 'Hello there.' }],
      phrases: [
        { text: 'Hello', confidence: 0.8, locale: 'en-US' },
        { text: 'there.', confidence: 1 },
      ],
    })).toEqual({
      text: 'Hello there.',
      confidence: 0.9,
      locale: 'en-US',
      durationInMs: 1200,
    });
  });

  it('recognizes a valid Azure response with no speech', () => {
    expect(parseAzureTranscriptionPayload({
      durationInMs: 10_000,
      combinedPhrases: [],
      phrases: [],
    })).toEqual({
      text: '',
      durationInMs: 10_000,
    });
  });

  it('posts an audio buffer with Entra bearer auth and returns transcript text', async () => {
    const requests: { input: string | URL | Request; init?: RequestInit }[] = [];
    const credential = {
      getToken: async () => ({ token: 'test-token' }),
    };
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        durationInMs: 500,
        combinedPhrases: [{ text: 'Azure transcript' }],
        phrases: [{ text: 'Azure transcript', confidence: 0.95, locale: 'en-US' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await transcribeWithAzureMai({
      settings: AZURE_SETTINGS,
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    }, {
      credential,
      fetchFn,
    });

    expect(result).toEqual({
      ok: true,
      text: 'Azure transcript',
      confidence: 0.95,
      locale: 'en-US',
      durationInMs: 500,
    });
    expect(requests).toHaveLength(1);
    expect(String(requests[0].input)).toBe(
      'https://your-resource.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
    );
    expect(requests[0].init?.headers).toEqual({
      Authorization: 'Bearer test-token',
    });

    const body = requests[0].init?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error('Expected FormData body');

    const definitionEntry = body.get('definition');
    expect(typeof definitionEntry).toBe('string');
    if (typeof definitionEntry !== 'string') throw new Error('Expected string definition');

    const definition: unknown = JSON.parse(definitionEntry);
    expect(definition).toEqual({
      enhancedMode: {
        enabled: true,
        task: 'transcribe',
        model: 'mai-transcribe-2',
      },
    });
    expect(body.get('audio')).toBeInstanceOf(Blob);
  });

  it('returns a successful no-speech result for a silent segment', async () => {
    const result = await transcribeWithAzureMai({
      settings: AZURE_SETTINGS,
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    }, {
      credential: {
        getToken: async () => ({ token: 'test-token' }),
      },
      fetchFn: async () => new Response(JSON.stringify({
        durationInMs: 10_000,
        combinedPhrases: [],
        phrases: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    expect(result).toEqual({
      ok: true,
      text: null,
      durationInMs: 10_000,
    });
  });

  it('returns a failed result for invalid settings before calling Azure', async () => {
    let called = false;
    const result = await transcribeWithAzureMai({
      settings: {
        ...DEFAULT_SETTINGS.azureStt,
        endpoint: 'not-a-url',
      },
      audioBytes: new Uint8Array([1]),
      mimeType: 'audio/wav',
    }, {
      credential: {
        getToken: async () => ({ token: 'unused' }),
      },
      fetchFn: async () => {
        called = true;
        return new Response('{}');
      },
    });

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('asks for an endpoint when none is configured, without calling Azure', async () => {
    let called = false;
    const result = await transcribeWithAzureMai({
      settings: DEFAULT_SETTINGS.azureStt,
      audioBytes: new Uint8Array([1]),
      mimeType: 'audio/wav',
    }, {
      credential: {
        getToken: async () => ({ token: 'unused' }),
      },
      fetchFn: async () => {
        called = true;
        return new Response('{}');
      },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Azure Speech endpoint is not set. Enter it in Settings.',
    });
    expect(called).toBe(false);
  });

  it('retries transient HTTP failures twice and reuses the audio segment', async () => {
    const requestBodies: BodyInit[] = [];
    const delays: number[] = [];
    let requestCount = 0;
    const result = await transcribeWithAzureMai({
      settings: AZURE_SETTINGS,
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    }, {
      credential: {
        getToken: async () => ({ token: 'test-token' }),
      },
      fetchFn: async (_input, init) => {
        requestCount += 1;
        if (init?.body) requestBodies.push(init.body);
        if (requestCount === 1) {
          return new Response('Busy', {
            status: 429,
            headers: { 'Retry-After': '1' },
          });
        }
        if (requestCount === 2) {
          return new Response('Unavailable', { status: 503 });
        }
        return new Response(JSON.stringify({
          combinedPhrases: [{ text: 'Recovered transcript' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleepFn: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result).toEqual({
      ok: true,
      text: 'Recovered transcript',
    });
    expect(requestCount).toBe(3);
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies.every((body) => body instanceof FormData)).toBe(true);
    expect(delays).toEqual([1_000, 500]);
  });

  it('reports an exhausted transient retry limit after three requests', async () => {
    let requestCount = 0;
    const result = await transcribeWithAzureMai({
      settings: AZURE_SETTINGS,
      audioBytes: new Uint8Array([1]),
      mimeType: 'audio/wav',
    }, {
      credential: {
        getToken: async () => ({ token: 'test-token' }),
      },
      fetchFn: async () => {
        requestCount += 1;
        throw new TypeError('fetch failed');
      },
      sleepFn: async () => {},
    });

    expect(result).toEqual({
      ok: false,
      error: 'Azure transcription request failed after 3 attempts: fetch failed',
    });
    expect(requestCount).toBe(3);
  });

  it('does not retry permanent HTTP failures', async () => {
    let requestCount = 0;
    const result = await transcribeWithAzureMai({
      settings: AZURE_SETTINGS,
      audioBytes: new Uint8Array([1]),
      mimeType: 'audio/wav',
    }, {
      credential: {
        getToken: async () => ({ token: 'test-token' }),
      },
      fetchFn: async () => {
        requestCount += 1;
        return new Response('Forbidden', { status: 403 });
      },
      sleepFn: async () => {
        throw new Error('Permanent failures must not wait for a retry');
      },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Azure transcription failed with HTTP 403. Forbidden',
    });
    expect(requestCount).toBe(1);
  });

  it('does not retry invalid successful responses', async () => {
    let requestCount = 0;
    const result = await transcribeWithAzureMai({
      settings: AZURE_SETTINGS,
      audioBytes: new Uint8Array([1]),
      mimeType: 'audio/wav',
    }, {
      credential: {
        getToken: async () => ({ token: 'test-token' }),
      },
      fetchFn: async () => {
        requestCount += 1;
        return new Response('{', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleepFn: async () => {
        throw new Error('Invalid payloads must not wait for a retry');
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected a failed transcription');
    expect(result.error).toContain('Azure transcription returned an invalid response:');
    expect(requestCount).toBe(1);
  });

  it('returns a short-lived Azure Speech token from the configured credential', async () => {
    const result = await getAzureSpeechToken({
      credential: {
        getToken: async (scopes) => {
          expect(scopes).toBe('https://cognitiveservices.azure.com/.default');
          return {
            token: 'speech-token',
            expiresOnTimestamp: 1234,
          };
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      token: 'speech-token',
      expiresOnTimestamp: 1234,
    });
  });
});
