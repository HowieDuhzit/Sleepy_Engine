import React, { useEffect, useRef, useState } from 'react';
import { MainMenu } from './MainMenu';
import { SplashOverlay } from './SplashOverlay';
import { GameView } from './GameView';
import { EditorView } from './EditorView';
import { menuAudio } from '../audio/menu-audio';

type AppState =
  | { mode: 'menu' }
  | { mode: 'game'; gameId?: string; scene?: string }
  | { mode: 'editor'; gameId?: string };

export function AppShell() {
  const [state, setState] = useState<AppState>({ mode: 'menu' });
  const [splashVisible, setSplashVisible] = useState(true);
  const previousSplashVisible = useRef(splashVisible);

  useEffect(() => {
    menuAudio.playBoot();
    menuAudio.setMenuAmbient(true);
  }, []);

  useEffect(() => {
    const unlock = () => {
      const firstUnlock = menuAudio.unlock();
      if (firstUnlock) {
        menuAudio.refreshAmbient();
      }
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('pointermove', unlock, { passive: true });
    window.addEventListener('wheel', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('pointermove', unlock);
      window.removeEventListener('wheel', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, []);

  useEffect(() => {
    if (previousSplashVisible.current && !splashVisible) {
      menuAudio.playLoad();
    }
    previousSplashVisible.current = splashVisible;
  }, [splashVisible]);

  return React.createElement(
    React.Fragment,
    null,
    splashVisible ? React.createElement(SplashOverlay, { onFinish: () => setSplashVisible(false) }) : null,
    state.mode === 'menu'
      ? React.createElement(MainMenu, {
          showForeground: !splashVisible,
          onPlay: (gameId: string, scene: string) => setState({ mode: 'game', gameId, scene }),
          onEditor: (gameId: string) => setState({ mode: 'editor', gameId }),
        })
      : null,
    !splashVisible && state.mode === 'game'
      ? React.createElement(GameView, {
          gameId: state.gameId,
          scene: state.scene,
          onBackToMenu: () => setState({ mode: 'menu' }),
        })
      : null,
    !splashVisible && state.mode === 'editor'
      ? React.createElement(EditorView, {
          gameId: state.gameId,
          onBackToMenu: () => setState({ mode: 'menu' }),
        })
      : null,
  );
}
