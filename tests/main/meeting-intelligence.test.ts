import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionGateResult } from '../../src/main/decision-gate.js';
import type {
  DecisionGateSettings,
  MeetingCardEvent,
  MeetingProfile,
  TranscriptSegment,
} from '../../src/shared/types.js';
import { createDefaultProfile, createProfileFromTemplate } from '../../src/shared/meeting-profiles.js';

const mocks = vi.hoisted(() => ({
  /** The triage pass. Resolves with the JSON contract from `meeting-triage.ts`. */
  agentCompletion: vi.fn((): Promise<string> => Promise.resolve('{"surface":[]}')),
  /**
   * The fetch stage. Every card kind now runs through the profile's own session. Typed with the real
   * parameter list so tests can drive `onPartial` the way the SDK's streaming deltas do.
   */
  profileAgentCompletion: vi.fn(
    (
      _profile: MeetingProfile,
      _userMessage: string,
      _overrides?: { systemPrompt?: string; model?: string; timeoutMs?: number; onPartial?: (textSoFar: string) => void },
    ): Promise<string> => new Promise<string>(() => {}),
  ),
  /** Empty means "model list not loaded yet", so triage uses the profile's configured model as-is. */
  getAvailableModels: vi.fn((): string[] => []),
  profile: null as unknown as MeetingProfile,
  getActiveProfile: vi.fn((): MeetingProfile => mocks.profile),
  persistProfileLearning: vi.fn((): Promise<void> => Promise.resolve()),
  /** Gate settings live on the global settings, not the profile. A blank endpoint means "not configured". */
  settings: { decisionGate: { enabled: true, endpoint: '', deployment: 'Microsoft-Decision-1' } } as {
    decisionGate: DecisionGateSettings;
  },
  getSettings: vi.fn(() => mocks.settings),
  /** The decision gate. Defaults to "no opinion", which is what an unconfigured install produces. */
  runDecisionGate: vi.fn(
    (
      _settings: DecisionGateSettings,
      _input: { profile: MeetingProfile; transcript: string; recentTopics: readonly string[] },
    ): Promise<DecisionGateResult> => Promise.resolve({ status: 'skipped', reason: 'not_configured' }),
  ),
  warmDecisionGate: vi.fn(),
  resetDecisionGateFailures: vi.fn(),
}));

vi.mock('../../src/main/copilot.js', () => ({
  agentCompletion: mocks.agentCompletion,
  profileAgentCompletion: mocks.profileAgentCompletion,
  getAvailableModels: mocks.getAvailableModels,
}));

vi.mock('../../src/main/settings.js', () => ({
  getActiveProfile: mocks.getActiveProfile,
  getSettings: mocks.getSettings,
  persistProfileLearning: mocks.persistProfileLearning,
}));

vi.mock('../../src/main/decision-gate.js', () => ({
  runDecisionGate: mocks.runDecisionGate,
  warmDecisionGate: mocks.warmDecisionGate,
  resetDecisionGateFailures: mocks.resetDecisionGateFailures,
}));

import {
  handlePartialTranscript,
  handleTranscriptSegment,
  clearMeetingHistory,
  recordMeetingCardSignal,
  refreshMeetingIntelligenceSettings,
  removeMeetingCard,
  resetMeetingIntelligenceForTests,
  setMeetingCallbacks,
  setMeetingListeningState,
} from '../../src/main/meeting-intelligence.js';

/** Builds the JSON contract triage is expected to return. */
function triage(...requests: { kind: 'passive' | 'answer'; topic: string; query?: string; reason?: string }[]): string {
  return JSON.stringify({ surface: requests });
}

beforeEach(() => {
  // vi.clearAllMocks() in the blocks below clears calls, not implementations, so gate state set by one
  // test would leak into every later one. Starting each test unconfigured keeps the old tests honest.
  mocks.settings = { decisionGate: { enabled: true, endpoint: '', deployment: 'Microsoft-Decision-1' } };
  mocks.runDecisionGate.mockResolvedValue({ status: 'skipped', reason: 'not_configured' });
});

describe('prompt-driven triage', () => {
  beforeEach(() => {
    resetMeetingIntelligenceForTests();
    vi.clearAllMocks();
    mocks.getAvailableModels.mockReturnValue([]);
    mocks.agentCompletion.mockResolvedValue(triage());
    mocks.profile = createDefaultProfile();
    mocks.profile.triageCadence = { mode: 'both', intervalSeconds: 5 };
    setMeetingCallbacks({});
    setMeetingListeningState(true);
  });

  afterEach(() => {
    resetMeetingIntelligenceForTests();
    vi.useRealTimers();
  });

  it('asks the model what to surface instead of pattern matching the transcript', async () => {
    handleTranscriptSegment(segment('We are ranking the account list with the search index.'));
    await flushPromises();

    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
    const [systemPrompt, userMessage] = mocks.agentCompletion.mock.calls[0]!;
    expect(systemPrompt).toContain(mocks.profile.systemPrompt.trim());
    expect(userMessage).toContain('ranking the account list');
  });

  it('runs triage without the profile MCP servers or skills', async () => {
    // Most ticks surface nothing, so paying to load tools for a "no" would be pure waste.
    handleTranscriptSegment(segment('Some meeting chatter.'));
    await flushPromises();

    const [, , options] = mocks.agentCompletion.mock.calls[0]!;
    expect(options).not.toHaveProperty('mcpServers');
    expect(options).not.toHaveProperty('skillDirectories');
    expect(mocks.profileAgentCompletion).not.toHaveBeenCalled();
  });

  it('runs triage on the profile triage model, not the answer model', async () => {
    // Triage only classifies, so it gets a fast model. Paying frontier-model latency on every
    // cadence tick would delay every card by seconds for no gain in the decision.
    mocks.profile = { ...mocks.profile, triageModel: 'gpt-4.1', answerModel: 'claude-sonnet-4.6' };
    mocks.getAvailableModels.mockReturnValue(['gpt-4.1', 'claude-sonnet-5.5']);

    handleTranscriptSegment(segment('Some meeting chatter.'));
    await flushPromises();

    const [, , options] = mocks.agentCompletion.mock.calls[0]!;
    expect(options).toMatchObject({ model: 'gpt-4.1' });
  });

  it('falls back to the answer model when the triage model is not available to this account', async () => {
    // A shared or imported profile can name a model this user cannot reach. Silently failing every
    // triage call would stop all cards, so we degrade to the model we know works.
    mocks.profile = { ...mocks.profile, triageModel: 'not-entitled', answerModel: 'claude-sonnet-4.6' };
    mocks.getAvailableModels.mockReturnValue(['gpt-4.1', 'claude-sonnet-4.6']);

    handleTranscriptSegment(segment('Some meeting chatter.'));
    await flushPromises();

    const [, , options] = mocks.agentCompletion.mock.calls[0]!;
    expect(options).toMatchObject({ model: 'claude-sonnet-4.6' });
  });

  it('skips an answer model that is also unavailable rather than falling onto a dead model', async () => {
    // A profile can name the same unreachable model for both roles — this is exactly how triage died
    // in the wild, with every tick throwing at session.create and no card ever reaching the overlay.
    mocks.profile = { ...mocks.profile, triageModel: 'not-entitled', answerModel: 'not-entitled' };
    mocks.getAvailableModels.mockReturnValue(['gpt-4.1', 'claude-sonnet-4.6']);

    handleTranscriptSegment(segment('Some meeting chatter.'));
    await flushPromises();

    const [, , options] = mocks.agentCompletion.mock.calls[0]!;
    expect(options).toMatchObject({ model: 'gpt-4.1' });
  });

  it('trusts the configured triage model before the model list has loaded', async () => {    // An empty list means "not fetched yet", not "nothing is available".
    mocks.profile = { ...mocks.profile, triageModel: 'gpt-4.1', answerModel: 'claude-sonnet-4.6' };
    mocks.getAvailableModels.mockReturnValue([]);

    handleTranscriptSegment(segment('Some meeting chatter.'));
    await flushPromises();

    const [, , options] = mocks.agentCompletion.mock.calls[0]!;
    expect(options).toMatchObject({ model: 'gpt-4.1' });
  });

  it('surfaces nothing when the profile prompt decides nothing is relevant', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('Anyway, how was your weekend?'));
    await flushPromises();

    expect(createdCards).toEqual([]);
    expect(mocks.profileAgentCompletion).not.toHaveBeenCalled();
  });

  it('raises a context card for a passive request on the docs profile like any other profile', async () => {
    // Documentation used to be a privileged built-in source. It is now just the Microsoft Learn MCP
    // server on the seeded profile, so the docs profile takes the exact same code path as a sales one.
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'passive', topic: 'Azure AI Search', query: 'Azure AI Search vector indexes' }),
    );
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('Vector indexes are how we rank results.'));
    await flushPromises();

    expect(createdCards.map((card) => card.kind)).toEqual(['context']);
    const [profileArg, userMessage] = mocks.profileAgentCompletion.mock.calls[0] ?? [];
    expect(profileArg).toBe(mocks.profile);
    expect(userMessage).toContain('Azure AI Search vector indexes');
  });

  it('starts exactly one answer agent for an explicit request', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Contoso renewal date', query: 'When does the Contoso agreement renew?' }),
    );
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('I need to check when that renews.'));
    await flushPromises();

    expect(createdCards.filter((card) => card.kind === 'answer')).toHaveLength(1);
    expect(createdCards.find((card) => card.kind === 'answer')?.title).toBe('Contoso renewal date');
  });

  it('surfaces an unbounded topic a fixed catalogue could never have matched', async () => {
    // The whole reason triage replaced regex detection: a sales profile has to react to customer
    // names nobody could have enumerated ahead of time.
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.profile = createProfileFromTemplate('sales-review', []) as MeetingProfile;
    mocks.profile.triageCadence = { mode: 'both', intervalSeconds: 5 };
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'passive', topic: 'Fabrikam renewal', query: 'Fabrikam renewal status and milestones' }),
    );
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('The Fabrikam one is slipping to next quarter.'));
    await flushPromises();

    expect(createdCards.map((card) => card.kind)).toEqual(['context']);
    expect(createdCards[0]!.title).toBe('Fabrikam renewal');
  });

  it('honours the profile prompt asking for every concept mentioned', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.profile = createProfileFromTemplate('training', []) as MeetingProfile;
    mocks.profile.triageCadence = { mode: 'both', intervalSeconds: 5 };
    mocks.agentCompletion.mockResolvedValueOnce(triage(
      { kind: 'passive', topic: 'Loop components' },
      { kind: 'passive', topic: 'Fluid Framework' },
    ));
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('Loop components sync through Fluid Framework.'));
    await flushPromises();

    expect(createdCards.map((card) => card.title)).toEqual(['Loop components', 'Fluid Framework']);
    expect(createdCards.map((card) => card.kind)).toEqual(['context', 'context']);
  });

  it('skips a topic that was already surfaced', async () => {
    vi.useFakeTimers();
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.profile.triageCadence = { mode: 'final_transcript', intervalSeconds: 5 };
    mocks.agentCompletion.mockResolvedValue(triage({ kind: 'passive', topic: 'Azure AI Search' }));
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('First mention of the index.'));
    await flushPromises();
    // The dedupe floor is measured in minutes, so a second window must not re-raise the card.
    handleTranscriptSegment(segment('Second mention of the very same index topic.'));
    await vi.advanceTimersByTimeAsync(8_000);
    await flushPromises();

    expect(mocks.agentCompletion).toHaveBeenCalledTimes(2);
    expect(createdCards).toHaveLength(1);
  });

  it('tells triage which topics it already surfaced', async () => {
    vi.useFakeTimers();
    mocks.profile.triageCadence = { mode: 'final_transcript', intervalSeconds: 5 };
    mocks.agentCompletion.mockResolvedValueOnce(triage({ kind: 'passive', topic: 'Azure AI Search' }));
    handleTranscriptSegment(segment('First mention of the index.'));
    await flushPromises();

    mocks.agentCompletion.mockResolvedValueOnce(triage());
    handleTranscriptSegment(segment('An entirely different subject now.'));
    await vi.advanceTimersByTimeAsync(8_000);
    await flushPromises();

    const [, userMessage] = mocks.agentCompletion.mock.calls[1]!;
    expect(userMessage).toContain('azure ai search');
  });

  it('does not call the model at all when both card kinds are disabled', async () => {
    mocks.profile.passiveCardsEnabled = false;
    mocks.profile.explicitAnswersEnabled = false;

    handleTranscriptSegment(segment('Plenty of technical discussion here.'));
    await flushPromises();

    expect(mocks.agentCompletion).not.toHaveBeenCalled();
  });

  it('drops a passive request when passive cards are disabled', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.profile.passiveCardsEnabled = false;
    mocks.agentCompletion.mockResolvedValueOnce(triage({ kind: 'passive', topic: 'Azure AI Search' }));
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('Vector indexes are how we rank results.'));
    await flushPromises();

    expect(createdCards).toEqual([]);
  });

  it('survives a triage failure without disrupting the meeting', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.agentCompletion.mockRejectedValueOnce(new Error('model unavailable'));
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('Something worth surfacing.'));
    await flushPromises();

    expect(createdCards).toEqual([]);

    mocks.agentCompletion.mockResolvedValueOnce(triage({ kind: 'passive', topic: 'Azure AI Search' }));
    setMeetingListeningState(false);
    resetMeetingIntelligenceForTests();
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });
    setMeetingListeningState(true);
    handleTranscriptSegment(segment('A later window recovers.'));
    await flushPromises();

    expect(createdCards).toHaveLength(1);
  });

  it('ignores malformed triage output', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.agentCompletion.mockResolvedValueOnce('I am not going to answer in JSON today.');
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('Something worth surfacing.'));
    await flushPromises();

    expect(createdCards).toEqual([]);
  });
});

describe('triage cadence', () => {
  beforeEach(() => {
    resetMeetingIntelligenceForTests();
    vi.clearAllMocks();
    mocks.getAvailableModels.mockReturnValue([]);
    mocks.agentCompletion.mockResolvedValue(triage());
    mocks.profile = createDefaultProfile();
    setMeetingCallbacks({});
  });

  afterEach(() => {
    resetMeetingIntelligenceForTests();
    vi.useRealTimers();
  });

  it('rate limits triage so a chatty meeting cannot fire a model call per sentence', async () => {
    vi.useFakeTimers();
    mocks.profile.triageCadence = { mode: 'final_transcript', intervalSeconds: 5 };
    setMeetingListeningState(true);

    handleTranscriptSegment(segment('First sentence with plenty of substance.'));
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    handleTranscriptSegment(segment('Second sentence arriving immediately afterwards.'));
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    // Still inside the floor: the second tick is deferred, not dropped.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(2);
  });

  it('waits for the interval when final-transcript checks are disabled', async () => {
    vi.useFakeTimers();
    mocks.profile.triageCadence = { mode: 'interval', intervalSeconds: 10 };

    const now = Math.floor(Date.now() / 1000);
    handleTranscriptSegment({
      ...segment('Azure AI Search supports vector search indexes.'),
      startedAt: now - 2,
      endedAt: now,
    });
    setMeetingListeningState(true);
    await flushPromises();

    expect(mocks.agentCompletion).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
  });

  it('feeds partial transcript text to triage before STT finalizes', async () => {
    vi.useFakeTimers();
    mocks.profile.triageCadence = { mode: 'interval', intervalSeconds: 10 };

    setMeetingListeningState(true);
    handlePartialTranscript({
      text: 'Azure AI Search supports vector search indexes.',
      source: 'mic',
      updatedAt: 120,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    const [, userMessage] = mocks.agentCompletion.mock.calls[0]!;
    expect(userMessage).toContain('vector search indexes');
  });

  it('skips a tick when the transcript window has not materially changed', async () => {
    vi.useFakeTimers();
    mocks.profile.triageCadence = { mode: 'interval', intervalSeconds: 10 };

    setMeetingListeningState(true);
    handlePartialTranscript({ text: 'Nothing new is being said.', source: 'mic', updatedAt: 120 });

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
  });

  it('starts triage from a partial instead of waiting for the speaker to stop', async () => {
    // Time-to-first-card is dominated by what happens before the model calls. Reacting only to
    // finalized speech meant waiting on end-of-utterance detection plus the next cadence tick.
    vi.useFakeTimers();
    mocks.profile.triageCadence = { mode: 'final_transcript', intervalSeconds: 60 };
    setMeetingListeningState(true);

    handlePartialTranscript({
      text: 'How does Azure Container Apps handle scale to zero',
      source: 'mic',
      updatedAt: 120,
    });
    await flushPromises();

    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
  });

  it('ignores a filler-word partial so it cannot consume a tick', async () => {
    vi.useFakeTimers();
    mocks.profile.triageCadence = { mode: 'final_transcript', intervalSeconds: 60 };
    setMeetingListeningState(true);

    handlePartialTranscript({ text: 'um yeah', source: 'mic', updatedAt: 120 });
    await flushPromises();

    expect(mocks.agentCompletion).not.toHaveBeenCalled();
  });

  it('holds interval ticks to the same floor as speech-driven ones', async () => {
    // Both triggers share one throttle; otherwise a short cadence would stack ticks on top of the
    // partial-driven ones and multiply spend.
    vi.useFakeTimers();
    mocks.profile.triageCadence = { mode: 'interval', intervalSeconds: 3 };
    setMeetingListeningState(true);

    // Speech-driven run 200ms before the interval tick is due.
    await vi.advanceTimersByTimeAsync(2_800);
    handlePartialTranscript({ text: 'First topic under discussion here', source: 'mic', updatedAt: 120 });
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    // One more word: enough to change the transcript fingerprint, not enough to schedule triage on
    // its own, so the interval tick is the only thing that could fire next.
    handlePartialTranscript({
      text: 'First topic under discussion here now',
      source: 'mic',
      updatedAt: 121,
    });

    // The tick lands 200ms after the speech-driven run, inside the floor, so it defers.
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(2);
  });
});

describe('card fetch stage', () => {
  beforeEach(() => {
    resetMeetingIntelligenceForTests();
    vi.clearAllMocks();
    mocks.getAvailableModels.mockReturnValue([]);
    mocks.agentCompletion.mockResolvedValue(triage());
    mocks.profile = createDefaultProfile();
    mocks.profile.triageCadence = { mode: 'both', intervalSeconds: 5 };
    setMeetingCallbacks({});
    setMeetingListeningState(true);
  });

  afterEach(() => {
    resetMeetingIntelligenceForTests();
    vi.useRealTimers();
  });

  it('paints partial answer text into the card before the agent finishes', async () => {
    // The full answer takes many seconds to write. Showing it as it arrives is what makes the card
    // feel fast; waiting for the final string is what made it feel slow.
    const updatedCards: MeetingCardEvent['card'][] = [];
    mocks.profileAgentCompletion.mockImplementationOnce(async (_profile, _prompt, options) => {
      options?.onPartial?.('Vector indexes ');
      await new Promise((resolve) => setTimeout(resolve, 250));
      options?.onPartial?.('Vector indexes store embeddings.');
      return 'Vector indexes store embeddings.';
    });
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Vector indexes', query: 'Azure AI Search vector indexes' }),
    );
    setMeetingCallbacks({ onCardUpdated: (event) => updatedCards.push(event.card) });

    handleTranscriptSegment(segment('I need to check how vector indexes work.'));

    await vi.waitFor(() => {
      expect(updatedCards.some((card) => card.status === 'running' && card.body === 'Vector indexes')).toBe(true);
      expect(updatedCards.some((card) => card.status === 'ready')).toBe(true);
    });
  });

  it('streams passive cards too, not just explicit answers', async () => {
    const updatedCards: MeetingCardEvent['card'][] = [];
    mocks.profileAgentCompletion.mockImplementationOnce(async (_profile, _prompt, options) => {
      options?.onPartial?.('Reviewing the pipeline');
      return 'Reviewing the pipeline for Contoso.';
    });
    mocks.agentCompletion.mockResolvedValueOnce(triage({ kind: 'passive', topic: 'Pipeline review' }));
    setMeetingCallbacks({ onCardUpdated: (event) => updatedCards.push(event.card) });

    handleTranscriptSegment(segment('Walking the Contoso pipeline now.'));

    await vi.waitFor(() => {
      expect(updatedCards.some((card) => card.kind === 'context' && card.status === 'running' && card.body === 'Reviewing the pipeline')).toBe(true);
    });
  });

  it('stops streaming into a card the user already cancelled', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    const updatedCards: MeetingCardEvent['card'][] = [];
    let emitPartial: ((text: string) => void) | undefined;
    mocks.profileAgentCompletion.mockImplementationOnce((_profile, _prompt, options) => {
      emitPartial = options?.onPartial;
      return new Promise<string>(() => {});
    });
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Vector indexes', query: 'Azure AI Search vector indexes' }),
    );
    setMeetingCallbacks({
      onCardCreated: (event) => createdCards.push(event.card),
      onCardUpdated: (event) => updatedCards.push(event.card),
    });

    handleTranscriptSegment(segment('I need to check how vector indexes work.'));
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));

    removeMeetingCard(createdCards[0]!.id);
    updatedCards.length = 0;
    expect(emitPartial).toBeDefined();
    emitPartial?.('text that should never be shown');

    expect(updatedCards).toEqual([]);
  });

  it('promotes URLs the agent cited into clickable card sources', async () => {
    // Docs links used to be appended as a plaintext "Sources:" block built from the docs search.
    // Now any profile can produce links, so they are parsed back out of the answer itself.
    const url = 'https://learn.microsoft.com/en-us/azure/search/vector-search-overview';
    const updatedCards: MeetingCardEvent['card'][] = [];
    mocks.profileAgentCompletion.mockResolvedValueOnce(
      `Use vector indexes for semantic retrieval. See [Vector search overview](${url}).`,
    );
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Vector indexes', query: 'Azure AI Search vector indexes' }),
    );
    setMeetingCallbacks({ onCardUpdated: (event) => updatedCards.push(event.card) });

    handleTranscriptSegment(segment('I need to check how vector indexes work.'));

    await vi.waitFor(() => {
      const answerCard = updatedCards.find((card) => card.kind === 'answer' && card.status === 'ready');
      expect(answerCard?.docs).toEqual([{ title: 'Vector search overview', url }]);
    });
  });

  it('lets the profile prompt decide what counts as unverified instead of a hardcoded gate', async () => {
    // The old code refused to even call the answer agent when a docs search came back empty. That
    // gate made every non-docs profile useless, so the prompt owns this now.
    const updatedCards: MeetingCardEvent['card'][] = [];
    mocks.profileAgentCompletion.mockResolvedValueOnce(
      'I could not confirm this from the connected sources. Needs verification with the connector owner.',
    );
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Internal connector', query: 'an unknown internal connector' }),
    );
    setMeetingCallbacks({ onCardUpdated: (event) => updatedCards.push(event.card) });

    handleTranscriptSegment(segment('I need to check that internal connector.'));

    await vi.waitFor(() => {
      const answerCard = updatedCards.find((card) => card.kind === 'answer' && card.status === 'ready');
      expect(answerCard?.body).toContain('Needs verification');
    });
    expect(mocks.profileAgentCompletion).toHaveBeenCalledTimes(1);
  });

  it('answers explicit asks from profile tools on a profile with no docs server at all', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    const updatedCards: MeetingCardEvent['card'][] = [];
    mocks.profile = createProfileFromTemplate('sales-review', []) as MeetingProfile;
    mocks.profile.triageCadence = { mode: 'both', intervalSeconds: 5 };
    mocks.profileAgentCompletion.mockResolvedValue('Contoso renews in March.');
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Contoso renewal', query: 'Contoso renewal date' }),
    );
    setMeetingCallbacks({
      onCardCreated: (event) => createdCards.push(event.card),
      onCardUpdated: (event) => updatedCards.push(event.card),
    });

    handleTranscriptSegment(segment('I need to check the Contoso renewal date.'));
    await flushPromises();

    expect(mocks.profile.mcpServers).toEqual([]);
    expect(createdCards.map((card) => card.kind)).toEqual(['answer']);
    expect(updatedCards.at(-1)?.status).toBe('ready');
    expect(updatedCards.at(-1)?.body).toContain('Contoso renews in March.');
  });

  it('runs the passive fetch with the full profile session', async () => {
    mocks.profile = createProfileFromTemplate('sales-review', []) as MeetingProfile;
    mocks.profile.triageCadence = { mode: 'both', intervalSeconds: 5 };
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'passive', topic: 'Fabrikam renewal', query: 'Fabrikam renewal status' }),
    );

    handleTranscriptSegment(segment('The Fabrikam one is slipping.'));
    await flushPromises();

    const [profileArg, userMessage] = mocks.profileAgentCompletion.mock.calls[0] ?? [];
    expect(profileArg).toBe(mocks.profile);
    expect(userMessage).toContain('Fabrikam renewal status');
  });

  it('resolves the fetch model too, so a dead answer model does not land on the SDK default', async () => {
    // The call-site guard in copilot.ts recovers by dropping the model override entirely, which keeps
    // cards working but hands model choice to the SDK. Resolving here means we land on a model Aura
    // actually chose, which is the difference between a fast fetch and an arbitrary one.
    mocks.profile = { ...mocks.profile, triageModel: 'not-entitled', answerModel: 'not-entitled' };
    mocks.getAvailableModels.mockReturnValue(['gpt-4.1', 'claude-sonnet-5.5']);
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'passive', topic: 'Azure Functions', query: 'Azure Functions overview' }),
    );

    handleTranscriptSegment(segment('We should look at Azure Functions.'));
    await flushPromises();

    const [, , options] = mocks.profileAgentCompletion.mock.calls[0] ?? [];
    expect(options).toMatchObject({ model: 'claude-sonnet-5.5' });
  });

  it('constrains both card prompts to the overlay format', async () => {
    mocks.profileAgentCompletion.mockResolvedValue('Short answer.');
    // One triage returning both kinds — a second segment would be deferred by the 8s throttle.
    mocks.agentCompletion.mockResolvedValueOnce(triage(
      { kind: 'passive', topic: 'Fabrikam renewal', query: 'Fabrikam renewal status' },
      { kind: 'answer', topic: 'Contoso renewal', query: 'Contoso renewal date' },
    ));

    handleTranscriptSegment(segment('The Fabrikam one is slipping.'));
    await flushPromises();

    const prompts = mocks.profileAgentCompletion.mock.calls.map((call) => String(call[1]));
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      // The card renders in a small always-on-top overlay, so Aura — not the profile — caps the
      // shape of the answer. Without this a free-form agent replies with a markdown document.
      expect(prompt).toContain('No headings, no tables, no emoji.');
      expect(prompt).toContain('do not append a separate sources list');
      expect(prompt).toMatch(/Keep it to at most \d+ short/);
    }
    const passivePrompt = prompts.find((p) => p.includes('Fabrikam renewal status'));
    const answerPrompt = prompts.find((p) => p.includes('Contoso renewal date'));
    expect(passivePrompt).toContain('at most 3 short bullets');
    expect(answerPrompt).toContain('at most 6 short lines');
  });

  it('attaches OCR visual context to the answer prompt', async () => {
    mocks.profileAgentCompletion.mockResolvedValue('Here is the answer.');
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Copilot coding agent', query: 'GitHub Copilot coding agent' }),
    );

    handleTranscriptSegment({
      ...segment('I need to check what is on this shared screen.'),
      visualContext: {
        capturedAt: Date.now(),
        mode: 'local_ocr',
        ocr: { text: 'GitHub Copilot coding agent', confidence: 91, language: 'eng' },
      },
    });
    await flushPromises();

    expect(mocks.profileAgentCompletion.mock.calls[0]?.[1]).toContain('GitHub Copilot coding agent');
  });

  it('removes context cards and answer cards', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    const removedCardIds: string[] = [];
    mocks.agentCompletion.mockResolvedValueOnce(triage(
      { kind: 'passive', topic: 'AI Gateway' },
      { kind: 'answer', topic: 'API Management' },
    ));
    setMeetingCallbacks({
      onCardCreated: (event) => createdCards.push(event.card),
      onCardRemoved: (event) => removedCardIds.push(event.cardId),
    });

    handleTranscriptSegment(segment('Talking about the gateway.'));
    await flushPromises();

    const contextCard = createdCards.find((card) => card.kind === 'context');
    const answerCard = createdCards.find((card) => card.kind === 'answer');
    if (!contextCard || !answerCard) throw new Error('Expected context and answer cards to be created.');

    expect(removeMeetingCard(contextCard.id)).toBe(true);
    expect(removeMeetingCard(answerCard.id)).toBe(true);
    expect(removedCardIds).toEqual([contextCard.id, answerCard.id]);
  });

  it('clears all cards and prevents in-flight card updates from returning', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    const updatedCards: MeetingCardEvent['card'][] = [];
    const removedCardIds: string[] = [];
    let emitPartial: ((text: string) => void) | undefined;
    mocks.agentCompletion.mockResolvedValueOnce(triage({ kind: 'passive', topic: 'AI Gateway' }));
    mocks.profileAgentCompletion.mockImplementation((_profile, _prompt, options) => {
      emitPartial = options?.onPartial;
      return new Promise(() => {});
    });
    setMeetingCallbacks({
      onCardCreated: (event) => createdCards.push(event.card),
      onCardUpdated: (event) => updatedCards.push(event.card),
      onCardRemoved: (event) => removedCardIds.push(event.cardId),
    });

    handleTranscriptSegment(segment('Talking about the gateway.'));
    await flushPromises();
    expect(createdCards).toHaveLength(1);

    clearMeetingHistory();
    emitPartial?.('text that should stay cleared');

    expect(removedCardIds).toEqual([createdCards[0]!.id]);
    expect(updatedCards).toEqual([]);
  });
});

describe('profile learning signals', () => {
  beforeEach(() => {
    resetMeetingIntelligenceForTests();
    vi.clearAllMocks();
    mocks.getAvailableModels.mockReturnValue([]);
    mocks.agentCompletion.mockResolvedValue(triage());
    mocks.profile = createDefaultProfile();
    mocks.profile.triageCadence = { mode: 'both', intervalSeconds: 5 };
    setMeetingCallbacks({});
    setMeetingListeningState(true);
  });

  afterEach(() => {
    resetMeetingIntelligenceForTests();
    vi.useRealTimers();
  });

  it('records a signal when a surfaced topic matches the profile vocabulary', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.profile.vocabulary = ['Contoso renewal'];
    mocks.agentCompletion.mockResolvedValueOnce(triage({ kind: 'passive', topic: 'contoso renewal' }));
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('The renewal is how the enterprise agreement works this year.'));
    await flushPromises();

    const card = createdCards.find((entry) => entry.kind === 'context');
    expect(card).toBeDefined();

    mocks.persistProfileLearning.mockClear();
    recordMeetingCardSignal(card!.id, 'link_opened');
    await flushPromises();

    expect(mocks.persistProfileLearning).toHaveBeenCalledTimes(1);
    const [, learning] = mocks.persistProfileLearning.mock.calls[0]!;
    // The stored term is the user's own casing, not the model's.
    expect(learning.terms.map((term) => term.term)).toEqual(['Contoso renewal']);
  });

  it('never persists a triage topic the user did not already curate', async () => {
    // Triage topics are model output derived from live transcript. Only closed-catalogue terms
    // may reach disk.
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.profile.vocabulary = [];
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'passive', topic: 'the Northwind pricing exception' }),
    );
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('We agreed a one-off discount for them.'));
    await flushPromises();

    const card = createdCards.find((entry) => entry.kind === 'context');
    expect(card).toBeDefined();

    mocks.persistProfileLearning.mockClear();
    recordMeetingCardSignal(card!.id, 'link_opened');
    await flushPromises();

    expect(mocks.persistProfileLearning).not.toHaveBeenCalled();
  });

  it('never records transcript text from explicit asks', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.profile.vocabulary = ['Northwind pricing exception'];
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Northwind pricing exception' }),
    );
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('I need to check the documentation for that exception.'));
    await flushPromises();

    const card = createdCards.find((entry) => entry.kind === 'answer');
    expect(card).toBeDefined();

    mocks.persistProfileLearning.mockClear();
    recordMeetingCardSignal(card!.id, 'link_opened');
    await flushPromises();

    expect(mocks.persistProfileLearning).not.toHaveBeenCalled();
  });

  it('ignores signals when profile learning is disabled', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    mocks.profile.learningEnabled = false;
    mocks.profile.vocabulary = ['Contoso renewal'];
    mocks.agentCompletion.mockResolvedValueOnce(triage({ kind: 'passive', topic: 'Contoso renewal' }));
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });

    handleTranscriptSegment(segment('The renewal is how the agreement works this year.'));
    await flushPromises();

    const card = createdCards.find((entry) => entry.kind === 'context');
    mocks.persistProfileLearning.mockClear();
    recordMeetingCardSignal(card!.id, 'link_opened');
    await flushPromises();

    expect(mocks.persistProfileLearning).not.toHaveBeenCalled();
  });

  it('ignores signals for unknown card ids', async () => {
    mocks.persistProfileLearning.mockClear();
    recordMeetingCardSignal('does-not-exist', 'dismissed');
    await flushPromises();

    expect(mocks.persistProfileLearning).not.toHaveBeenCalled();
  });
});

describe('word-cadence triage', () => {
  beforeEach(() => {
    resetMeetingIntelligenceForTests();
    vi.clearAllMocks();
    mocks.getAvailableModels.mockReturnValue([]);
    mocks.agentCompletion.mockResolvedValue(triage());
    mocks.profile = createDefaultProfile();
    // Interval mode only, so every assertion here is about speech-driven triage.
    mocks.profile.triageCadence = { mode: 'interval', intervalSeconds: 600 };
    setMeetingCallbacks({});
    setMeetingListeningState(true);
  });

  afterEach(() => {
    resetMeetingIntelligenceForTests();
    vi.useRealTimers();
  });

  it('re-triages once a partial has added a few new words', async () => {
    // Triage is what decides whether a card exists at all, so it should track the sentence as it is
    // spoken rather than waiting for the speaker to stop.
    vi.useFakeTimers();

    handlePartialTranscript({ text: 'I am looking for the', source: 'mic', updatedAt: 120 });
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    handlePartialTranscript({
      text: 'I am looking for the documentation for hosted agents',
      source: 'mic',
      updatedAt: 121,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    expect(mocks.agentCompletion).toHaveBeenCalledTimes(2);
    expect(String(mocks.agentCompletion.mock.calls[1]?.[1])).toContain('hosted agents');
  });

  it('does not re-triage a partial that only added a word or two', async () => {
    // A partial arrives every few hundred milliseconds. Re-reading almost the same words is pure
    // spend, and the extra word rarely changes the decision.
    vi.useFakeTimers();

    handlePartialTranscript({ text: 'I am looking for the', source: 'mic', updatedAt: 120 });
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    handlePartialTranscript({ text: 'I am looking for the docs', source: 'mic', updatedAt: 121 });
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
  });

  it('classifies a short finalized utterance that would never reach the word gate', async () => {
    // "Deploy AKS." is two words, so gating finalized speech on new words would drop it entirely.
    mocks.profile.triageCadence = { mode: 'final_transcript', intervalSeconds: 600 };

    handleTranscriptSegment(segment('Deploy AKS.'));
    await flushPromises();

    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
  });

  it('lets a second triage start while the first is still thinking', async () => {
    // A strict one-at-a-time guard means the tick holding the important words waits on a tick that
    // was classified before they were spoken — which is the "finish your sentence, then wait" feel.
    vi.useFakeTimers();
    let resolveFirst: ((value: string) => void) | undefined;
    mocks.agentCompletion.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    handlePartialTranscript({ text: 'I am looking for the', source: 'mic', updatedAt: 120 });
    await flushPromises();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);

    handlePartialTranscript({
      text: 'I am looking for the documentation for hosted agents',
      source: 'mic',
      updatedAt: 121,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    // The first call has still not resolved, yet the informative one already went out.
    expect(resolveFirst).toBeDefined();
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(2);
  });
});

describe('card supersede', () => {
  beforeEach(() => {
    resetMeetingIntelligenceForTests();
    vi.clearAllMocks();
    mocks.getAvailableModels.mockReturnValue([]);
    mocks.agentCompletion.mockResolvedValue(triage());
    // clearAllMocks clears calls, not implementations, so a resolved value set by an earlier block
    // would leak in and finish every card before it could be superseded.
    mocks.profileAgentCompletion.mockImplementation(() => new Promise<string>(() => {}));
    mocks.profile = createDefaultProfile();
    mocks.profile.triageCadence = { mode: 'interval', intervalSeconds: 600 };
    setMeetingCallbacks({});
    setMeetingListeningState(true);
  });

  afterEach(() => {
    resetMeetingIntelligenceForTests();
    vi.useRealTimers();
  });

  it('grows a card in place when the same ask gets more specific', async () => {
    // "documentation for hosted agents available regions" arrives as two triage passes. One question
    // was asked, so it should end as one card carrying the fuller query.
    vi.useFakeTimers();
    const createdCards: MeetingCardEvent['card'][] = [];
    const updatedCards: MeetingCardEvent['card'][] = [];
    setMeetingCallbacks({
      onCardCreated: (event) => createdCards.push(event.card),
      onCardUpdated: (event) => updatedCards.push(event.card),
    });
    mocks.agentCompletion
      .mockResolvedValueOnce(triage({ kind: 'answer', topic: 'Hosted agents', query: 'hosted agents' }))
      .mockResolvedValueOnce(triage({
        kind: 'answer',
        topic: 'Hosted agents available regions',
        query: 'hosted agents available regions',
      }));

    handlePartialTranscript({ text: 'documentation for hosted agents', source: 'mic', updatedAt: 120 });
    await flushPromises();
    expect(createdCards).toHaveLength(1);

    handlePartialTranscript({
      text: 'documentation for hosted agents available regions please',
      source: 'mic',
      updatedAt: 121,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    expect(createdCards).toHaveLength(1);
    expect(updatedCards.at(-1)?.id).toBe(createdCards[0]!.id);
    expect(updatedCards.at(-1)?.title).toBe('Hosted agents available regions');
    expect(String(mocks.profileAgentCompletion.mock.calls[1]?.[1])).toContain('available regions');
  });

  it('drops a straggler that says less than the card already on screen', async () => {
    vi.useFakeTimers();
    const createdCards: MeetingCardEvent['card'][] = [];
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });
    mocks.agentCompletion
      .mockResolvedValueOnce(triage({
        kind: 'answer',
        topic: 'Hosted agents available regions',
        query: 'hosted agents available regions',
      }))
      .mockResolvedValueOnce(triage({ kind: 'answer', topic: 'Hosted agents', query: 'hosted agents' }));

    handlePartialTranscript({ text: 'hosted agents available regions', source: 'mic', updatedAt: 120 });
    await flushPromises();
    expect(createdCards).toHaveLength(1);

    handlePartialTranscript({ text: 'hosted agents available regions please tell me', source: 'mic', updatedAt: 121 });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    expect(createdCards).toHaveLength(1);
    expect(mocks.profileAgentCompletion).toHaveBeenCalledTimes(1);
  });

  it('discards the superseded run instead of letting it overwrite the refined card', async () => {
    // The SDK exposes no cancellation, so the replaced agent call runs to completion. Its result has
    // to be dropped, or the narrower answer lands on top of the better one.
    vi.useFakeTimers();
    const updatedCards: MeetingCardEvent['card'][] = [];
    let resolveFirstFetch: ((value: string) => void) | undefined;
    setMeetingCallbacks({ onCardUpdated: (event) => updatedCards.push(event.card) });
    mocks.profileAgentCompletion
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveFirstFetch = resolve; }))
      .mockResolvedValueOnce('Hosted agents run in five regions.');
    mocks.agentCompletion
      .mockResolvedValueOnce(triage({ kind: 'answer', topic: 'Hosted agents', query: 'hosted agents' }))
      .mockResolvedValueOnce(triage({
        kind: 'answer',
        topic: 'Hosted agents available regions',
        query: 'hosted agents available regions',
      }));

    handlePartialTranscript({ text: 'documentation for hosted agents', source: 'mic', updatedAt: 120 });
    await flushPromises();

    handlePartialTranscript({
      text: 'documentation for hosted agents available regions please',
      source: 'mic',
      updatedAt: 121,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    resolveFirstFetch?.('Hosted agents are managed runners.');
    await flushPromises();

    expect(updatedCards.at(-1)?.body).toBe('Hosted agents run in five regions.');
  });

  it('opens a second card once the first one has started painting text', async () => {
    // Replacing text someone is already reading is worse than a second card, so the supersede window
    // closes at the first delta rather than at some timeout.
    vi.useFakeTimers();
    const createdCards: MeetingCardEvent['card'][] = [];
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });
    mocks.profileAgentCompletion.mockImplementation((_profile, _prompt, options) => {
      options?.onPartial?.('Hosted agents are');
      return new Promise<string>(() => {});
    });
    mocks.agentCompletion
      .mockResolvedValueOnce(triage({ kind: 'answer', topic: 'Hosted agents', query: 'hosted agents' }))
      .mockResolvedValueOnce(triage({
        kind: 'answer',
        topic: 'Hosted agents available regions',
        query: 'hosted agents available regions',
      }));

    handlePartialTranscript({ text: 'documentation for hosted agents', source: 'mic', updatedAt: 120 });
    await flushPromises();
    expect(createdCards).toHaveLength(1);

    handlePartialTranscript({
      text: 'documentation for hosted agents available regions please',
      source: 'mic',
      updatedAt: 121,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    expect(createdCards).toHaveLength(2);
  });

  it('treats a repeat of the same topic as already answered', async () => {
    vi.useFakeTimers();
    const createdCards: MeetingCardEvent['card'][] = [];
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });
    mocks.agentCompletion.mockResolvedValue(
      triage({ kind: 'answer', topic: 'Hosted agents', query: 'hosted agents' }),
    );

    handlePartialTranscript({ text: 'documentation for hosted agents', source: 'mic', updatedAt: 120 });
    await flushPromises();

    handlePartialTranscript({ text: 'documentation for hosted agents again please', source: 'mic', updatedAt: 121 });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    expect(createdCards).toHaveLength(1);
    expect(mocks.profileAgentCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('decision gate in front of triage', () => {
  const GATE_SETTINGS: DecisionGateSettings = {
    enabled: true,
    endpoint: 'https://your-resource.services.ai.azure.com/',
    deployment: 'Microsoft-Decision-1',
  };

  const decided = (verdict: 'pass' | 'decline'): DecisionGateResult => ({
    status: 'decided',
    verdict,
    probabilities: verdict === 'pass' ? { passive: 0.8, answer: 0.1 } : { passive: 0.02, answer: 0.01 },
    ms: 90,
  });

  beforeEach(() => {
    resetMeetingIntelligenceForTests();
    vi.clearAllMocks();
    mocks.getAvailableModels.mockReturnValue([]);
    mocks.agentCompletion.mockResolvedValue(triage());
    mocks.profileAgentCompletion.mockImplementation(() => new Promise<string>(() => {}));
    mocks.profile = createDefaultProfile();
    mocks.profile.triageCadence = { mode: 'both', intervalSeconds: 5 };
    mocks.settings = { decisionGate: GATE_SETTINGS };
    mocks.runDecisionGate.mockResolvedValue(decided('pass'));
    setMeetingCallbacks({});
    setMeetingListeningState(true);
  });

  afterEach(() => {
    resetMeetingIntelligenceForTests();
    vi.useRealTimers();
  });

  it('skips the LLM triage, and so every card, when the gate declines', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });
    mocks.runDecisionGate.mockResolvedValue(decided('decline'));

    handleTranscriptSegment(segment('Anyway, how was your weekend?'));
    await flushPromises();

    expect(mocks.runDecisionGate).toHaveBeenCalledTimes(1);
    expect(mocks.agentCompletion).not.toHaveBeenCalled();
    expect(mocks.profileAgentCompletion).not.toHaveBeenCalled();
    expect(createdCards).toEqual([]);
  });

  it('lets the LLM name the topic when the gate passes, and the profile session does the search', async () => {
    const createdCards: MeetingCardEvent['card'][] = [];
    setMeetingCallbacks({ onCardCreated: (event) => createdCards.push(event.card) });
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'passive', topic: 'Hosted agents', query: 'hosted agents available regions' }),
    );

    handleTranscriptSegment(segment('We are looking at hosted agents in West Europe.'));
    await flushPromises();

    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
    expect(createdCards.map((card) => card.title)).toEqual(['Hosted agents']);
    expect(String(mocks.profileAgentCompletion.mock.calls[0]?.[1])).toContain('hosted agents available regions');
    // The gate answers first; the LLM never runs ahead of it.
    expect(mocks.runDecisionGate.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.agentCompletion.mock.invocationCallOrder[0]!);
  });

  it('hands the gate the gate settings, the active profile, and the live transcript', async () => {
    handleTranscriptSegment(segment('We need to check hosted agents in West Europe.'));
    await flushPromises();

    const [settingsArg, input] = mocks.runDecisionGate.mock.calls[0]!;
    expect(settingsArg).toEqual(GATE_SETTINGS);
    expect(input.profile).toBe(mocks.profile);
    expect(input.transcript).toContain('hosted agents in West Europe');
    expect(input.recentTopics).toEqual([]);
  });

  it('tells the gate what is already on screen, so it does not ask for the same card again', async () => {
    vi.useFakeTimers();
    mocks.agentCompletion
      .mockResolvedValueOnce(triage({ kind: 'passive', topic: 'Hosted agents' }))
      .mockResolvedValueOnce(triage());

    handlePartialTranscript({ text: 'we are looking at hosted agents today', source: 'mic', updatedAt: 120 });
    await flushPromises();
    handlePartialTranscript({
      text: 'we are looking at hosted agents today and the pricing too',
      source: 'mic',
      updatedAt: 121,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    expect(mocks.runDecisionGate).toHaveBeenCalledTimes(2);
    expect(mocks.runDecisionGate.mock.calls[1]![1].recentTopics).toEqual(['hosted agents']);
  });

  it('does not let a declined tick block the next one that finally holds the subject', async () => {
    vi.useFakeTimers();
    mocks.runDecisionGate
      .mockResolvedValueOnce(decided('decline'))
      .mockResolvedValueOnce(decided('pass'));
    mocks.agentCompletion.mockResolvedValueOnce(
      triage({ kind: 'answer', topic: 'Hosted agents regions', query: 'hosted agents available regions' }),
    );

    handlePartialTranscript({ text: 'so um I was just thinking about', source: 'mic', updatedAt: 120 });
    await flushPromises();
    expect(mocks.agentCompletion).not.toHaveBeenCalled();

    handlePartialTranscript({
      text: 'so um I was just thinking about hosted agents available regions',
      source: 'mic',
      updatedAt: 121,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    await flushPromises();

    expect(mocks.runDecisionGate).toHaveBeenCalledTimes(2);
    expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
  });

  describe('falls back to the LLM, so a gate problem can never be why a card is missing', () => {
    it.each<[string, () => void]>([
      ['fails', () => mocks.runDecisionGate.mockResolvedValue({ status: 'failed', error: 'HTTP 404', ms: 12 })],
      ['is cooling down', () => mocks.runDecisionGate.mockResolvedValue({ status: 'skipped', reason: 'cooling_down' })],
      ['has no questions', () => mocks.runDecisionGate.mockResolvedValue({ status: 'skipped', reason: 'no_questions' })],
      ['throws unexpectedly', () => mocks.runDecisionGate.mockRejectedValue(new Error('boom'))],
    ])('when the gate %s', async (_name, arrange) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      arrange();

      handleTranscriptSegment(segment('We are ranking the account list with the search index.'));
      await flushPromises();

      expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
    });
  });

  describe('when no gate is configured', () => {
    it.each<[string, DecisionGateSettings]>([
      ['has no endpoint', { ...GATE_SETTINGS, endpoint: '' }],
      ['is switched off', { ...GATE_SETTINGS, enabled: false }],
    ])('never consults it when it %s', async (_name, gate) => {
      mocks.settings = { decisionGate: gate };

      handleTranscriptSegment(segment('We are ranking the account list with the search index.'));
      await flushPromises();

      expect(mocks.runDecisionGate).not.toHaveBeenCalled();
      expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
    });

    it('starts the LLM triage in the same turn, exactly as before the gate existed', () => {
      mocks.settings = { decisionGate: { ...GATE_SETTINGS, endpoint: '' } };

      handleTranscriptSegment(segment('We are ranking the account list with the search index.'));

      // No await at all: an unconfigured install must not pick up even one extra async hop.
      expect(mocks.agentCompletion).toHaveBeenCalledTimes(1);
    });
  });

  describe('keeping the gate ready', () => {
    it('gets a token ready when listening starts, so the first tick is not spent on credentials', () => {
      setMeetingListeningState(false);
      mocks.warmDecisionGate.mockClear();

      setMeetingListeningState(true);

      expect(mocks.warmDecisionGate).toHaveBeenCalledWith(GATE_SETTINGS);
    });

    it('forgets earlier gate failures when settings change, in case the new endpoint is the fix', () => {
      refreshMeetingIntelligenceSettings();

      expect(mocks.resetDecisionGateFailures).toHaveBeenCalledTimes(1);
      expect(mocks.warmDecisionGate).toHaveBeenCalledWith(GATE_SETTINGS);
    });
  });
});

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

function segment(text: string): TranscriptSegment {
  // Triage reads the rolling window, which prunes by age, so timestamps must be realistic.
  const now = Math.floor(Date.now() / 1000);
  return {
    text,
    source: 'mic',
    confidence: 1,
    startedAt: now - 2,
    endedAt: now,
  };
}
