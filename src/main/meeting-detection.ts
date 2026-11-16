import type { TranscriptSegment } from '../shared/types.js';

const MAX_TRANSCRIPT_WINDOW = 40;

/**
 * Rolling transcript window helpers.
 *
 * Deciding *what is worth surfacing* is no longer done here. It used to be a closed catalogue of
 * regexes, which meant the profile prompt could only shape the answer, never the trigger. That
 * decision now belongs to the triage pass in `meeting-triage.ts`, which runs the active profile's
 * own prompt over this window. All that is left here is keeping the window bounded and rendering it.
 */
export function appendRollingTranscript(
  current: TranscriptSegment[],
  segment: TranscriptSegment,
  nowSeconds: number,
  windowSeconds: number,
): TranscriptSegment[] {
  const cutoff = nowSeconds - windowSeconds;
  return [...current, segment]
    .filter((item) => item.endedAt >= cutoff)
    .slice(-MAX_TRANSCRIPT_WINDOW);
}

export function buildTranscriptContext(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return '(No meeting transcript context yet.)';

  return segments
    .map((segment) => {
      const time = new Date(segment.startedAt * 1000).toLocaleTimeString();
      return `[${time}] ${segment.source}: ${segment.text}`;
    })
    .join('\n');
}
