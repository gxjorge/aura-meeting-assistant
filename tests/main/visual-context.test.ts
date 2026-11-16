import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  VISUAL_CONTEXT_MODE_OPTIONS,
} from '../../src/shared/types.js';
import {
  createVisualContextCaptureRequest,
  shouldRunLocalOcr,
  shouldSendScreenshotToAgent,
} from '../../src/shared/visual-context.js';

describe('visual context settings', () => {
  it('defaults to disabled primary-screen visual context', () => {
    expect(DEFAULT_SETTINGS.visualContext).toEqual({
      mode: 'off',
      captureTarget: 'primary_screen',
      trigger: 'transcript_segment',
      ocrLanguage: 'eng',
      maxImageWidth: 1280,
      jpegQuality: 0.72,
    });
    expect(VISUAL_CONTEXT_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'off',
      'agent_image',
      'local_ocr',
      'both',
    ]);
  });

  it('creates a bounded capture request for OCR modes', () => {
    expect(createVisualContextCaptureRequest({
      mode: 'both',
      captureTarget: 'primary_screen',
      trigger: 'transcript_segment',
      ocrLanguage: 'eng',
      maxImageWidth: 1920,
      jpegQuality: 0.9,
    })).toEqual({
      target: 'primary_screen',
      maxImageWidth: 1920,
      jpegQuality: 0.9,
    });
  });

  it('classifies screenshot and OCR modes', () => {
    expect(shouldRunLocalOcr('off')).toBe(false);
    expect(shouldRunLocalOcr('agent_image')).toBe(false);
    expect(shouldRunLocalOcr('local_ocr')).toBe(true);
    expect(shouldRunLocalOcr('both')).toBe(true);

    expect(shouldSendScreenshotToAgent('off')).toBe(false);
    expect(shouldSendScreenshotToAgent('agent_image')).toBe(true);
    expect(shouldSendScreenshotToAgent('local_ocr')).toBe(false);
    expect(shouldSendScreenshotToAgent('both')).toBe(true);
  });
});
