import { describe, expect, it } from 'vitest';
import { normalizeExternalUrl } from '../../src/main/external-links.js';

describe('external links', () => {
  it('allows http and https documentation links', () => {
    expect(normalizeExternalUrl('https://learn.microsoft.com/azure/ai-foundry/')).toBe(
      'https://learn.microsoft.com/azure/ai-foundry/',
    );
    expect(normalizeExternalUrl('http://example.com/docs')).toBe('http://example.com/docs');
  });

  it('rejects non-web protocols', () => {
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalUrl('file:///C:/temp/secret.txt')).toBeNull();
  });
});
