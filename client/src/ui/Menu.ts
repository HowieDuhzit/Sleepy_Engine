import { PSXSettingsPanel } from './PSXSettingsPanel';
import { getGameScenes, listGames } from '../services/game-api';

export function createMenu(onSelect: (choice: 'game' | 'editor', gameId?: string, scene?: string) => void) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = [
    '<div class="menu-card">',
    '<h1 class="menu-title">Sleepy Engine</h1>',
    '<p class="menu-description">Choose a game</p>',
    '<label class="menu-field"><span>Game</span><select data-game-id></select></label>',
    '<button class="ui-button ui-button-primary" data-play>Play</button>',
    '<button class="ui-button" data-editor>Editor</button>',
    '<button class="ui-button ui-button-ghost" data-settings>Settings</button>',
    '</div>',
    '<div class="menu-settings" hidden></div>',
  ].join('');

  const playBtn = menu.querySelector('[data-play]') as HTMLButtonElement;
  const editorBtn = menu.querySelector('[data-editor]') as HTMLButtonElement;
  const settingsBtn = menu.querySelector('[data-settings]') as HTMLButtonElement;
  const gameSelect = menu.querySelector('[data-game-id]') as HTMLSelectElement;
  const settingsContainer = menu.querySelector('.menu-settings') as HTMLElement;

  let currentGameId: string | null = null;
  let currentStartScene = 'main';

  const loadGames = async () => {
    try {
      const games = await listGames();
      gameSelect.innerHTML = '';
      for (const game of games) {
        const opt = document.createElement('option');
        opt.value = game.id;
        opt.textContent = game.name;
        gameSelect.appendChild(opt);
      }
      // Auto-select prototype if available
      if (games.find((g) => g.id === 'prototype')) {
        gameSelect.value = 'prototype';
        currentGameId = 'prototype';
      } else if (games.length > 0) {
        currentGameId = games[0]?.id ?? null;
      }
      await loadStartScene();
    } catch (err) {
      console.error('Failed to load games:', err);
      currentGameId = null;
      currentStartScene = 'main';
    }
  };

  const loadStartScene = async () => {
    if (!currentGameId) return;
    try {
      const data = await getGameScenes(currentGameId);
      currentStartScene = data.scenes?.[0]?.name ?? 'main';
    } catch (err) {
      console.error('Failed to load game scenes:', err);
      currentStartScene = 'main';
    }
  };

  gameSelect.addEventListener('change', () => {
    currentGameId = gameSelect.value;
    void loadStartScene();
  });

  void loadGames();

  // Create PSX settings panel
  const psxPanel = new PSXSettingsPanel();
  settingsContainer.appendChild(psxPanel.getElement());

  // Menu navigation
  const menuCard = menu.querySelector('.menu-card') as HTMLElement;

  playBtn.addEventListener('click', () => {
    if (!currentGameId) return;
    onSelect('game', currentGameId, currentStartScene);
  });
  editorBtn.addEventListener('click', () => {
    if (!currentGameId) return;
    onSelect('editor', currentGameId, currentStartScene);
  });

  settingsBtn.addEventListener('click', () => {
    menuCard.style.display = 'none';
    settingsContainer.hidden = false;
  });

  // Add back button to settings
  const backBtn = document.createElement('button');
  backBtn.textContent = 'Back to Menu';
  backBtn.className = 'ui-button menu-back-button';
  backBtn.addEventListener('click', () => {
    settingsContainer.hidden = true;
    menuCard.style.display = 'block';
  });
  settingsContainer.appendChild(backBtn);

  return menu;
}
