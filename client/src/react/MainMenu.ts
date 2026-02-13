import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getGameScenes, listGames } from '../services/game-api';
import { createRoot, type Root } from 'react-dom/client';
import { ReactPSXSettingsPanel } from './ReactPSXSettingsPanel';
import { UiButton, UiCard, UiField, UiSelect } from './ui-primitives';

type MainMenuProps = {
  onPlay: (gameId: string, scene: string) => void;
  onEditor: (gameId: string, scene: string) => void;
};

type GameEntry = { id: string; name: string };

const h = React.createElement;

export function MainMenu({ onPlay, onEditor }: MainMenuProps) {
  const [games, setGames] = useState<GameEntry[]>([]);
  const [currentGameId, setCurrentGameId] = useState<string>('');
  const [currentStartScene, setCurrentStartScene] = useState<string>('main');
  const [showSettings, setShowSettings] = useState(false);
  const settingsHostRef = useRef<HTMLDivElement | null>(null);
  const settingsRootRef = useRef<Root | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadGames = async () => {
      try {
        const items = await listGames();
        if (!mounted) return;

        setGames(items);
        const nextId = items.find((g) => g.id === 'prototype')?.id ?? items[0]?.id ?? '';
        setCurrentGameId(nextId);
      } catch (error) {
        console.error('Failed to load games:', error);
        if (!mounted) return;
        setGames([]);
        setCurrentGameId('');
      }
    };

    void loadGames();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!currentGameId) {
      setCurrentStartScene('main');
      return;
    }

    const loadStartScene = async () => {
      try {
        const data = await getGameScenes(currentGameId);
        if (!mounted) return;
        setCurrentStartScene(data.scenes?.[0]?.name ?? 'main');
      } catch (error) {
        console.error('Failed to load game scenes:', error);
        if (!mounted) return;
        setCurrentStartScene('main');
      }
    };

    void loadStartScene();

    return () => {
      mounted = false;
    };
  }, [currentGameId]);

  useEffect(() => {
    if (!showSettings) return;
    const host = settingsHostRef.current;
    if (!host) return;

    const root = createRoot(host);
    settingsRootRef.current = root;
    root.render(h(ReactPSXSettingsPanel));

    return () => {
      settingsRootRef.current?.unmount();
      settingsRootRef.current = null;
    };
  }, [showSettings]);

  const disabled = useMemo(() => !currentGameId, [currentGameId]);

  const gameOptions = games.map((game) => h('option', { key: game.id, value: game.id }, game.name));

  const menuCard = h(
    UiCard,
    { className: 'menu-card' },
    h('h1', { className: 'menu-title' }, 'Sleepy Engine'),
    h('p', { className: 'menu-description' }, 'Choose a game'),
    h(UiField, {
      label: 'Game',
      control: h(
        UiSelect,
        {
          value: currentGameId,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setCurrentGameId(event.target.value),
        },
        gameOptions
      ),
    }),
    h(
      UiButton,
      {
        variant: 'primary',
        onClick: () => currentGameId && onPlay(currentGameId, currentStartScene),
        disabled,
      },
      'Play'
    ),
    h(
      UiButton,
      {
        onClick: () => currentGameId && onEditor(currentGameId, currentStartScene),
        disabled,
      },
      'Editor'
    ),
    h(
      UiButton,
      {
        variant: 'ghost',
        onClick: () => setShowSettings(true),
      },
      'Settings'
    )
  );

  const settingsCard = h(
    'div',
    { className: 'menu-settings' },
    h('div', { ref: settingsHostRef }),
    h(
      UiButton,
      {
        className: 'menu-back-button',
        onClick: () => setShowSettings(false),
      },
      'Back to Menu'
    )
  );

  return h('div', { className: 'menu' }, showSettings ? settingsCard : menuCard);
}
