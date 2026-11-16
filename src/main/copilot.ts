import type { CopilotClient as CopilotClientInstance, CopilotClientOptions } from '@github/copilot-sdk' with { "resolution-mode": "import" };
import type { AgentMcpServerConfig, MeetingProfile } from '../shared/types.js';
import { buildAgentSessionConfig } from '../shared/profile-session-config.js';
import { ASSISTANT_DELTA_EVENT, readAssistantDelta } from '../shared/assistant-stream.js';
import { isModelUnavailableError, readUnavailableModelId } from '../shared/model-availability.js';
import { stageProfileSkills } from './profile-skills.js';
import { hydrateWorkIqMcpServers } from './workiq-auth.js';

type CopilotSdk = typeof import('@github/copilot-sdk', { with: { "resolution-mode": "import" } });

/** Effort levels the SDK accepts. Only forwarded to models that advertise support. */
export type ReasoningEffortLevel = 'low' | 'medium' | 'high' | 'xhigh';

interface ModelCapability {
  /** Passing `reasoningEffort` to a model that lacks it fails session creation outright. */
  supportsReasoningEffort: boolean;
  efforts: string[];
}

let sdkModule: CopilotSdk | null = null;
let client: CopilotClientInstance | null = null;
let clientStarting: Promise<void> | null = null;
let availableModels: string[] = [];
const modelCapabilities = new Map<string, ModelCapability>();
/**
 * Models the backend rejected at `session.create` despite advertising them. Remembered so the next
 * call skips them outright — with triage now able to fire every 1.2s, re-learning this per call would
 * put a guaranteed failed round-trip in front of every card.
 */
const unusableModels = new Set<string>();

async function getSdk(): Promise<CopilotSdk> {
  if (!sdkModule) {
    sdkModule = await import('@github/copilot-sdk') as CopilotSdk;
  }
  return sdkModule;
}

async function getClient(): Promise<CopilotClientInstance> {
  if (client) return client;
  if (clientStarting) {
    await clientStarting;
    if (!client) throw new Error('Copilot client failed to start');
    return client;
  }

  const sdk = await getSdk();
  const path = await import('path');
  const nativeCli = path.join(
    __dirname,
    '..',
    '..',
    'node_modules',
    '@github',
    `copilot-${process.platform}-${process.arch}`,
    'copilot.exe',
  );

  const clientOptions: CopilotClientOptions = {
    logLevel: 'warning',
    cliPath: nativeCli,
  };
  const nextClient = new sdk.CopilotClient(clientOptions);

  clientStarting = nextClient.start();
  await clientStarting;
  client = nextClient;
  clientStarting = null;

  try {
    const models = await nextClient.listModels();
    availableModels = models
      .map((model) => model.id ?? model.name ?? '')
      .filter((modelId) => modelId.length > 0)
      // The probe finishes after the first triage, so without this filter a model already proven dead
      // at session.create gets re-advertised and every profile-level guard starts trusting it again.
      .filter((modelId) => !unusableModels.has(modelId));
    recordModelCapabilities(models);
    console.log('[Copilot SDK] Available models:', availableModels.length);
  } catch (err) {
    console.warn('[Copilot SDK] Could not list models:', err);
  }

  console.log('[Copilot SDK] Client started');
  return nextClient;
}

function recordModelCapabilities(models: readonly unknown[]): void {
  modelCapabilities.clear();

  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as {
      id?: string;
      name?: string;
      supportedReasoningEfforts?: unknown;
      capabilities?: { supports?: { reasoningEffort?: unknown } };
    };

    const modelId = model.id ?? model.name;
    if (!modelId) continue;

    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.filter((effort): effort is string => typeof effort === 'string')
      : [];

    modelCapabilities.set(modelId, {
      supportsReasoningEffort: model.capabilities?.supports?.reasoningEffort === true,
      efforts,
    });
  }
}

/**
 * Returns the effort level only when the target model actually supports it. The SDK rejects
 * `session.create` outright for models without reasoning-effort support, so an unguarded option
 * would turn a latency tweak into a hard failure the moment someone picks a different model.
 */
function resolveReasoningEffort(
  model: string | undefined,
  requested: ReasoningEffortLevel | undefined,
): ReasoningEffortLevel | null {
  if (!requested || !model) return null;

  const capability = modelCapabilities.get(model);
  if (!capability?.supportsReasoningEffort) return null;
  if (capability.efforts.length > 0 && !capability.efforts.includes(requested)) return null;

  return requested;
}

export function getAvailableModels(): string[] {
  return availableModels;
}

export interface AgentCompletionOptions {
  model?: string;
  /** Profile MCP servers made available to this session only. */
  mcpServers?: Record<string, AgentMcpServerConfig>;
  /** Parent directories containing staged `SKILL.md` folders. */
  skillDirectories?: string[];
  timeoutMs?: number;
  /** Dropped silently when the chosen model does not advertise reasoning-effort support. */
  reasoningEffort?: ReasoningEffortLevel;
  /**
   * Receives the answer so far as it is generated. Supplying it turns on SDK streaming, which lets a
   * card paint partial text instead of holding a spinner until the whole answer lands.
   */
  onPartial?: (textSoFar: string) => void;
}

export async function agentCompletion(
  systemPrompt: string,
  userMessage: string,
  options: AgentCompletionOptions = {},
): Promise<string> {
  const copilotClient = await getClient();
  const sdk = await getSdk();

  const hasMcpServers = Boolean(options.mcpServers && Object.keys(options.mcpServers).length > 0);
  const hasSkills = Boolean(options.skillDirectories && options.skillDirectories.length > 0);
  const reasoningEffort = resolveReasoningEffort(options.model, options.reasoningEffort);
  const wantsPartials = typeof options.onPartial === 'function';

  const session = await createSessionWithModelFallback(
    copilotClient,
    {
      systemMessage: {
        mode: 'replace',
        content: systemPrompt,
      },
      // Stay hermetic: never inherit MCP servers or skills from the working directory.
      enableConfigDiscovery: false,
      ...(hasMcpServers ? { mcpServers: options.mcpServers } : {}),
      ...(hasSkills ? { skillDirectories: options.skillDirectories } : {}),
      ...(wantsPartials ? { streaming: true } : {}),
      onPermissionRequest: sdk.approveAll,
    },
    options.model,
    reasoningEffort,
  );

  const unsubscribe = wantsPartials ? subscribeToPartials(session, options.onPartial!) : null;

  try {
    const result = await session.sendAndWait({ prompt: userMessage }, options.timeoutMs ?? 300_000);
    return result?.data.content ?? '';
  } finally {
    unsubscribe?.();
    await session.disconnect().catch(() => {});
  }
}

type StreamingSession = Awaited<ReturnType<CopilotClientInstance['createSession']>>;
type SessionConfigArg = Parameters<CopilotClientInstance['createSession']>[0];

/**
 * Creates a session, surviving a model the backend advertises but will not run.
 *
 * The retry drops the model override entirely rather than guessing a replacement id, because the
 * advertised list has already proven unreliable — letting the SDK pick its own default is the only
 * option that cannot name a second bad model. `reasoningEffort` goes with it, since it was resolved
 * against the rejected model and an unsupported effort fails session creation outright.
 */
async function createSessionWithModelFallback(
  copilotClient: CopilotClientInstance,
  baseConfig: SessionConfigArg,
  requestedModel: string | undefined,
  reasoningEffort: ReasoningEffortLevel | null,
): Promise<StreamingSession> {
  // Already known bad, so skip the round-trip instead of paying it before every card.
  if (requestedModel && unusableModels.has(requestedModel)) {
    return copilotClient.createSession({ ...baseConfig });
  }

  try {
    return await copilotClient.createSession({
      ...baseConfig,
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  } catch (err) {
    if (!requestedModel || !isModelUnavailableError(err)) throw err;

    const rejected = readUnavailableModelId(err) ?? requestedModel;
    markModelUnusable(rejected);
    if (rejected !== requestedModel) markModelUnusable(requestedModel);

    console.warn(
      `[Copilot SDK] Model "${rejected}" is advertised but unusable; using the default model instead.`,
    );

    return copilotClient.createSession({ ...baseConfig });
  }
}

function markModelUnusable(modelId: string): void {
  unusableModels.add(modelId);
  // Prune the advertised list too, so profile-level guards stop trusting an id we know is dead.
  availableModels = availableModels.filter((candidate) => candidate !== modelId);
}

/**
 * Streams the assistant's answer as it is written so a card can paint before the turn finishes.
 *
 * The event name and payload shape are subtle enough to live in their own tested module; see
 * `readAssistantDelta` for why `assistant.streaming_delta` is the wrong channel despite its name.
 */
function subscribeToPartials(
  session: StreamingSession,
  onPartial: (textSoFar: string) => void,
): () => void {
  let accumulated = '';

  const handle = (event: unknown): void => {
    const chunk = readAssistantDelta(event);
    if (chunk === null) return;

    accumulated += chunk;
    onPartial(accumulated);
  };

  const unsubscribers = [session.on(ASSISTANT_DELTA_EVENT, handle)];

  return () => {
    for (const off of unsubscribers) {
      try {
        off();
      } catch {
        // Unsubscribing a session that already tore down is not an error worth surfacing.
      }
    }
  };
}

/**
 * Runs a completion with the active meeting profile's model, MCP servers, and skills wired into the
 * session. Skills are staged to disk first because the SDK takes directory paths.
 */
export async function profileAgentCompletion(
  profile: MeetingProfile,
  userMessage: string,
  overrides: {
    systemPrompt?: string;
    model?: string;
    timeoutMs?: number;
    reasoningEffort?: ReasoningEffortLevel;
    onPartial?: (textSoFar: string) => void;
  } = {},
): Promise<string> {
  const skillsDirectory = stageProfileSkills(profile);
  const sessionConfig = buildAgentSessionConfig(profile, {
    ...(skillsDirectory ? { skillsDirectory } : {}),
    ...(overrides.systemPrompt ? { systemPrompt: overrides.systemPrompt } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
  });
  const mcpServers = await hydrateWorkIqMcpServers(profile, sessionConfig.mcpServers);

  return agentCompletion(sessionConfig.systemPrompt, userMessage, {
    model: sessionConfig.model,
    mcpServers,
    skillDirectories: sessionConfig.skillDirectories,
    ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
    ...(overrides.onPartial ? { onPartial: overrides.onPartial } : {}),
  });
}

export async function stopCopilotClient(): Promise<void> {
  if (client) {
    const errors = await client.stop();
    if (errors.length > 0) {
      console.warn('[Copilot SDK] Client stopped with cleanup errors:', errors);
    }
    client = null;
  }
}
