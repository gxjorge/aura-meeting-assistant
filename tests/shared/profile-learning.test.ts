import { describe, expect, it } from 'vitest';
import {
  DEMOTION_WEIGHT,
  LEARNING_HALF_LIFE_MS,
  MAX_TRACKED_TERMS,
  PROMOTION_WEIGHT,
  PROPOSAL_SIGNAL_THRESHOLD,
  applyVocabularyChanges,
  createLearningState,
  decayLearningState,
  deriveVocabularyChanges,
  normalizeLearningState,
  recordTermSignal,
  recordTermSurfaced,
  shouldProposeEvolution,
  summarizeLearning,
} from '../../src/shared/profile-learning.js';
import { createBlankProfile } from '../../src/shared/meeting-profiles.js';
import { MAX_VOCABULARY_TERMS } from '../../src/shared/types.js';
import type { MeetingProfile, ProfileLearningState } from '../../src/shared/types.js';

const NOW = 1_700_000_000_000;

function profileWith(patch: Partial<MeetingProfile> = {}): MeetingProfile {
  return { ...createBlankProfile('Test', [], NOW), ...patch };
}

function stateWith(
  terms: Array<Partial<ProfileLearningState['terms'][number]> & { term: string }>,
  signalsSinceProposal = 0,
): ProfileLearningState {
  return {
    lastDecayedAt: NOW,
    signalsSinceProposal,
    terms: terms.map((term) => ({
      weight: 0,
      surfaced: 0,
      engaged: 0,
      rejected: 0,
      updatedAt: NOW,
      ...term,
    })),
  };
}

describe('learning state normalization', () => {
  it('creates an empty state', () => {
    const state = createLearningState(NOW);
    expect(state).toEqual({ terms: [], lastDecayedAt: NOW, signalsSinceProposal: 0 });
  });

  it('falls back to an empty state for malformed input', () => {
    expect(normalizeLearningState(undefined, NOW).terms).toEqual([]);
  });

  it('drops entries without a usable term and de-duplicates case-insensitively', () => {
    const normalized = normalizeLearningState(
      {
        lastDecayedAt: NOW,
        signalsSinceProposal: 2,
        terms: [
          { term: 'Kusto', weight: 1, surfaced: 1, engaged: 1, rejected: 0, updatedAt: NOW },
          { term: 'kusto', weight: 9, surfaced: 9, engaged: 9, rejected: 9, updatedAt: NOW },
          { term: '   ', weight: 5, surfaced: 1, engaged: 0, rejected: 0, updatedAt: NOW },
        ],
      },
      NOW,
    );

    expect(normalized.terms).toHaveLength(1);
    expect(normalized.terms[0]?.term).toBe('Kusto');
    expect(normalized.signalsSinceProposal).toBe(2);
  });

  it('coerces non-finite counters to safe values', () => {
    const normalized = normalizeLearningState(
      {
        lastDecayedAt: Number.NaN,
        signalsSinceProposal: -4,
        terms: [{
          term: 'agent',
          weight: Number.POSITIVE_INFINITY,
          surfaced: -3,
          engaged: 1.7,
          rejected: Number.NaN,
          updatedAt: Number.NaN,
        }],
      },
      NOW,
    );

    expect(normalized.lastDecayedAt).toBe(NOW);
    expect(normalized.signalsSinceProposal).toBe(0);
    expect(normalized.terms[0]).toMatchObject({ weight: 0, surfaced: 0, engaged: 2, rejected: 0 });
  });
});

describe('decay', () => {
  it('halves weights after one half life', () => {
    const decayed = decayLearningState(
      stateWith([{ term: 'kusto', weight: 4 }]),
      NOW + LEARNING_HALF_LIFE_MS,
    );

    expect(decayed.terms[0]?.weight).toBeCloseTo(2, 5);
    expect(decayed.lastDecayedAt).toBe(NOW + LEARNING_HALF_LIFE_MS);
  });

  it('drops terms that decay into noise', () => {
    const decayed = decayLearningState(
      stateWith([{ term: 'stale', weight: 0.2 }, { term: 'strong', weight: 8 }]),
      NOW + LEARNING_HALF_LIFE_MS * 4,
    );

    expect(decayed.terms.map((term) => term.term)).toEqual(['strong']);
  });

  it('is a no-op when no time has passed', () => {
    const state = stateWith([{ term: 'kusto', weight: 4 }]);
    expect(decayLearningState(state, NOW)).toBe(state);
  });
});

describe('recording signals', () => {
  it('treats surfacing as a weak negative prior', () => {
    const state = recordTermSurfaced(createLearningState(NOW), 'kusto', NOW);
    expect(state.terms[0]).toMatchObject({ term: 'kusto', surfaced: 1, engaged: 0 });
    expect(state.terms[0]?.weight).toBeLessThan(0);
    expect(state.signalsSinceProposal).toBe(0);
  });

  it('weights an opened link above a plain expand', () => {
    const opened = recordTermSignal(createLearningState(NOW), 'kusto', 'opened', NOW);
    const linked = recordTermSignal(createLearningState(NOW), 'kusto', 'link_opened', NOW);

    expect(linked.terms[0]!.weight).toBeGreaterThan(opened.terms[0]!.weight);
    expect(linked.terms[0]).toMatchObject({ engaged: 1, rejected: 0 });
  });

  it('counts dismissals as rejections and bumps the proposal counter', () => {
    let state = createLearningState(NOW);
    state = recordTermSignal(state, 'kusto', 'dismissed', NOW);
    state = recordTermSignal(state, 'kusto', 'cancelled', NOW);

    expect(state.terms[0]).toMatchObject({ engaged: 0, rejected: 2 });
    expect(state.terms[0]!.weight).toBeLessThan(0);
    expect(state.signalsSinceProposal).toBe(2);
  });

  it('accumulates onto the same term regardless of casing', () => {
    let state = recordTermSignal(createLearningState(NOW), 'Kusto', 'link_opened', NOW);
    state = recordTermSignal(state, 'kusto', 'link_opened', NOW);

    expect(state.terms).toHaveLength(1);
    expect(state.terms[0]?.term).toBe('Kusto');
    expect(state.terms[0]?.engaged).toBe(2);
  });

  it('ignores blank terms', () => {
    const state = recordTermSignal(createLearningState(NOW), '   ', 'opened', NOW);
    expect(state.terms).toEqual([]);
  });

  it('caps tracked terms so the state can never grow unbounded', () => {
    let state = createLearningState(NOW);
    for (let i = 0; i < MAX_TRACKED_TERMS + 40; i += 1) {
      state = recordTermSignal(state, `term-${i}`, 'link_opened', NOW);
    }

    expect(state.terms.length).toBe(MAX_TRACKED_TERMS);
  });
});

describe('vocabulary promotion and demotion', () => {
  it('promotes a term that cleared both the weight and engagement bars', () => {
    const profile = profileWith({
      vocabulary: [],
      learning: stateWith([{ term: 'kusto', weight: PROMOTION_WEIGHT, engaged: 2 }]),
    });

    expect(deriveVocabularyChanges(profile).promote).toEqual(['kusto']);
  });

  it('does not promote on weight alone', () => {
    const profile = profileWith({
      vocabulary: [],
      learning: stateWith([{ term: 'kusto', weight: 10, engaged: 1 }]),
    });

    expect(deriveVocabularyChanges(profile).promote).toEqual([]);
  });

  it('never promotes a term already in the vocabulary', () => {
    const profile = profileWith({
      vocabulary: ['Kusto'],
      learning: stateWith([{ term: 'kusto', weight: 10, engaged: 5 }]),
    });

    expect(deriveVocabularyChanges(profile).promote).toEqual([]);
  });

  it('demotes only vocabulary terms that were repeatedly rejected', () => {
    const profile = profileWith({
      vocabulary: ['kusto', 'vector'],
      learning: stateWith([
        { term: 'kusto', weight: DEMOTION_WEIGHT, rejected: 3 },
        { term: 'vector', weight: DEMOTION_WEIGHT, rejected: 2 },
      ]),
    });

    expect(deriveVocabularyChanges(profile).demote).toEqual(['kusto']);
  });

  it('respects the vocabulary cap when promoting', () => {
    const vocabulary = Array.from({ length: MAX_VOCABULARY_TERMS - 1 }, (_, i) => `seed-${i}`);
    const profile = profileWith({
      vocabulary,
      learning: stateWith([
        { term: 'first', weight: 9, engaged: 5 },
        { term: 'second', weight: 8, engaged: 5 },
      ]),
    });

    const changes = deriveVocabularyChanges(profile);
    expect(changes.promote).toEqual(['first']);

    const applied = applyVocabularyChanges(profile, changes);
    expect(applied.vocabulary.length).toBe(MAX_VOCABULARY_TERMS);
  });

  it('applies promotions and demotions together, preserving existing casing', () => {
    const profile = profileWith({
      vocabulary: ['Renewal', 'Pipeline'],
      learning: stateWith([
        { term: 'forecast', weight: 6, engaged: 3 },
        { term: 'pipeline', weight: -5, rejected: 4 },
      ]),
    });

    const applied = applyVocabularyChanges(profile, deriveVocabularyChanges(profile));
    expect(applied.vocabulary).toEqual(['Renewal', 'forecast']);
  });
});

describe('proposal gating', () => {
  it('waits until enough signal accumulated', () => {
    expect(shouldProposeEvolution(profileWith({
      learning: stateWith([], PROPOSAL_SIGNAL_THRESHOLD - 1),
    }))).toBe(false);

    expect(shouldProposeEvolution(profileWith({
      learning: stateWith([], PROPOSAL_SIGNAL_THRESHOLD),
    }))).toBe(true);
  });

  it('never proposes while learning is disabled or a proposal is already pending', () => {
    const learning = stateWith([], PROPOSAL_SIGNAL_THRESHOLD * 2);

    expect(shouldProposeEvolution(profileWith({ learning, learningEnabled: false }))).toBe(false);
    expect(shouldProposeEvolution(profileWith({
      learning,
      pendingProposal: { id: 'p1', createdAt: NOW, changes: [] },
    }))).toBe(false);
  });
});

describe('the digest handed to the proposal agent', () => {
  it('contains only terms and counters', () => {
    const summary = summarizeLearning(profileWith({
      learning: stateWith([{ term: 'kusto', weight: 4.25, surfaced: 6, engaged: 3, rejected: 1 }]),
    }));

    expect(summary).toContain('kusto');
    expect(summary).toContain('surfaced 6');
    expect(summary).toContain('engaged 3');
    expect(summary).toContain('dismissed 1');
  });

  it('reports honestly when nothing was recorded', () => {
    expect(summarizeLearning(profileWith())).toContain('No card interaction signal');
  });

  it('ranks by magnitude and honours the limit', () => {
    const summary = summarizeLearning(
      profileWith({
        learning: stateWith([
          { term: 'weak', weight: 0.5 },
          { term: 'strong', weight: -9 },
        ]),
      }),
      1,
    );

    expect(summary).toContain('strong');
    expect(summary).not.toContain('weak');
  });
});
