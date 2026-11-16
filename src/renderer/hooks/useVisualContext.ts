import { useCallback, useEffect, useRef, useState } from 'react';
import Tesseract from 'tesseract.js';
import type { VisualContextPayload, VisualContextSettings } from '../../shared/types';
import {
  createVisualContextCaptureRequest,
  shouldRunLocalOcr,
} from '../../shared/visual-context';

type VisualContextStatus = 'idle' | 'capturing' | 'ocr' | 'error';

export function useVisualContext() {
  const [status, setStatus] = useState<VisualContextStatus>('idle');
  const [error, setError] = useState('');
  const workerRef = useRef<Tesseract.Worker | null>(null);
  const workerLanguageRef = useRef('');
  const ocrQueueRef = useRef<Promise<VisualContextPayload | null>>(Promise.resolve(null));

  const getWorker = useCallback(async (language: string): Promise<Tesseract.Worker> => {
    if (workerRef.current && workerLanguageRef.current === language) {
      return workerRef.current;
    }

    if (workerRef.current) {
      await workerRef.current.terminate();
      workerRef.current = null;
      workerLanguageRef.current = '';
    }

    const worker = await Tesseract.createWorker(language);
    workerRef.current = worker;
    workerLanguageRef.current = language;
    return worker;
  }, []);

  const runOcr = useCallback((payload: VisualContextPayload, language: string): Promise<VisualContextPayload> => {
    ocrQueueRef.current = ocrQueueRef.current.then(async () => {
      if (!payload.screenshot) return payload;

      setStatus('ocr');
      const worker = await getWorker(language);
      const result = await worker.recognize(payload.screenshot.dataUrl);
      return {
        ...payload,
        ocr: {
          text: result.data.text.trim(),
          confidence: result.data.confidence,
          language,
        },
      };
    }).catch((err: unknown) => ({
      ...payload,
      error: err instanceof Error ? err.message : String(err),
    }));

    return ocrQueueRef.current.then((result) => result ?? payload);
  }, [getWorker]);

  const captureVisualContext = useCallback(async (
    settings: VisualContextSettings,
  ): Promise<VisualContextPayload | undefined> => {
    const request = createVisualContextCaptureRequest(settings);
    if (!request) {
      setStatus('idle');
      setError('');
      return undefined;
    }

    setStatus('capturing');
    setError('');

    try {
      const screenshotPayload = await window.aura.capturePrimaryScreen(request);
      const payload: VisualContextPayload = {
        ...screenshotPayload,
        mode: settings.mode,
      };

      if (payload.error || !shouldRunLocalOcr(settings.mode)) {
        setStatus(payload.error ? 'error' : 'idle');
        if (payload.error) setError(payload.error);
        return payload;
      }

      const withOcr = await runOcr(payload, settings.ocrLanguage || 'eng');
      setStatus(withOcr.error ? 'error' : 'idle');
      if (withOcr.error) setError(withOcr.error);
      return withOcr;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus('error');
      setError(message);
      return {
        capturedAt: Date.now(),
        mode: settings.mode,
        error: message,
      };
    }
  }, [runOcr]);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate().catch((err: unknown) => {
          console.warn('[Visual context] Failed to terminate OCR worker:', err);
        });
      }
    };
  }, []);

  return { captureVisualContext, status, error };
}
