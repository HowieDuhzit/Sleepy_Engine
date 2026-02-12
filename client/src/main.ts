import './style.css';
import { GameApp } from './game/GameApp';
import { EditorApp } from './editor/EditorApp';
import { createMenu } from './ui/Menu';
import { createSplash } from './ui/Splash';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app');

let app: { start: () => void; stop: () => void } | null = null;

const startGame = (scene?: string, gameId?: string) => {
  app?.stop();
  app = new GameApp(container, scene, gameId);
  app.start();
};

const startEditor = (gameId?: string) => {
  app?.stop();
  app = new EditorApp(container, gameId);
  app.start();
};

const menu = createMenu((choice, gameId, scene) => {
  container.innerHTML = '';
  splash.remove();
  if (choice === 'game') startGame(scene, gameId);
  if (choice === 'editor') startEditor(gameId);
});

const splash = createSplash();
document.body.appendChild(splash);
container.appendChild(menu);

const dismissSplash = () => {
  if (!document.body.contains(splash)) return;
  splash.classList.add('splash-hide');
  window.setTimeout(() => splash.remove(), 650);
};
window.setTimeout(dismissSplash, 5000);

window.addEventListener('beforeunload', () => {
  app?.stop();
});
