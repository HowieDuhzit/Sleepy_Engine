import React, { useEffect, useMemo, useState } from 'react';
import { getGameScenes, listGames } from '../services/game-api';
import { UiButton, UiSelect } from './ui-primitives';
import { MainMenuScene3D } from './MainMenuScene3D';
import { PlayerProfileCard } from './PlayerProfileCard';

type MainMenuProps = {
  onPlay: (gameId: string, scene: string) => void;
  onEditor: (gameId: string, scene: string) => void;
};

type GameEntry = { id: string; name: string };
type MenuTab = 'home' | 'games' | 'media' | 'social' | 'store' | 'settings';

const h = React.createElement;

const MENU_TABS: Array<{ id: MenuTab; label: string; icon: string }> = [
  { id: 'home', label: 'Home', icon: '⌂' },
  { id: 'games', label: 'Games', icon: '▦' },
  { id: 'media', label: 'Media', icon: '▶' },
  { id: 'social', label: 'Social', icon: '◎' },
  { id: 'store', label: 'Store', icon: '◇' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

const TAB_SUBNAV: Record<MenuTab, string[]> = {
  home: ['Featured', 'Recent', 'Notifications'],
  games: ['Installed', 'Demos', 'Achievements'],
  media: ['Watch', 'Listen', 'Library'],
  social: ['Friends', 'Messages', 'Invites'],
  store: ['Featured', 'New', 'Collections'],
  settings: ['Graphics', 'System', 'Storage'],
};

const MOCK_FRIENDS_ONLINE = 2;
const MOCK_NOTIFICATIONS = 3;

export function MainMenu({ onPlay, onEditor }: MainMenuProps) {
  const [games, setGames] = useState<GameEntry[]>([]);
  const [currentGameId, setCurrentGameId] = useState<string>('');
  const [currentStartScene, setCurrentStartScene] = useState<string>('main');
  const [activeTab, setActiveTab] = useState<MenuTab>('home');
  const [clock, setClock] = useState<string>(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadGames = async () => {
      try {
        const items = await listGames(true);
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

  const gameOptions = games.map((game) => h('option', { key: game.id, value: game.id }, game.name));
  const disabled = useMemo(() => !currentGameId, [currentGameId]);
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
    { className: 'menu nxe-menu nxe-menu-3d' },
    h('div', { className: 'nxe-bg-orb nxe-bg-orb-a' }),
    h('div', { className: 'nxe-bg-orb nxe-bg-orb-b' }),
    h(
      'div',
      { className: 'nxe-shell' },
      h(
        'header',
        { className: 'nxe-header' },
        h(
          'div',
          { className: 'nxe-brand' },
          h('strong', null, 'Sleepy Engine'),
          h('span', null, '3D Dashboard'),
        ),
        h(
          'div',
          { className: 'nxe-status' },
          h('span', { className: 'nxe-pill' }, 'Online'),
          h('span', { className: 'nxe-clock' }, clock),
        ),
      ),
      h(
        'nav',
        { className: 'nxe-tabs' },
        ...MENU_TABS.map((tab) =>
          h(
            'button',
            {
              key: tab.id,
              className: `nxe-tab${activeTab === tab.id ? ' active' : ''}`,
              onClick: () => setActiveTab(tab.id),
            },
            h('span', { className: 'nxe-tab-icon', 'aria-hidden': 'true' }, tab.icon),
            h('span', null, tab.label),
          ),
        ),
      ),
      h(
        'div',
        { className: 'nxe-subnav' },
        ...TAB_SUBNAV[activeTab].map((item) => h('span', { key: item, className: 'nxe-subnav-item' }, item)),
      ),
      h(
        'section',
        { className: 'nxe-stage nxe-stage-full' },
        h(MainMenuScene3D, {
          activeTab,
          gameId: currentGameId,
          gameName: selectedGameName,
          startScene: currentStartScene,
          gamesCount: games.length,
          notificationsCount: MOCK_NOTIFICATIONS,
          friendsOnline: MOCK_FRIENDS_ONLINE,
          onSelectTab: setActiveTab,
          onPlay: handlePlay,
          onEditor: handleEditor,
        }),
      ),
      h(
        'div',
        { className: 'nxe-utility-row' },
        h(
          'div',
          { className: 'nxe-3d-controls' },
          h(
            'label',
            { className: 'nxe-3d-field' },
            h('span', null, 'Game'),
            h(
              UiSelect,
              {
                value: currentGameId,
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setCurrentGameId(event.target.value),
              },
              gameOptions,
            ),
          ),
          h(
            UiButton,
            { variant: 'primary', disabled, onClick: handlePlay },
            'Play',
          ),
          h(
            UiButton,
            { disabled, onClick: handleEditor },
            'Editor',
          ),
        ),
        h(PlayerProfileCard, { gameId: currentGameId, scene: currentStartScene, gameName: selectedGameName }),
      ),
    ),
  );
}
