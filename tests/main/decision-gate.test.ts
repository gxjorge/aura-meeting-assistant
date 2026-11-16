import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfile } from '../../src/shared/meeting-profiles.js';
import type { DecisionGateSettings } from '../../src/shared/types.js';
import {
  resetDecisionGateFailures,
  runDecisionGate,
  warmDecisionGate,
  type DecisionGateInput,
} from '../../src/main/decision-gate.js';

const SETTINGS: DecisionGateSettings = {
  enabled: true,
  endpoint: 'https://your-resource.services.ai.azure.com/',
  deployment: 'my-decision',
};

const INPUT: DecisionGateInput = {
  profile: createDefaultProfile(),
  transcript: 'We should check whether hosted agents are available in West Europe.',
  recentTopics: ['hosted agents'],
};

const SCOPE = 'https://cognitiveservices.azure.com/.default';

/** A credential that, like most real ones, reports when its token expires. Omit `expiresInMs` for one that does not. */
function credential(expiresInMs?: number) {
  return {
    getToken: vi.fn(async () => ({
      token: 'test-token',
      ...(expiresInMs === undefined ? {} : { expiresOnTimestamp: Date.now() + expiresInMs }),
    })),
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function answers(passive: number, answer: number) {
  return {
    model: 'microsoft-decision-1',
    answers: {
      passive: { type: 'noul', noul: passive },
      answer: { type: 'noul', noul: answer },
    },
    usage: { input_tokens: 120, output_tokens: 0 },
  };
}

describe('decision gate', () => {
  beforeEach(() => {
    resetDecisionGateFailures();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('when it has nothing to do', () => {
    it.each([
      ['switched off', { ...SETTINGS, enabled: false }, 'disabled'],
      ['given no endpoint', { ...SETTINGS, endpoint: '' }, 'not_configured'],
      ['given an insecure endpoint', { ...SETTINGS, endpoint: 'http://example.test' }, 'not_configured'],
      ['given no deployment', { ...SETTINGS, deployment: '  ' }, 'not_configured'],
    ] as const)('skips without any network call when %s', async (_name, settings, reason) => {
      const fetchFn = vi.fn<typeof fetch>();
      const creds = credential();

      const result = await runDecisionGate(settings, INPUT, { credential: creds, fetchFn });

      expect(result).toEqual({ status: 'skipped', reason });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(creds.getToken).not.toHaveBeenCalled();
    });

    it('skips when the profile has no card kind enabled', async () => {
      const fetchFn = vi.fn<typeof fetch>();
      const profile = { ...INPUT.profile, passiveCardsEnabled: false, explicitAnswersEnabled: false };

      const result = await runDecisionGate(SETTINGS, { ...INPUT, profile }, { credential: credential(), fetchFn });

      expect(result).toEqual({ status: 'skipped', reason: 'no_questions' });
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('asking the model', () => {
    it('posts the profile-driven request to the deployment with an Entra bearer token', async () => {
      const requests: { url: string; init?: RequestInit }[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), init });
        return json(answers(0.91, 0.04));
      };
      const creds = credential();

      const result = await runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn });

      expect(result).toMatchObject({
        status: 'decided',
        verdict: 'pass',
        probabilities: { passive: 0.91, answer: 0.04 },
      });
      expect(creds.getToken).toHaveBeenCalledWith(SCOPE);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(
        'https://your-resource.services.ai.azure.com/providers/microsoft/v1/systemone',
      );
      expect(requests[0]!.init?.method).toBe('POST');
      expect(requests[0]!.init?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      });

      const body = JSON.parse(String(requests[0]!.init?.body)) as {
        model: string;
        state: { profile_instructions: string; already_surfaced: string[]; just_said: string };
        questions: Record<string, { type: string }>;
      };
      expect(body.model).toBe('my-decision');
      expect(body.state.profile_instructions).toBe(INPUT.profile.systemPrompt.trim());
      expect(body.state.already_surfaced).toEqual(['hosted agents']);
      expect(body.state.just_said).toContain('hosted agents are available in West Europe');
      expect(Object.keys(body.questions)).toEqual(['passive', 'answer']);
    });

    it('declines when every question is clearly answered no', async () => {
      const fetchFn: typeof fetch = async () => json(answers(0.02, 0.01));

      const result = await runDecisionGate(SETTINGS, INPUT, { credential: credential(), fetchFn });

      expect(result).toMatchObject({ status: 'decided', verdict: 'decline' });
    });

    it('passes when either question is probably yes', async () => {
      const fetchFn: typeof fetch = async () => json(answers(0.03, 0.8));

      const result = await runDecisionGate(SETTINGS, INPUT, { credential: credential(), fetchFn });

      expect(result).toMatchObject({ status: 'decided', verdict: 'pass' });
    });

    it('asks only about the kinds the profile has enabled', async () => {
      let asked: string[] = [];
      const fetchFn: typeof fetch = async (_input, init) => {
        asked = Object.keys((JSON.parse(String(init?.body)) as { questions: object }).questions);
        return json({ answers: { passive: { type: 'noul', noul: 0.6 } } });
      };
      const profile = { ...INPUT.profile, explicitAnswersEnabled: false };

      const result = await runDecisionGate(SETTINGS, { ...INPUT, profile }, { credential: credential(), fetchFn });

      expect(asked).toEqual(['passive']);
      expect(result).toMatchObject({ status: 'decided', verdict: 'pass', probabilities: { passive: 0.6 } });
    });
  });

  describe('when something goes wrong, it fails open instead of throwing', () => {
    it.each([
      [
        'an HTTP 404 that carries the service message',
        async () => new Response('{"error":{"code":"DeploymentNotFound"}}', { status: 404 }),
        /HTTP 404.*DeploymentNotFound/,
      ],
      ['an HTTP 429', async () => new Response('slow down', { status: 429 }), /HTTP 429/],
      ['a response that is not JSON', async () => new Response('<html>nope</html>', { status: 200 }), /JSON|Unexpected/i],
      [
        'an answer missing for one question',
        async () => json({ answers: { passive: { type: 'noul', noul: 0.01 } } }),
        /usable answer/,
      ],
      [
        'a refusal in place of a number',
        async () => json({ answers: { passive: { type: 'refusal' }, answer: { type: 'noul', noul: 0.01 } } }),
        /usable answer/,
      ],
      [
        'a network error',
        async () => {
          throw new TypeError('fetch failed');
        },
        /fetch failed/,
      ],
    ] as const)('reports %s as a failure', async (_name, respond, message) => {
      const result = await runDecisionGate(SETTINGS, INPUT, {
        credential: credential(),
        fetchFn: respond as unknown as typeof fetch,
      });

      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error('Expected a failure');
      expect(result.error).toMatch(message);
    });

    it('reports a credential problem as a failure and never calls the endpoint', async () => {
      const fetchFn = vi.fn<typeof fetch>();
      const broken = { getToken: vi.fn(async () => { throw new Error('az login required'); }) };

      const result = await runDecisionGate(SETTINGS, INPUT, { credential: broken, fetchFn });

      expect(result).toMatchObject({ status: 'failed', error: 'az login required' });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('treats an empty token as a failure', async () => {
      const empty = { getToken: vi.fn(async () => null) };

      const result = await runDecisionGate(SETTINGS, INPUT, { credential: empty, fetchFn: vi.fn<typeof fetch>() });

      expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('access token') });
    });

    it('gives up after five seconds when the endpoint hangs, so it cannot hold up a card', async () => {
      vi.useFakeTimers();
      const hangingFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });

      const pending = runDecisionGate(SETTINGS, INPUT, { credential: credential(), fetchFn: hangingFetch });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await pending).toMatchObject({ status: 'failed', error: 'timed out' });
    });

    it('also gives up when getting a token hangs', async () => {
      vi.useFakeTimers();
      const stuck = { getToken: vi.fn(() => new Promise<never>(() => {})) };
      const fetchFn = vi.fn<typeof fetch>();

      const pending = runDecisionGate(SETTINGS, INPUT, { credential: stuck, fetchFn });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await pending).toMatchObject({ status: 'failed', error: 'timed out' });
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('backing off', () => {
    const failing = () => vi.fn<typeof fetch>(async () => new Response('boom', { status: 500 }));

    it('stops asking for two minutes after three failures in a row, then tries again', async () => {
      let clock = 1_000_000;
      const now = () => clock;
      const fetchFn = failing();
      const deps = { credential: credential(), fetchFn, now };

      for (let attempt = 0; attempt < 3; attempt += 1) await runDecisionGate(SETTINGS, INPUT, deps);
      expect(fetchFn).toHaveBeenCalledTimes(3);

      expect(await runDecisionGate(SETTINGS, INPUT, deps)).toEqual({ status: 'skipped', reason: 'cooling_down' });
      expect(fetchFn).toHaveBeenCalledTimes(3);

      clock += 120_001;
      await runDecisionGate(SETTINGS, INPUT, deps);
      expect(fetchFn).toHaveBeenCalledTimes(4);
    });

    it('does not back off when a success breaks up the failures', async () => {
      const fetchFn = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(json(answers(0.5, 0.5)))
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValue(json(answers(0.5, 0.5)));
      const deps = { credential: credential(), fetchFn };

      for (let attempt = 0; attempt < 5; attempt += 1) await runDecisionGate(SETTINGS, INPUT, deps);
      const next = await runDecisionGate(SETTINGS, INPUT, deps);

      expect(next).toMatchObject({ status: 'decided' });
      expect(fetchFn).toHaveBeenCalledTimes(6);
    });

    it('forgets a cooldown as soon as settings change', async () => {
      const fetchFn = failing();
      const deps = { credential: credential(), fetchFn };
      for (let attempt = 0; attempt < 3; attempt += 1) await runDecisionGate(SETTINGS, INPUT, deps);
      expect(await runDecisionGate(SETTINGS, INPUT, deps)).toMatchObject({ reason: 'cooling_down' });

      resetDecisionGateFailures();
      await runDecisionGate(SETTINGS, INPUT, deps);

      expect(fetchFn).toHaveBeenCalledTimes(4);
    });
  });

  describe('azure tokens', () => {
    // A credential chain ending in the Azure CLI starts a process per call (~1.5s), which is longer than
    // the model takes to decide, so the gate keeps the token for as long as it is good.
    const okFetch = () => vi.fn<typeof fetch>(async () => json(answers(0.02, 0.01)));

    it('reuses one token across ticks instead of asking the credential every time', async () => {
      const creds = credential(60 * 60_000);
      const fetchFn = okFetch();

      for (let tick = 0; tick < 3; tick += 1) {
        await runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn });
      }

      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(creds.getToken).toHaveBeenCalledTimes(1);
    });

    it('replaces the token once it is within five minutes of expiring', async () => {
      let clock = 5_000_000;
      let issued = 0;
      const creds = {
        getToken: vi.fn(async () => ({ token: `token-${(issued += 1)}`, expiresOnTimestamp: clock + 10 * 60_000 })),
      };
      const seen: string[] = [];
      const fetchFn: typeof fetch = async (_input, init) => {
        seen.push(String((init?.headers as Record<string, string>).Authorization));
        return json(answers(0.02, 0.01));
      };
      const deps = { credential: creds, fetchFn, now: () => clock };

      await runDecisionGate(SETTINGS, INPUT, deps);
      clock += 4 * 60_000; // six minutes left: still good
      await runDecisionGate(SETTINGS, INPUT, deps);
      clock += 2 * 60_000; // four minutes left: too close
      await runDecisionGate(SETTINGS, INPUT, deps);

      expect(creds.getToken).toHaveBeenCalledTimes(2);
      expect(seen).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-2']);
    });

    it('shares one token request between ticks that start together', async () => {
      const creds = credential(60 * 60_000);
      const fetchFn = okFetch();

      await Promise.all([
        runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn }),
        runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn }),
      ]);

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(creds.getToken).toHaveBeenCalledTimes(1);
    });

    it('asks again every time for a credential that reports no expiry, since it cannot be cached safely', async () => {
      const creds = credential();
      const fetchFn = okFetch();

      await runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn });
      await runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn });

      expect(creds.getToken).toHaveBeenCalledTimes(2);
    });

    it('does not remember a failed token request, so the next tick tries again', async () => {
      const creds = {
        getToken: vi.fn()
          .mockRejectedValueOnce(new Error('az login required'))
          .mockResolvedValue({ token: 'test-token', expiresOnTimestamp: Date.now() + 60 * 60_000 }),
      };
      const fetchFn = okFetch();

      const failed = await runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn });
      const recovered = await runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn });

      expect(failed).toMatchObject({ status: 'failed', error: 'az login required' });
      expect(recovered).toMatchObject({ status: 'decided' });
    });

    it('lets the warm-up at the start of a meeting spare the first tick its own token request', async () => {
      const creds = credential(60 * 60_000);
      const fetchFn = okFetch();

      warmDecisionGate(SETTINGS, { credential: creds });
      await runDecisionGate(SETTINGS, INPUT, { credential: creds, fetchFn });

      expect(creds.getToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('warming up', () => {
    it('fetches a token ahead of time only when the gate is configured', async () => {
      const creds = credential();

      warmDecisionGate({ ...SETTINGS, endpoint: '' }, { credential: creds });
      warmDecisionGate({ ...SETTINGS, enabled: false }, { credential: creds });
      await Promise.resolve();
      expect(creds.getToken).not.toHaveBeenCalled();

      warmDecisionGate(SETTINGS, { credential: creds });
      await vi.waitFor(() => expect(creds.getToken).toHaveBeenCalledWith(SCOPE));
    });

    it('swallows a failed warm-up, since the first real tick will report it', async () => {
      const broken = { getToken: vi.fn(async () => { throw new Error('no credentials'); }) };

      expect(() => warmDecisionGate(SETTINGS, { credential: broken })).not.toThrow();
      await vi.waitFor(() => expect(broken.getToken).toHaveBeenCalled());
    });
  });
});
