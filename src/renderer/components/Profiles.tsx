import { useEffect, useMemo, useState } from 'react';
import {
  PROFILE_TEMPLATES,
  createBlankProfile,
  createProfileFromTemplate,
  createWorkIqMcpServer,
  deleteProfile,
  exportProfile,
  importProfile,
  slugify,
  upsertProfile,
  WORKIQ_MCP_ID,
} from '../../shared/meeting-profiles';
import type {
  MeetingProfile,
  ProfileMcpServer,
  ProfileMcpTransport,
  ProfileProposalChange,
  ProfileSkill,
  ProfilesState,
  WorkIqAuthSettings,
  WorkIqAuthStatus,
} from '../../shared/types';
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_TRIAGE_CADENCE,
  LLM_MODEL_OPTIONS,
  TRIAGE_CADENCE_MODE_OPTIONS,
} from '../../shared/types';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { CloseIcon } from './Icons';
import { validateWorkIqAuthSettings } from '../../shared/workiq-auth-config';

interface ProfilesProps {
  onClose: () => void;
  onSaved?: (state: ProfilesState) => void;
}

const TRANSPORT_OPTIONS: readonly { value: ProfileMcpTransport; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'Local command (stdio)' },
];

export default function Profiles({ onClose, onSaved }: ProfilesProps) {
  const [profiles, setProfiles] = useState<MeetingProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>(DEFAULT_PROFILE_ID);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_PROFILE_ID);
  const [sdkModels, setSdkModels] = useState<string[]>([]);
  const [importDraft, setImportDraft] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [workIqAuth, setWorkIqAuth] = useState<WorkIqAuthStatus | null>(null);

  useEscapeKey(onClose);

  useEffect(() => {
    window.aura.getProfiles().then((state) => {
      setProfiles(state.profiles);
      setActiveProfileId(state.activeProfileId);
      setSelectedId(state.activeProfileId);
    });
    window.aura.listModels().then(setSdkModels);
  }, []);

  const modelOptions = useMemo(() => {
    const options = [...LLM_MODEL_OPTIONS];
    for (const model of sdkModels) {
      if (!options.find((option) => option.value === model)) {
        options.push({ label: model, value: model });
      }
    }
    return options;
  }, [sdkModels]);

  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0];
  const selectedWorkIqAuth = selected?.mcpServers.find(
    (server) => server.authProvider === 'workiq',
  )?.workIqAuth;

  useEffect(() => {
    if (!selectedWorkIqAuth) {
      setWorkIqAuth(null);
      return;
    }
    window.aura.getWorkIqAuthStatus(selectedWorkIqAuth)
      .then(setWorkIqAuth)
      .catch((err: unknown) => setError(`Could not read Work IQ status: ${errorMessage(err)}`));
  }, [selectedWorkIqAuth?.clientId, selectedWorkIqAuth?.tenantId]);

  /**
   * A saved profile can name a model that is neither in the static list nor in this account's SDK
   * list. Without this the select would silently render blank and the next save would wipe the
   * user's choice, so the current value is always offered back.
   */
  const optionsIncluding = (value: string) =>
    modelOptions.find((option) => option.value === value)
      ? modelOptions
      : [...modelOptions, { label: value, value }];

  const updateSelected = (patch: Partial<MeetingProfile>) => {
    if (!selected) return;
    setProfiles(upsertProfile(profiles, { ...selected, ...patch }));
  };

  const handleSave = async () => {
    for (const profile of profiles) {
      for (const server of profile.mcpServers) {
        if (server.authProvider !== 'workiq') continue;
        if (!server.workIqAuth) {
          setError(`Work IQ in "${profile.name}" is missing its client and tenant IDs.`);
          return;
        }
        const validationError = validateWorkIqAuthSettings(server.workIqAuth);
        if (validationError) {
          setError(`Work IQ in "${profile.name}": ${validationError}`);
          return;
        }
      }
    }
    const state = await window.aura.saveProfiles(profiles);
    setProfiles(state.profiles);
    setActiveProfileId(state.activeProfileId);
    onSaved?.(state);
    setMessage('Saved');
    setTimeout(() => setMessage(''), 2000);
  };

  const handleActivate = async (profileId: string) => {
    const state = await window.aura.setActiveProfile(profileId);
    setActiveProfileId(state.activeProfileId);
    onSaved?.(state);
  };

  const handleAddTemplate = (templateId: string) => {
    if (!templateId) return;
    const profile = createProfileFromTemplate(templateId, profiles);
    if (!profile) return;
    setProfiles([...profiles, profile]);
    setSelectedId(profile.id);
  };

  const handleAddBlank = () => {
    const profile = createBlankProfile('New profile', profiles);
    setProfiles([...profiles, profile]);
    setSelectedId(profile.id);
  };

  const handleDelete = (profileId: string) => {
    if (profileId === DEFAULT_PROFILE_ID) return;
    const next = deleteProfile(profiles, profileId);
    setProfiles(next);
    setSelectedId(next[0]?.id ?? DEFAULT_PROFILE_ID);
  };

  /**
   * Applies one agent-proposed change and clears the proposal. Nothing is written until the user
   * clicks here, so an unreviewed proposal can never alter behaviour.
   */
  const handleAcceptProposal = async (change: ProfileProposalChange) => {
    if (!selected) return;

    const next = upsertProfile(profiles, {
      ...selected,
      systemPrompt: change.value,
      pendingProposal: undefined,
    });
    setProfiles(next);
    const state = await window.aura.saveProfiles(next);
    setProfiles(state.profiles);
    onSaved?.(state);
    setMessage('Suggestion applied');
    setTimeout(() => setMessage(''), 2000);
  };

  const handleDismissProposal = async () => {
    if (!selected) return;
    const next = upsertProfile(profiles, { ...selected, pendingProposal: undefined });
    setProfiles(next);
    const state = await window.aura.saveProfiles(next);
    setProfiles(state.profiles);
    onSaved?.(state);
  };

  const handleExport = async () => {    if (!selected) return;
    await navigator.clipboard.writeText(exportProfile(selected));
    setMessage('Profile JSON copied (credentials stripped)');
    setTimeout(() => setMessage(''), 3000);
  };

  const handleImport = () => {
    const result = importProfile(importDraft, profiles);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setProfiles([...profiles, result.profile]);
    setSelectedId(result.profile.id);
    setImportDraft('');
    setShowImport(false);
    setError('');
  };

  const updateMcpServer = (serverId: string, patch: Partial<ProfileMcpServer>) => {
    if (!selected) return;
    updateSelected({
      mcpServers: selected.mcpServers.map((server) => (
        server.id === serverId ? { ...server, ...patch } : server
      )),
    });
  };

  const handleAddMcpServer = () => {
    if (!selected) return;
    const id = uniqueId('mcp-server', selected.mcpServers.map((server) => server.id));
    const server: ProfileMcpServer = {
      id,
      name: 'New MCP server',
      transport: 'http',
      enabled: true,
      tools: ['*'],
      url: '',
    };
    updateSelected({ mcpServers: [...selected.mcpServers, server] });
  };

  const handleAddWorkIqServer = () => {
    if (!selected) return;
    if (selected.mcpServers.some((server) => server.authProvider === 'workiq')) {
      setError('This profile already has a Work IQ connection.');
      return;
    }
    updateSelected({ mcpServers: [...selected.mcpServers, createWorkIqMcpServer()] });
    setError('');
  };

  const handleConnectWorkIq = async (settings: WorkIqAuthSettings) => {
    setError('');
    const pending: WorkIqAuthStatus = {
      state: 'connecting',
      configuredClient: workIqAuth?.configuredClient ?? false,
    };
    setWorkIqAuth(pending);
    try {
      const next = await window.aura.connectWorkIq(settings);
      setWorkIqAuth(next);
      if (next.error) setError(next.error);
    } catch (err) {
      setWorkIqAuth({
        state: 'error',
        configuredClient: pending.configuredClient,
        error: errorMessage(err),
      });
      setError(`Work IQ connection failed: ${errorMessage(err)}`);
    }
  };

  const handleDisconnectWorkIq = async () => {
    try {
      setWorkIqAuth(await window.aura.disconnectWorkIq());
    } catch (err) {
      setError(`Work IQ disconnect failed: ${errorMessage(err)}`);
    }
  };

  const updateSkill = (skillId: string, patch: Partial<ProfileSkill>) => {
    if (!selected) return;
    updateSelected({
      skills: selected.skills.map((skill) => (skill.id === skillId ? { ...skill, ...patch } : skill)),
    });
  };

  const handleAddSkill = () => {
    if (!selected) return;
    const id = uniqueId('skill', selected.skills.map((skill) => skill.id));
    const skill: ProfileSkill = {
      id,
      name: 'New skill',
      description: 'When the agent should use this skill.',
      body: '## Instructions\n\nDescribe what the agent should do.',
      enabled: true,
    };
    updateSelected({ skills: [...selected.skills, skill] });
  };

  const templateOptions = PROFILE_TEMPLATES.filter((template) => template.id !== DEFAULT_PROFILE_ID);

  return (
    <div className="settings-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="settings-panel profiles-panel" role="dialog" aria-modal="true" aria-label="Meeting profiles">
        <div className="settings-header">
          <h2>Meeting profiles</h2>
          <button className="settings-close icon-button" onClick={onClose} aria-label="Close meeting profiles">
            <CloseIcon />
          </button>
        </div>

        <div className="profiles-body">
          <aside className="profiles-sidebar">
            <div className="profiles-list">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  className={`profiles-list-item${profile.id === selectedId ? ' is-selected' : ''}`}
                  onClick={() => setSelectedId(profile.id)}
                >
                  <span className="profiles-list-name">{profile.name}</span>
                  {profile.id === activeProfileId && <span className="profiles-badge">Active</span>}
                </button>
              ))}
            </div>

            <div className="profiles-sidebar-actions">
              <button className="settings-btn" onClick={handleAddBlank}>New profile</button>
              <select
                className="settings-select"
                value=""
                onChange={(event) => handleAddTemplate(event.target.value)}
              >
                <option value="">Add from template…</option>
                {templateOptions.map((template) => (
                  <option key={template.id} value={template.id}>{template.name}</option>
                ))}
              </select>
              <button className="settings-btn" onClick={() => setShowImport(!showImport)}>
                {showImport ? 'Cancel import' : 'Import JSON'}
              </button>
              {showImport && (
                <>
                  <textarea
                    className="settings-input profiles-textarea"
                    rows={5}
                    value={importDraft}
                    placeholder="Paste exported profile JSON"
                    onChange={(event) => setImportDraft(event.target.value)}
                  />
                  <button className="settings-btn" onClick={handleImport}>Add profile</button>
                </>
              )}
              {error && <p className="settings-error">{error}</p>}
            </div>
          </aside>

          <section className="profiles-editor">
            {!selected && <p className="settings-hint">No profile selected.</p>}
            {selected && (
              <>
                <div className="profiles-editor-header">
                  <div className="settings-group">
                    <label className="settings-label">Profile name</label>
                    <input
                      className="settings-input"
                      value={selected.name}
                      onChange={(event) => updateSelected({ name: event.target.value })}
                    />
                  </div>
                  <div className="profiles-editor-actions">
                    {selected.id !== activeProfileId && (
                      <button className="settings-btn" onClick={() => handleActivate(selected.id)}>
                        Use for this meeting
                      </button>
                    )}
                    <button className="settings-btn" onClick={handleExport}>Export</button>
                    {!selected.builtIn && (
                      <button
                        className="settings-btn settings-btn-cancel"
                        onClick={() => handleDelete(selected.id)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {selected.pendingProposal && (
                  <div className="profile-proposal">
                    <div className="profile-proposal-header">
                      <span className="profile-proposal-badge">Suggested by Aura</span>
                      <button className="settings-btn settings-btn-cancel" onClick={handleDismissProposal}>
                        Dismiss all
                      </button>
                    </div>
                    <p className="settings-hint">
                      Based on which cards you engaged with. Nothing changes until you accept.
                    </p>
                    {selected.pendingProposal.changes.map((change) => (
                      <div key={change.id} className="profile-proposal-change">
                        <div className="profile-proposal-change-header">
                          <strong>{change.summary}</strong>
                          <button className="settings-btn" onClick={() => handleAcceptProposal(change)}>
                            Accept
                          </button>
                        </div>
                        {change.rationale && <p className="settings-hint">{change.rationale}</p>}
                        <pre className="profile-proposal-value">{change.value}</pre>
                      </div>
                    ))}
                  </div>
                )}

                <div className="settings-group">
                  <label className="settings-label">Description</label>                  <input
                    className="settings-input"
                    value={selected.description}
                    placeholder="When to use this profile"
                    onChange={(event) => updateSelected({ description: event.target.value })}
                  />
                </div>

                <div className="settings-group">
                  <label className="settings-label">Profile prompt</label>
                  <textarea
                    className="settings-input profiles-textarea"
                    rows={14}
                    value={selected.systemPrompt}
                    onChange={(event) => updateSelected({ systemPrompt: event.target.value })}
                  />
                  <p className="settings-hint">
                    This prompt decides both <strong>what Aura surfaces</strong> during the meeting and{' '}
                    <strong>how it answers</strong>. Say what is worth interrupting for and what to ignore,
                    then say how to answer. Aura re-reads the live transcript against this prompt as the
                    call goes on.
                  </p>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Answer model</label>
                  <select
                    className="settings-select"
                    value={selected.answerModel}
                    onChange={(event) => updateSelected({ answerModel: event.target.value })}
                  >
                    {optionsIncluding(selected.answerModel).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <p className="settings-hint">Writes the card answers.</p>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Triage model</label>
                  <select
                    className="settings-select"
                    value={selected.triageModel}
                    onChange={(event) => updateSelected({ triageModel: event.target.value })}
                  >
                    {optionsIncluding(selected.triageModel).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <p className="settings-hint">
                    Names what to surface, and nothing else. It only classifies, so a fast model here shows
                    cards sooner without changing the answers. It runs on every cadence tick, or only when
                    the decision gate in Settings says something may be worth surfacing.
                  </p>
                </div>

                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={selected.passiveCardsEnabled}
                    onChange={(event) => updateSelected({ passiveCardsEnabled: event.target.checked })}
                  />
                  Surface passive cards proactively
                </label>

                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={selected.explicitAnswersEnabled}
                    onChange={(event) => updateSelected({ explicitAnswersEnabled: event.target.checked })}
                  />
                  Auto-start one answer agent for explicit asks
                </label>
                <p className="settings-hint">
                  Turning both off stops Aura from reading the transcript with a model at all.
                </p>

                <div className="settings-group">
                  <label className="settings-label">Passive check cadence</label>
                  <select
                    className="settings-select"
                    value={selected.triageCadence.mode}
                    onChange={(event) => updateSelected({
                      triageCadence: {
                        ...selected.triageCadence,
                        mode: event.target.value as MeetingProfile['triageCadence']['mode'],
                      },
                    })}
                  >
                    {TRIAGE_CADENCE_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  {selected.triageCadence.mode !== 'final_transcript' && (
                    <>
                      <label className="settings-label">Interval (seconds)</label>
                      <input
                        className="settings-input"
                        type="number"
                        min={3}
                        max={120}
                        value={selected.triageCadence.intervalSeconds}
                        onChange={(event) => updateSelected({
                          triageCadence: {
                            ...selected.triageCadence,
                            intervalSeconds: parsePositiveNumber(
                              event.target.value,
                              DEFAULT_TRIAGE_CADENCE.intervalSeconds,
                            ),
                          },
                        })}
                      />
                    </>
                  )}
                </div>

                <div className="settings-group">
                  <label className="settings-label">Trigger vocabulary</label>
                  <input
                    className="settings-input"
                    value={selected.vocabulary.join(', ')}
                    placeholder="pipeline, renewal, forecast"
                    onChange={(event) => updateSelected({ vocabulary: parseList(event.target.value) })}
                  />
                  <p className="settings-hint">
                    Comma-separated terms that should trigger a passive card for this profile.
                  </p>
                </div>

                <div className="settings-group">
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={selected.learningEnabled}
                      onChange={(event) => updateSelected({ learningEnabled: event.target.checked })}
                    />
                    <span>Let this profile learn from my card interactions</span>
                  </label>
                  <p className="settings-hint">
                    {selected.learningEnabled
                      ? `Tracking ${selected.learning.terms.length} term${selected.learning.terms.length === 1 ? '' : 's'}. `
                        + 'Only concept names and counters are stored — never transcript text.'
                      : 'Learning is off. Vocabulary and prompts change only when you edit them.'}
                  </p>
                  {selected.learningEnabled && selected.learning.terms.length > 0 && (
                    <div className="learning-terms">
                      {[...selected.learning.terms]
                        .sort((a, b) => b.weight - a.weight)
                        .slice(0, 8)
                        .map((term) => (
                          <span key={term.term} className="learning-term">
                            {term.term}
                            <span className="learning-term-weight">{term.weight.toFixed(1)}</span>
                          </span>
                        ))}
                    </div>
                  )}
                </div>

                <div className="settings-group">
                  <div className="settings-label">MCP servers</div>
                  {selected.mcpServers.length === 0 && (
                    <div className="mcp-empty">No MCP servers configured.</div>
                  )}
                  {selected.mcpServers.map((server) => (
                    <div key={server.id} className="mcp-item">
                      <div className="mcp-item-header">
                        <input
                          className="settings-input"
                          value={server.name}
                          onChange={(event) => updateMcpServer(server.id, {
                            name: event.target.value,
                            id: slugify(event.target.value) || server.id,
                          })}
                        />
                        <label className="settings-checkbox">
                          <input
                            type="checkbox"
                            checked={server.enabled}
                            onChange={(event) => updateMcpServer(server.id, { enabled: event.target.checked })}
                          />
                          Enabled
                        </label>
                      </div>
                      <select
                        className="settings-select"
                        value={server.transport}
                        onChange={(event) => updateMcpServer(server.id, {
                          transport: event.target.value as ProfileMcpTransport,
                        })}
                      >
                        {TRANSPORT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      {server.transport === 'stdio' ? (
                        <>
                          <input
                            className="settings-input"
                            value={server.command ?? ''}
                            placeholder="npx"
                            onChange={(event) => updateMcpServer(server.id, { command: event.target.value })}
                          />
                          <input
                            className="settings-input"
                            value={(server.args ?? []).join(' ')}
                            placeholder="-y @scope/server"
                            onChange={(event) => updateMcpServer(server.id, {
                              args: event.target.value.split(/\s+/).filter(Boolean),
                            })}
                          />
                        </>
                      ) : (
                        <input
                          className="settings-input"
                          value={server.url ?? ''}
                          placeholder="https://mcp.example.com"
                          onChange={(event) => updateMcpServer(server.id, { url: event.target.value })}
                        />
                      )}
                      <input
                        className="settings-input"
                        value={server.tools.join(', ')}
                        placeholder="* (all tools)"
                        onChange={(event) => updateMcpServer(server.id, {
                          tools: parseList(event.target.value, ['*']),
                        })}
                      />
                      {server.authProvider === 'workiq' && (
                        <div className="workiq-auth">
                          <label className="settings-label">Application (client) ID</label>
                          <input
                            className="settings-input"
                            value={server.workIqAuth?.clientId ?? ''}
                            onChange={(event) => updateMcpServer(server.id, {
                              workIqAuth: {
                                clientId: event.target.value,
                                tenantId: server.workIqAuth?.tenantId ?? '',
                              },
                            })}
                          />
                          <label className="settings-label">Directory (tenant) ID</label>
                          <input
                            className="settings-input"
                            value={server.workIqAuth?.tenantId ?? ''}
                            onChange={(event) => updateMcpServer(server.id, {
                              workIqAuth: {
                                clientId: server.workIqAuth?.clientId ?? '',
                                tenantId: event.target.value,
                              },
                            })}
                          />
                          <div className="mcp-item-header">
                            <span className={`mcp-status mcp-status-${
                              workIqAuth?.state === 'connected'
                                ? 'connected'
                                : workIqAuth?.state === 'error'
                                  ? 'error'
                                  : 'configured'
                            }`}>
                              {workIqAuth?.state ?? 'disconnected'}
                            </span>
                            {workIqAuth?.state === 'connected' ? (
                              <button
                                className="settings-btn settings-btn-cancel"
                                onClick={handleDisconnectWorkIq}
                              >
                                Disconnect
                              </button>
                            ) : (
                              <button
                                className="settings-btn"
                                disabled={
                                  workIqAuth?.state === 'connecting' || !server.workIqAuth
                                }
                                onClick={() => {
                                  if (server.workIqAuth) handleConnectWorkIq(server.workIqAuth);
                                }}
                              >
                                {workIqAuth?.state === 'connecting' ? 'Connecting...' : 'Connect Work IQ'}
                              </button>
                            )}
                          </div>
                          {workIqAuth?.username && (
                            <p className="settings-hint">Signed in as {workIqAuth.username}</p>
                          )}
                          <p className="settings-hint">
                            Public Entra identifiers for this MCP server. No client secret is used.
                          </p>
                        </div>
                      )}
                      <button
                        className="settings-btn settings-btn-cancel"
                        onClick={() => updateSelected({
                          mcpServers: selected.mcpServers.filter((entry) => entry.id !== server.id),
                        })}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="profile-actions">
                    <button className="settings-btn" onClick={handleAddMcpServer}>Add MCP server</button>
                    <button
                      className="settings-btn"
                      onClick={handleAddWorkIqServer}
                      disabled={selected.mcpServers.some((server) => (
                        server.id === WORKIQ_MCP_ID || server.authProvider === 'workiq'
                      ))}
                    >
                      Add Work IQ
                    </button>
                  </div>
                  <p className="settings-hint">
                    Servers are handed to the agent for this profile only. Tokens stay local and are
                    stripped from exported profiles.
                  </p>
                </div>

                <div className="settings-group">
                  <div className="settings-label">Skills</div>
                  {selected.skills.length === 0 && (
                    <div className="mcp-empty">No skills configured.</div>
                  )}
                  {selected.skills.map((skill) => (
                    <div key={skill.id} className="mcp-item">
                      <div className="mcp-item-header">
                        <input
                          className="settings-input"
                          value={skill.name}
                          onChange={(event) => updateSkill(skill.id, {
                            name: event.target.value,
                            id: slugify(event.target.value) || skill.id,
                          })}
                        />
                        <label className="settings-checkbox">
                          <input
                            type="checkbox"
                            checked={skill.enabled}
                            onChange={(event) => updateSkill(skill.id, { enabled: event.target.checked })}
                          />
                          Enabled
                        </label>
                      </div>
                      <input
                        className="settings-input"
                        value={skill.description}
                        placeholder="When the agent should use this skill"
                        onChange={(event) => updateSkill(skill.id, { description: event.target.value })}
                      />
                      <textarea
                        className="settings-input profiles-textarea"
                        rows={6}
                        value={skill.body}
                        onChange={(event) => updateSkill(skill.id, { body: event.target.value })}
                      />
                      <button
                        className="settings-btn settings-btn-cancel"
                        onClick={() => updateSelected({
                          skills: selected.skills.filter((entry) => entry.id !== skill.id),
                        })}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button className="settings-btn" onClick={handleAddSkill}>Add skill</button>
                  <p className="settings-hint">
                    Skills are written as Copilot CLI <code>SKILL.md</code> files when a session starts.
                  </p>
                </div>
              </>
            )}
          </section>
        </div>

        <div className="settings-footer">
          <button className="settings-btn settings-btn-save" onClick={handleSave}>
            {message || 'Save'}
          </button>
          <button className="settings-btn settings-btn-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function parseList(value: string, fallback: string[] = []): string[] {
  const items = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueId(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}
