import './style.css';
import { GameApp } from './game/GameApp';
import { EditorApp } from './editor/EditorApp';
import { createMenu } from './ui/Menu';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app');

let app: { start: () => void; stop: () => void } | null = null;

const startGame = () => {
  app?.stop();
  app = new GameApp(container);
  app.start();
};

const startEditor = () => {
  app?.stop();
  app = new EditorApp(container);
  app.start();
};

const menu = createMenu((choice) => {
  container.innerHTML = '';
  if (choice === 'game') startGame();
  if (choice === 'editor') startEditor();
});

container.appendChild(menu);

window.addEventListener('beforeunload', () => {
  app?.stop();
});
