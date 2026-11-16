import type {
  AuraSettings,
  LegacyAuraSettings,
  McpConnection,
  MeetingProfile,
  ProfileMcpServer,
  ProfileMcpTransport,
  ProfileProposal,
  ProfileProposalChange,
  ProfileProposalKind,
  ProfileSkill,
  TriageCadenceSettings,
  WorkIqAuthSettings,
} from './types.js';
import {
  DEFAULT_ANSWER_MODEL,
  DEFAULT_PROFILE_ID,
  DEFAULT_TRIAGE_CADENCE,
  DEFAULT_TRIAGE_MODEL,
  LEGACY_GENERAL_PROFILE_ID,
  MAX_VOCABULARY_TERMS,
} from './types.js';
import { createLearningState, normalizeLearningState } from './profile-learning.js';
import { normalizeWorkIqAuthSettings } from './workiq-auth-config.js';

const PROPOSAL_KINDS = new Set<ProfileProposalKind>([
  'vocabulary_add',
  'vocabulary_remove',
  'system_prompt',
]);

const LEGACY_DEFAULT_ANSWER_MODEL = 'claude-sonnet-4.6';

/**
 * Verbatim `passivePrompt` values Aura shipped before the single-prompt model. Persisted profiles
 * still carrying one of these were never customised, so migration drops them instead of appending
 * boilerplate to the user's prompt.
 */
const LEGACY_PASSIVE_PROMPTS: readonly string[] = [
  `You are Aura's passive context agent.

You run in the background during a live meeting and surface a short, glanceable card about the topic currently being discussed.

Use the tools available to you to look up real data. Never invent figures, names, or record IDs. If a tool returns nothing, say plainly what could not be retrieved.

Answer in at most four short lines. Lead with the single most useful fact.`,
  `You are Aura's passive context agent for a sales review call.

When an account, opportunity, or customer is mentioned, surface the most relevant current facts about it using your available tools: stage, amount, close date, and the latest activity.

Never invent data. If nothing is found, say so in one line. Answer in at most four short lines.`,
  `You are Aura's passive context agent for a document review call.

When a claim, standard, or specification is discussed, surface what authoritative sources say about it using your available tools.

Flag contradictions first. Never invent a citation. Answer in at most four short lines.`,
];

/**
 * Verbatim `systemPrompt` values Aura shipped as the built-in default before the uniform-profile
 * refactor. They tell the agent to ground itself in "the official documentation URLs provided in the
 * prompt", and Aura stopped injecting those URLs when documentation became an ordinary MCP server —
 * so a profile still carrying one is instructed to use grounding that no longer arrives.
 *
 * That matters more than it looks, because this prompt is now also the *triage* prompt. The oldest of
 * these describes an answer agent and never says what to watch for, so triage is left classifying a
 * live transcript with no criteria and surfaces almost nothing.
 *
 * Matching is byte-exact on purpose: only a prompt the user never edited is refreshed.
 */
const LEGACY_ANSWER_PROMPTS: readonly string[] = [
  `You are Aura's explicit-answer agent.

Aura listens during meetings and starts exactly one answer agent when the user says they need to check, verify, or look something up.

Use only the official documentation URLs provided in the prompt as external grounding. If those docs do not answer the ask, say exactly what still needs verification instead of guessing or using unsupported sources.

Return a concise meeting-ready answer and cite the provided source URLs.`,
  `You are Aura, a meeting assistant for calls about cloud and developer technology.

Watch for:
- A product, service, API, protocol, or technical concept being discussed in enough detail that a documentation link would help.
- Anyone saying they need to check, verify, confirm, or look something up.

Ignore scheduling, status updates, small talk, and anything you cannot ground in official documentation.

When you answer, use only the official documentation URLs provided in the prompt as external grounding. If those docs do not answer the ask, say exactly what still needs verification instead of guessing or using unsupported sources.

Return a concise meeting-ready answer and cite the provided source URLs.`,
];

/**
 * Microsoft's public documentation MCP server. Aura seeds it on the docs-oriented templates, but it is
 * an ordinary profile MCP server: users can disable it, point a profile at a different docs source, or
 * add it to a profile that did not ship with it.
 */
export const MICROSOFT_LEARN_MCP_ID = 'microsoft-learn';
const MICROSOFT_LEARN_MCP_URL = 'https://learn.microsoft.com/api/mcp';
export const WORKIQ_MCP_ID = 'workiq';
export const WORKIQ_MCP_URL = 'https://workiq.svc.cloud.microsoft/mcp';
export const WORKIQ_READ_ONLY_TOOLS = [
  'ask',
  'fetch',
  'fetch_blob',
  'retrieve',
  'get_schema',
  'search_paths',
  'list_agents',
  'call_function',
] as const;

export function createMicrosoftLearnMcpServer(): ProfileMcpServer {
  return {
    id: MICROSOFT_LEARN_MCP_ID,
    name: 'Microsoft Learn',
    description: 'Official Microsoft and Azure documentation search.',
    transport: 'http',
    url: MICROSOFT_LEARN_MCP_URL,
    tools: ['*'],
    enabled: true,
  };
}

export function createWorkIqMcpServer(): ProfileMcpServer {
  return {
    id: WORKIQ_MCP_ID,
    name: 'Work IQ',
    description: 'Read-only Microsoft 365 context using your signed-in identity.',
    transport: 'http',
    url: WORKIQ_MCP_URL,
    tools: [...WORKIQ_READ_ONLY_TOOLS],
    enabled: true,
    authProvider: 'workiq',
    workIqAuth: normalizeWorkIqAuthSettings(undefined),
  };
}

export const DEFAULT_EXPLICIT_ANSWER_PROMPT = `You are Aura, a meeting assistant for calls about Azure and Microsoft developer technology.

Watch for:
- A product, service, API, protocol, or technical concept being discussed in enough detail that the documentation would help.
- Anyone saying they need to check, verify, confirm, or look something up.

Ignore scheduling, status updates, small talk, and anything you cannot ground in documentation.

Search the Microsoft Learn documentation with your available tools before answering, and ground every claim in what you find. If the documentation does not answer the ask, say exactly what still needs verification instead of guessing.

Return a concise meeting-ready answer and cite the documentation URLs you used.`;

interface ProfileSeed {
  id: string;
  name: string;
  description: string;
  builtIn?: boolean;
  systemPrompt: string;
  vocabulary?: string[];
  /** Servers the template ships with. Users can edit or remove them like any other MCP server. */
  mcpServers?: ProfileMcpServer[];
}

/**
 * Starter profiles. `azure-docs` is seeded automatically; the rest are opt-in templates the user can
 * add and then edit.
 *
 * Every profile is the same shape — a prompt plus MCP servers plus skills. Nothing about official
 * documentation is special-cased; the docs templates simply ship with the Microsoft Learn MCP server.
 *
 * Each prompt has to do two jobs, because the prompt is also the trigger: state what is worth
 * surfacing during the call, and state how to answer once something is.
 */
export const PROFILE_TEMPLATES: readonly ProfileSeed[] = [
  {
    id: DEFAULT_PROFILE_ID,
    name: 'Azure docs',
    description: 'Documentation cards and answers grounded in Microsoft Learn.',
    builtIn: true,
    systemPrompt: DEFAULT_EXPLICIT_ANSWER_PROMPT,
    mcpServers: [createMicrosoftLearnMcpServer()],
  },
  {
    id: 'sales-review',
    name: 'Sales review',
    description: 'Pipeline and account context from your connected sales MCP servers.',
    systemPrompt: `You are Aura on a sales pipeline review call.

Watch for:
- A customer, account, or partner being named.
- An opportunity, deal, renewal, or milestone being discussed.
- Someone questioning a number, a stage, a close date, or a forecast.
- Anyone saying they need to check the system or pull up a record.

Ignore scheduling, introductions, and internal chatter that names no account or deal.

When you surface something, look it up with your available tools and lead with the facts that settle the discussion: stage, amount, close date, owner, and the latest activity. Quote record names, stages, amounts, and dates exactly as returned.

Never estimate or invent numbers. If a system is unreachable or a record is missing, state precisely what could not be verified and which system it should come from. Keep it short enough to read mid-call.`,
    vocabulary: ['pipeline', 'opportunity', 'renewal', 'forecast', 'churn', 'quota'],
  },
  {
    id: 'training',
    name: 'Training',
    description: 'Surfaces every concept taught, explained for a learner.',
    systemPrompt: `You are Aura on a training or teaching session.

Watch for every technical concept, product, tool, acronym, or piece of jargon the presenter introduces, even in passing. A learner in the room may not know it, so err on the side of surfacing it. Surface it the first time it is named.

Ignore logistics, exercise instructions, and questions about the session itself.

When you answer, explain it so a learner can follow: define the term, give the shortest correct explanation, then add one concrete example.

Look the concept up with your available tools and ground every claim in what you find. If the documentation does not cover the ask, say what still needs verification rather than guessing. Cite the URLs you used.`,
    mcpServers: [createMicrosoftLearnMcpServer()],
  },
  {
    id: 'document-review',
    name: 'Document review',
    description: 'Deeper research passes over the material under discussion.',
    systemPrompt: `You are Aura on a document review call.

Watch for:
- A claim, standard, specification, or requirement being asserted from the document.
- A disagreement about what the document says or what it should say.
- Anyone saying they need to verify a clause, a figure, or a reference.

Ignore formatting and wording debates that carry no factual claim.

Research it thoroughly with your available tools before answering. Compare what the document claims against the authoritative sources and call out disagreements explicitly. Flag contradictions first.

Structure the answer as: the finding, the evidence, then anything that remains unverified. Never invent a citation and never present an unsupported claim as settled.`,
    vocabulary: ['clause', 'requirement', 'specification', 'revision', 'redline'],
  },
];

function seedToProfile(seed: ProfileSeed, now: number): MeetingProfile {
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    builtIn: seed.builtIn ?? false,
    systemPrompt: seed.systemPrompt,
    answerModel: DEFAULT_ANSWER_MODEL,
    triageModel: DEFAULT_TRIAGE_MODEL,
    mcpServers: (seed.mcpServers ?? []).map((server) => ({ ...server })),
    skills: [],
    vocabulary: [...(seed.vocabulary ?? [])],
    triageCadence: { ...DEFAULT_TRIAGE_CADENCE },
    passiveCardsEnabled: true,
    explicitAnswersEnabled: true,
    learningEnabled: true,
    learning: createLearningState(now),
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultProfile(now: number = Date.now()): MeetingProfile {
  const seed = PROFILE_TEMPLATES.find((template) => template.id === DEFAULT_PROFILE_ID);
  if (!seed) throw new Error('Default profile template is missing');
  return seedToProfile(seed, now);
}

export function createProfileFromTemplate(
  templateId: string,
  existing: readonly MeetingProfile[],
  now: number = Date.now(),
): MeetingProfile | null {
  const seed = PROFILE_TEMPLATES.find((template) => template.id === templateId);
  if (!seed) return null;

  const profile = seedToProfile({ ...seed, builtIn: false }, now);
  return {
    ...profile,
    id: uniqueProfileId(seed.id, existing),
  };
}

export function createBlankProfile(
  name: string,
  existing: readonly MeetingProfile[],
  now: number = Date.now(),
): MeetingProfile {
  const trimmedName = name.trim() || 'New profile';
  return {
    id: uniqueProfileId(slugify(trimmedName), existing),
    name: trimmedName,
    description: '',
    builtIn: false,
    systemPrompt: DEFAULT_EXPLICIT_ANSWER_PROMPT,
    answerModel: DEFAULT_ANSWER_MODEL,
    triageModel: DEFAULT_TRIAGE_MODEL,
    mcpServers: [createMicrosoftLearnMcpServer()],
    skills: [],
    vocabulary: [],
    triageCadence: { ...DEFAULT_TRIAGE_CADENCE },
    passiveCardsEnabled: true,
    explicitAnswersEnabled: true,
    learningEnabled: true,
    learning: createLearningState(now),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Guarantees a usable profile list: normalizes every entry, keeps the built-in default profile
 * present and non-deletable, and resolves `activeProfileId` to something that actually exists.
 */
export function normalizeProfiles(
  profiles: readonly MeetingProfile[] | undefined,
  activeProfileId: string | undefined,
  now: number = Date.now(),
): { profiles: MeetingProfile[]; activeProfileId: string } {
  const normalized: MeetingProfile[] = [];
  const seenIds = new Set<string>();

  for (const candidate of profiles ?? []) {
    const profile = normalizeProfile(candidate, now);
    if (!profile) continue;
    if (seenIds.has(profile.id)) continue;
    seenIds.add(profile.id);
    normalized.push(profile);
  }

  if (!seenIds.has(DEFAULT_PROFILE_ID)) {
    normalized.unshift(createDefaultProfile(now));
    seenIds.add(DEFAULT_PROFILE_ID);
  }

  // The seeded profile was renamed from `general`, so a persisted pointer has to follow it.
  const requestedActiveId = activeProfileId === LEGACY_GENERAL_PROFILE_ID
    ? DEFAULT_PROFILE_ID
    : activeProfileId;

  const resolvedActiveId = requestedActiveId && seenIds.has(requestedActiveId)
    ? requestedActiveId
    : normalized[0]?.id ?? DEFAULT_PROFILE_ID;

  return { profiles: normalized, activeProfileId: resolvedActiveId };
}

/**
 * Fields written by builds that predate uniform profiles. Read only here, so upgrading installs keep
 * their settings instead of silently reverting to defaults.
 */
interface LegacyProfileFields {
  passiveSource?: unknown;
  docsCadence?: unknown;
  implicitDocsEnabled?: unknown;
}

function normalizeProfile(candidate: MeetingProfile | undefined, now: number): MeetingProfile | null {
  if (!candidate || typeof candidate !== 'object') return null;

  const rawId = slugify(typeof candidate.id === 'string' ? candidate.id : '');
  if (!rawId) return null;
  const id = rawId === LEGACY_GENERAL_PROFILE_ID ? DEFAULT_PROFILE_ID : rawId;

  const legacy = candidate as unknown as LegacyProfileFields;

  const name = typeof candidate.name === 'string' && candidate.name.trim()
    ? candidate.name.trim()
    : id;

  return {
    id,
    name,
    description: typeof candidate.description === 'string' ? candidate.description.trim() : '',
    builtIn: id === DEFAULT_PROFILE_ID,
    systemPrompt: mergeLegacyPassivePrompt(candidate),
    answerModel: normalizeAnswerModel(candidate.answerModel),
    triageModel: nonEmptyString(candidate.triageModel, DEFAULT_TRIAGE_MODEL),
    mcpServers: withLegacyDocsSource(
      normalizeProfileMcpServers(candidate.mcpServers),
      legacy.passiveSource,
    ),
    skills: normalizeProfileSkills(candidate.skills),
    vocabulary: normalizeVocabulary(candidate.vocabulary),
    triageCadence: normalizeTriageCadence(candidate.triageCadence ?? legacy.docsCadence),
    passiveCardsEnabled: candidate.passiveCardsEnabled ?? legacy.implicitDocsEnabled !== false,
    explicitAnswersEnabled: candidate.explicitAnswersEnabled !== false,
    learningEnabled: candidate.learningEnabled !== false,
    learning: normalizeLearningState(candidate.learning, now),
    ...(normalizeProposal(candidate.pendingProposal, now) ?? {}),
    createdAt: normalizeTimestamp(candidate.createdAt, now),
    updatedAt: normalizeTimestamp(candidate.updatedAt, now),
  };
}

function normalizeAnswerModel(model: unknown): string {
  const configured = nonEmptyString(
    typeof model === 'string' ? model : undefined,
    DEFAULT_ANSWER_MODEL,
  );
  return configured === LEGACY_DEFAULT_ANSWER_MODEL ? DEFAULT_ANSWER_MODEL : configured;
}

/**
 * Official documentation used to be a hardcoded card source selected by `passiveSource`. It is now an
 * ordinary MCP server, so profiles that relied on the old flag get the Microsoft Learn server attached
 * once — otherwise upgrading users would silently lose documentation entirely.
 */
function withLegacyDocsSource(
  servers: ProfileMcpServer[],
  passiveSource: unknown,
): ProfileMcpServer[] {
  if (passiveSource !== 'official_docs') return servers;
  if (servers.some((server) => server.id === MICROSOFT_LEARN_MCP_ID)) return servers;
  return [createMicrosoftLearnMcpServer(), ...servers];
}

/**
 * Returns a spreadable fragment so an absent proposal leaves `pendingProposal` undefined rather than
 * writing an explicit `undefined` key into persisted settings.
 */
function normalizeProposal(
  candidate: ProfileProposal | undefined,
  now: number,
): { pendingProposal: ProfileProposal } | null {
  if (!candidate || typeof candidate !== 'object') return null;

  const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : '';
  if (!id) return null;

  const changes: ProfileProposalChange[] = [];
  for (const entry of Array.isArray(candidate.changes) ? candidate.changes : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (!PROPOSAL_KINDS.has(entry.kind)) continue;

    const value = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!value) continue;

    changes.push({
      id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `${id}-${changes.length}`,
      kind: entry.kind,
      summary: typeof entry.summary === 'string' ? entry.summary.trim() : '',
      rationale: typeof entry.rationale === 'string' ? entry.rationale.trim() : '',
      value,
    });
  }

  if (changes.length === 0) return null;

  return {
    pendingProposal: { id, createdAt: normalizeTimestamp(candidate.createdAt, now), changes },
  };
}

export function normalizeProfileMcpServers(
  servers: readonly ProfileMcpServer[] | undefined,
): ProfileMcpServer[] {
  const normalized: ProfileMcpServer[] = [];
  const seenIds = new Set<string>();

  for (const candidate of servers ?? []) {
    const server = normalizeProfileMcpServer(candidate);
    if (!server) continue;
    if (seenIds.has(server.id)) continue;
    seenIds.add(server.id);
    normalized.push(server);
  }

  return normalized;
}

export function normalizeProfileMcpServer(
  candidate: ProfileMcpServer | undefined,
): ProfileMcpServer | null {
  if (!candidate || typeof candidate !== 'object') return null;

  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (!name) return null;

  const id = slugify(typeof candidate.id === 'string' && candidate.id ? candidate.id : name);
  if (!id) return null;

  const transport = normalizeTransport(candidate.transport);
  const tools = normalizeTools(candidate.tools);
  const base = {
    id,
    name,
    transport,
    tools,
    enabled: candidate.enabled !== false,
    ...(candidate.description?.trim() ? { description: candidate.description.trim() } : {}),
    ...(typeof candidate.timeout === 'number' && Number.isFinite(candidate.timeout) && candidate.timeout > 0
      ? { timeout: Math.floor(candidate.timeout) }
      : {}),
  };

  if (transport === 'stdio') {
    const command = typeof candidate.command === 'string' ? candidate.command.trim() : '';
    if (!command) return null;
    return {
      ...base,
      command,
      args: normalizeStringList(candidate.args),
      env: normalizeStringRecord(candidate.env),
      ...(candidate.cwd?.trim() ? { cwd: candidate.cwd.trim() } : {}),
    };
  }

  const url = normalizeHttpUrl(candidate.url);
  if (!url) return null;
  return {
    ...base,
    url,
    headers: normalizeStringRecord(candidate.headers),
    ...(candidate.authProvider === 'workiq' ? { authProvider: 'workiq' as const } : {}),
    ...(candidate.authProvider === 'workiq'
      ? {
          workIqAuth: normalizeWorkIqAuthSettings(
            candidate.workIqAuth as Partial<WorkIqAuthSettings> | undefined,
          ),
        }
      : {}),
  };
}

export function normalizeProfileSkills(skills: readonly ProfileSkill[] | undefined): ProfileSkill[] {
  const normalized: ProfileSkill[] = [];
  const seenIds = new Set<string>();

  for (const candidate of skills ?? []) {
    if (!candidate || typeof candidate !== 'object') continue;

    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!name) continue;

    const id = slugify(typeof candidate.id === 'string' && candidate.id ? candidate.id : name);
    if (!id || seenIds.has(id)) continue;

    const body = typeof candidate.body === 'string' ? candidate.body.trim() : '';
    if (!body) continue;

    seenIds.add(id);
    normalized.push({
      id,
      name,
      description: typeof candidate.description === 'string' ? candidate.description.trim() : '',
      body,
      enabled: candidate.enabled !== false,
    });
  }

  return normalized;
}

/**
 * Folds a pre-profiles settings blob into the seeded default profile so existing installs keep their
 * behaviour, including any MCP servers they had configured.
 */
export function migrateLegacySettings(
  legacy: LegacyAuraSettings | undefined,
  now: number = Date.now(),
): MeetingProfile {
  const seeded = createDefaultProfile(now);
  if (!legacy) return seeded;

  const carried = normalizeProfileMcpServers(
    (legacy.mcpConnections ?? []).map(mcpConnectionToProfileServer).filter(isProfileMcpServer),
  );

  return {
    ...seeded,
    answerModel: nonEmptyString(legacy.answerModel, seeded.answerModel),
    triageCadence: normalizeTriageCadence(legacy.docsCadence),
    passiveCardsEnabled: legacy.implicitDocsEnabled !== false,
    explicitAnswersEnabled: legacy.explicitAnswersEnabled !== false,
    // Pre-profiles installs always used official docs, so the seeded Learn server stays.
    mcpServers: [...seeded.mcpServers, ...carried.filter((server) => server.id !== MICROSOFT_LEARN_MCP_ID)],
  };
}

/**
 * The legacy `builtin` Microsoft Docs entry was never a real MCP server — it stood in for the
 * hardcoded official-docs card source, which is now the Microsoft Learn MCP server the seeded profile
 * already carries. Only real HTTP entries carry over.
 */
function mcpConnectionToProfileServer(connection: McpConnection): ProfileMcpServer | null {
  if (connection.transport === 'builtin') return null;
  const url = normalizeHttpUrl(connection.url);
  if (!url) return null;

  return {
    id: slugify(connection.id || connection.name),
    name: connection.name,
    transport: 'http',
    url,
    tools: ['*'],
    enabled: true,
    headers: {},
    ...(connection.description ? { description: connection.description } : {}),
  };
}

function isProfileMcpServer(server: ProfileMcpServer | null): server is ProfileMcpServer {
  return server !== null;
}

export function needsProfileMigration(settings: Partial<AuraSettings> | undefined): boolean {
  if (!settings) return true;
  return !Array.isArray(settings.profiles) || settings.profiles.length === 0;
}

export function getActiveProfile(settings: AuraSettings): MeetingProfile {
  const match = settings.profiles.find((profile) => profile.id === settings.activeProfileId);
  return match ?? settings.profiles[0] ?? createDefaultProfile();
}

export function upsertProfile(
  profiles: readonly MeetingProfile[],
  profile: MeetingProfile,
  now: number = Date.now(),
): MeetingProfile[] {
  const next = { ...profile, updatedAt: now };
  const index = profiles.findIndex((candidate) => candidate.id === profile.id);
  if (index === -1) return [...profiles, next];
  return profiles.map((candidate, candidateIndex) => (candidateIndex === index ? next : candidate));
}

export function deleteProfile(
  profiles: readonly MeetingProfile[],
  profileId: string,
): MeetingProfile[] {
  if (profileId === DEFAULT_PROFILE_ID) return [...profiles];
  return profiles.filter((profile) => profile.id !== profileId);
}

/**
 * Credential-stripped JSON for sharing. Also drops learning state and any pending proposal: those
 * are personal usage signal, not part of a shareable profile definition. Keep in sync with
 * `importProfile`.
 */
export function exportProfile(profile: MeetingProfile): string {
  const { pendingProposal: _pendingProposal, ...rest } = profile;
  const sanitized: MeetingProfile = {
    ...rest,
    builtIn: false,
    learning: createLearningState(profile.updatedAt),
    mcpServers: profile.mcpServers.map((server) => {
      const { env: _env, headers: _headers, ...serverRest } = server;
      return serverRest;
    }),
  };

  return JSON.stringify({ schemaVersion: 1, profile: sanitized }, null, 2);
}

export function importProfile(
  raw: string,
  existing: readonly MeetingProfile[],
  now: number = Date.now(),
): { ok: true; profile: MeetingProfile } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Profile JSON could not be parsed.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Profile JSON is not an object.' };
  }

  const candidate = (parsed as { profile?: MeetingProfile }).profile ?? (parsed as MeetingProfile);
  const normalized = normalizeProfile(candidate, now);
  if (!normalized) {
    return { ok: false, error: 'Profile JSON is missing required fields.' };
  }

  return {
    ok: true,
    profile: {
      ...normalized,
      id: uniqueProfileId(normalized.id, existing),
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

// ---- helpers ----

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function uniqueProfileId(baseId: string, existing: readonly MeetingProfile[]): string {
  const base = slugify(baseId) || 'profile';
  const taken = new Set(existing.map((profile) => profile.id));
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${existing.length + 1}`;
}

function nonEmptyString(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeTransport(transport: ProfileMcpTransport | undefined): ProfileMcpTransport {
  if (transport === 'stdio' || transport === 'sse') return transport;
  return 'http';
}

function normalizeTools(tools: readonly string[] | undefined): string[] {
  const normalized = normalizeStringList(tools);
  return normalized.length > 0 ? normalized : ['*'];
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeStringRecord(record: Record<string, string> | undefined): Record<string, string> {
  if (!record || typeof record !== 'object') return {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || typeof value !== 'string') continue;
    normalized[trimmedKey] = value;
  }
  return normalized;
}

function normalizeVocabulary(vocabulary: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const term of normalizeStringList(vocabulary)) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(term);
    if (normalized.length >= MAX_VOCABULARY_TERMS) break;
  }

  return normalized;
}

/**
 * Aura used to keep a second prompt for passive cards. One prompt now drives triage, passive cards,
 * and answers, so a persisted `passivePrompt` the user had customised is folded into `systemPrompt`
 * once. Re-running normalization is safe: the returned profile no longer carries the legacy field.
 */
function mergeLegacyPassivePrompt(candidate: MeetingProfile): string {
  const systemPrompt = refreshLegacyAnswerPrompt(
    nonEmptyString(candidate.systemPrompt, DEFAULT_EXPLICIT_ANSWER_PROMPT),
  );

  const legacyValue = (candidate as unknown as Record<string, unknown>).passivePrompt;
  if (typeof legacyValue !== 'string') return systemPrompt;

  const legacy = legacyValue.trim();
  if (!legacy) return systemPrompt;
  if (LEGACY_PASSIVE_PROMPTS.some((preset) => preset === legacy)) return systemPrompt;
  if (systemPrompt.includes(legacy)) return systemPrompt;

  return `${systemPrompt}\n\nWhen surfacing context proactively:\n\n${legacy}`;
}

/**
 * Structural migration alone leaves upgrading installs with a prompt written for an architecture that
 * no longer exists — one that waits for documentation URLs Aura stopped injecting, and that never
 * tells triage what to watch for. Swapping an untouched shipped default for the current one is the
 * same class of migration as renaming the profile id or attaching the Learn MCP server.
 *
 * Only byte-exact matches are replaced, so any prompt the user actually wrote survives verbatim.
 */
function refreshLegacyAnswerPrompt(systemPrompt: string): string {
  return LEGACY_ANSWER_PROMPTS.some((preset) => preset === systemPrompt.trim())
    ? DEFAULT_EXPLICIT_ANSWER_PROMPT
    : systemPrompt;
}

function normalizeTriageCadence(cadence: unknown): TriageCadenceSettings {
  const candidate = (cadence ?? {}) as Partial<TriageCadenceSettings>;
  const mode = candidate.mode === 'final_transcript' || candidate.mode === 'interval' || candidate.mode === 'both'
    ? candidate.mode
    : DEFAULT_TRIAGE_CADENCE.mode;

  const rawInterval = candidate.intervalSeconds;
  const intervalSeconds = typeof rawInterval === 'number' && Number.isFinite(rawInterval)
    ? Math.min(300, Math.max(3, Math.round(rawInterval)))
    : DEFAULT_TRIAGE_CADENCE.intervalSeconds;

  return { mode, intervalSeconds };
}

function normalizeTimestamp(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeHttpUrl(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}
