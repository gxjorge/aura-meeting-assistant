import { describe, expect, it } from 'vitest';
import { extractCitedLinks } from '../../src/shared/answer-links.js';

describe('extractCitedLinks', () => {
  it('pulls markdown links out with their own titles', () => {
    const answer = 'See [Vector search overview](https://learn.microsoft.com/azure/search/vector-search) for details.';

    expect(extractCitedLinks(answer)).toEqual([
      { title: 'Vector search overview', url: 'https://learn.microsoft.com/azure/search/vector-search' },
    ]);
  });

  it('derives a readable title for a bare URL', () => {
    const answer = 'Reference: https://learn.microsoft.com/azure/search/vector-search-overview';

    expect(extractCitedLinks(answer)).toEqual([
      { title: 'Vector search overview', url: 'https://learn.microsoft.com/azure/search/vector-search-overview' },
    ]);
  });

  it('does not list a URL twice when it also appeared as a markdown link', () => {
    const url = 'https://learn.microsoft.com/azure/search/vector-search';
    const answer = `[Vector search](${url}) — full text at ${url}`;

    expect(extractCitedLinks(answer)).toEqual([{ title: 'Vector search', url }]);
  });

  it('collapses the same page cited with different fragments', () => {
    const answer = [
      'https://learn.microsoft.com/azure/search/overview#intro',
      'https://learn.microsoft.com/azure/search/overview#limits',
    ].join('\n');

    expect(extractCitedLinks(answer)).toHaveLength(1);
  });

  it('strips trailing sentence punctuation from a bare URL', () => {
    const answer = 'Docs live at https://learn.microsoft.com/azure/search/overview.';

    expect(extractCitedLinks(answer)[0]?.url).toBe('https://learn.microsoft.com/azure/search/overview');
  });

  it('ignores text that is not a usable link', () => {
    expect(extractCitedLinks('No sources were available for this question.')).toEqual([]);
    expect(extractCitedLinks('')).toEqual([]);
  });

  it('caps how many links a single card can carry', () => {
    const answer = Array.from({ length: 9 }, (_, index) => `https://example.com/page-${index}`).join('\n');

    expect(extractCitedLinks(answer)).toHaveLength(4);
    expect(extractCitedLinks(answer, 2)).toHaveLength(2);
  });
});
