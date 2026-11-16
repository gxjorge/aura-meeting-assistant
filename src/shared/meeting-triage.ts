import type { MeetingProfile } from './types.js';

/**
 * A single thing the triage pass decided is worth surfacing.
 *
 * `passive` means nobody asked and Aura is offering context proactively. `answer` means someone on
 * the call explicitly said they need to check, verify, or look something up.
 */
export interface TriageRequest {
  kind: 'passive' | 'answer';
  /** Short label used as the card title, the dedupe key, and the learning-term candidate. */
  topic: string;
  /** What to actually look up. May be longer and more specific than `topic`. */
  query: string;
  /** Why the triage pass thought this was worth surfacing. Diagnostic only. */
  reason: string;
}

/** Upper bound on cards produced by a single triage pass, so one noisy minute cannot flood the feed. */
export const MAX_TRIAGE_REQUESTS = 3;

const MAX_TOPIC_LENGTH = 80;
const MAX_QUERY_LENGTH = 240;
const MAX_REASON_LENGTH = 240;

/**
 * Wraps the profile's own prompt with the triage contract. The profile prompt stays first and stays
 * authoritative: it is what decides *whether* anything is worth surfacing and *what* that is. The
 * appended protocol only fixes the output shape so the result can be parsed.
 */
export function buildTriageSystemPrompt(profile: MeetingProfile): string {
  const vocabulary = profile.vocabulary.filter((term) => term.trim().length > 0);
  const vocabularySection = vocabulary.length > 0
    ? `\nTerms this profile always cares about, if they come up: ${vocabulary.join(', ')}.\n`
    : '';

  const allowed: string[] = [];
  if (profile.passiveCardsEnabled) allowed.push('"passive"');
  if (profile.explicitAnswersEnabled) allowed.push('"answer"');
  const allowedSection = allowed.length > 0
    ? `Only these kinds are enabled right now: ${allowed.join(' and ')}. Never emit any other kind.`
    : 'Nothing is enabled right now. Always return an empty list.';

  return `${profile.systemPrompt.trim()}

---

You are now running as Aura's triage pass. You are shown a rolling window of a live meeting
transcript and you decide, according to your instructions above, whether anything being discussed
right now deserves a card in the meeting feed.

Reply with JSON only. No prose, no code fence.

{"surface": [{"kind": "passive", "topic": "short label", "query": "what to look up", "reason": "why"}]}

- "passive" - nobody asked; you are proactively offering context because your instructions say this
  is worth surfacing.
- "answer" - someone on the call explicitly said they need to check, verify, confirm, look up, or
  research something, or asked Aura directly.

${allowedSection}
${vocabularySection}
Rules:
- Return {"surface": []} when nothing is worth surfacing. Most windows are silence, small talk, or
  chat that your instructions do not care about, and an empty list is the correct answer for those.
- At most ${MAX_TRIAGE_REQUESTS} entries. Pick the most useful.
- Do not restate an already-surfaced topic unless the call has since made it materially more
  specific. Triage runs while someone is still speaking, so a half-finished sentence is often
  surfaced before its point arrives: if "hosted agents" was surfaced and the speaker went on to ask
  about available regions, return "hosted agents available regions" — reusing the earlier words so
  it reads as the same topic grown, not a new one. Never repeat a topic that gained nothing.
- "topic" is a short label, roughly two to six words, that names the subject. It becomes the card
  title, so keep it free of verbatim quotes from the call.
- "query" is what should actually be looked up or answered.
- Judge only what is being discussed now. Do not surface something because it was mentioned once in
  passing several minutes ago.`;
}

export function buildTriageUserMessage(
  transcriptContext: string,
  recentTopics: readonly string[] = [],
): string {
  const alreadySurfaced = recentTopics.length > 0
    ? `Already surfaced recently. Do not repeat these, but do restate one if the call has since made it materially more specific:\n${recentTopics.map((topic) => `- ${topic}`).join('\n')}`
    : 'Already surfaced recently: nothing yet.';

  return `Live meeting transcript window:
${transcriptContext}

${alreadySurfaced}

Decide what, if anything, to surface now.`;
}

/**
 * Parses a triage reply. Tolerant of code fences and surrounding prose because small models wrap
 * JSON often; anything that does not validate is dropped rather than guessed at.
 */
export function parseTriageResponse(raw: string): TriageRequest[] {
  const payload = extractJsonObject(raw);
  if (!payload) return [];

  const entries = Array.isArray(payload.surface) ? payload.surface : [];
  const requests: TriageRequest[] = [];

  for (const entry of entries) {
    if (requests.length >= MAX_TRIAGE_REQUESTS) break;
    const request = normalizeRequest(entry);
    if (request) requests.push(request);
  }

  return requests;
}

/**
 * Privacy gate for profile learning.
 *
 * Triage topics are model-generated from transcript text, so they can echo meeting content and must
 * never reach disk. Only a topic that matches a term the user already curated in `profile.vocabulary`
 * becomes a learnable term, and the stored form is the user's own casing, not the model's.
 */
export function resolveLearningTerm(
  topic: string,
  vocabulary: readonly string[],
): string | null {
  const normalizedTopic = topic.trim().toLowerCase();
  if (!normalizedTopic) return null;

  for (const term of vocabulary) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase() === normalizedTopic) return trimmed;
  }

  return null;
}

function normalizeRequest(entry: unknown): TriageRequest | null {
  if (!entry || typeof entry !== 'object') return null;
  const candidate = entry as Record<string, unknown>;

  const kind = candidate.kind;
  if (kind !== 'passive' && kind !== 'answer') return null;

  const topic = clampText(candidate.topic, MAX_TOPIC_LENGTH);
  if (!topic) return null;

  const query = clampText(candidate.query, MAX_QUERY_LENGTH) || topic;
  const reason = clampText(candidate.reason, MAX_REASON_LENGTH);

  return { kind, topic, query, reason };
}

function clampText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength).trim() : collapsed;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
