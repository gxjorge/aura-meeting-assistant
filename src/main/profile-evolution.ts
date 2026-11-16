import type {
  MeetingProfile,
  ProfileProposal,
  ProfileProposalChange,
  ProfileProposalKind,
} from '../shared/types.js';
import { profileAgentCompletion } from './copilot.js';
import { getActiveProfile, updateProfile } from './settings.js';
import {
  applyVocabularyChanges,
  deriveVocabularyChanges,
  shouldProposeEvolution,
  summarizeLearning,
} from '../shared/profile-learning.js';

/**
 * End-of-meeting profile self-evolution.
 *
 * Two loops run here, in order of increasing intrusiveness:
 *
 * 1. **Silent** — vocabulary promotions/demotions the accumulated signal clearly justifies are applied
 *    directly. These are reversible from the Profiles UI and only ever move terms in or out of the
 *    trigger list.
 * 2. **Proposed** — an agent reviews an anonymized counter digest and drafts prompt edits. These are
 *    stored as `profile.pendingProposal` and applied only after the user accepts them.
 *
 * The agent only ever sees derived terms and counters. Transcript text is never included.
 */

const PROPOSAL_TIMEOUT_MS = 90_000;
const MAX_PROPOSED_CHANGES = 3;

const PROPOSAL_SYSTEM_PROMPT = `You review usage statistics for an Aura meeting profile and suggest small, concrete improvements to its prompt.

The profile prompt does two jobs: it tells Aura what is worth surfacing during a meeting, and how to answer once something is. Each statistic shows how often a concept was surfaced, how often the user engaged with the resulting card, and how often they dismissed it.

Concepts that are surfaced but consistently dismissed suggest the prompt is watching for the wrong thing. Concepts that are consistently engaged with suggest the prompt should watch for more like them.

Suggest at most 3 changes. Only suggest a change you can justify from the statistics. Prefer no change over a speculative one.

Respond with JSON only, no prose and no code fences:
{"changes":[{"kind":"system_prompt","summary":"short title","rationale":"one sentence","value":"the full replacement prompt text"}]}

Return {"changes":[]} when the statistics do not justify any change.`;

const PROPOSAL_KINDS = new Set<ProfileProposalKind>(['system_prompt']);

/**
 * Called when listening stops. Never throws — a failed review must not disrupt the app.
 */
export async function reviewProfileAfterMeeting(): Promise<void> {
  try {
    const profile = getActiveProfile();
    if (!profile.learningEnabled) return;

    const withVocabulary = applyLearnedVocabulary(profile);
    if (!shouldProposeEvolution(withVocabulary)) return;

    await draftEvolutionProposal(withVocabulary);
  } catch (err: unknown) {
    console.warn('[Profile evolution] Post-meeting review failed:', err);
  }
}

/** Applies the vocabulary changes the signal justifies. Returns the profile as it now stands. */
export function applyLearnedVocabulary(profile: MeetingProfile): MeetingProfile {
  const changes = deriveVocabularyChanges(profile);
  if (changes.promote.length === 0 && changes.demote.length === 0) return profile;

  const updated = applyVocabularyChanges(profile, changes);
  const persisted = updateProfile(profile.id, { vocabulary: updated.vocabulary });

  console.log(
    `[Profile evolution] ${profile.name}: promoted ${changes.promote.length}, `
    + `demoted ${changes.demote.length} vocabulary terms`,
  );

  return persisted ?? updated;
}

async function draftEvolutionProposal(profile: MeetingProfile): Promise<void> {
  const answer = await profileAgentCompletion(profile, buildProposalPrompt(profile), {
    systemPrompt: PROPOSAL_SYSTEM_PROMPT,
    timeoutMs: PROPOSAL_TIMEOUT_MS,
  });

  const changes = parseProposalChanges(answer, profile);
  const learning = { ...profile.learning, signalsSinceProposal: 0 };

  if (changes.length === 0) {
    updateProfile(profile.id, { learning });
    return;
  }

  const proposal: ProfileProposal = {
    id: `proposal-${Date.now()}`,
    createdAt: Date.now(),
    changes,
  };

  updateProfile(profile.id, { pendingProposal: proposal, learning });
  console.log(`[Profile evolution] ${profile.name}: drafted ${changes.length} proposed change(s)`);
}

function buildProposalPrompt(profile: MeetingProfile): string {
  return [
    `Profile: ${profile.name}`,
    profile.description ? `Purpose: ${profile.description}` : '',
    `Connected sources: ${describeMcpServers(profile)}`,
    '',
    'Current profile prompt (kind "system_prompt"):',
    profile.systemPrompt,
    '',
    'Card interaction statistics:',
    summarizeLearning(profile),
  ].filter(Boolean).join('\n');
}

/** Lists the profile's live tool sources so the proposal agent knows what it can already reach. */
function describeMcpServers(profile: MeetingProfile): string {
  const enabled = profile.mcpServers.filter((server) => server.enabled);
  return enabled.length > 0
    ? enabled.map((server) => server.name).join(', ')
    : 'none';
}

/** Tolerates the model wrapping its JSON in prose or code fences. */
function parseProposalChanges(answer: string, profile: MeetingProfile): ProfileProposalChange[] {
  const json = extractJsonObject(answer);
  if (!json) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    console.warn('[Profile evolution] Proposal response was not valid JSON');
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const rawChanges = (parsed as { changes?: unknown }).changes;
  if (!Array.isArray(rawChanges)) return [];

  const changes: ProfileProposalChange[] = [];
  for (const entry of rawChanges) {
    if (changes.length >= MAX_PROPOSED_CHANGES) break;
    if (!entry || typeof entry !== 'object') continue;

    const candidate = entry as Partial<ProfileProposalChange>;
    if (typeof candidate.kind !== 'string') continue;
    if (!PROPOSAL_KINDS.has(candidate.kind as ProfileProposalKind)) continue;

    const value = typeof candidate.value === 'string' ? candidate.value.trim() : '';
    if (!value) continue;

    // A "change" identical to what the profile already has is noise.
    if (value === profile.systemPrompt.trim()) continue;

    changes.push({
      id: `${candidate.kind}-${changes.length}`,
      kind: candidate.kind as ProfileProposalKind,
      summary: typeof candidate.summary === 'string' && candidate.summary.trim()
        ? candidate.summary.trim()
        : 'Suggested prompt update',
      rationale: typeof candidate.rationale === 'string' ? candidate.rationale.trim() : '',
      value,
    });
  }

  return changes;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
