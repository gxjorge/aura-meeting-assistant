import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '../shared/types.js';
import type {
  AuraSettings,
  AzureSttSettings,
  AzureTranscribeModel,
  AzureTranscribeStyle,
  LegacyAuraSettings,
  MeetingProfile,
  ProfileLearningState,
  ProfilesState,
  SttProvider,
} from '../shared/types.js';
import {
  getActiveProfile as selectActiveProfile,
  migrateLegacySettings,
  needsProfileMigration,
  normalizeProfiles,
} from '../shared/meeting-profiles.js';
import { normalizeDecisionGateSettings } from '../shared/decision-gate.js';

type StoredSettings = Partial<AuraSettings> & LegacyAuraSettings;

let cachedSettings: AuraSettings | null = null;

const LEARNING_FLUSH_DELAY_MS = 5_000;
let learningFlushTimer: ReturnType<typeof setTimeout> | null = null;

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): AuraSettings {
  if (cachedSettings) return cachedSettings;

  const filePath = getSettingsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as StoredSettings;
      cachedSettings = normalizeSettings(parsed);
      return cachedSettings;
    }
  } catch (err) {
    console.warn('[Settings] Failed to read settings, using defaults:', err);
  }

  cachedSettings = normalizeSettings({});
  return cachedSettings;
}

export function saveSettings(settings: AuraSettings): AuraSettings {
  const filePath = getSettingsPath();
  try {
    const normalized = normalizeSettings(settings);
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
    cachedSettings = normalized;
    console.log('[Settings] Saved');
    return normalized;
  } catch (err) {
    console.error('[Settings] Failed to save:', err);
    throw err;
  }
}

/** The profile driving meeting intelligence right now. Always resolves to something usable. */
export function getActiveProfile(): MeetingProfile {
  return selectActiveProfile(getSettings());
}

export function getProfilesState(): ProfilesState {
  const settings = getSettings();
  return { profiles: settings.profiles, activeProfileId: settings.activeProfileId };
}

export function saveProfiles(profiles: MeetingProfile[], activeProfileId?: string): ProfilesState {
  const current = getSettings();
  saveSettings({
    ...current,
    profiles,
    activeProfileId: activeProfileId ?? current.activeProfileId,
  });
  return getProfilesState();
}

/**
 * Applies a partial update to one profile without disturbing the rest of the settings blob.
 * Returns the updated profile, or null when the id is unknown.
 */
export function updateProfile(
  profileId: string,
  patch: Partial<MeetingProfile>,
): MeetingProfile | null {
  const current = getSettings();
  const existing = current.profiles.find((profile) => profile.id === profileId);
  if (!existing) return null;

  const updated: MeetingProfile = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
  saveSettings({
    ...current,
    profiles: current.profiles.map((profile) => (profile.id === profileId ? updated : profile)),
  });

  return selectProfileById(profileId);
}

/**
 * Stores learning state for one profile. Writes are debounced because card signals arrive in bursts
 * and settings.json is rewritten in full on every save.
 */
export function persistProfileLearning(
  profileId: string,
  learning: ProfileLearningState,
): Promise<void> {
  const current = getSettings();
  const existing = current.profiles.find((profile) => profile.id === profileId);
  if (!existing) return Promise.resolve();

  // Update the in-memory cache immediately so consecutive signals accumulate rather than race.
  cachedSettings = {
    ...current,
    profiles: current.profiles.map((profile) =>
      profile.id === profileId ? { ...profile, learning } : profile),
  };

  if (learningFlushTimer) clearTimeout(learningFlushTimer);
  return new Promise<void>((resolve) => {
    learningFlushTimer = setTimeout(() => {
      learningFlushTimer = null;
      if (cachedSettings) saveSettings(cachedSettings);
      resolve();
    }, LEARNING_FLUSH_DELAY_MS);
  });
}

function selectProfileById(profileId: string): MeetingProfile | null {
  return getSettings().profiles.find((profile) => profile.id === profileId) ?? null;
}

export function setActiveProfile(profileId: string): ProfilesState {
  const current = getSettings();
  saveSettings({ ...current, activeProfileId: profileId });
  return getProfilesState();
}

function normalizeSettings(settings: StoredSettings): AuraSettings {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const visualContext = {
    ...DEFAULT_SETTINGS.visualContext,
    ...(settings.visualContext ?? {}),
  };

  // Pre-profiles installs carry meeting behaviour on the settings root; fold it into `general`.
  const seedProfiles: MeetingProfile[] = needsProfileMigration(settings)
    ? [migrateLegacySettings(settings)]
    : (settings.profiles ?? []);

  const { profiles, activeProfileId } = normalizeProfiles(seedProfiles, settings.activeProfileId);

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    sttProvider: normalizeSttProvider(settings.sttProvider),
    localSttModelUrl: merged.localSttModelUrl,
    azureStt: normalizeAzureSttSettings(settings.azureStt),
    decisionGate: normalizeDecisionGateSettings(settings.decisionGate),
    audioSource: merged.audioSource,
    visualContext,
    profiles,
    activeProfileId,
  };
}

function normalizeSttProvider(provider: unknown): SttProvider {
  if (provider === 'azure_mai_transcribe' || provider === 'azure_speech_realtime') {
    return provider;
  }

  return 'local_vosk';
}

function normalizeAzureSttSettings(settings: Partial<AzureSttSettings> | undefined): AzureSttSettings {
  const merged = { ...DEFAULT_SETTINGS.azureStt, ...(settings ?? {}) };

  return {
    endpoint: typeof merged.endpoint === 'string' ? merged.endpoint.trim() : DEFAULT_SETTINGS.azureStt.endpoint,
    model: normalizeTranscribeModel(merged.model),
    locales: typeof merged.locales === 'string' ? merged.locales.trim() : DEFAULT_SETTINGS.azureStt.locales,
    transcribeStyle: normalizeTranscribeStyle(merged.transcribeStyle),
    segmentDurationSeconds: normalizeSegmentDurationSeconds(merged.segmentDurationSeconds),
    realtimeLanguage: normalizeRealtimeLanguage(merged.realtimeLanguage),
  };
}

function normalizeTranscribeModel(model: unknown): AzureTranscribeModel {
  return model === 'mai-transcribe-1.5' || model === 'mai-transcribe-2'
    ? model
    : DEFAULT_SETTINGS.azureStt.model;
}

function normalizeTranscribeStyle(style: unknown): AzureTranscribeStyle {
  return style === 'verbatim' ? 'verbatim' : 'readable';
}

function normalizeSegmentDurationSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.azureStt.segmentDurationSeconds;
  }

  return Math.min(60, Math.max(5, Math.round(value)));
}

function normalizeRealtimeLanguage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.azureStt.realtimeLanguage;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_SETTINGS.azureStt.realtimeLanguage;
}
