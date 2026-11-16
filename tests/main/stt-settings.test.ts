import { describe, expect, it } from 'vitest';
import {
  AZURE_TRANSCRIBE_MODEL_OPTIONS,
  AZURE_TRANSCRIBE_STYLE_OPTIONS,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_SETTINGS,
  DEFAULT_WORKIQ_CLIENT_ID,
  DEFAULT_WORKIQ_TENANT_ID,
  TRIAGE_CADENCE_MODE_OPTIONS,
  STT_PROVIDER_OPTIONS,
} from '../../src/shared/types.js';
import { createDefaultProfile } from '../../src/shared/meeting-profiles.js';

describe('STT provider settings', () => {
  it('defaults to local Vosk while keeping Azure MAI-Transcribe configurable', () => {
    expect(DEFAULT_SETTINGS.sttProvider).toBe('local_vosk');
    expect(DEFAULT_SETTINGS.azureStt).toEqual({
      endpoint: '',
      model: 'mai-transcribe-2',
      locales: '',
      transcribeStyle: 'readable',
      segmentDurationSeconds: 10,
      realtimeLanguage: 'en-US',
    });

  });

  it('keeps Work IQ OAuth configuration out of general Aura settings', () => {
    expect('workIqAuth' in DEFAULT_SETTINGS).toBe(false);
    expect(DEFAULT_WORKIQ_CLIENT_ID).toBe('ba081686-5d24-4bc6-a0d6-d034ecffed87');
    expect(DEFAULT_WORKIQ_TENANT_ID).toBe('72f988bf-86f1-41af-91ab-2d7cd011db47');
  });

  it('exposes provider and transcript style options', () => {
    expect(STT_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
      'local_vosk',
      'azure_mai_transcribe',
      'azure_speech_realtime',
    ]);
    expect(AZURE_TRANSCRIBE_STYLE_OPTIONS.map((option) => option.value)).toEqual([
      'readable',
      'verbatim',
    ]);
    expect(AZURE_TRANSCRIBE_MODEL_OPTIONS.map((option) => option.value)).toEqual([
      'mai-transcribe-2',
      'mai-transcribe-1.5',
    ]);
  });

  it('defaults answers to Claude Sonnet 5.5', () => {
    expect(DEFAULT_ANSWER_MODEL).toBe('claude-sonnet-5.5');
    expect(createDefaultProfile().answerModel).toBe('claude-sonnet-5.5');
  });

  it('defaults the triage cadence to final transcript plus interval', () => {
    const profile = createDefaultProfile();
    expect(profile.triageCadence).toEqual({
      mode: 'both',
      intervalSeconds: 20,
    });
    expect(TRIAGE_CADENCE_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'final_transcript',
      'interval',
      'both',
    ]);
  });
});
