import { describe, expect, it } from 'vitest';
import {
  MAX_TRIAGE_REQUESTS,
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  parseTriageResponse,
  resolveLearningTerm,
} from '../../src/shared/meeting-triage.js';
import { createDefaultProfile, createProfileFromTemplate } from '../../src/shared/meeting-profiles.js';
import type { MeetingProfile } from '../../src/shared/types.js';

describe('triage system prompt', () => {
  it('leads with the profile prompt so the profile governs what is surfaced', () => {
    const profile = createDefaultProfile();
    profile.systemPrompt = 'Surface every mention of Loop engineering concepts.';

    const prompt = buildTriageSystemPrompt(profile);

    expect(prompt.startsWith('Surface every mention of Loop engineering concepts.')).toBe(true);
    expect(prompt).toContain('"surface"');
  });

  it('carries a sales profile prompt through unchanged', () => {
    const profile = createProfileFromTemplate('sales-review', []) as MeetingProfile;

    const prompt = buildTriageSystemPrompt(profile);

    expect(prompt).toContain(profile.systemPrompt.trim());
  });

  it('offers profile vocabulary as an always-watch hint', () => {
    const profile = createDefaultProfile();
    profile.vocabulary = ['Opportunity Explorer', 'MSX'];

    const prompt = buildTriageSystemPrompt(profile);

    expect(prompt).toContain('Opportunity Explorer');
    expect(prompt).toContain('MSX');
  });

  it('omits the vocabulary section when the profile has none', () => {
    const profile = createDefaultProfile();
    profile.vocabulary = [];

    expect(buildTriageSystemPrompt(profile)).not.toContain('always worth watching for');
  });

  it('tells the model which request kinds the user left enabled', () => {
    const profile = createDefaultProfile();
    profile.passiveCardsEnabled = false;

    const prompt = buildTriageSystemPrompt(profile);

    expect(prompt).toContain('"answer"');
    expect(prompt).toContain('Only these kinds are enabled');
  });

  it('asks for an empty list when the user disabled both kinds', () => {
    const profile = createDefaultProfile();
    profile.passiveCardsEnabled = false;
    profile.explicitAnswersEnabled = false;

    expect(buildTriageSystemPrompt(profile)).toContain('Always return an empty list');
  });

  it('invites a restatement once the call has made a topic more specific', () => {
    // Triage now runs mid-sentence, so it sees "hosted agents" before "hosted agents available
    // regions" is spoken. A flat never-repeat rule would suppress the second, fuller topic — which
    // is the one the card is meant to grow into — and quietly strip Aura of card refinement.
    const prompt = buildTriageSystemPrompt(createDefaultProfile()).replace(/\s+/g, ' ');

    expect(prompt).toContain('unless the call has since made it materially more specific');
    expect(prompt).toContain('hosted agents available regions');
    expect(prompt).toContain('Never repeat a topic that gained nothing');
  });
});

describe('triage user message', () => {
  it('includes the transcript context', () => {
    const message = buildTriageUserMessage('Alice: the Contoso renewal is slipping.');

    expect(message).toContain('Contoso renewal is slipping');
  });

  it('lists already-surfaced topics so triage stops repeating itself', () => {
    const message = buildTriageUserMessage('...', ['azure ai search', 'contoso renewal']);

    expect(message).toContain('azure ai search');
    expect(message).toContain('contoso renewal');
  });

  it('allows a surfaced topic to come back when it has grown', () => {
    const message = buildTriageUserMessage('...', ['hosted agents']);

    expect(message).toContain('materially more specific');
  });
});

describe('parseTriageResponse', () => {
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({
      surface: [
        { kind: 'passive', topic: 'Azure AI Search', query: 'Azure AI Search vector indexes', reason: 'Being designed' },
      ],
    });

    expect(parseTriageResponse(raw)).toEqual([
      {
        kind: 'passive',
        topic: 'Azure AI Search',
        query: 'Azure AI Search vector indexes',
        reason: 'Being designed',
      },
    ]);
  });

  it('tolerates prose and code fences around the JSON', () => {
    const raw = 'Here you go:\n```json\n{"surface":[{"kind":"answer","topic":"Contoso renewal"}]}\n```\nHope that helps.';

    expect(parseTriageResponse(raw)).toHaveLength(1);
  });

  it('defaults the query to the topic', () => {
    const raw = '{"surface":[{"kind":"passive","topic":"Loop components"}]}';

    expect(parseTriageResponse(raw)[0]?.query).toBe('Loop components');
  });

  it('returns nothing for an empty surface list', () => {
    expect(parseTriageResponse('{"surface":[]}')).toEqual([]);
  });

  it('returns nothing for unparseable output', () => {
    expect(parseTriageResponse('I could not decide.')).toEqual([]);
    expect(parseTriageResponse('')).toEqual([]);
    expect(parseTriageResponse('{"surface":')).toEqual([]);
  });

  it('drops entries with an unknown kind or a missing topic', () => {
    const raw = JSON.stringify({
      surface: [
        { kind: 'shout', topic: 'Nope' },
        { kind: 'passive', topic: '   ' },
        { kind: 'passive', topic: 'Keeper' },
      ],
    });

    expect(parseTriageResponse(raw).map((entry) => entry.topic)).toEqual(['Keeper']);
  });

  it('caps how many cards one tick can raise', () => {
    const raw = JSON.stringify({
      surface: Array.from({ length: 10 }, (_, index) => ({ kind: 'passive', topic: `Topic ${index}` })),
    });

    expect(parseTriageResponse(raw)).toHaveLength(MAX_TRIAGE_REQUESTS);
  });

  it('clamps runaway text so one bad response cannot flood a card', () => {
    const raw = JSON.stringify({
      surface: [{ kind: 'passive', topic: 'x'.repeat(500), query: 'y'.repeat(2000) }],
    });

    const [request] = parseTriageResponse(raw);
    expect(request!.topic.length).toBeLessThanOrEqual(80);
    expect(request!.query.length).toBeLessThanOrEqual(240);
  });
});

describe('resolveLearningTerm', () => {
  it('returns the user-curated casing when a topic matches vocabulary', () => {
    expect(resolveLearningTerm('opportunity explorer', ['Opportunity Explorer'])).toBe('Opportunity Explorer');
  });

  it('returns null for a topic the user never curated', () => {
    // The privacy boundary: triage topics come from live transcript, so anything not already in the
    // profile's own vocabulary must never reach disk.
    expect(resolveLearningTerm('the Northwind pricing exception', ['Opportunity Explorer'])).toBeNull();
  });

  it('returns null for an empty topic or empty vocabulary', () => {
    expect(resolveLearningTerm('', ['Anything'])).toBeNull();
    expect(resolveLearningTerm('Anything', [])).toBeNull();
  });
});
