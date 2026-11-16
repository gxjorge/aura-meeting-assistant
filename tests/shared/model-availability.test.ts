import { describe, expect, it } from 'vitest';
import { isModelUnavailableError, readUnavailableModelId } from '../../src/shared/model-availability';

/**
 * The exact shape the SDK produced when a model appeared in `listModels()` but `session.create`
 * refused it. Pinned verbatim because this failure is silently fatal — it took out triage on every
 * tick with no card ever reaching the overlay, and nothing in the advertised list hinted at it.
 */
const REAL_SDK_MESSAGE =
  'Request session.create failed with message: Model "gpt-5.6-luna" is not available.';

describe('isModelUnavailableError', () => {
  it('detects the real SDK session.create rejection', () => {
    expect(isModelUnavailableError(new Error(REAL_SDK_MESSAGE))).toBe(true);
  });

  it('detects the rejection on a plain object carrying a message', () => {
    expect(isModelUnavailableError({ code: -32603, message: REAL_SDK_MESSAGE })).toBe(true);
  });

  it('detects a bare string message', () => {
    expect(isModelUnavailableError(REAL_SDK_MESSAGE)).toBe(true);
  });

  it('accepts other phrasings the backend may use for the same condition', () => {
    expect(isModelUnavailableError(new Error('Unknown model: gpt-9'))).toBe(true);
    expect(isModelUnavailableError(new Error('Model gpt-9 is not supported'))).toBe(true);
    expect(isModelUnavailableError(new Error('model not found'))).toBe(true);
  });

  it('ignores failures that retrying on another model cannot fix', () => {
    // Retrying these would only double the delay before the real error surfaces.
    expect(isModelUnavailableError(new Error('Request failed: unauthorized'))).toBe(false);
    expect(isModelUnavailableError(new Error('socket hang up'))).toBe(false);
    expect(isModelUnavailableError(new Error('Rate limit exceeded'))).toBe(false);
  });

  it('does not fire on an availability message unrelated to models', () => {
    expect(isModelUnavailableError(new Error('Skill directory is not available'))).toBe(false);
  });

  it('tolerates errors with no readable message', () => {
    expect(isModelUnavailableError(null)).toBe(false);
    expect(isModelUnavailableError(undefined)).toBe(false);
    expect(isModelUnavailableError({})).toBe(false);
    expect(isModelUnavailableError(42)).toBe(false);
  });
});

describe('readUnavailableModelId', () => {
  it('extracts the rejected model from the real SDK message', () => {
    expect(readUnavailableModelId(new Error(REAL_SDK_MESSAGE))).toBe('gpt-5.6-luna');
  });

  it('extracts an unquoted model id', () => {
    expect(readUnavailableModelId(new Error('Model gpt-4.1 is not available'))).toBe('gpt-4.1');
  });

  it('returns null when the message names no model', () => {
    expect(readUnavailableModelId(new Error('model not found'))).toBeNull();
    expect(readUnavailableModelId(null)).toBeNull();
  });
});
