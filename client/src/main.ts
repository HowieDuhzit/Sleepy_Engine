import './style.css';
import { GameApp } from './game/GameApp';
import { EditorApp } from './editor/EditorApp';
import { createMenu } from './ui/Menu';
import { createSplash } from './ui/Splash';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app');

let app: { start: () => void; stop: () => void } | null = null;

const startGame = (scene?: string) => {
  app?.stop();
  app = new GameApp(container, scene);
  app.start();
};

const startEditor = () => {
  app?.stop();
  app = new EditorApp(container);
  app.start();
};

const menu = createMenu((choice, scene) => {
  container.innerHTML = '';
  splash.remove();
  if (choice === 'game') startGame(scene);
  if (choice === 'editor') startEditor();
});

const splash = createSplash();
document.body.appendChild(splash);
container.appendChild(menu);

const dismissSplash = () => {
  if (!document.body.contains(splash)) return;
  splash.classList.add('splash-hide');
  window.setTimeout(() => splash.remove(), 650);
};

window.addEventListener('keydown', dismissSplash, { once: true });
window.addEventListener('pointerdown', dismissSplash, { once: true });
window.setTimeout(dismissSplash, 2200);

window.addEventListener('beforeunload', () => {
  app?.stop();
});
