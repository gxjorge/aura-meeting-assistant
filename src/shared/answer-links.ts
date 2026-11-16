import type { LearnDoc } from './types.js';

/**
 * Turns the URLs an agent cited into clickable card sources.
 *
 * Documentation links used to come from a bespoke Microsoft Learn search that only the official-docs
 * card source could use. Now every profile reaches its sources through MCP servers, so citations are
 * read back out of the answer itself and every profile gets the same clickable list.
 */

const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** Punctuation that reliably belongs to the sentence rather than the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?'"”’)\]]+$/;

const DEFAULT_LIMIT = 4;

export function extractCitedLinks(text: string, limit: number = DEFAULT_LIMIT): LearnDoc[] {
  if (typeof text !== 'string' || !text.trim() || limit <= 0) return [];

  const collected: LearnDoc[] = [];
  const seen = new Set<string>();
  const linkedUrls = new Set<string>();

  const add = (url: string, title: string): void => {
    const key = dedupeKey(url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    collected.push({ title: title || fallbackTitle(url), url });
  };

  // Markdown links first: they carry a human-written title worth keeping.
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const url = cleanUrl(match[2] ?? '');
    if (!url) continue;
    linkedUrls.add(url);
    if (collected.length >= limit) continue;
    add(url, (match[1] ?? '').trim());
  }

  for (const match of text.matchAll(BARE_URL)) {
    if (collected.length >= limit) break;
    const url = cleanUrl(match[0]);
    if (!url || linkedUrls.has(url)) continue;
    add(url, '');
  }

  return collected.slice(0, limit);
}

function cleanUrl(raw: string): string {
  const trimmed = raw.trim().replace(TRAILING_PUNCTUATION, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return trimmed;
  } catch {
    return '';
  }
}

/** Ignores the trailing slash and host casing so the same page is not listed twice. */
function dedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, '');
    return `${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return '';
  }
}

/** Builds a readable label from the URL when the agent cited it bare. */
function fallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return parsed.host;

    const words = last
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    if (!words) return parsed.host;

    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch {
    return url;
  }
}
