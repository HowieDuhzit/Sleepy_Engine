import React, { useEffect, useRef } from 'react';

type LegacyApp = { start: () => void; stop: () => void };

type LegacyAppHostProps = {
  createApp: (container: HTMLElement) => LegacyApp;
};

const h = React.createElement;

export function LegacyAppHost({ createApp }: LegacyAppHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<LegacyApp | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    host.innerHTML = '';
    const app = createApp(host);
    appRef.current = app;
    app.start();

    return () => {
      appRef.current?.stop();
      appRef.current = null;
      host.innerHTML = '';
    };
  }, [createApp]);

  return h('div', { ref: hostRef, className: 'app-shell' });
}
