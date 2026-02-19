import React, { useEffect, useState } from 'react';

const h = React.createElement;

type SplashOverlayProps = {
  onFinish?: () => void;
};

export function SplashOverlay({ onFinish }: SplashOverlayProps) {
  const [hiding, setHiding] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const hideTimer = window.setTimeout(() => setHiding(true), 5000);
    const removeTimer = window.setTimeout(() => {
      setVisible(false);
      onFinish?.();
    }, 5650);

    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(removeTimer);
    };
  }, [onFinish]);

  if (!visible) return null;

  return h(
    'div',
    { className: `splash-screen${hiding ? ' splash-hide' : ''}` },
    h('img', {
      className: 'splash-logo splash-logo-only',
      src: 'https://sleepystudio.xyz/SleepyStudioBlackShadowed.png',
      alt: 'Sleepy Studio',
    }),
  );
}
