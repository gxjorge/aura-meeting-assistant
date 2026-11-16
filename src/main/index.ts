import { app, globalShortcut, Menu } from 'electron';
import { createTray, setTrayState, destroyTray, setAudioCallbacks, setProfileCallbacks, updateTrayMenu } from './tray.js';
import { createOverlayWindow, toggleOverlay, showOverlay } from './overlay.js';
import { validateAuth } from './auth.js';
import { registerIpcHandlers, toggleAudioListening, isAudioListening, activateProfile } from './ipc.js';
import { stopCopilotClient } from './copilot.js';
import { getProfilesState } from './settings.js';

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+A';
const LISTENING_SHORTCUT = 'CommandOrControl+Shift+M';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('Another Aura instance is running. Exiting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    showOverlay();
  });

  app.whenReady().then(async () => {
    console.log('Aura starting...');
    try {
      // Aura is driven by the tray and in-app controls; the default OS menu bar adds no value.
      Menu.setApplicationMenu(null);

      registerIpcHandlers();

      setAudioCallbacks(toggleAudioListening, isAudioListening);
      setProfileCallbacks(getProfilesState, (profileId) => {
        activateProfile(profileId);
      });

      createTray();
      console.log('Tray created');

      createOverlayWindow();
      console.log('Overlay window created');

      const overlayRegistered = globalShortcut.register(DEFAULT_SHORTCUT, () => {
        toggleOverlay();
      });

      if (!overlayRegistered) {
        console.warn(
          `Failed to register shortcut ${DEFAULT_SHORTCUT}. It may be in use by another app. Use the tray icon instead.`,
        );
      } else {
        console.log(`Shortcut ${DEFAULT_SHORTCUT} registered`);
      }

      const listeningRegistered = globalShortcut.register(LISTENING_SHORTCUT, () => {
        const listening = toggleAudioListening();
        setTrayState(listening ? 'listening' : 'active');
        updateTrayMenu();
        console.log(`Listening: ${listening ? 'ON' : 'OFF'}`);
      });

      if (!listeningRegistered) {
        console.warn(`Failed to register listening shortcut ${LISTENING_SHORTCUT}`);
      } else {
        console.log(`Shortcut ${LISTENING_SHORTCUT} registered`);
      }

      const authStatus = await validateAuth();
      setTrayState(authStatus.authenticated ? 'active' : 'error');

      if (authStatus.authenticated) {
        console.log(`Authenticated as ${authStatus.username}`);
      }

      showOverlay();
      console.log('Aura is ready! Use Ctrl+Shift+A to toggle overlay, Ctrl+Shift+M to toggle listening.');
    } catch (err) {
      console.error('Failed to initialize Aura:', err);
      setTrayState('error');
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    destroyTray();
    stopCopilotClient().catch(() => {});
  });

  app.on('window-all-closed', () => {
    // Keep Aura running in the tray.
  });
}
