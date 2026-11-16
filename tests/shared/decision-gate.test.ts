import { describe, expect, it } from 'vitest';
import {
  DECISION_GATE_PASS_THRESHOLD,
  buildDecisionGateRequest,
  buildDecisionGateUrl,
  formatDecisionGateProbabilities,
  isDecisionGateConfigured,
  judgeDecisionGate,
  normalizeDecisionGateSettings,
  parseDecisionGateResponse,
} from '../../src/shared/decision-gate.js';
import { createDefaultProfile } from '../../src/shared/meeting-profiles.js';
import { DEFAULT_SETTINGS, type DecisionGateSettings } from '../../src/shared/types.js';

const CONFIGURED: DecisionGateSettings = {
  enabled: true,
  endpoint: 'https://your-resource.services.ai.azure.com/',
  deployment: 'my-decision',
};

describe('buildDecisionGateUrl', () => {
  it('appends the decision path to a bare resource endpoint', () => {
    expect(buildDecisionGateUrl('https://your-resource.services.ai.azure.com/')).toBe(
      'https://your-resource.services.ai.azure.com/providers/microsoft/v1/systemone',
    );
  });

  it('keeps a path prefix and drops trailing slashes, query, and fragment', () => {
    expect(buildDecisionGateUrl('  https://r.services.ai.azure.com/api/projects/p//?x=1#frag ')).toBe(
      'https://r.services.ai.azure.com/api/projects/p/providers/microsoft/v1/systemone',
    );
  });

  it('rejects anything that is not a usable HTTPS URL', () => {
    expect(buildDecisionGateUrl('')).toBeNull();
    expect(buildDecisionGateUrl('   ')).toBeNull();
    expect(buildDecisionGateUrl('not-a-url')).toBeNull();
    expect(buildDecisionGateUrl('http://your-resource.services.ai.azure.com/')).toBeNull();
  });
});

describe('isDecisionGateConfigured', () => {
  it('is off out of the box, because no endpoint ships as a default', () => {
    expect(isDecisionGateConfigured(DEFAULT_SETTINGS.decisionGate)).toBe(false);
  });

  it('needs the switch on, a valid endpoint, and a deployment', () => {
    expect(isDecisionGateConfigured(CONFIGURED)).toBe(true);
    expect(isDecisionGateConfigured({ ...CONFIGURED, enabled: false })).toBe(false);
    expect(isDecisionGateConfigured({ ...CONFIGURED, endpoint: 'http://insecure.example' })).toBe(false);
    expect(isDecisionGateConfigured({ ...CONFIGURED, deployment: '  ' })).toBe(false);
  });
});

describe('normalizeDecisionGateSettings', () => {
  it('fills in defaults for an install that predates the gate', () => {
    expect(normalizeDecisionGateSettings(undefined)).toEqual(DEFAULT_SETTINGS.decisionGate);
  });

  it('trims strings and keeps valid values', () => {
    expect(normalizeDecisionGateSettings({
      enabled: false,
      endpoint: '  https://r.services.ai.azure.com/  ',
      deployment: '  my-decision ',
    })).toEqual({
      enabled: false,
      endpoint: 'https://r.services.ai.azure.com/',
      deployment: 'my-decision',
    });
  });

  it('replaces garbage field by field, and a blank deployment with the default name', () => {
    const garbage = { enabled: 'yes', endpoint: 42, deployment: '   ' } as unknown as Partial<DecisionGateSettings>;
    expect(normalizeDecisionGateSettings(garbage)).toEqual(DEFAULT_SETTINGS.decisionGate);
  });
});

describe('buildDecisionGateRequest', () => {
  const profile = createDefaultProfile();

  it('hands the decision model the profile prompt, so the profile decides what is worth surfacing', () => {
    const request = buildDecisionGateRequest({
      deployment: ' my-decision ',
      profile,
      transcript: 'We should check hosted agents in West Europe.',
      recentTopics: ['hosted agents'],
    });

    expect(request?.model).toBe('my-decision');
    expect(request?.state.profile_instructions).toBe(profile.systemPrompt.trim());
    expect(request?.state.already_surfaced).toEqual(['hosted agents']);
    expect(request?.state.just_said).toBe('We should check hosted agents in West Europe.');
  });

  it('asks one yes/no question per enabled kind and nothing for a disabled one', () => {
    const both = buildDecisionGateRequest({ deployment: 'd', profile, transcript: 'hello there', recentTopics: [] });
    expect(Object.keys(both?.questions ?? {})).toEqual(['passive', 'answer']);
    expect(Object.values(both?.questions ?? {}).every((question) => question.type === 'noul')).toBe(true);

    const passiveOnly = buildDecisionGateRequest({
      deployment: 'd',
      profile: { ...profile, explicitAnswersEnabled: false },
      transcript: 'hello there',
      recentTopics: [],
    });
    expect(Object.keys(passiveOnly?.questions ?? {})).toEqual(['passive']);

    const answerOnly = buildDecisionGateRequest({
      deployment: 'd',
      profile: { ...profile, passiveCardsEnabled: false },
      transcript: 'hello there',
      recentTopics: [],
    });
    expect(Object.keys(answerOnly?.questions ?? {})).toEqual(['answer']);
  });

  it('has nothing to ask when no kind is enabled or nobody has spoken', () => {
    expect(buildDecisionGateRequest({
      deployment: 'd',
      profile: { ...profile, passiveCardsEnabled: false, explicitAnswersEnabled: false },
      transcript: 'hello there',
      recentTopics: [],
    })).toBeNull();
    expect(buildDecisionGateRequest({ deployment: 'd', profile, transcript: '  \n ', recentTopics: [] })).toBeNull();
  });

  it('passes only the profile vocabulary that is not blank', () => {
    const withTerms = buildDecisionGateRequest({
      deployment: 'd',
      profile: { ...profile, vocabulary: ['AKS', '  ', ' Foundry '] },
      transcript: 'hello there',
      recentTopics: [],
    });
    expect(withTerms?.state.watch_terms).toEqual(['AKS', 'Foundry']);

    const without = buildDecisionGateRequest({
      deployment: 'd',
      profile: { ...profile, vocabulary: [] },
      transcript: 'hello there',
      recentTopics: [],
    });
    expect(without?.state).not.toHaveProperty('watch_terms');
  });

  it('separates what was just said from the background, keeping line breaks', () => {
    const words = Array.from({ length: 400 }, (_, index) => `w${index}`);
    const transcript = [words.slice(0, 200).join(' '), words.slice(200).join(' ')].join('\n');
    const request = buildDecisionGateRequest({ deployment: 'd', profile, transcript, recentTopics: [] });

    const justSaid = request?.state.just_said.split(/\s+/) ?? [];
    const earlier = request?.state.earlier_conversation.split(/\s+/) ?? [];
    expect(justSaid).toHaveLength(50);
    expect(justSaid.at(-1)).toBe('w399');
    expect(earlier).toHaveLength(300);
    // The oldest words fall off the front rather than the newest ones.
    expect(earlier[0]).toBe('w50');
    expect(request?.state.earlier_conversation).toContain('\n');
  });

  it('puts a short transcript entirely in just_said', () => {
    const request = buildDecisionGateRequest({ deployment: 'd', profile, transcript: 'one two three', recentTopics: [] });
    expect(request?.state.just_said).toBe('one two three');
    expect(request?.state.earlier_conversation).toBe('');
  });
});

describe('parseDecisionGateResponse', () => {
  it('reads the yes-probability from the System One `noul` field', () => {
    expect(parseDecisionGateResponse({
      model: 'microsoft-decision-1',
      answers: { passive: { type: 'noul', noul: 0.98 }, answer: { type: 'noul', noul: 0.04 } },
      usage: { input_tokens: 238, output_tokens: 0 },
    }, ['passive', 'answer'])).toEqual({ passive: 0.98, answer: 0.04 });
  });

  it('also accepts the `probability` spelling', () => {
    expect(parseDecisionGateResponse({
      answers: { passive: { type: 'noul', probability: 0.1 } },
    }, ['passive'])).toEqual({ passive: 0.1 });
  });

  it('refuses to answer from a partial response, because the missing kind might be the one that matters', () => {
    const answers = { passive: { type: 'noul', noul: 0.01 } };
    expect(parseDecisionGateResponse({ answers }, ['passive', 'answer'])).toBeNull();
  });

  it('rejects malformed, out-of-range, and non-numeric answers', () => {
    expect(parseDecisionGateResponse(null, ['passive'])).toBeNull();
    expect(parseDecisionGateResponse({}, ['passive'])).toBeNull();
    expect(parseDecisionGateResponse({ answers: [] }, ['passive'])).toBeNull();
    expect(parseDecisionGateResponse({ answers: { passive: { type: 'noul', noul: 1.4 } } }, ['passive'])).toBeNull();
    expect(parseDecisionGateResponse({ answers: { passive: { type: 'noul', noul: -0.1 } } }, ['passive'])).toBeNull();
    expect(parseDecisionGateResponse({ answers: { passive: { type: 'noul', noul: '0.9' } } }, ['passive'])).toBeNull();
    expect(parseDecisionGateResponse({ answers: { passive: { type: 'refusal' } } }, ['passive'])).toBeNull();
    expect(parseDecisionGateResponse({ answers: { passive: { noul: 0.5 } } }, [])).toBeNull();
  });
});

describe('judgeDecisionGate', () => {
  it('passes when any kind reaches the threshold, including exactly at it', () => {
    expect(judgeDecisionGate({ passive: 0.9, answer: 0.01 })).toBe('pass');
    expect(judgeDecisionGate({ passive: 0, answer: DECISION_GATE_PASS_THRESHOLD })).toBe('pass');
  });

  it('declines only when every kind is clearly below the threshold', () => {
    expect(judgeDecisionGate({ passive: 0.02, answer: 0.01 })).toBe('decline');
    expect(judgeDecisionGate({ passive: DECISION_GATE_PASS_THRESHOLD - 0.01 })).toBe('decline');
  });

  it('is biased to let the LLM look, since a missed card costs more than a wasted call', () => {
    expect(DECISION_GATE_PASS_THRESHOLD).toBeLessThanOrEqual(0.5);
  });
});

describe('formatDecisionGateProbabilities', () => {
  it('renders a compact log fragment', () => {
    expect(formatDecisionGateProbabilities({ passive: 0.123, answer: 0.5 })).toBe('passive=0.12 answer=0.50');
  });
});
