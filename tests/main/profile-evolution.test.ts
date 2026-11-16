import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingProfile, ProfileTermStat } from '../../src/shared/types.js';
import { createBlankProfile } from '../../src/shared/meeting-profiles.js';

const NOW = 1_700_000_000_000;

const mocks = vi.hoisted(() => ({
  agentCompletion: vi.fn((): Promise<string> => Promise.resolve('{"changes":[]}')),
  profile: null as unknown as MeetingProfile,
  getActiveProfile: vi.fn((): MeetingProfile => mocks.profile),
  updateProfile: vi.fn((_id: string, patch: Partial<MeetingProfile>): MeetingProfile | null => {
    mocks.profile = { ...mocks.profile, ...patch };
    return mocks.profile;
  }),
}));

vi.mock('../../src/main/copilot.js', () => ({
  profileAgentCompletion: mocks.agentCompletion,
}));

vi.mock('../../src/main/settings.js', () => ({
  getActiveProfile: mocks.getActiveProfile,
  updateProfile: mocks.updateProfile,
}));

import { applyLearnedVocabulary, reviewProfileAfterMeeting } from '../../src/main/profile-evolution.js';

function term(patch: Partial<ProfileTermStat> & { term: string }): ProfileTermStat {
  return {
    weight: 0,
    surfaced: 0,
    engaged: 0,
    rejected: 0,
    updatedAt: NOW,
    ...patch,
  };
}

function profileWith(patch: Partial<MeetingProfile>): MeetingProfile {
  return { ...createBlankProfile('Evolution', [], NOW), ...patch };
}

/** A profile that has accumulated enough signal for `shouldProposeEvolution` to fire. */
function readyForProposal(patch: Partial<MeetingProfile> = {}): MeetingProfile {
  return profileWith({
    learningEnabled: true,
    learning: { terms: [term({ term: 'renewal', weight: 4, surfaced: 6, engaged: 4 })], signalsSinceProposal: 12 },
    ...patch,
  });
}

describe('profile evolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentCompletion.mockResolvedValue('{"changes":[]}');
  });

  describe('applyLearnedVocabulary', () => {
    it('promotes well-engaged terms into the vocabulary', () => {
      const profile = profileWith({
        vocabulary: [],
        learning: {
          terms: [term({ term: 'contoso renewal', weight: 5, surfaced: 6, engaged: 4 })],
          signalsSinceProposal: 4,
        },
      });
      mocks.profile = profile;

      const result = applyLearnedVocabulary(profile);

      expect(result.vocabulary).toContain('contoso renewal');
      expect(mocks.updateProfile).toHaveBeenCalledWith(
        profile.id,
        expect.objectContaining({ vocabulary: expect.arrayContaining(['contoso renewal']) }),
      );
    });

    it('demotes terms the user keeps dismissing', () => {
      const profile = profileWith({
        vocabulary: ['noisy term'],
        learning: {
          terms: [term({ term: 'noisy term', weight: -4, surfaced: 8, rejected: 5 })],
          signalsSinceProposal: 4,
        },
      });
      mocks.profile = profile;

      const result = applyLearnedVocabulary(profile);

      expect(result.vocabulary).not.toContain('noisy term');
    });

    it('does not persist when nothing crosses a threshold', () => {
      const profile = profileWith({
        learning: { terms: [term({ term: 'weak', weight: 0.5, surfaced: 2, engaged: 1 })], signalsSinceProposal: 1 },
      });

      const result = applyLearnedVocabulary(profile);

      expect(result).toBe(profile);
      expect(mocks.updateProfile).not.toHaveBeenCalled();
    });
  });

  describe('reviewProfileAfterMeeting', () => {
    it('does nothing when learning is disabled', async () => {
      mocks.profile = readyForProposal({ learningEnabled: false });

      await reviewProfileAfterMeeting();

      expect(mocks.agentCompletion).not.toHaveBeenCalled();
      expect(mocks.updateProfile).not.toHaveBeenCalled();
    });

    it('does not run the proposal agent below the signal threshold', async () => {
      mocks.profile = readyForProposal({
        learning: { terms: [], signalsSinceProposal: 2 },
      });

      await reviewProfileAfterMeeting();

      expect(mocks.agentCompletion).not.toHaveBeenCalled();
    });

    it('never sends transcript text to the proposal agent', async () => {
      mocks.profile = readyForProposal();

      await reviewProfileAfterMeeting();

      const [, userMessage] = mocks.agentCompletion.mock.calls[0] as unknown as [MeetingProfile, string];
      expect(userMessage).toContain('renewal');
      expect(userMessage).toContain('surfaced 6');
      expect(userMessage).not.toMatch(/transcript/i);
    });

    it('stores a pending proposal when the agent suggests a change', async () => {
      mocks.profile = readyForProposal();
      mocks.agentCompletion.mockResolvedValue(JSON.stringify({
        changes: [{
          kind: 'system_prompt',
          summary: 'Lead with renewal status',
          rationale: 'Renewal cards get opened most.',
          value: 'You answer renewal questions first.',
        }],
      }));

      await reviewProfileAfterMeeting();

      const patch = lastPatch();
      expect(patch.pendingProposal?.changes).toHaveLength(1);
      expect(patch.pendingProposal?.changes[0].kind).toBe('system_prompt');
      expect(patch.pendingProposal?.changes[0].value).toBe('You answer renewal questions first.');
      expect(patch.learning?.signalsSinceProposal).toBe(0);
    });

    it('tolerates the model wrapping its JSON in code fences and prose', async () => {
      mocks.profile = readyForProposal();
      mocks.agentCompletion.mockResolvedValue(
        'Here is my suggestion:\n```json\n'
        + JSON.stringify({ changes: [{ kind: 'system_prompt', summary: 'Tighten', value: 'Be brief.' }] })
        + '\n```\nHope that helps!',
      );

      await reviewProfileAfterMeeting();

      expect(lastPatch().pendingProposal?.changes[0]).toMatchObject({
        kind: 'system_prompt',
        value: 'Be brief.',
      });
    });

    it('rejects changes with an unknown kind', async () => {
      mocks.profile = readyForProposal();
      mocks.agentCompletion.mockResolvedValue(JSON.stringify({
        changes: [
          { kind: 'mcp_server', summary: 'Add MSX', value: 'https://example.invalid' },
          { kind: 'answer_model', summary: 'Switch model', value: 'gpt-9' },
        ],
      }));

      await reviewProfileAfterMeeting();

      const patch = lastPatch();
      expect(patch.pendingProposal).toBeUndefined();
      expect(patch.learning?.signalsSinceProposal).toBe(0);
    });

    it('caps the proposal at three changes', async () => {
      mocks.profile = readyForProposal();
      mocks.agentCompletion.mockResolvedValue(JSON.stringify({
        changes: [1, 2, 3, 4, 5].map((n) => ({
          kind: 'system_prompt',
          summary: `Change ${n}`,
          value: `Replacement prompt ${n}`,
        })),
      }));

      await reviewProfileAfterMeeting();

      expect(lastPatch().pendingProposal?.changes).toHaveLength(3);
    });

    it('drops a change identical to the prompt the profile already has', async () => {
      const profile = readyForProposal();
      mocks.profile = profile;
      mocks.agentCompletion.mockResolvedValue(JSON.stringify({
        changes: [{ kind: 'system_prompt', summary: 'No-op', value: profile.systemPrompt }],
      }));

      await reviewProfileAfterMeeting();

      expect(lastPatch().pendingProposal).toBeUndefined();
    });

    it('ignores a malformed response instead of throwing', async () => {
      mocks.profile = readyForProposal();
      mocks.agentCompletion.mockResolvedValue('{ not json at all }');

      await expect(reviewProfileAfterMeeting()).resolves.toBeUndefined();
      expect(lastPatch().pendingProposal).toBeUndefined();
    });

    it('does not disrupt shutdown when the agent call fails', async () => {
      mocks.profile = readyForProposal();
      mocks.agentCompletion.mockRejectedValue(new Error('agent unavailable'));

      await expect(reviewProfileAfterMeeting()).resolves.toBeUndefined();
    });
  });
});

/** The patch handed to the last `updateProfile` call. */
function lastPatch(): Partial<MeetingProfile> {
  const calls = mocks.updateProfile.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Partial<MeetingProfile>;
}
