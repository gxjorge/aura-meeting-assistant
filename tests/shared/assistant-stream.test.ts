import { describe, it, expect } from 'vitest';
import { ASSISTANT_DELTA_EVENT, readAssistantDelta } from '../../src/shared/assistant-stream';

describe('assistant stream deltas', () => {
  it('subscribes to the message delta channel, not the byte-count channel', () => {
    // `assistant.streaming_delta` fires far more often and looks like the streaming feed, but its payload
    // is `{ totalResponseSizeBytes }`. Subscribing to it produced a card that never painted.
    expect(ASSISTANT_DELTA_EVENT).toBe('assistant.message_delta');
  });

  it('reads text from deltaContent', () => {
    expect(readAssistantDelta({ data: { deltaContent: 'Azure' } })).toBe('Azure');
  });

  it('ignores a streaming_delta byte-count payload', () => {
    expect(readAssistantDelta({ data: { totalResponseSizeBytes: 4096 } })).toBeNull();
  });

  it('ignores the delta/content/text field names the SDK does not use', () => {
    expect(readAssistantDelta({ data: { delta: 'Azure' } })).toBeNull();
    expect(readAssistantDelta({ data: { content: 'Azure' } })).toBeNull();
    expect(readAssistantDelta({ data: { text: 'Azure' } })).toBeNull();
  });

  it('skips sub-agent deltas so tool-internal reasoning never reaches a card', () => {
    expect(
      readAssistantDelta({ data: { deltaContent: 'searching docs…', parentToolCallId: 'call_1' } }),
    ).toBeNull();
  });

  it('treats malformed and empty events as nothing to paint', () => {
    expect(readAssistantDelta(undefined)).toBeNull();
    expect(readAssistantDelta(null)).toBeNull();
    expect(readAssistantDelta({})).toBeNull();
    expect(readAssistantDelta({ data: {} })).toBeNull();
    expect(readAssistantDelta({ data: { deltaContent: '' } })).toBeNull();
    expect(readAssistantDelta({ data: { deltaContent: 42 } })).toBeNull();
  });

  it('concatenates chunks into the exact final message', () => {
    // Verified against a live session: 123 deltas accumulated byte-identically to the final content,
    // which is what makes `accumulated += chunk` correct rather than duplicating a cumulative snapshot.
    const events = ['**', 'Azure', ' Container', ' Apps', '**'].map((deltaContent) => ({
      data: { deltaContent },
    }));

    let accumulated = '';
    for (const event of events) {
      const chunk = readAssistantDelta(event);
      if (chunk !== null) accumulated += chunk;
    }

    expect(accumulated).toBe('**Azure Container Apps**');
  });
});
