import { useState, useEffect } from 'react';
import type { AuraSettings } from '../../shared/types';
import {
  AZURE_TRANSCRIBE_MODEL_OPTIONS,
  AZURE_TRANSCRIBE_STYLE_OPTIONS,
  AUDIO_SOURCE_OPTIONS,
  DEFAULT_DECISION_DEPLOYMENT,
  DEFAULT_SETTINGS,
  LOCAL_STT_MODEL_OPTIONS,
  STT_PROVIDER_OPTIONS,
  VISUAL_CONTEXT_MODE_OPTIONS,
} from '../../shared/types';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { CloseIcon } from './Icons';

interface SettingsProps {
  onClose: () => void;
  onSaved?: (settings: AuraSettings) => void;
  onOpenProfiles?: () => void;
}

export default function Settings({ onClose, onSaved, onOpenProfiles }: SettingsProps) {
  const [settings, setSettings] = useState<AuraSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEscapeKey(onClose);

  useEffect(() => {
    window.aura.getSettings().then(setSettings);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const persistedSettings = await window.aura.saveSettings(settings);
      setSettings(persistedSettings);
      onSaved?.(persistedSettings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaved(false);
      setSaveError(`Settings could not be saved: ${formatUnknownError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close icon-button" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Speech transcription provider</label>
            <select
              className="settings-select"
              value={settings.sttProvider}
              onChange={(event) => setSettings({
                ...settings,
                sttProvider: event.target.value as AuraSettings['sttProvider'],
              })}
            >
              {STT_PROVIDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="settings-hint">
              {STT_PROVIDER_OPTIONS.find((option) => option.value === settings.sttProvider)?.description}
            </p>
          </div>

          {settings.sttProvider === 'local_vosk' && (
            <div className="settings-group">
              <label className="settings-label">Local speech model</label>
              <select
                className="settings-select"
                value={settings.localSttModelUrl}
                onChange={(event) => setSettings({ ...settings, localSttModelUrl: event.target.value })}
              >
                {LOCAL_STT_MODEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <p className="settings-hint">
                Local transcription downloads the selected model once and reuses the cached copy.
              </p>
            </div>
          )}

          {isAzureSpeechProvider(settings.sttProvider) && (
            <div className="settings-group">
              <label className="settings-label">Azure Speech endpoint</label>
              <input
                className="settings-input"
                value={settings.azureStt.endpoint}
                placeholder="https://your-resource.cognitiveservices.azure.com/"
                onChange={(event) => setSettings({
                  ...settings,
                  azureStt: {
                    ...settings.azureStt,
                    endpoint: event.target.value,
                  },
                })}
              />

              {settings.sttProvider === 'azure_mai_transcribe' && (
                <>
                  <label className="settings-label">Azure model</label>
                  <select
                    className="settings-select"
                    value={settings.azureStt.model}
                    onChange={(event) => setSettings({
                      ...settings,
                      azureStt: {
                        ...settings.azureStt,
                        model: event.target.value as AuraSettings['azureStt']['model'],
                      },
                    })}
                  >
                    {AZURE_TRANSCRIBE_MODEL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <p className="settings-hint">
                    Selected for Azure transcription:{' '}
                    {AZURE_TRANSCRIBE_MODEL_OPTIONS.find(
                      (option) => option.value === settings.azureStt.model,
                    )?.label}
                  </p>
                  <label className="settings-label">Locales (optional)</label>
                  <input
                    className="settings-input"
                    value={settings.azureStt.locales}
                    placeholder="en, es"
                    onChange={(event) => setSettings({
                      ...settings,
                      azureStt: {
                        ...settings.azureStt,
                        locales: event.target.value,
                      },
                    })}
                  />
                  <label className="settings-label">Transcript style</label>
                  <select
                    className="settings-select"
                    value={settings.azureStt.transcribeStyle}
                    onChange={(event) => setSettings({
                      ...settings,
                      azureStt: {
                        ...settings.azureStt,
                        transcribeStyle: event.target.value as AuraSettings['azureStt']['transcribeStyle'],
                      },
                    })}
                  >
                    {AZURE_TRANSCRIBE_STYLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <label className="settings-label">Azure segment length (seconds)</label>
                  <input
                    className="settings-input"
                    type="number"
                    min={5}
                    max={60}
                    value={settings.azureStt.segmentDurationSeconds}
                    onChange={(event) => setSettings({
                      ...settings,
                      azureStt: {
                        ...settings.azureStt,
                        segmentDurationSeconds: parsePositiveNumber(
                          event.target.value,
                          DEFAULT_SETTINGS.azureStt.segmentDurationSeconds,
                        ),
                      },
                    })}
                  />
                </>
              )}

              {settings.sttProvider === 'azure_speech_realtime' && (
                <>
                  <label className="settings-label">Recognition language</label>
                  <input
                    className="settings-input"
                    value={settings.azureStt.realtimeLanguage}
                    placeholder="en-US"
                    onChange={(event) => setSettings({
                      ...settings,
                      azureStt: {
                        ...settings.azureStt,
                        realtimeLanguage: event.target.value,
                      },
                    })}
                  />
                </>
              )}

              <p className="settings-hint">
                Uses Microsoft Entra authentication from the main process. Run az login and ensure your user has
                Cognitive Services User access. Meeting audio is kept in memory and is not written to disk.
              </p>
            </div>
          )}

          <div className="settings-group">
            <label className="settings-label">Meeting audio source</label>
            <select
              className="settings-select"
              value={settings.audioSource}
              onChange={(event) => setSettings({
                ...settings,
                audioSource: event.target.value as AuraSettings['audioSource'],
              })}
            >
              {AUDIO_SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="settings-hint">
              Full meeting audio uses the microphone plus a system-audio capture prompt when available.
            </p>
          </div>

          <div className="settings-group">
            <label className="settings-label">Meeting profiles</label>
            <p className="settings-hint">
              Answer model, prompts, MCP servers, skills, and docs behaviour now live on meeting
              profiles so each call type can bring different information.
            </p>
            {onOpenProfiles && (
              <button className="settings-btn" onClick={onOpenProfiles}>
                Manage profiles
              </button>
            )}
          </div>

          <div className="settings-group">
            <label className="settings-label">Decision gate (Microsoft-Decision-1)</label>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={settings.decisionGate.enabled}
                onChange={(event) => setSettings({
                  ...settings,
                  decisionGate: { ...settings.decisionGate, enabled: event.target.checked },
                })}
              />
              Let a fast decision model decide when something is worth looking up
            </label>

            {settings.decisionGate.enabled && (
              <>
                <label className="settings-label">Foundry endpoint</label>
                <input
                  className="settings-input"
                  value={settings.decisionGate.endpoint}
                  placeholder="https://your-resource.services.ai.azure.com/"
                  onChange={(event) => setSettings({
                    ...settings,
                    decisionGate: { ...settings.decisionGate, endpoint: event.target.value },
                  })}
                />

                <label className="settings-label">Deployment name</label>
                <input
                  className="settings-input"
                  value={settings.decisionGate.deployment}
                  placeholder={DEFAULT_DECISION_DEPLOYMENT}
                  onChange={(event) => setSettings({
                    ...settings,
                    decisionGate: { ...settings.decisionGate, deployment: event.target.value },
                  })}
                />
              </>
            )}

            <p className="settings-hint">
              {settings.decisionGate.enabled && !settings.decisionGate.endpoint.trim()
                ? 'Add your Foundry endpoint to turn the gate on. Until then the triage model decides every time. '
                : ''}
              Microsoft-Decision-1 checks each transcript update in a fraction of a second and only wakes the
              triage model when something may be worth surfacing. The triage model then names the topic and the
              profile's tools do the search. If the gate is unreachable, the triage model decides instead.
              Use the resource's Foundry endpoint (services.ai.azure.com), which is not the Speech one, and the
              name you gave the Microsoft-Decision-1 deployment. Uses Microsoft Entra authentication: run
              az login and ensure your user has Cognitive Services User access. Transcript excerpts are sent
              to this resource.
            </p>
          </div>

          <div className="settings-group">
            <label className="settings-label">Visual context</label>
            <select
              className="settings-select"
              value={settings.visualContext.mode}
              onChange={(event) => setSettings({
                ...settings,
                visualContext: {
                  ...settings.visualContext,
                  mode: event.target.value as AuraSettings['visualContext']['mode'],
                },
              })}
            >
              {VISUAL_CONTEXT_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="settings-hint">
              {VISUAL_CONTEXT_MODE_OPTIONS.find((option) => option.value === settings.visualContext.mode)?.description}
              {' '}When enabled, Aura captures the primary screen on each finalized transcript segment.
            </p>
          </div>

          {settings.visualContext.mode !== 'off' && (
            <div className="settings-group">
              <label className="settings-label">OCR language</label>
              <input
                className="settings-input"
                value={settings.visualContext.ocrLanguage}
                placeholder="eng"
                onChange={(event) => setSettings({
                  ...settings,
                  visualContext: {
                    ...settings.visualContext,
                    ocrLanguage: event.target.value,
                  },
                })}
              />
              <label className="settings-label">Screenshot width limit</label>
              <input
                className="settings-input"
                type="number"
                min={320}
                max={2560}
                value={settings.visualContext.maxImageWidth}
                onChange={(event) => setSettings({
                  ...settings,
                  visualContext: {
                    ...settings.visualContext,
                    maxImageWidth: Number(event.target.value),
                  },
                })}
              />
              <label className="settings-label">JPEG quality</label>
              <input
                className="settings-input"
                type="number"
                min={0.4}
                max={0.92}
                step={0.01}
                value={settings.visualContext.jpegQuality}
                onChange={(event) => setSettings({
                  ...settings,
                  visualContext: {
                    ...settings.visualContext,
                    jpegQuality: Number(event.target.value),
                  },
                })}
              />
              <p className="settings-hint">
                Visual context is ephemeral. Screenshots are used in memory for OCR/agent context and are not saved.
              </p>
            </div>
          )}
        </div>

        <div className="settings-footer">
          {saveError && <span className="settings-error">{saveError}</span>}
          <button
            className="settings-btn settings-btn-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
          </button>
          <button className="settings-btn settings-btn-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function isAzureSpeechProvider(provider: AuraSettings['sttProvider']): boolean {
  return provider === 'azure_mai_transcribe' || provider === 'azure_speech_realtime';
}

function parsePositiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
