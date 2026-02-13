import React, { useEffect, useRef } from 'react';

type LegacyApp = { start: () => void; stop: () => void };

type LegacyAppHostProps<T extends LegacyApp> = {
  createApp: (container: HTMLElement) => T;
  onAppReady?: (app: T) => void;
  onAppDispose?: () => void;
};

const h = React.createElement;

export function LegacyAppHost<T extends LegacyApp>({ createApp, onAppReady, onAppDispose }: LegacyAppHostProps<T>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<T | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    host.innerHTML = '';
    const app = createApp(host);
    appRef.current = app;
    app.start();
    onAppReady?.(app);

    return () => {
      appRef.current?.stop();
      appRef.current = null;
      onAppDispose?.();
      host.innerHTML = '';
    };
  }, [createApp, onAppDispose, onAppReady]);

  return h('div', { ref: hostRef, className: 'app-shell' });
}
