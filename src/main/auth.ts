import { exec } from 'child_process';
import { promisify } from 'util';
import type { AuthStatus } from '../shared/types.js';

const execAsync = promisify(exec);

let cachedToken: string | null = null;
let cachedStatus: AuthStatus | null = null;
let validationInProgress: Promise<AuthStatus> | null = null;

export async function getGhToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  try {
    const { stdout } = await execAsync('gh auth token');
    const token = stdout.trim();
    if (!token) throw new Error('Empty token');
    cachedToken = token;
    return token;
  } catch {
    throw new Error(
      'GitHub CLI token not found. Run `gh auth login` to authenticate.'
    );
  }
}

async function validateGitHubToken(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const data = (await res.json()) as { login: string };
  return data.login;
}

async function validateCopilotAccess(token: string): Promise<boolean> {
  // Probe the models endpoint to verify Copilot/Models access.
  // This is best-effort: we warn but don't block if the probe fails,
  // because answer-agent calls may still work.
  try {
    const res = await fetch(
      'https://api.github.com/copilot_internal/v2/token',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }
    );
    if (res.ok) return true;

    const modelsRes = await fetch('https://models.github.ai/inference/models', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    return modelsRes.ok;
  } catch {
    return false;
  }
}

export async function validateAuth(): Promise<AuthStatus> {
  if (cachedStatus) return cachedStatus;
  if (validationInProgress) return validationInProgress;

  validationInProgress = doValidateAuth();
  const result = await validationInProgress;
  validationInProgress = null;
  return result;
}

async function doValidateAuth(): Promise<AuthStatus> {
  try {
    const token = await getGhToken();
    const username = await validateGitHubToken(token);

    const copilotOk = await validateCopilotAccess(token);
    if (!copilotOk) {
      console.warn(
        'Copilot/Models probe failed - answer-agent calls may still work. If they do not, check your Copilot access.'
      );
    }

    cachedStatus = { authenticated: true, username };
    return cachedStatus;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    cachedStatus = { authenticated: false, error };
    return cachedStatus;
  }
}

export function clearAuthCache(): void {
  cachedToken = null;
  cachedStatus = null;
  validationInProgress = null;
}
