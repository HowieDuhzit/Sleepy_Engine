import React, { useCallback, useRef, useState } from 'react';
import { EditorApp } from '../editor/EditorApp';
import { LegacyAppHost } from './LegacyAppHost';
import { UiButton, UiCard, UiSectionTitle, UiSelect } from './ui-primitives';

type EditorViewProps = {
  gameId?: string;
  onBackToMenu: () => void;
};

type EditorTab = 'animation' | 'player' | 'level' | 'settings';
type GameEntry = { id: string; name: string };

const h = React.createElement;

export function EditorView({ gameId, onBackToMenu }: EditorViewProps) {
  const appRef = useRef<EditorApp | null>(null);
  const leftHostRef = useRef<HTMLDivElement | null>(null);
  const bottomHostRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<EditorTab>('animation');
  const [games, setGames] = useState<GameEntry[]>([]);
  const [selectedGame, setSelectedGame] = useState<string>(gameId ?? '');

  const createApp = useCallback((container: HTMLElement) => new EditorApp(container, gameId, onBackToMenu), [gameId, onBackToMenu]);

  const mountPanels = useCallback((tabName: EditorTab) => {
    const app = appRef.current;
    const leftHost = leftHostRef.current;
    const bottomHost = bottomHostRef.current;
    if (!app || !leftHost || !bottomHost) return;
    app.mountExternalPanel(tabName, 'left', leftHost);
    app.mountExternalPanel(tabName, 'bottom', bottomHost);
  }, []);

  const refreshGames = useCallback(async () => {
    const app = appRef.current;
    if (!app) return;
    const entries = await app.listAvailableGamesFromUi();
    setGames(entries);
    const current = app.getCurrentGameId() ?? entries[0]?.id ?? '';
    setSelectedGame(current);
  }, []);

  return h(
    'div',
    { className: 'editor-react-layout' },
    h(
      UiCard,
      { className: 'react-mode-header editor-react-header' },
      h(UiButton, { onClick: onBackToMenu }, 'Back to Menu'),
      h(UiSectionTitle, { className: 'editor-react-title' }, 'Sleepy Engine Editor'),
      h(
        'label',
        { className: 'editor-react-game' },
        h('span', null, 'Game'),
        h(
          UiSelect,
          {
            value: selectedGame,
            onChange: async (event: React.ChangeEvent<HTMLSelectElement>) => {
              const next = event.target.value;
              setSelectedGame(next);
              await appRef.current?.selectGameFromUi(next);
            },
          },
          ...games.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))
        )
      ),
      h(
        UiButton,
        {
          onClick: async () => {
            const name = prompt('Enter game name:');
            if (!name) return;
            const description = prompt('Enter game description (optional):') || '';
            try {
              const created = await appRef.current?.createGameFromUi(name, description);
              await refreshGames();
              if (created?.id) {
                setSelectedGame(created.id);
              }
            } catch (error) {
              alert(`Error creating game: ${String(error)}`);
            }
          },
        },
        'New Game'
      ),
      h(
        'div',
        { className: 'editor-react-tabs shad-tabs' },
        ...(['animation', 'player', 'level', 'settings'] as EditorTab[]).map((tabName) =>
          h(
            UiButton,
            {
              key: tabName,
              variant: tab === tabName ? 'primary' : 'default',
              onClick: () => {
                setTab(tabName);
                appRef.current?.setTabFromUi(tabName);
                mountPanels(tabName);
              },
            },
            tabName.toUpperCase()
          )
        )
      )
    ),
    h(
      'div',
      { className: 'editor-react-main' },
      h('div', { ref: leftHostRef, className: 'editor-react-left shad-dock' }),
      h(
        'div',
        { className: 'editor-react-viewport' },
        h(LegacyAppHost<EditorApp>, {
          createApp,
          onAppReady: async (app) => {
            appRef.current = app;
            app.setExternalShellEnabled(true);
            const currentTab = app.getCurrentTab();
            setTab(currentTab);
            await refreshGames();
            if (selectedGame) {
              await app.selectGameFromUi(selectedGame);
            }
            mountPanels(currentTab);
          },
          onAppDispose: () => {
            appRef.current = null;
          },
        })
      )
    ),
    h('div', { ref: bottomHostRef, className: 'editor-react-bottom shad-dock' })
  );
}
