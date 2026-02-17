import React, { useState } from 'react';
import { MainMenu } from './MainMenu';
import { SplashOverlay } from './SplashOverlay';
import { GameView } from './GameView';
import { EditorView } from './EditorView';

type AppState =
  | { mode: 'menu' }
  | { mode: 'game'; gameId?: string; scene?: string }
  | { mode: 'editor'; gameId?: string };

export function AppShell() {
  const [state, setState] = useState<AppState>({ mode: 'menu' });

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(SplashOverlay),
    state.mode === 'menu'
      ? React.createElement(MainMenu, {
          onPlay: (gameId: string, scene: string) => setState({ mode: 'game', gameId, scene }),
          onEditor: (gameId: string) => setState({ mode: 'editor', gameId }),
        })
      : null,
    state.mode === 'game'
      ? React.createElement(GameView, {
          gameId: state.gameId,
          scene: state.scene,
          onBackToMenu: () => setState({ mode: 'menu' }),
        })
      : null,
    state.mode === 'editor'
      ? React.createElement(EditorView, {
          gameId: state.gameId,
          onBackToMenu: () => setState({ mode: 'menu' }),
        })
      : null,
  );
}
