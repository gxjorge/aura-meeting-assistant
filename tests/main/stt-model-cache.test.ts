import { describe, expect, it } from 'vitest';
import {
  createSttModelCacheKey,
  resolveSttModelSourceUrl,
  shouldCacheModelUrl,
} from '../../src/renderer/audio/stt-model-cache.js';

describe('STT model cache helpers', () => {
  it('creates a stable cache key for the configured model URL', () => {
    expect(createSttModelCacheKey('/vosk-model-small-en-us.tar.gz')).toBe('stt-model:/vosk-model-small-en-us.tar.gz');
  });

  it('does not try to cache generated blob URLs', () => {
    expect(shouldCacheModelUrl('blob:http://localhost/model')).toBe(false);
    expect(shouldCacheModelUrl('/vosk-model-small-en-us.tar.gz')).toBe(true);
  });

  it('resolves the bundled model from the renderer directory in packaged builds', () => {
    expect(resolveSttModelSourceUrl(
      '/vosk-model-small-en-us.tar.gz',
      'file:///C:/Program%20Files/Aura/resources/app.asar/dist/renderer/index.html',
    )).toBe(
      'file:///C:/Program%20Files/Aura/resources/app.asar/dist/renderer/vosk-model-small-en-us.tar.gz',
    );
  });

  it('keeps root-relative model URLs rooted at the Vite origin in development', () => {
    expect(resolveSttModelSourceUrl(
      '/vosk-model-small-en-us.tar.gz',
      'http://localhost:5173/index.html',
    )).toBe('http://localhost:5173/vosk-model-small-en-us.tar.gz');
  });

  it('leaves remote and generated model URLs unchanged', () => {
    expect(resolveSttModelSourceUrl(
      'https://alphacephei.com/model.tar.gz',
      'file:///C:/Aura/index.html',
    )).toBe('https://alphacephei.com/model.tar.gz');
    expect(resolveSttModelSourceUrl(
      'blob:http://localhost/model',
      'http://localhost:5173/index.html',
    )).toBe('blob:http://localhost/model');
  });
});
