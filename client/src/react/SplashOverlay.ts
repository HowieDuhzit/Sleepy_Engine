import React, { useEffect, useState } from 'react';

const h = React.createElement;

export function SplashOverlay() {
  const [hiding, setHiding] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const hideTimer = window.setTimeout(() => setHiding(true), 5000);
    const removeTimer = window.setTimeout(() => setVisible(false), 5650);

    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(removeTimer);
    };
  }, []);

  if (!visible) return null;

  return h(
    'div',
    { className: `splash-screen${hiding ? ' splash-hide' : ''}` },
    h(
      'div',
      { className: 'splash-console' },
      h(
        'div',
        { className: 'splash-frame' },
        h('div', { className: 'splash-burst' }),
        h('img', {
          className: 'splash-logo',
          src: 'https://sleepystudio.xyz/SleepyStudioBlackShadowed.png',
          alt: 'Sleepy Studio',
        }),
        h('div', { className: 'splash-ring' }),
      ),
      h('div', { className: 'splash-flash' }),
    ),
  );
}
