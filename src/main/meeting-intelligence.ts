import type {
  AudioSource,
  DecisionGateSettings,
  LearnDoc,
  MeetingCard,
  MeetingCardEvent,
  MeetingCardRemovedEvent,
  MeetingCardSignal,
  MeetingProfile,
  PartialTranscriptSegment,
  ProfileLearningState,
  TranscriptSegment,
  TriageCadenceMode,
} from '../shared/types.js';
import { DEFAULT_ANSWER_MODEL, DEFAULT_TRIAGE_MODEL } from '../shared/types.js';
import { agentCompletion, getAvailableModels, profileAgentCompletion } from './copilot.js';
import { resetDecisionGateFailures, runDecisionGate, warmDecisionGate } from './decision-gate.js';
import { extractCitedLinks } from '../shared/answer-links.js';
import { formatDecisionGateProbabilities, isDecisionGateConfigured } from '../shared/decision-gate.js';
import { getActiveProfile, getSettings, persistProfileLearning } from './settings.js';
import { recordTermSignal, recordTermSurfaced } from '../shared/profile-learning.js';
import {
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  parseTriageResponse,
  resolveLearningTerm,
  type TriageRequest,
} from '../shared/meeting-triage.js';
import { appendRollingTranscript, buildTranscriptContext } from './meeting-detection.js';

interface MeetingCallbacks {
  onCardCreated?: (event: MeetingCardEvent) => void;
  onCardUpdated?: (event: MeetingCardEvent) => void;
  onCardRemoved?: (event: MeetingCardRemovedEvent) => void;
  /** Fired when listening stops, so the profile can review what it learned during the meeting. */
  onMeetingEnded?: () => void | Promise<void>;
}

const TRANSCRIPT_WINDOW_SECONDS = 5 * 60;
const CONCEPT_DEDUPE_SECONDS = 10 * 60;
const PASSIVE_CONTEXT_TIMEOUT_MS = 120_000;
/**
 * Triage is an LLM call, so it keeps a hard floor independent of `triageCadence`. A user who sets a
 * 3s cadence should not be able to fire a model call every 3 seconds.
 *
 * The floor was 8s when triage ran on the answer model and took ~8s, then 4s once triage moved to a
 * fast classifier. Both were sized for a pipeline that only reacted to finished sentences. Triage now
 * reads speech in progress, where the meaningful unit is "has the speaker said anything new yet" — a
 * few words, not a few seconds. 1.2s is roughly three words at conversational pace, so this floor and
 * the word gate below agree by construction instead of one masking the other.
 */
const TRIAGE_MIN_INTERVAL_MS = 1_200;
/**
 * How many new words a partial must add before it is worth re-classifying. Someone mid-sentence emits
 * a partial every few hundred milliseconds, and re-reading the same words is pure spend; a new word or
 * two is what actually changes the answer. Finalized segments bypass this — they are comparatively
 * rare and mark the end of a thought, so a two-word utterance still gets classified.
 *
 * This replaces an earlier character minimum. Words are the better unit: 16 characters is one long
 * technical term or four filler words, whereas three words is three words.
 */
const MIN_NEW_WORDS_FOR_TRIAGE = 3;
/**
 * Triage takes ~3s, so a strict one-at-a-time guard means the tick that finally contains the important
 * words has to wait for a tick that was classified before they were spoken. Allowing a second call in
 * flight removes that blind spot. Out-of-order results are safe because `classifySurfacedOverlap()`
 * resolves competing topics by specificity rather than arrival order.
 */
const MAX_CONCURRENT_TRIAGE = 2;
/** Triage must feel instant relative to the meeting; a slow tick is better dropped than queued. */
const TRIAGE_TIMEOUT_MS = 30_000;
/** How many recently surfaced topics are shown to triage so it stops re-raising the same thing. */
const MAX_RECENT_TOPICS = 12;
/**
 * Streaming deltas arrive far faster than a human reads, and every one crosses IPC and re-renders the
 * overlay. Batching to ~200ms still reads as live text while keeping the render cost negligible.
 */
const STREAM_UPDATE_INTERVAL_MS = 200;
/**
 * How many times one card may be restarted with a better query. Superseding is what turns "hosted
 * agents" into "hosted agents available regions" in place rather than as a second card, but each
 * restart is a fresh agent run, so it is capped and only allowed before any text has appeared.
 */
const MAX_CARD_REFINEMENTS = 2;
/** Function words that should not make two topics look different from each other. */
const TOPIC_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'for',
  'of',
  'in',
  'on',
  'to',
  'with',
  'about',
  'from',
  'by',
  'or',
  'at',
  'is',
  'are',
  'its',
]);

let callbacks: MeetingCallbacks = {};
let transcriptWindow: TranscriptSegment[] = [];
let partialTranscripts = new Map<AudioSource, PartialTranscriptSegment>();
let triageInterval: ReturnType<typeof setInterval> | null = null;
let triageIntervalSeconds = 0;
let listening = false;
let lastIntervalFingerprint = '';
let lastTriageAt = 0;
let triageInFlight = 0;
let pendingTriage: ReturnType<typeof setTimeout> | null = null;
/**
 * When the oldest speech that triage has not yet seen arrived. Time-to-first-card is dominated by
 * what happens *before* the model calls, so measuring from here is the only way to tell a slow model
 * apart from a tick that simply waited its turn.
 */
let untriagedSpeechAt = 0;
/** Word count of everything triage has already read, so a partial can be judged on what it adds. */
let lastTriagedWordCount = 0;
/** Kept only so an explicit answer can still carry the visual context captured with the segment. */
let lastSegment: TranscriptSegment | null = null;
const cards = new Map<string, MeetingCard>();
/**
 * Maps a card to the concept term it represents. Populated only for passive cards whose topic
 * matched the profile's curated vocabulary, so the renderer can send a bare card id and no
 * model-generated text ever reaches persisted settings.
 */
const cardTerms = new Map<string, string>();
/** Topic -> the card that answered it, so a more specific restatement can take that card over. */
const surfacedConcepts = new Map<string, SurfacedConcept>();
const cancelledCards = new Set<string>();
/**
 * Which run of a card is current. A superseded agent call cannot be aborted, so it is allowed to
 * finish and then discarded by comparing the generation it started with against this map.
 */
const cardGenerations = new Map<string, number>();
const cardRefinements = new Map<string, number>();
/** Cards that have painted real text, and are therefore past the point where replacing them is calm. */
const streamedCards = new Set<string>();

interface SurfacedConcept {
  at: number;
  cardId: string;
}

export function setMeetingCallbacks(nextCallbacks: MeetingCallbacks): void {
  callbacks = nextCallbacks;
}

export function setMeetingListeningState(nextListening: boolean): void {
  const wasListening = listening;
  listening = nextListening;
  if (listening && !wasListening) warmDecisionGate(getSettings().decisionGate);
  if (!listening) {
    transcriptWindow = [];
    partialTranscripts.clear();
    lastIntervalFingerprint = '';
    lastSegment = null;
    untriagedSpeechAt = 0;
    lastTriagedWordCount = 0;
    cardTerms.clear();
    clearPendingTriage();
    if (wasListening) void callbacks.onMeetingEnded?.();
  }
  refreshTriageInterval();
}

export function refreshMeetingIntelligenceSettings(): void {
  // A saved endpoint or deployment may be the fix for what was failing, so earlier failures are forgotten.
  resetDecisionGateFailures();
  if (listening) warmDecisionGate(getSettings().decisionGate);
  refreshTriageInterval();
}

export function resetMeetingIntelligenceForTests(): void {
  clearTriageInterval();
  clearPendingTriage();
  callbacks = {};
  transcriptWindow = [];
  listening = false;
  lastIntervalFingerprint = '';
  lastTriageAt = 0;
  triageInFlight = 0;
  lastSegment = null;
  untriagedSpeechAt = 0;
  lastTriagedWordCount = 0;
  cards.clear();
  cardTerms.clear();
  surfacedConcepts.clear();
  cancelledCards.clear();
  cardGenerations.clear();
  cardRefinements.clear();
  streamedCards.clear();
  partialTranscripts.clear();
  warnedUnavailableModels.clear();
}

/**
 * Folds a card interaction into the active profile's learning state. The renderer sends only a card
 * id; the concept term is resolved here from the in-process registry, so no transcript text can
 * reach persisted settings. Cards without a registered term (explicit answers) are ignored.
 */
export function recordMeetingCardSignal(cardId: string, signal: MeetingCardSignal): void {
  const term = cardTerms.get(cardId);
  if (!term) return;

  void updateActiveProfileLearning((state, now) => recordTermSignal(state, term, signal, now));
}

function recordSurfacedTerm(term: string): Promise<void> {
  return updateActiveProfileLearning((state, now) => recordTermSurfaced(state, term, now));
}

async function updateActiveProfileLearning(
  mutate: (state: ProfileLearningState, now: number) => ProfileLearningState,
): Promise<void> {
  try {
    const profile = getActiveProfile();
    if (!profile.learningEnabled) return;
    await persistProfileLearning(profile.id, mutate(profile.learning, Date.now()));
  } catch (err: unknown) {
    console.warn('[Meeting intelligence] Could not record profile learning signal:', err);
  }
}

export function handleTranscriptSegment(segment: TranscriptSegment): void {
  const trimmedText = segment.text.trim();
  if (!trimmedText) return;

  const nowSeconds = Math.floor(Date.now() / 1000);
  transcriptWindow = appendRollingTranscript(
    transcriptWindow,
    segment,
    nowSeconds,
    TRANSCRIPT_WINDOW_SECONDS,
  );
  partialTranscripts.delete(segment.source);
  lastSegment = segment;
  markSpeechArrived();

  const profile = getActiveProfile();
  if (shouldTriageOnFinalTranscript(profile.triageCadence.mode)) {
    scheduleTriage();
  }

  refreshTriageInterval();
}

/**
 * Partials arrive continuously while someone is still talking, so this is what keeps a card from
 * waiting on the speaker to stop. Before, a partial only refreshed the interval timer, which meant
 * the earliest possible reaction was end-of-utterance detection plus the next tick of a free-running
 * `intervalSeconds` timer — at the default cadence, ~10s of dead air on average before triage even
 * started, dwarfing the model calls that follow.
 *
 * Scheduling here instead lets triage run against the sentence in progress, so classification is
 * often already done by the time the speaker finishes. The gate is how much *new* speech has arrived
 * rather than how much time has passed, because that is the only thing that can change triage's
 * answer: a pause costs nothing, and a fast speaker gets classified sooner.
 */
export function handlePartialTranscript(segment: PartialTranscriptSegment): void {
  const trimmedText = segment.text.trim();
  if (!trimmedText) {
    partialTranscripts.delete(segment.source);
    return;
  }

  partialTranscripts.set(segment.source, {
    ...segment,
    text: trimmedText,
  });
  markSpeechArrived();
  refreshTriageInterval();

  if (hasEnoughNewSpeech()) {
    scheduleTriage();
  }
}

/** Timestamps the start of an un-triaged run of speech, leaving an in-progress one alone. */
function markSpeechArrived(): void {
  if (untriagedSpeechAt === 0) untriagedSpeechAt = Date.now();
}

/**
 * True once enough new words have arrived to be worth another classification pass.
 *
 * The rolling window prunes by age, so the total can fall; when it does the baseline is pulled down
 * with it, otherwise expiring old speech would suppress triage for the rest of the meeting.
 */
function hasEnoughNewSpeech(): boolean {
  const words = currentSpeechWordCount();
  if (words < lastTriagedWordCount) lastTriagedWordCount = words;
  return words - lastTriagedWordCount >= MIN_NEW_WORDS_FOR_TRIAGE;
}

/**
 * Counts words across exactly what triage reads. Counting raw partials instead would double-count:
 * a partial is replaced by a finalized segment containing the same words, which would look like a
 * burst of new speech and fire a redundant call.
 */
function currentSpeechWordCount(): number {
  let total = 0;
  for (const segment of transcriptWindow) total += countWords(segment.text);
  for (const segment of partialTranscripts.values()) total += countWords(segment.text);
  return total;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Runs triage as soon as the hard floor allows. A finalized segment usually means someone just
 * finished a sentence, which is exactly when an explicit ask needs to be caught, so the tick is
 * deferred rather than dropped.
 */
function scheduleTriage(): void {
  if (pendingTriage) return;

  const elapsed = Date.now() - lastTriageAt;
  if (elapsed >= TRIAGE_MIN_INTERVAL_MS) {
    void runTriage();
    return;
  }

  pendingTriage = setTimeout(() => {
    pendingTriage = null;
    void runTriage();
  }, TRIAGE_MIN_INTERVAL_MS - elapsed);
}

function clearPendingTriage(): void {
  if (pendingTriage) {
    clearTimeout(pendingTriage);
    pendingTriage = null;
  }
}

/**
 * Asks the active profile what, if anything, in the current transcript window is worth surfacing.
 *
 * This is the whole point of the profile system: the prompt decides the trigger, not a hardcoded
 * catalogue. Triage deliberately runs without the profile's MCP servers or skills, because most
 * ticks surface nothing and loading tools for a "no" is pure cost. The fetch stage that follows
 * gets the full profile session.
 *
 * When a decision gate is configured it goes first. A decision model answers "is anything here worth
 * surfacing?" in a few hundred milliseconds against ~3s for the LLM, so the LLM below only runs for ticks
 * that probably hold something. The gate feeds on the same profile prompt and can only say "skip"; it
 * never names a topic or runs a search.
 */
async function runTriage(): Promise<void> {
  if (!listening || triageInFlight >= MAX_CONCURRENT_TRIAGE) return;

  const profile = getActiveProfile();
  if (!profile.passiveCardsEnabled && !profile.explicitAnswersEnabled) return;

  const context = buildIntervalContext();
  if (!context) return;
  if (context.fingerprint === lastIntervalFingerprint) return;

  lastIntervalFingerprint = context.fingerprint;
  lastTriageAt = Date.now();
  lastTriagedWordCount = currentSpeechWordCount();
  triageInFlight += 1;

  const startedAt = lastTriageAt;
  const waitedMs = untriagedSpeechAt === 0 ? 0 : startedAt - untriagedSpeechAt;
  untriagedSpeechAt = 0;

  try {
    // Only hop to the gate when one is configured, so an unconfigured install keeps its old timing.
    const gateSettings = getSettings().decisionGate;
    if (
      isDecisionGateConfigured(gateSettings)
      && !(await passesDecisionGate(gateSettings, profile, context.detectionText))
    ) {
      return;
    }

    const raw = await agentCompletion(
      buildTriageSystemPrompt(profile),
      buildTriageUserMessage(context.detectionText, recentTopics()),
      { model: resolveTriageModel(profile), timeoutMs: TRIAGE_TIMEOUT_MS },
    );

    const triageMs = Date.now() - startedAt;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const requests = parseTriageResponse(raw);
    for (const request of requests) {
      dispatchTriageRequest(request, context.sourceText, profile, nowSeconds);
    }

    console.log(
      `[Meeting intelligence] Triage: waited ${waitedMs}ms after speech, ran ${triageMs}ms, surfaced ${requests.length}`,
    );
  } catch (err: unknown) {
    console.warn('[Meeting intelligence] Triage failed:', err);
  } finally {
    triageInFlight -= 1;
    // Speech that arrived while every slot was busy would otherwise sit until the next partial or
    // interval tick, which is the stall this whole path exists to remove.
    if (listening && hasEnoughNewSpeech()) scheduleTriage();
  }
}

/**
 * True when this tick is worth an LLM triage call. Only a clear "decline" says no: a gate that is off,
 * unreachable, timed out, or confused has no opinion, and none of those may be the reason a card
 * fails to appear, so they all fall through to the LLM.
 */
async function passesDecisionGate(
  settings: DecisionGateSettings,
  profile: MeetingProfile,
  transcript: string,
): Promise<boolean> {
  try {
    const result = await runDecisionGate(settings, {
      profile,
      transcript,
      recentTopics: recentTopics(),
    });
    if (result.status !== 'decided') return true;

    console.log(
      `[Meeting intelligence] Triage gate: ${formatDecisionGateProbabilities(result.probabilities)} in ${result.ms}ms -> ${result.verdict === 'pass' ? 'passed' : 'declined'}`,
    );
    return result.verdict === 'pass';
  } catch (err: unknown) {
    console.warn('[Meeting intelligence] Decision gate threw unexpectedly; the LLM decides this tick:', err);
    return true;
  }
}

/**
 * Picks the model a stage actually runs on.
 *
 * Model availability varies per account, and an unusable model fails session creation outright — which
 * means no cards at all rather than slower cards. Two details earn this its own helper. Triage can fire
 * every 1.2s, so an unconditional warn would spam the log once per tick, hence `warnedUnavailableModels`.
 * And the other stage's model is not automatically a safe landing spot: a profile can name the same dead
 * model for both roles, which is exactly how this failed in the wild, so the chain ends on a shipped
 * default that is known to exist.
 */
const warnedUnavailableModels = new Set<string>();

function resolveModel(label: string, configured: string, alternate: string, shipped: string): string {
  const models = getAvailableModels();
  // An empty list means "not fetched yet", not "nothing is available".
  if (models.length === 0) return configured;
  if (models.includes(configured)) return configured;

  const fallback = models.includes(alternate)
    ? alternate
    : models.includes(shipped)
      ? shipped
      : alternate;

  if (!warnedUnavailableModels.has(configured)) {
    warnedUnavailableModels.add(configured);
    console.warn(
      `[Meeting intelligence] ${label} model "${configured}" is unavailable; using "${fallback}".`,
    );
  }

  return fallback;
}

function resolveTriageModel(profile: MeetingProfile): string {
  return resolveModel('Triage', profile.triageModel, profile.answerModel, DEFAULT_TRIAGE_MODEL);
}

function resolveAnswerModel(profile: MeetingProfile): string {
  return resolveModel('Answer', profile.answerModel, profile.triageModel, DEFAULT_ANSWER_MODEL);
}

function dispatchTriageRequest(
  request: TriageRequest,
  sourceText: string,
  profile: MeetingProfile,
  nowSeconds: number,
): void {
  if (request.kind === 'answer' && !profile.explicitAnswersEnabled) return;
  if (request.kind === 'passive' && !profile.passiveCardsEnabled) return;

  const overlap = classifySurfacedOverlap(request.topic, nowSeconds);
  // Already answered, or less specific than something already on screen. Either way, adding a card
  // would just restate what the user can already read.
  if (overlap.relation === 'duplicate' || overlap.relation === 'subsumed') return;

  const existing =
    overlap.relation === 'extends' && canRefineCard(overlap.cardId)
      ? (cards.get(overlap.cardId) ?? null)
      : null;

  const card =
    request.kind === 'answer'
      ? startExplicitAnswer(request, sourceText, profile, existing)
      : startPassiveLookup(request, sourceText, profile, existing);

  // Registered under the new topic as well as the old one, so a third restatement still finds the
  // same card rather than opening a rival.
  surfacedConcepts.set(request.topic.toLowerCase(), { at: nowSeconds, cardId: card.id });
}

type SurfacedRelation = 'none' | 'duplicate' | 'extends' | 'subsumed';

interface SurfacedOverlap {
  relation: SurfacedRelation;
  cardId: string;
}

/**
 * Decides how a freshly triaged topic relates to one already on screen.
 *
 * Triage now runs while someone is still talking, so the same intent arrives repeatedly and grows:
 * "hosted agents", then "hosted agents available regions". Exact-match dedupe treated those as two
 * unrelated topics and opened two cards for one question, and the more specific one — the one the
 * speaker actually asked — arrived second. Comparing significant words instead lets the fuller topic
 * take over the card the shorter one already opened, and lets a straggler that says *less* be dropped.
 *
 * Most recent first, so a chain of refinements resolves against the latest phrasing.
 */
function classifySurfacedOverlap(topic: string, nowSeconds: number): SurfacedOverlap {
  const words = significantWords(topic);
  if (words.size === 0) return { relation: 'none', cardId: '' };

  const entries = Array.from(surfacedConcepts.entries()).reverse();
  for (const [surfacedTopic, entry] of entries) {
    if (nowSeconds - entry.at >= CONCEPT_DEDUPE_SECONDS) continue;

    const existing = significantWords(surfacedTopic);
    if (existing.size === 0) continue;

    if (isSubsetOf(existing, words)) {
      return {
        relation: existing.size === words.size ? 'duplicate' : 'extends',
        cardId: entry.cardId,
      };
    }
    if (isSubsetOf(words, existing)) return { relation: 'subsumed', cardId: entry.cardId };
  }

  return { relation: 'none', cardId: '' };
}

/** Words that carry the topic, so punctuation and filler cannot make two phrasings look different. */
function significantWords(topic: string): Set<string> {
  return new Set(
    topic
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0 && !TOPIC_STOPWORDS.has(word)),
  );
}

function isSubsetOf(candidate: Set<string>, container: Set<string>): boolean {
  for (const word of candidate) {
    if (!container.has(word)) return false;
  }
  return true;
}

/**
 * Whether a card can still be handed to a better query. Once text has appeared, replacing it would
 * make the overlay flicker mid-read, so the window closes there rather than at some timeout; the
 * refinement cap bounds spend for a speaker who keeps qualifying the same question.
 */
function canRefineCard(cardId: string): boolean {
  const card = cards.get(cardId);
  if (!card || card.status !== 'running') return false;
  if (streamedCards.has(cardId)) return false;
  return (cardRefinements.get(cardId) ?? 0) < MAX_CARD_REFINEMENTS;
}

function recentTopics(): string[] {
  return Array.from(surfacedConcepts.keys()).slice(-MAX_RECENT_TOPICS);
}

/**
 * The interval is now a safety net rather than the primary trigger, since partials schedule triage
 * directly. It goes through `scheduleTriage()` so both paths share one floor — calling `runTriage()`
 * here would let a short cadence stack ticks on top of partial-driven ones.
 */
function evaluateIntervalTriage(): void {
  if (!listening) return;
  scheduleTriage();
}

function refreshTriageInterval(): void {
  const profile = getActiveProfile();
  const shouldRun = listening && shouldTriageOnInterval(profile.triageCadence.mode);
  const intervalSeconds = profile.triageCadence.intervalSeconds;

  if (!shouldRun) {
    clearTriageInterval();
    return;
  }

  if (triageInterval && triageIntervalSeconds === intervalSeconds) return;

  clearTriageInterval();
  triageIntervalSeconds = intervalSeconds;
  triageInterval = setInterval(evaluateIntervalTriage, intervalSeconds * 1000);
}

function clearTriageInterval(): void {
  if (triageInterval) {
    clearInterval(triageInterval);
    triageInterval = null;
  }
  triageIntervalSeconds = 0;
  lastIntervalFingerprint = '';
}

function shouldTriageOnFinalTranscript(mode: TriageCadenceMode): boolean {
  return mode === 'final_transcript' || mode === 'both';
}

function shouldTriageOnInterval(mode: TriageCadenceMode): boolean {
  return mode === 'interval' || mode === 'both';
}

interface IntervalContext {
  fingerprint: string;
  detectionText: string;
  sourceText: string;
}

function buildIntervalContext(): IntervalContext | null {
  const finalized = transcriptWindow.map((segment) => ({
    fingerprint: `final:${segment.source}:${segment.endedAt}:${buildDetectionText(segment)}`,
    detectionText: buildDetectionText(segment),
    sourceText: buildSourceText(segment),
  }));
  const partial = Array.from(partialTranscripts.values()).map((segment) => ({
    fingerprint: `partial:${segment.source}:${segment.updatedAt}:${segment.text}`,
    detectionText: segment.text,
    sourceText: `Partial ${segment.source}: ${segment.text}`,
  }));
  const entries = [...finalized, ...partial];
  if (entries.length === 0) return null;

  return {
    fingerprint: entries.map((entry) => entry.fingerprint).join('|'),
    detectionText: entries.map((entry) => entry.detectionText).join('\n'),
    sourceText: entries.map((entry) => entry.sourceText).join('\n\n'),
  };
}

export function cancelMeetingCard(cardId: string): void {
  const card = cards.get(cardId);
  if (!card || card.status !== 'running') return;

  cancelledCards.add(cardId);
  updateCard({
    ...card,
    status: 'cancelled',
    body: 'Cancelled.',
  });
}

export function removeMeetingCard(cardId: string): boolean {
  const card = cards.get(cardId);
  if (!card) return false;

  cancelledCards.add(cardId);
  cards.delete(cardId);
  cardGenerations.delete(cardId);
  cardRefinements.delete(cardId);
  streamedCards.delete(cardId);
  callbacks.onCardRemoved?.({ cardId });
  return true;
}

export function clearMeetingHistory(): void {
  clearPendingTriage();
  transcriptWindow = [];
  partialTranscripts.clear();
  lastIntervalFingerprint = '';
  lastSegment = null;
  untriagedSpeechAt = 0;
  lastTriagedWordCount = 0;

  for (const cardId of cards.keys()) {
    cancelledCards.add(cardId);
    callbacks.onCardRemoved?.({ cardId });
  }

  cards.clear();
  cardTerms.clear();
  surfacedConcepts.clear();
  cardGenerations.clear();
  cardRefinements.clear();
  streamedCards.clear();
}

/**
 * Passive cards always run the profile's own agent with its MCP servers and skills live. There is no
 * privileged built-in source: documentation is reached through the Microsoft Learn MCP server like
 * any other profile source.
 */
function startPassiveLookup(
  request: TriageRequest,
  sourceText: string,
  profile: MeetingProfile,
  existing: MeetingCard | null,
): MeetingCard {
  // Triage topics are model-generated from live transcript, so they are only learnable when they
  // match a term the user already curated. Anything else is surfaced but never written to disk.
  const learningTerm = resolveLearningTerm(request.topic, profile.vocabulary);

  return startContextLookup(request, sourceText, profile, learningTerm, existing);
}

function startContextLookup(
  request: TriageRequest,
  sourceText: string,
  profile: MeetingProfile,
  learningTerm: string | null,
  existing: MeetingCard | null,
): MeetingCard {
  const card =
    existing ??
    createCard({
      kind: 'context',
      title: request.topic,
      body: `Looking up ${request.topic} with the ${profile.name} profile...`,
      sourceText,
      ...(learningTerm ? { learningTerm } : {}),
    });

  const run = existing
    ? refineCard(card, request.topic, `Refining ${request.topic} with the ${profile.name} profile...`)
    : { card, generation: bumpCardGeneration(card.id) };

  const prompt = buildPassiveContextPrompt(request, buildTranscriptContext(transcriptWindow));

  void profileAgentCompletion(profile, prompt, {
    model: resolveAnswerModel(profile),
    timeoutMs: PASSIVE_CONTEXT_TIMEOUT_MS,
    onPartial: streamIntoCard(run.card, run.generation),
  }).then((answer) => {
    if (isStaleCardRun(run.card.id, run.generation)) return;
    const trimmed = answer.trim();
    updateCard({
      ...run.card,
      status: trimmed ? 'ready' : 'failed',
      body: trimmed || `No ${profile.name} context found for "${request.topic}".`,
      ...citedLinks(trimmed),
    });
  }).catch((err: unknown) => {
    console.warn('[Meeting intelligence] Context lookup failed:', err);
    if (isStaleCardRun(run.card.id, run.generation)) return;
    updateCard({
      ...run.card,
      status: 'failed',
      body: `Could not retrieve ${profile.name} context right now.`,
    });
  });

  return run.card;
}

function startExplicitAnswer(
  request: TriageRequest,
  sourceText: string,
  profile: MeetingProfile,
  existing: MeetingCard | null,
): MeetingCard {
  const card =
    existing ??
    createCard({
      kind: 'answer',
      title: request.topic,
      body: 'Working on an answer while you continue the meeting...',
      sourceText,
    });

  const run = existing
    ? refineCard(card, request.topic, `Refining the answer for ${request.topic}...`)
    : { card, generation: bumpCardGeneration(card.id) };

  const prompt = buildExplicitAnswerPrompt(request, buildTranscriptContext(transcriptWindow));

  // The profile's own prompt decides how the answer is grounded and what counts as unverified, so
  // there is no separate refusal gate here.
  void profileAgentCompletion(profile, prompt, {
    model: resolveAnswerModel(profile),
    onPartial: streamIntoCard(run.card, run.generation),
  }).then((answer) => {
    if (isStaleCardRun(run.card.id, run.generation)) return;
    const trimmed = answer.trim();
    updateCard({
      ...run.card,
      status: trimmed ? 'ready' : 'failed',
      body: trimmed || 'The answer agent did not return a useful answer.',
      ...citedLinks(trimmed),
    });
  }).catch((err: unknown) => {
    console.warn('[Meeting intelligence] Explicit answer failed:', err);
    if (isStaleCardRun(run.card.id, run.generation)) return;
    updateCard({
      ...run.card,
      status: 'failed',
      body: 'The answer agent could not complete this request.',
    });
  });

  return run.card;
}

interface CardRun {
  card: MeetingCard;
  generation: number;
}

/**
 * Hands a card that is still waiting on its first result over to a more specific version of the same
 * ask, so "hosted agents available regions" replaces the query behind the "hosted agents" card rather
 * than opening a second one next to it.
 *
 * The old agent run cannot be aborted — the SDK exposes no cancellation — so instead it is made
 * harmless: bumping the generation means both its streamed text and its final result are discarded.
 */
function refineCard(card: MeetingCard, title: string, body: string): CardRun {
  cardRefinements.set(card.id, (cardRefinements.get(card.id) ?? 0) + 1);
  const refined: MeetingCard = { ...card, status: 'running', title, body };
  updateCard(refined);

  return { card: refined, generation: bumpCardGeneration(card.id) };
}

function bumpCardGeneration(cardId: string): number {
  const next = (cardGenerations.get(cardId) ?? 0) + 1;
  cardGenerations.set(cardId, next);
  return next;
}

/**
 * Whether a run's results should still be written to its card. Generation is checked rather than the
 * card id alone, because a refinement reuses the id: keying cancellation off the id would silence the
 * replacement run along with the one it replaced.
 */
function isStaleCardRun(cardId: string, generation: number): boolean {
  if (cancelledCards.has(cardId)) return true;
  return cardGenerations.get(cardId) !== generation;
}

/**
 * Paints the answer into the card as it is generated instead of holding a placeholder for the whole
 * turn. Measured on an Azure docs lookup, the first token lands ~71% earlier than the completed
 * answer, which is the difference between a card that feels live and one that feels stuck.
 *
 * Updates stay throttled because the overlay re-renders on every card event, and the card is left in
 * `running` until the final text arrives so link extraction and the empty-answer fallback still run
 * against the complete response rather than a partial one.
 */
function streamIntoCard(card: MeetingCard, generation: number): (textSoFar: string) => void {
  let lastEmitAt = 0;
  const startedAt = Date.now();
  let loggedFirstText = false;

  return (textSoFar: string) => {
    if (isStaleCardRun(card.id, generation)) return;

    const trimmed = textSoFar.trim();
    if (!trimmed) return;

    if (!loggedFirstText) {
      loggedFirstText = true;
      // Closes the refinement window: once the user can read something, swapping the text out from
      // under them costs more than the better query would gain.
      streamedCards.add(card.id);
      console.log(
        `[Meeting intelligence] Card "${card.title}": first text after ${Date.now() - startedAt}ms`,
      );
    }

    const now = Date.now();
    if (now - lastEmitAt < STREAM_UPDATE_INTERVAL_MS) return;
    lastEmitAt = now;

    updateCard({ ...card, status: 'running', body: trimmed });
  };
}

/** Promotes URLs the agent cited into the card's clickable source list. */
function citedLinks(answer: string): { docs?: LearnDoc[] } {
  const docs = extractCitedLinks(answer);
  return docs.length > 0 ? { docs } : {};
}

/**
 * Card bodies render in a small always-on-top overlay that people read mid-sentence, so Aura — not
 * the profile — owns the format. The profile decides *what* is worth surfacing; this decides how
 * much of it fits on screen. Without this, a free-form agent answers a passive card with a
 * multi-section markdown document, which is unreadable during a call.
 *
 * Links must be inline markdown so `extractCitedLinks()` can promote them to clickable chips; a
 * trailing "Sources:" list would just duplicate those chips in the body.
 */
const CARD_FORMAT_RULES = `Write for a small meeting overlay someone reads mid-conversation:
- Lead with the answer, not with preamble.
- Plain sentences or short bullets only. No headings, no tables, no emoji.
- Cite sources as inline markdown links; do not append a separate sources list.`;

function buildPassiveContextPrompt(request: TriageRequest, transcriptContext: string): string {
  return `Live meeting transcript:
${transcriptContext}

Topic to surface:
${request.topic}

What to look up:
${request.query}

Why it came up:
${request.reason || '(not stated)'}

Surface the most useful current context about this topic for the people on the call.

${CARD_FORMAT_RULES}
- Keep it to at most 3 short bullets.`;
}

function buildExplicitAnswerPrompt(request: TriageRequest, transcriptContext: string): string {
  return `Live meeting transcript:
${transcriptContext}

Question to answer:
${request.query}

Why it came up:
${request.reason || '(not stated)'}

Answer for the people on the call.

${CARD_FORMAT_RULES}
- Keep it to at most 6 short lines.

${buildVisualPromptContext(lastSegment)}`;
}

function createCard(input: {
  kind: MeetingCard['kind'];
  title: string;
  body: string;
  sourceText: string;
  /**
   * Concept term this card represents, for profile learning. Supplied only when a passive card's
   * topic matched the profile's curated vocabulary. Triage topics and explicit-ask queries derive
   * from free transcript text and must never contribute a learnable term.
   */
  learningTerm?: string;
}): MeetingCard {
  const now = Date.now();
  const card: MeetingCard = {
    id: crypto.randomUUID(),
    kind: input.kind,
    status: 'running',
    title: input.title,
    body: input.body,
    sourceText: input.sourceText,
    createdAt: now,
    updatedAt: now,
  };
  cards.set(card.id, card);

  if (input.learningTerm) {
    cardTerms.set(card.id, input.learningTerm);
    void recordSurfacedTerm(input.learningTerm);
  }

  callbacks.onCardCreated?.({ card });
  return card;
}

function updateCard(card: MeetingCard): void {
  const updated = { ...card, updatedAt: Date.now() };
  cards.set(updated.id, updated);
  callbacks.onCardUpdated?.({ card: updated });
}

function buildDetectionText(segment: TranscriptSegment): string {
  const visualText = getVisualText(segment);
  return visualText ? `${segment.text}\nScreen text: ${visualText}` : segment.text;
}

function buildSourceText(segment: TranscriptSegment): string {
  const visualText = getVisualText(segment);
  if (visualText) return `${segment.text}\n\nScreen text: ${visualText}`;
  if (segment.visualContext?.error) return `${segment.text}\n\nVisual context error: ${segment.visualContext.error}`;
  return segment.text;
}

function buildVisualPromptContext(segment: TranscriptSegment | null): string {
  if (!segment) return 'Visual context: none.';

  const visualText = getVisualText(segment);
  if (visualText) {
    return `Visual context from local OCR:\n${visualText}`;
  }

  if (segment.visualContext?.screenshot) {
    return 'Visual context: screenshot captured, but direct image attachment is not supported by the current agent transport.';
  }

  if (segment.visualContext?.error) {
    return `Visual context unavailable: ${segment.visualContext.error}`;
  }

  return 'Visual context: none.';
}

function getVisualText(segment: TranscriptSegment): string {
  return segment.visualContext?.ocr?.text.trim() ?? '';
}
