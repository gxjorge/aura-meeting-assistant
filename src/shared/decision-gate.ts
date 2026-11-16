import { DEFAULT_SETTINGS, type DecisionGateSettings, type MeetingProfile } from './types.js';

/** The two kinds of card triage can raise; the gate asks one yes/no question per enabled kind. */
export type DecisionGateKind = 'passive' | 'answer';

/**
 * Probability above which the gate lets the LLM triage run.
 *
 * Deliberately low. The gate is a cost cut, not a surfacing rule: the profile prompt still decides what
 * is worth a card, through the LLM stage that follows. A missed card is worse than a wasted LLM call,
 * so the gate only skips ticks that are clearly empty. It is a constant rather than a setting for the
 * same reason Aura has no sensitivity dial — a profile that should surface more says so in its prompt.
 */
export const DECISION_GATE_PASS_THRESHOLD = 0.25;

/** How much of the most recent speech counts as "just said"; the rest of the window is background. */
const JUST_SAID_WORDS = 50;
/** Background kept ahead of the latest speech. Enough to resolve "that service", not a whole meeting. */
const EARLIER_CONTEXT_WORDS = 300;

const DECISION_PATH = '/providers/microsoft/v1/systemone';

interface DecisionQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface DecisionGateState {
  /** The profile's own prompt. This is what makes the profile, not the code, decide what to surface. */
  profile_instructions: string;
  watch_terms?: string[];
  already_surfaced: string[];
  earlier_conversation: string;
  just_said: string;
}

export interface DecisionGateRequest {
  /** The deployment name, which is what the endpoint expects here rather than the model's own name. */
  model: string;
  state: DecisionGateState;
  questions: Partial<Record<DecisionGateKind, DecisionQuestion>>;
}

export type DecisionGateProbabilities = Partial<Record<DecisionGateKind, number>>;
export type DecisionGateVerdict = 'pass' | 'decline';

type GateProfile = Pick<
  MeetingProfile,
  'systemPrompt' | 'vocabulary' | 'passiveCardsEnabled' | 'explicitAnswersEnabled'
>;

const QUESTIONS: Record<DecisionGateKind, DecisionQuestion> = {
  passive: {
    type: 'noul',
    instructions:
      'Following profile_instructions, did just_said bring up a subject the profile wants background '
      + 'context on? Use earlier_conversation only as background, and ignore subjects already in already_surfaced.',
    criteria: {
      true: 'just_said raises a subject that profile_instructions say is worth surfacing, and it is not already surfaced.',
      false: 'Silence, small talk, off-topic chatter, or only subjects that are already surfaced.',
    },
  },
  answer: {
    type: 'noul',
    instructions:
      'Following profile_instructions, did someone in just_said explicitly ask to check, verify, confirm, '
      + 'look up, or research something, or ask the assistant directly? Ignore requests already covered by already_surfaced.',
    criteria: {
      true: 'A speaker asks for something to be checked or answered, and it is not already surfaced.',
      false: 'Nobody asked for anything to be checked or answered.',
    },
  },
};

/**
 * Coerces whatever was persisted into valid gate settings. Installs that predate the gate have no such
 * key, and a hand-edited file can hold anything, so every field falls back to its default on its own.
 */
export function normalizeDecisionGateSettings(
  settings: Partial<DecisionGateSettings> | undefined,
): DecisionGateSettings {
  const defaults = DEFAULT_SETTINGS.decisionGate;
  const deployment = typeof settings?.deployment === 'string' ? settings.deployment.trim() : '';

  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : defaults.enabled,
    endpoint: typeof settings?.endpoint === 'string' ? settings.endpoint.trim() : defaults.endpoint,
    deployment: deployment.length > 0 ? deployment : defaults.deployment,
  };
}

/** True only when the gate can actually make a call: switched on, with an endpoint and a deployment. */
export function isDecisionGateConfigured(settings: DecisionGateSettings): boolean {
  return settings.enabled
    && settings.deployment.trim().length > 0
    && buildDecisionGateUrl(settings.endpoint) !== null;
}

/** Builds the decision endpoint on a Foundry resource, or null when the endpoint is not a usable HTTPS URL. */
export function buildDecisionGateUrl(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;

    const pathPrefix = url.pathname.replace(/\/+$/, '');
    url.pathname = `${pathPrefix}${DECISION_PATH}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function enabledGateKinds(profile: Pick<MeetingProfile, 'passiveCardsEnabled' | 'explicitAnswersEnabled'>): DecisionGateKind[] {
  const kinds: DecisionGateKind[] = [];
  if (profile.passiveCardsEnabled) kinds.push('passive');
  if (profile.explicitAnswersEnabled) kinds.push('answer');
  return kinds;
}

/**
 * Turns the active profile and the live transcript into one decision request. Returns null when there is
 * nothing to ask: no kind is enabled, or no one has said anything yet.
 */
export function buildDecisionGateRequest(input: {
  deployment: string;
  profile: GateProfile;
  transcript: string;
  recentTopics: readonly string[];
}): DecisionGateRequest | null {
  const kinds = enabledGateKinds(input.profile);
  if (kinds.length === 0) return null;
  if (!input.transcript.trim()) return null;

  const { earlier, justSaid } = splitTranscript(input.transcript);
  const watchTerms = input.profile.vocabulary.map((term) => term.trim()).filter((term) => term.length > 0);

  const questions: DecisionGateRequest['questions'] = {};
  for (const kind of kinds) questions[kind] = QUESTIONS[kind];

  return {
    model: input.deployment.trim(),
    state: {
      profile_instructions: input.profile.systemPrompt.trim(),
      ...(watchTerms.length > 0 ? { watch_terms: watchTerms } : {}),
      already_surfaced: [...input.recentTopics],
      earlier_conversation: earlier,
      just_said: justSaid,
    },
    questions,
  };
}

/**
 * Reads the yes-probability for every kind that was asked. Returns null unless every one of them has a
 * usable number: a half-answered request must not be allowed to decline, because the missing kind might
 * be exactly the one that mattered.
 *
 * The number arrives as `noul` on the System One wire format and as `probability` on the SQL-style one;
 * both mean the same thing, so either is accepted.
 */
export function parseDecisionGateResponse(
  payload: unknown,
  kinds: readonly DecisionGateKind[],
): DecisionGateProbabilities | null {
  if (!isRecord(payload) || !isRecord(payload.answers)) return null;

  const probabilities: DecisionGateProbabilities = {};
  for (const kind of kinds) {
    const probability = readYesProbability(payload.answers[kind]);
    if (probability === null) return null;
    probabilities[kind] = probability;
  }

  return kinds.length > 0 ? probabilities : null;
}

export function judgeDecisionGate(probabilities: DecisionGateProbabilities): DecisionGateVerdict {
  const values = Object.values(probabilities);
  return values.some((value) => value >= DECISION_GATE_PASS_THRESHOLD) ? 'pass' : 'decline';
}

/** Compact "passive=0.12 answer=0.03" form for the triage log line. */
export function formatDecisionGateProbabilities(probabilities: DecisionGateProbabilities): string {
  return (Object.entries(probabilities) as [DecisionGateKind, number][])
    .map(([kind, value]) => `${kind}=${value.toFixed(2)}`)
    .join(' ');
}

function readYesProbability(answer: unknown): number | null {
  if (!isRecord(answer)) return null;

  const value = typeof answer.noul === 'number'
    ? answer.noul
    : typeof answer.probability === 'number'
      ? answer.probability
      : null;

  return value !== null && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * Separates what was just said from the background around it, on word boundaries so line breaks between
 * speakers survive. The gate is asked about the former; without the split a decision model scores the
 * whole five-minute window and keeps answering yes about a subject that came up minutes ago.
 */
function splitTranscript(transcript: string): { earlier: string; justSaid: string } {
  const starts: number[] = [];
  for (const match of transcript.matchAll(/\S+/g)) starts.push(match.index);

  const justSaidStart = Math.max(0, starts.length - JUST_SAID_WORDS);
  const earlierStart = Math.max(0, justSaidStart - EARLIER_CONTEXT_WORDS);
  const cutAt = starts[justSaidStart] ?? 0;
  const earlierFrom = starts[earlierStart] ?? 0;

  return {
    earlier: transcript.slice(earlierFrom, cutAt).trim(),
    justSaid: transcript.slice(cutAt).trim(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
