import React, { useCallback } from 'react';
import { GameApp } from '../game/GameApp';
import { LegacyAppHost } from './LegacyAppHost';

type GameViewProps = {
  gameId?: string;
  scene?: string;
  onBackToMenu: () => void;
};

const h = React.createElement;

export function GameView({ gameId, scene, onBackToMenu }: GameViewProps) {
  const createApp = useCallback(
    (container: HTMLElement) => new GameApp(container, scene, gameId, onBackToMenu),
    [gameId, onBackToMenu, scene]
  );

  return h(LegacyAppHost, { createApp });
}
