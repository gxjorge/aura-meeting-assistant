/**
 * Recovery for models the SDK advertises but refuses to run.
 *
 * `listModels()` is not authoritative for session creation: a model id can appear in the advertised
 * list and still make `session.create` fail with `Model "<id>" is not available.` That combination is
 * silently fatal, because every guard Aura had checked the advertised list — so the check passed, the
 * session throw propagated, and triage died on every tick with no card ever reaching the overlay.
 *
 * Detection therefore has to key on the failure itself rather than on any list we hold up front.
 */

/** Pulled out of the message when present, so logs name the model the backend actually rejected. */
export function readUnavailableModelId(error: unknown): string | null {
  const message = readErrorMessage(error);
  if (!message) return null;

  const quoted = /model\s+["'`]([^"'`]+)["'`]\s+is not available/i.exec(message);
  if (quoted?.[1]) return quoted[1];

  const bare = /model\s+([\w.\-:]+)\s+is not available/i.exec(message);
  return bare?.[1] ?? null;
}

/**
 * True when a session failed specifically because the requested model is unusable, as opposed to a
 * network, auth, or prompt error. Only this case is worth retrying on a different model; retrying an
 * auth failure would just double the delay before the real error surfaces.
 */
export function isModelUnavailableError(error: unknown): boolean {
  const message = readErrorMessage(error);
  if (!message) return false;

  const normalized = message.toLowerCase();
  if (!normalized.includes('model')) return false;

  return (
    normalized.includes('is not available') ||
    normalized.includes('is not supported') ||
    normalized.includes('unknown model') ||
    normalized.includes('model not found')
  );
}

function readErrorMessage(error: unknown): string | null {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;

  if (error && typeof error === 'object') {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') return candidate;
  }

  return null;
}
