/**
 * Reading incremental assistant text out of Copilot SDK session events.
 *
 * This lives in `shared/` rather than inline in `main/copilot.ts` because the field names below are the
 * kind of detail that is easy to get wrong and impossible to notice: subscribing to the wrong event or
 * reading the wrong property yields no text at all, and a card that simply never streams looks identical
 * to a card that streams correctly but finishes quickly. Keeping the extraction pure means it can be
 * asserted directly in tests instead of only through a live session.
 */

/** The only event type that carries assistant text. See `readAssistantDelta` for why. */
export const ASSISTANT_DELTA_EVENT = 'assistant.message_delta';

interface AssistantDeltaEvent {
  data?: {
    deltaContent?: unknown;
    parentToolCallId?: unknown;
  };
}

/**
 * Returns the next text chunk to append, or `null` when the event carries nothing paintable.
 *
 * Two traps are encoded here:
 *
 * 1. `assistant.streaming_delta` is not the text channel. It fires hundreds of times per turn, which makes
 *    it look like the streaming feed, but its payload is `{ totalResponseSizeBytes: number }` — a progress
 *    counter with no words in it. Only `assistant.message_delta` carries `deltaContent`.
 * 2. Deltas produced by a sub-agent carry `parentToolCallId`. A profile whose MCP tools delegate would
 *    otherwise paint the sub-agent's internal working notes into the user's card.
 *
 * `deltaContent` is documented as an incremental chunk, so callers accumulate it. It is not a cumulative
 * snapshot, and concatenating cumulative payloads would duplicate the answer.
 */
export function readAssistantDelta(event: unknown): string | null {
  const data = (event as AssistantDeltaEvent | null | undefined)?.data;
  if (!data) return null;
  if (typeof data.parentToolCallId === 'string') return null;

  const chunk = data.deltaContent;
  if (typeof chunk !== 'string' || chunk.length === 0) return null;

  return chunk;
}
