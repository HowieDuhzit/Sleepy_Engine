import React, { useCallback, useMemo, useRef, useState } from 'react';
import { GameApp } from '../game/GameApp';
import { LegacyAppHost } from './LegacyAppHost';
import { GameSettingsOverlay } from './GameSettingsOverlay';
import { UiButton } from './ui-primitives';

type GameViewProps = {
  gameId?: string;
  scene?: string;
  onBackToMenu: () => void;
};

const h = React.createElement;

export function GameView({ gameId, scene, onBackToMenu }: GameViewProps) {
  const appRef = useRef<GameApp | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [camera, setCamera] = useState({
    orbitRadius: 6,
    cameraSmoothing: 0,
    cameraSensitivity: 1,
    firstPersonMode: false,
  });

  const createApp = useCallback(
    (container: HTMLElement) => new GameApp(container, scene, gameId, onBackToMenu),
    [gameId, onBackToMenu, scene],
  );

  const header = useMemo(
    () =>
      h(
        'div',
        { className: 'react-mode-header game-react-header' },
        h(UiButton, { onClick: onBackToMenu }, 'Back to Menu'),
        h(
          UiButton,
          {
            variant: 'primary',
            onClick: () => setSettingsOpen((current) => !current),
          },
          settingsOpen ? 'Close Settings' : 'Settings',
        ),
      ),
    [onBackToMenu, settingsOpen],
  );

  return h(
    React.Fragment,
    null,
    header,
    h(LegacyAppHost<GameApp>, {
      createApp,
      onAppReady: (app) => {
        appRef.current = app;
        setCamera(app.getUiCameraSettings());
        unsubscribeRef.current = app.onUiCameraSettingsChange((value) => setCamera(value));
      },
      onAppDispose: () => {
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
        appRef.current = null;
      },
    }),
    h(GameSettingsOverlay, {
      open: settingsOpen,
      camera,
      onClose: () => setSettingsOpen(false),
      onCameraChange: (patch) => {
        appRef.current?.setUiCameraSettings(patch);
      },
    }),
  );
}
