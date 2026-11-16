import type {
  MeetingCardSignal,
  MeetingProfile,
  ProfileLearningState,
  ProfileTermStat,
} from './types.js';
import { MAX_VOCABULARY_TERMS } from './types.js';

/**
 * Pure profile learning.
 *
 * Aura's transcript context is ephemeral, so this module deliberately stores **only** derived concept
 * terms and small numeric counters. Terms are supplied by the caller and always originate from the
 * closed detection catalogue or the profile's own vocabulary — no free transcript text ever reaches
 * this state, and therefore none of it can reach `settings.json`.
 */

/** Weight applied to each interaction. Rejections are damped so one dismissal cannot bury a term. */
const SIGNAL_WEIGHTS: Record<MeetingCardSignal, number> = {
  link_opened: 2,
  opened: 1,
  dismissed: -0.75,
  cancelled: -1,
};

/** Surfacing a card is a weak negative prior: a term must earn its place through engagement. */
const SURFACE_WEIGHT = -0.1;

/** Weights halve roughly every two weeks so stale meeting habits fade out on their own. */
export const LEARNING_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Hard cap on tracked terms; the weakest are evicted first so the state can never grow unbounded. */
export const MAX_TRACKED_TERMS = 128;

/** Below this magnitude a term carries no useful signal and is dropped entirely. */
const MIN_RETAINED_WEIGHT = 0.05;

/** A term must clear this weight, and this many engagements, before it is worth promoting. */
export const PROMOTION_WEIGHT = 3;
const PROMOTION_MIN_ENGAGEMENTS = 2;

/** An existing vocabulary term is only demoted once it has been actively rejected repeatedly. */
export const DEMOTION_WEIGHT = -2;
const DEMOTION_MIN_REJECTIONS = 3;

/** Enough accumulated interaction to be worth asking an agent to review the profile. */
export const PROPOSAL_SIGNAL_THRESHOLD = 8;

export function createLearningState(now: number = Date.now()): ProfileLearningState {
  return { terms: [], lastDecayedAt: now, signalsSinceProposal: 0 };
}

export function normalizeLearningState(
  candidate: ProfileLearningState | undefined,
  now: number = Date.now(),
): ProfileLearningState {
  if (!candidate || typeof candidate !== 'object') return createLearningState(now);

  const terms: ProfileTermStat[] = [];
  const seen = new Set<string>();

  for (const entry of Array.isArray(candidate.terms) ? candidate.terms : []) {
    if (!entry || typeof entry !== 'object') continue;
    const term = typeof entry.term === 'string' ? entry.term.trim() : '';
    if (!term) continue;

    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    terms.push({
      term,
      weight: finiteNumber(entry.weight, 0),
      surfaced: Math.max(0, Math.round(finiteNumber(entry.surfaced, 0))),
      engaged: Math.max(0, Math.round(finiteNumber(entry.engaged, 0))),
      rejected: Math.max(0, Math.round(finiteNumber(entry.rejected, 0))),
      updatedAt: finiteNumber(entry.updatedAt, now),
    });
  }

  return {
    terms: capTerms(terms),
    lastDecayedAt: finiteNumber(candidate.lastDecayedAt, now),
    signalsSinceProposal: Math.max(0, Math.round(finiteNumber(candidate.signalsSinceProposal, 0))),
  };
}

/** Applies exponential decay so old signal fades without ever being explicitly reset. */
export function decayLearningState(
  state: ProfileLearningState,
  now: number = Date.now(),
): ProfileLearningState {
  const elapsed = now - state.lastDecayedAt;
  if (elapsed <= 0) return state;

  const factor = Math.pow(0.5, elapsed / LEARNING_HALF_LIFE_MS);
  const terms = state.terms
    .map((term) => ({ ...term, weight: term.weight * factor }))
    .filter((term) => Math.abs(term.weight) >= MIN_RETAINED_WEIGHT);

  return { ...state, terms: capTerms(terms), lastDecayedAt: now };
}

/** Records that a passive card was raised for `term`, without any user interaction yet. */
export function recordTermSurfaced(
  state: ProfileLearningState,
  term: string,
  now: number = Date.now(),
): ProfileLearningState {
  return applyToTerm(state, term, now, (stat) => ({
    ...stat,
    weight: stat.weight + SURFACE_WEIGHT,
    surfaced: stat.surfaced + 1,
  }));
}

/** Folds a single card interaction into the decayed per-term weights. */
export function recordTermSignal(
  state: ProfileLearningState,
  term: string,
  signal: MeetingCardSignal,
  now: number = Date.now(),
): ProfileLearningState {
  const weight = SIGNAL_WEIGHTS[signal];
  if (weight === undefined) return state;

  const next = applyToTerm(state, term, now, (stat) => ({
    ...stat,
    weight: stat.weight + weight,
    engaged: weight > 0 ? stat.engaged + 1 : stat.engaged,
    rejected: weight < 0 ? stat.rejected + 1 : stat.rejected,
  }));

  return { ...next, signalsSinceProposal: next.signalsSinceProposal + 1 };
}

export interface VocabularyChanges {
  promote: string[];
  demote: string[];
}

/**
 * Derives the vocabulary edits the accumulated signal justifies. Promotions are capped against
 * `MAX_VOCABULARY_TERMS` so an enthusiastic meeting cannot blow up the profile.
 */
export function deriveVocabularyChanges(profile: MeetingProfile): VocabularyChanges {
  const existing = new Set(profile.vocabulary.map((term) => term.toLowerCase()));
  const headroom = Math.max(0, MAX_VOCABULARY_TERMS - profile.vocabulary.length);

  const promote = profile.learning.terms
    .filter((stat) => !existing.has(stat.term.toLowerCase()))
    .filter((stat) => stat.weight >= PROMOTION_WEIGHT && stat.engaged >= PROMOTION_MIN_ENGAGEMENTS)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, headroom)
    .map((stat) => stat.term);

  const demote = profile.learning.terms
    .filter((stat) => existing.has(stat.term.toLowerCase()))
    .filter((stat) => stat.weight <= DEMOTION_WEIGHT && stat.rejected >= DEMOTION_MIN_REJECTIONS)
    .sort((a, b) => a.weight - b.weight)
    .map((stat) => stat.term);

  return { promote, demote };
}

/** Applies derived vocabulary changes, preserving the user's original casing for kept terms. */
export function applyVocabularyChanges(
  profile: MeetingProfile,
  changes: VocabularyChanges,
): MeetingProfile {
  const demoted = new Set(changes.demote.map((term) => term.toLowerCase()));
  const kept = profile.vocabulary.filter((term) => !demoted.has(term.toLowerCase()));
  const seen = new Set(kept.map((term) => term.toLowerCase()));

  const vocabulary = [...kept];
  for (const term of changes.promote) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    if (vocabulary.length >= MAX_VOCABULARY_TERMS) break;
    seen.add(key);
    vocabulary.push(term);
  }

  return { ...profile, vocabulary };
}

export function shouldProposeEvolution(profile: MeetingProfile): boolean {
  if (!profile.learningEnabled) return false;
  if (profile.pendingProposal) return false;
  return profile.learning.signalsSinceProposal >= PROPOSAL_SIGNAL_THRESHOLD;
}

/** Anonymized digest handed to the proposal agent. Contains terms and counters only. */
export function summarizeLearning(profile: MeetingProfile, limit = 12): string {
  const ranked = [...profile.learning.terms]
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, limit);

  if (ranked.length === 0) return 'No card interaction signal recorded yet.';

  return ranked
    .map((stat) => `- ${stat.term}: score ${stat.weight.toFixed(2)}, `
      + `surfaced ${stat.surfaced}, engaged ${stat.engaged}, dismissed ${stat.rejected}`)
    .join('\n');
}

function applyToTerm(
  state: ProfileLearningState,
  term: string,
  now: number,
  mutate: (stat: ProfileTermStat) => ProfileTermStat,
): ProfileLearningState {
  const trimmed = term.trim();
  if (!trimmed) return state;

  const decayed = decayLearningState(state, now);
  const key = trimmed.toLowerCase();
  const index = decayed.terms.findIndex((stat) => stat.term.toLowerCase() === key);
  const current = index >= 0
    ? decayed.terms[index]
    : { term: trimmed, weight: 0, surfaced: 0, engaged: 0, rejected: 0, updatedAt: now };

  const updated = { ...mutate(current), updatedAt: now };
  const terms = index >= 0
    ? decayed.terms.map((stat, i) => (i === index ? updated : stat))
    : [...decayed.terms, updated];

  return { ...decayed, terms: capTerms(terms) };
}

function capTerms(terms: ProfileTermStat[]): ProfileTermStat[] {
  if (terms.length <= MAX_TRACKED_TERMS) return terms;
  return [...terms]
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_TRACKED_TERMS);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
