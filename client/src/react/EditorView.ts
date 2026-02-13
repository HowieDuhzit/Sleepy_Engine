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
    [gameId, onBackToMenu]
  );

  return h(LegacyAppHost, { createApp });
}
