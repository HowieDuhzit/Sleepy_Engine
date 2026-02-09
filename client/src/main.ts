import './style.css';
import { GameApp } from './game/GameApp';

const app = new GameApp(document.getElementById('app'));
app.start();

window.addEventListener('beforeunload', () => {
  app.stop();
});
