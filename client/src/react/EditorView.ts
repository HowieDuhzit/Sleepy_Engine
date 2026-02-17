import React, { useCallback } from 'react';
import { EditorApp } from '../editor/EditorApp';
import { LegacyAppHost } from './LegacyAppHost';

type EditorViewProps = {
  gameId?: string;
  onBackToMenu: () => void;
};

const h = React.createElement;

export function EditorView({ gameId, onBackToMenu }: EditorViewProps) {
  const createApp = useCallback(
    (container: HTMLElement) => new EditorApp(container, gameId, onBackToMenu),
    [gameId, onBackToMenu],
  );

  return h(
    'div',
    { className: 'editor-legacy-root' },
    h(LegacyAppHost<EditorApp>, {
      createApp,
      onAppReady: (app) => {
        // Keep legacy shell ownership local to EditorApp while React migration continues.
        app.setExternalShellEnabled(false);
      },
    }),
  );
}
