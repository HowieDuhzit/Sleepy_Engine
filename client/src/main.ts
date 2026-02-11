import './style.css';
import { GameApp } from './game/GameApp';
import { EditorApp } from './editor/EditorApp';
import { createMenu } from './ui/Menu';

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
  if (choice === 'game') startGame(scene);
  if (choice === 'editor') startEditor();
});

container.appendChild(menu);

window.addEventListener('beforeunload', () => {
  app?.stop();
});
