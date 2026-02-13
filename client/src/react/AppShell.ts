import React, { useEffect, useRef, useState } from 'react';
import { GameApp } from '../game/GameApp';
import { EditorApp } from '../editor/EditorApp';
import { createMenu } from '../ui/Menu';
import { createSplash } from '../ui/Splash';

type LegacyApp = { start: () => void; stop: () => void };

type AppState =
  | { mode: 'menu' }
  | { mode: 'game'; gameId?: string; scene?: string }
  | { mode: 'editor'; gameId?: string };

export function AppShell() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<LegacyApp | null>(null);
  const [state, setState] = useState<AppState>({ mode: 'menu' });

  useEffect(() => {
    const splash = createSplash();
    document.body.appendChild(splash);

    const dismissSplash = () => {
      if (!document.body.contains(splash)) return;
      splash.classList.add('splash-hide');
      window.setTimeout(() => splash.remove(), 650);
    };

    const timer = window.setTimeout(dismissSplash, 5000);
    return () => {
      window.clearTimeout(timer);
      if (document.body.contains(splash)) {
        splash.remove();
      }
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    appRef.current?.stop();
    appRef.current = null;
    host.innerHTML = '';

    if (state.mode === 'menu') {
      const menu = createMenu((choice, gameId, scene) => {
        if (choice === 'game') {
          setState({ mode: 'game', gameId, scene });
          return;
        }
        setState({ mode: 'editor', gameId });
      });
      host.appendChild(menu);
      return;
    }

    if (state.mode === 'game') {
      const app = new GameApp(host, state.scene, state.gameId, () => setState({ mode: 'menu' }));
      appRef.current = app;
      app.start();
      return;
    }

    const app = new EditorApp(host, state.gameId, () => setState({ mode: 'menu' }));
    appRef.current = app;
    app.start();
  }, [state]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      appRef.current?.stop();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      appRef.current?.stop();
      appRef.current = null;
    };
  }, []);

  return React.createElement('div', { ref: hostRef, className: 'app-shell' });
}
