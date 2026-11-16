import type { DecisionGateSettings, MeetingProfile } from '../shared/types.js';
import {
  buildDecisionGateRequest,
  buildDecisionGateUrl,
  isDecisionGateConfigured,
  judgeDecisionGate,
  parseDecisionGateResponse,
  type DecisionGateKind,
  type DecisionGateProbabilities,
  type DecisionGateRequest,
  type DecisionGateVerdict,
} from '../shared/decision-gate.js';
import {
  AZURE_COGNITIVE_SERVICES_SCOPE,
  defaultAzureCredential,
  type TokenProvider,
} from './azure-credential.js';

/**
 * The gate sits in front of every triage tick, so it must never be what makes a card late. Past this
 * it gives up and the LLM decides, exactly as it did before the gate existed.
 */
const DECISION_GATE_TIMEOUT_MS = 5_000;
/** After this many failures in a row the gate stops trying for a while instead of taxing every tick. */
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 120_000;
const MAX_ERROR_DETAIL_LENGTH = 200;
/** A cached token is replaced this long before it expires, so a call never carries one about to lapse. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export type DecisionGateSkipReason = 'disabled' | 'not_configured' | 'no_questions' | 'cooling_down';

/**
 * Only `decided` carries a verdict. `skipped` and `failed` both mean "the gate has no opinion", and the
 * caller treats them identically: run the LLM.
 */
export type DecisionGateResult =
  | { status: 'skipped'; reason: DecisionGateSkipReason }
  | {
    status: 'decided';
    verdict: DecisionGateVerdict;
    probabilities: DecisionGateProbabilities;
    ms: number;
  }
  | { status: 'failed'; error: string; ms: number };

export interface DecisionGateInput {
  profile: MeetingProfile;
  transcript: string;
  recentTopics: readonly string[];
}

interface DecisionGateDependencies {
  credential?: TokenProvider;
  fetchFn?: typeof fetch;
  now?: () => number;
}

let consecutiveFailures = 0;
let cooldownUntil = 0;

interface CachedToken {
  token: string;
  expiresOnTimestamp: number;
}

/**
 * Keyed by credential so an injected test credential never shares a token with the real one.
 *
 * This cache is what makes the gate fast. A credential chain that ends in the Azure CLI starts a process
 * on every `getToken` call, ~1.5s each, which is far longer than the model takes to decide. Measured
 * against a real deployment, that one call turned a ~0.3s decision into ~1.7s.
 */
const tokenCache = new WeakMap<TokenProvider, CachedToken>();
/** Concurrent ticks share one token request instead of each starting their own. */
const tokenRequests = new WeakMap<TokenProvider, Promise<string>>();

/**
 * Asks Microsoft-Decision-1 whether the live transcript holds anything the active profile wants surfaced.
 * Never throws: every problem comes back as `failed` so it cannot reach the transcript path.
 */
export async function runDecisionGate(
  settings: DecisionGateSettings,
  input: DecisionGateInput,
  dependencies: DecisionGateDependencies = {},
): Promise<DecisionGateResult> {
  if (!settings.enabled) return { status: 'skipped', reason: 'disabled' };

  const url = isDecisionGateConfigured(settings) ? buildDecisionGateUrl(settings.endpoint) : null;
  if (!url) return { status: 'skipped', reason: 'not_configured' };

  const now = dependencies.now ?? Date.now;
  if (now() < cooldownUntil) return { status: 'skipped', reason: 'cooling_down' };

  const request = buildDecisionGateRequest({
    deployment: settings.deployment,
    profile: input.profile,
    transcript: input.transcript,
    recentTopics: input.recentTopics,
  });
  if (!request) return { status: 'skipped', reason: 'no_questions' };

  const kinds = Object.keys(request.questions) as DecisionGateKind[];
  const startedAt = now();

  try {
    const payload = await postDecision(url, request, dependencies, now);
    const probabilities = parseDecisionGateResponse(payload, kinds);
    if (!probabilities) {
      throw new Error('The response did not contain a usable answer for every question.');
    }

    consecutiveFailures = 0;
    return {
      status: 'decided',
      verdict: judgeDecisionGate(probabilities),
      probabilities,
      ms: now() - startedAt,
    };
  } catch (err: unknown) {
    noteFailure(err, now());
    return { status: 'failed', error: describeError(err), ms: now() - startedAt };
  }
}

/**
 * Fetches a token ahead of the first tick, and keeps it cached for the ticks that follow. Credential
 * discovery can take seconds the first time, and without this the first triage of a meeting would
 * spend its whole timeout on it.
 */
export function warmDecisionGate(
  settings: DecisionGateSettings,
  dependencies: Pick<DecisionGateDependencies, 'credential'> = {},
): void {
  if (!isDecisionGateConfigured(settings)) return;

  const credential = dependencies.credential ?? defaultAzureCredential;
  getAccessToken(credential, Date.now).catch((err: unknown) => {
    console.warn('[Decision gate] Could not get Azure credentials ahead of time:', describeError(err));
  });
}

/** Forgets earlier failures, so fixing the endpoint in Settings takes effect without waiting out a cooldown. */
export function resetDecisionGateFailures(): void {
  consecutiveFailures = 0;
  cooldownUntil = 0;
}

function getAccessToken(credential: TokenProvider, now: () => number): Promise<string> {
  const cached = tokenCache.get(credential);
  if (cached && cached.expiresOnTimestamp - now() > TOKEN_REFRESH_MARGIN_MS) {
    return Promise.resolve(cached.token);
  }

  const pending = tokenRequests.get(credential);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(() => credential.getToken(AZURE_COGNITIVE_SERVICES_SCOPE))
    .then((result) => {
      if (!result?.token) throw new Error('Azure authentication did not return an access token.');
      // A credential that reports no expiry cannot be cached safely, so it is asked again next time.
      if (typeof result.expiresOnTimestamp === 'number') {
        tokenCache.set(credential, { token: result.token, expiresOnTimestamp: result.expiresOnTimestamp });
      }
      return result.token;
    })
    .finally(() => {
      tokenRequests.delete(credential);
    });

  tokenRequests.set(credential, request);
  return request;
}

async function postDecision(
  url: string,
  body: DecisionGateRequest,
  dependencies: DecisionGateDependencies,
  now: () => number,
): Promise<unknown> {
  const credential = dependencies.credential ?? defaultAzureCredential;
  const fetchFn = dependencies.fetchFn ?? fetch;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DECISION_GATE_TIMEOUT_MS);

  try {
    // Token acquisition is not abortable, so it is raced against the same deadline as the request. If it
    // loses, the request carries on in the background and the next tick finds the token already cached.
    const token = await abortable(getAccessToken(credential, now), controller.signal);

    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${await readErrorDetail(response)}`);
    }

    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('timed out'));
    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim();
    return text ? `: ${text.slice(0, MAX_ERROR_DETAIL_LENGTH)}` : '';
  } catch {
    return '';
  }
}

/**
 * Logs the first failure of a streak and the moment the gate backs off, not every tick: at a 1.2s
 * cadence an unreachable endpoint would otherwise bury the log.
 */
function noteFailure(err: unknown, nowMs: number): void {
  consecutiveFailures += 1;

  if (consecutiveFailures === 1) {
    console.warn(`[Decision gate] Request failed, so the LLM decides this tick: ${describeError(err)}`);
  }

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    consecutiveFailures = 0;
    cooldownUntil = nowMs + FAILURE_COOLDOWN_MS;
    console.warn(
      `[Decision gate] ${MAX_CONSECUTIVE_FAILURES} failures in a row; the LLM decides every tick for the next ${FAILURE_COOLDOWN_MS / 1000}s.`,
    );
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' ? 'timed out' : err.message;
  return String(err);
}
