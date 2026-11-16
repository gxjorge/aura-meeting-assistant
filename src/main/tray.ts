import { Tray, Menu, nativeImage, app } from 'electron';
import { toggleOverlay } from './overlay.js';
import type { ProfilesState } from '../shared/types.js';

let tray: Tray | null = null;
// Lazy import to break circular dependency (ipc imports from tray indirectly)
let audioToggleFn: (() => boolean) | null = null;
let audioStatusFn: (() => boolean) | null = null;
let profilesStateFn: (() => ProfilesState) | null = null;
let activateProfileFn: ((profileId: string) => void) | null = null;

export function setAudioCallbacks(toggle: () => boolean, status: () => boolean): void {
  audioToggleFn = toggle;
  audioStatusFn = status;
}

export function setProfileCallbacks(
  getState: () => ProfilesState,
  activate: (profileId: string) => void
): void {
  profilesStateFn = getState;
  activateProfileFn = activate;
  updateTrayMenu();
}

type TrayState = 'active' | 'inactive' | 'error' | 'listening';

function createTrayIcon(state: TrayState): Electron.NativeImage {
  const size = 16;
  const colors: Record<TrayState, [string, string]> = {
    active: ['#22c55e', '#16a34a'],
    listening: ['#3b82f6', '#2563eb'],
    inactive: ['#6b7280', '#4b5563'],
    error: ['#ef4444', '#dc2626'],
  };
  const [outer, inner] = colors[state];
  const canvas = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="8" cy="8" r="7" fill="${outer}" />
      <circle cx="8" cy="8" r="4" fill="${inner}" />
    </svg>
  `;
  const buffer = Buffer.from(canvas.trim());
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${buffer.toString('base64')}`
  );
}

export function createTray(): Tray {
  const icon = createTrayIcon('inactive');
  tray = new Tray(icon);
  tray.setToolTip('Aura — Meeting Intelligence');

  updateTrayMenu();

  tray.on('click', () => {
    toggleOverlay();
  });

  return tray;
}

export function updateTrayMenu(): void {
  if (!tray) return;

  const listening = audioStatusFn ? audioStatusFn() : false;
  const profilesState = profilesStateFn ? profilesStateFn() : null;

  const profileItems: Electron.MenuItemConstructorOptions[] = profilesState
    ? [
        {
          label: 'Meeting profile',
          submenu: profilesState.profiles.map((profile) => ({
            label: profile.name,
            type: 'radio' as const,
            checked: profile.id === profilesState.activeProfileId,
            click: () => {
              activateProfileFn?.(profile.id);
              updateTrayMenu();
            },
          })),
        },
        { type: 'separator' as const },
      ]
    : [];

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Minimize',
      click: () => toggleOverlay(),
    },
    { type: 'separator' },
    ...profileItems,
    {
      label: listening ? '🎤 Listening: ON' : '🎤 Listening: OFF',
      click: () => {
        if (audioToggleFn) {
          const newState = audioToggleFn();
          setTrayState(newState ? 'listening' : 'active');
          updateTrayMenu();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Aura',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
}

export function setTrayState(state: TrayState): void {
  if (!tray) return;
  const icon = createTrayIcon(state);
  tray.setImage(icon);

  const tooltips: Record<TrayState, string> = {
    active: 'Aura — Ready for meetings',
    listening: 'Aura — Listening to meeting audio',
    inactive: 'Aura — Inactive',
    error: 'Aura — Authentication Error',
  };
  tray.setToolTip(tooltips[state]);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
