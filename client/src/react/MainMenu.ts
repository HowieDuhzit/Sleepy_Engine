import React, { useEffect, useMemo, useState } from 'react';
import { getGameScenes, listGames } from '../services/game-api';
import { MainMenuScene3D } from './MainMenuScene3D';

type MainMenuProps = {
  onPlay: (gameId: string, scene: string) => void;
  onEditor: (gameId: string, scene: string) => void;
  showForeground?: boolean;
};

type GameEntry = { id: string; name: string };
const h = React.createElement;

type BatteryManagerLike = EventTarget & {
  level: number;
  charging: boolean;
};

type NavigatorWithBattery = Navigator & {
  getBattery?: () => Promise<BatteryManagerLike>;
};

const MOCK_FRIENDS_ONLINE = 2;
const MOCK_NOTIFICATIONS = 3;

const sameGames = (a: GameEntry[], b: GameEntry[]) =>
  a.length === b.length &&
  a.every((game, index) => game.id === b[index]?.id && game.name === b[index]?.name);

export function MainMenu({ onPlay, onEditor, showForeground = true }: MainMenuProps) {
  const [games, setGames] = useState<GameEntry[]>([]);
  const [currentGameId, setCurrentGameId] = useState<string>('');
  const [currentStartScene, setCurrentStartScene] = useState<string>('main');
  const [clock, setClock] = useState<string>(() =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  );
  const [battery, setBattery] = useState<string>('');

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let mounted = true;
    let manager: BatteryManagerLike | null = null;

    const nav = navigator as NavigatorWithBattery;
    const isLikelyMobile =
      (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) ||
      ('maxTouchPoints' in nav && nav.maxTouchPoints > 1);

    if (!isLikelyMobile) return;
    if (!nav.getBattery) return;

    const updateBattery = () => {
      if (!mounted || !manager) return;
      const level = Math.round(manager.level * 100);
      const charging = manager.charging ? ' +' : '';
      setBattery(`${level}%${charging}`);
    };

    void nav.getBattery().then((batteryManager) => {
      if (!mounted) return;
      manager = batteryManager;
      updateBattery();
      manager.addEventListener('levelchange', updateBattery);
      manager.addEventListener('chargingchange', updateBattery);
    });

    return () => {
      mounted = false;
      if (!manager) return;
      manager.removeEventListener('levelchange', updateBattery);
      manager.removeEventListener('chargingchange', updateBattery);
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadGames = async () => {
      try {
        const items = await listGames(true);
        if (!mounted) return;
        setGames((prev) => (sameGames(prev, items) ? prev : items));
        setCurrentGameId((prev) => {
          if (prev && items.some((game) => game.id === prev)) return prev;
          return items.find((g) => g.id === 'prototype')?.id ?? items[0]?.id ?? '';
        });
      } catch (error) {
        console.error('Failed to load games:', error);
        if (!mounted) return;
        setGames((prev) => prev);
      }
    };

    void loadGames();
    const refreshTimer = window.setInterval(() => {
      void loadGames();
    }, 5000);
    return () => {
      mounted = false;
      window.clearInterval(refreshTimer);
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

  const selectedGameName = useMemo(
    () => games.find((g) => g.id === currentGameId)?.name ?? 'No game selected',
    [games, currentGameId],
  );

  const handlePlay = () => {
    if (!currentGameId) return;
    onPlay(currentGameId, currentStartScene);
  };

  const handleEditor = () => {
    if (!currentGameId) return;
    onEditor(currentGameId, currentStartScene);
  };

  return h(
    'div',
    { className: 'nxe-menu nxe-menu-3d nxe-menu-cards' },
    h('div', { className: 'nxe-bg-orb nxe-bg-orb-a' }),
    h('div', { className: 'nxe-bg-orb nxe-bg-orb-b' }),
    h(
      'div',
      { className: 'nxe-menu-clock', 'aria-live': 'polite' },
      h('span', null, clock),
      battery ? h('span', { className: 'nxe-menu-clock-battery' }, battery) : null,
    ),
    h(MainMenuScene3D, {
      showForeground,
      gameId: currentGameId,
      gameName: selectedGameName,
      startScene: currentStartScene,
      gamesCount: games.length,
      notificationsCount: MOCK_NOTIFICATIONS,
      friendsOnline: MOCK_FRIENDS_ONLINE,
      clock,
      games,
      onGameChange: setCurrentGameId,
      onPlay: handlePlay,
      onEditor: handleEditor,
    }),
  );
}
