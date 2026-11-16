import { BrowserWindow, screen } from 'electron';
import path from 'path';

let overlayWindow: BrowserWindow | null = null;

const WINDOW_WIDTH = 520;
const WINDOW_HEIGHT = 680;
const MARGIN = 16;

export function createOverlayWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    title: 'Aura',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: screenW - WINDOW_WIDTH - MARGIN,
    y: screenH - WINDOW_HEIGHT - MARGIN,
    frame: true,
    maximizable: true,
    minimizable: true,
    resizable: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    show: false,
    transparent: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    const port = process.env.VITE_PORT || '5173';
    overlayWindow.loadURL(`http://localhost:${port}`);
    overlayWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

export function showOverlay(): void {
  if (!overlayWindow) {
    createOverlayWindow();
  }
  if (!overlayWindow) return;

  if (overlayWindow.isMinimized()) {
    overlayWindow.restore();
  }
  overlayWindow.show();
  overlayWindow.focus();
}

export function toggleOverlay(): void {
  if (!overlayWindow) return;

  if (overlayWindow.isVisible() && !overlayWindow.isMinimized()) {
    overlayWindow.minimize();
  } else {
    showOverlay();
  }
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}
