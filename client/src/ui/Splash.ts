export const createSplash = () => {
  const splash = document.createElement('div');
  splash.className = 'splash-screen';
  splash.innerHTML = `
    <div class="splash-console">
      <div class="splash-bezel">
        <div class="splash-crt">
          <img class="splash-logo" src="https://sleepystudio.xyz/SleepyStudioBlackShadowed.png" alt="Sleepy Studio" />
          <div class="splash-glow"></div>
        </div>
      </div>
      <div class="splash-controls">
        <div class="splash-led"></div>
        <div class="splash-led"></div>
      </div>
      <div class="splash-boot">
        <div class="splash-boot-title">Sleepy Computer Systems</div>
        <div class="splash-boot-sub">Licensed by Sleepy Engine</div>
      </div>
      <div class="splash-bar">
        <div class="splash-bar-fill"></div>
      </div>
      <div class="splash-footer">
        <span data-splash-status>WAKING UP</span>
        <span class="splash-blink">PRESS ANY KEY</span>
      </div>
    </div>
  `;
  return splash;
};
