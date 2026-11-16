import { useState, useEffect, useCallback, useRef } from 'react';
import type { AudioSource, AuraSettings, AuthStatus, MeetingCard, ProfilesState } from '../shared/types';
import AuthError from './components/AuthError';
import { ClearIcon, GearIcon, MicIcon, StopIcon } from './components/Icons';
import MeetingFeed from './components/MeetingFeed';
import Profiles from './components/Profiles';
import Settings from './components/Settings';
import { useAudioCapture } from './hooks/useAudioCapture';
import { useVisualContext } from './hooks/useVisualContext';

const MAX_TRANSCRIPT_ENTRIES = 500;
const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 16;

interface TranscriptEntry {
  source: AudioSource;
  text: string;
}

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [transcriptLog, setTranscriptLog] = useState<TranscriptEntry[]>([]);
  const [partialText, setPartialText] = useState('');
  const [audioError, setAudioError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [cards, setCards] = useState<MeetingCard[]>([]);
  const [settings, setSettings] = useState<AuraSettings | null>(null);
  const [profilesState, setProfilesState] = useState<ProfilesState | null>(null);
  const { captureVisualContext, status: visualStatus, error: visualError } = useVisualContext();
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollTranscriptRef = useRef(true);
  const wasListeningRef = useRef(false);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element && shouldAutoScrollTranscriptRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [transcriptLog]);

  useEffect(() => {
    window.aura.getAuthStatus().then(setAuthStatus);
    window.aura.getSettings().then(setSettings);
    window.aura.getProfiles().then(setProfilesState);
  }, []);

  useEffect(() => window.aura.onProfilesChanged(setProfilesState), []);

  useEffect(() => {
    const unsubscribeCreated = window.aura.onMeetingCardCreated(({ card }) => {
      setCards((prev) => [card, ...prev.filter((item) => item.id !== card.id)].slice(0, 30));
    });

    const unsubscribeUpdated = window.aura.onMeetingCardUpdated(({ card }) => {
      setCards((prev) => prev.map((item) => (item.id === card.id ? card : item)));
    });

    const unsubscribeRemoved = window.aura.onMeetingCardRemoved(({ cardId }) => {
      setCards((prev) => prev.filter((item) => item.id !== cardId));
    });

    return () => {
      unsubscribeCreated();
      unsubscribeUpdated();
      unsubscribeRemoved();
    };
  }, []);

  const handleTranscript = useCallback(async (text: string, source: AudioSource) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setTranscriptLog((prev) => [...prev, { source, text: trimmed }].slice(-MAX_TRANSCRIPT_ENTRIES));
    setPartialText('');

    const now = Math.floor(Date.now() / 1000);
    const visualContext = settings
      ? await captureVisualContext(settings.visualContext)
      : undefined;

    window.aura.sendTranscript({
      text: trimmed,
      source,
      confidence: 1.0,
      startedAt: now - 3,
      endedAt: now,
      ...(visualContext ? { visualContext } : {}),
    });
  }, [captureVisualContext, settings]);

  const { listening, modelLoading, activeSources, status, startListening, stopListening } = useAudioCapture({
    onTranscript: handleTranscript,
    onPartial: (text, source) => {
      setPartialText(`${sourceLabel(source)}: ${text}`);
      window.aura.sendPartialTranscript({
        text,
        source,
        updatedAt: Math.floor(Date.now() / 1000),
      });
    },
    onError: setAudioError,
  });

  useEffect(() => {
    if (listening && !wasListeningRef.current) {
      setTranscriptLog([]);
      shouldAutoScrollTranscriptRef.current = true;
    }
    wasListeningRef.current = listening;
  }, [listening]);

  useEffect(() => {
    window.aura.setAudioListeningState(listening);
  }, [listening]);

  useEffect(() => {
    const unsubscribe = window.aura.onAudioToggle((shouldListen) => {
      if (shouldListen && !listening) startListening();
      else if (!shouldListen && listening) stopListening();
    });
    return unsubscribe;
  }, [listening, startListening, stopListening]);

  if (!authStatus) {
    return (
      <div className="app loading">
        <div className="spinner" />
        <p>Connecting...</p>
      </div>
    );
  }

  if (!authStatus.authenticated) {
    return <AuthError error={authStatus.error ?? 'Unknown error'} />;
  }

  const lastEntry = transcriptLog[transcriptLog.length - 1];
  const statusLabel =
    status === 'loading-model' ? 'Downloading local speech model...' :
    status === 'error' ? audioError :
    status === 'listening' ? (
      partialText ||
      (lastEntry ? `${sourceLabel(lastEntry.source)}: ${lastEntry.text}` : '') ||
      `Listening to ${formatSources(activeSources)}...`
    ) :
    'Ready to listen';
  const expectsSystemAudio = settings?.audioSource === 'both' || settings?.audioSource === 'system';
  const systemAudioMissing = listening && expectsSystemAudio && !activeSources.includes('system');
  const clearMeetingContent = () => {
    setTranscriptLog([]);
    setPartialText('');
    setCards([]);
    shouldAutoScrollTranscriptRef.current = true;
    window.aura.clearMeetingHistory();
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <span className="app-title">Aura</span>
          <span className="app-subtitle">Meeting intelligence</span>
        </div>
        <div className="app-header-right">
          {profilesState && (
            <div className="profile-field">
              <label className="profile-field-label" htmlFor="profile-switcher">
                Profile
              </label>
              <select
                id="profile-switcher"
                className="profile-switcher"
                value={profilesState.activeProfileId}
                title="Active meeting profile"
                onChange={async (event) => {
                  setProfilesState(await window.aura.setActiveProfile(event.target.value));
                }}
              >
                {profilesState.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </div>
          )}
          <button
            className={`listen-toggle ${listening ? 'listen-on' : ''} ${modelLoading ? 'listen-loading' : ''}`}
            onClick={() => (listening ? stopListening() : startListening())}
            title={
              modelLoading ? 'Loading local speech model...' :
              listening ? 'Stop listening (Ctrl+Shift+M)' :
              'Start listening (Ctrl+Shift+M)'
            }
            aria-pressed={listening}
            disabled={modelLoading}
          >
            {modelLoading ? <span className="spinner-small" /> : listening ? <StopIcon /> : <MicIcon />}
            <span>{modelLoading ? 'Loading' : listening ? 'Stop' : 'Listen'}</span>
          </button>
          <button
            className="clear-history icon-button"
            onClick={clearMeetingContent}
            title="Clear transcript history and all context cards"
            aria-label="Clear transcript history and all context cards"
          >
            <ClearIcon />
          </button>
          <button
            className="settings-gear icon-button"
            onClick={() => setShowSettings(true)}
            title="Settings"
            aria-label="Settings"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <div
        className={`meeting-status ${status === 'error' ? 'meeting-status-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {status === 'listening' && <span className="status-dot" />}
        {status === 'loading-model' && <span className="spinner-small" />}
        <span className="meeting-status-text">{statusLabel}</span>
      </div>

      {systemAudioMissing && (
        <div className="meeting-status meeting-status-warning">
          System audio is not being captured. Stop, press Listen, then choose Entire screen and
          enable Share system audio.
        </div>
      )}

      {visualStatus !== 'idle' && (
        <div className={`meeting-status ${visualStatus === 'error' ? 'meeting-status-error' : ''}`}>
          {visualStatus === 'capturing' && 'Capturing screen context...'}
          {visualStatus === 'ocr' && 'Reading screen text locally...'}
          {visualStatus === 'error' && `Visual context unavailable: ${visualError}`}
        </div>
      )}

      {transcriptLog.length > 0 && (
        <div
          className="transcript-history"
          ref={transcriptRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
            shouldAutoScrollTranscriptRef.current = distanceFromBottom <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
          }}
        >
          {transcriptLog.map((entry, index) => (
            <div key={`${entry.text}-${index}`} className="transcript-line">
              <span className={`transcript-source transcript-source-${entry.source}`}>
                {sourceLabel(entry.source)}
              </span>
              <span className="transcript-text">{entry.text}</span>
            </div>
          ))}
        </div>
      )}

      <MeetingFeed
        cards={cards}
        listening={listening}
        onCancelCard={(cardId) => window.aura.cancelMeetingCard(cardId)}
        onRemoveCard={(cardId) => window.aura.removeMeetingCard(cardId)}
      />

      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onSaved={(nextSettings) => setSettings(nextSettings)}
          onOpenProfiles={() => {
            setShowSettings(false);
            setShowProfiles(true);
          }}
        />
      )}

      {showProfiles && (
        <Profiles
          onClose={() => setShowProfiles(false)}
          onSaved={setProfilesState}
        />
      )}
    </div>
  );
}

function sourceLabel(source: AudioSource): string {
  return source === 'mic' ? 'Mic' : 'System';
}

function formatSources(sources: AudioSource[]): string {
  if (sources.length === 0) return 'meeting audio';
  if (sources.length === 1) return sourceLabel(sources[0]).toLowerCase();
  return 'mic + system audio';
}
