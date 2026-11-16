import { desktopCapturer, screen } from 'electron';
import type { VisualCaptureRequest, VisualContextPayload } from '../shared/types.js';

export async function capturePrimaryScreen(request: VisualCaptureRequest): Promise<VisualContextPayload> {
  const capturedAt = Date.now();

  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const scale = request.maxImageWidth / primaryDisplay.size.width;
    const thumbnailSize = scale < 1
      ? {
          width: request.maxImageWidth,
          height: Math.round(primaryDisplay.size.height * scale),
        }
      : primaryDisplay.size;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
    });
    const primarySource = sources.find((source) => source.display_id === String(primaryDisplay.id)) ?? sources[0];

    if (!primarySource || primarySource.thumbnail.isEmpty()) {
      return {
        capturedAt,
        mode: 'agent_image',
        error: 'Primary screen screenshot was unavailable.',
      };
    }

    const thumbnail = primarySource.thumbnail;
    const size = thumbnail.getSize();
    const jpegQuality = Math.round(Math.min(Math.max(request.jpegQuality, 0.4), 0.92) * 100);
    const dataUrl = `data:image/jpeg;base64,${thumbnail.toJPEG(jpegQuality).toString('base64')}`;

    return {
      capturedAt,
      mode: 'agent_image',
      screenshot: {
        dataUrl,
        width: size.width,
        height: size.height,
      },
    };
  } catch (err) {
    return {
      capturedAt,
      mode: 'agent_image',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
