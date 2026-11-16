import type {
  VisualCaptureRequest,
  VisualContextMode,
  VisualContextSettings,
} from './types.js';

export function shouldRunLocalOcr(mode: VisualContextMode): boolean {
  return mode === 'local_ocr' || mode === 'both';
}

export function shouldSendScreenshotToAgent(mode: VisualContextMode): boolean {
  return mode === 'agent_image' || mode === 'both';
}

export function createVisualContextCaptureRequest(settings: VisualContextSettings): VisualCaptureRequest | null {
  if (settings.mode === 'off') return null;

  return {
    target: settings.captureTarget,
    maxImageWidth: clampInteger(settings.maxImageWidth, 320, 2560),
    jpegQuality: clampNumber(settings.jpegQuality, 0.4, 0.92),
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
