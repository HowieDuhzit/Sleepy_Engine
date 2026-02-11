export const createSplash = () => {
  const splash = document.createElement('div');
  splash.className = 'splash-screen';
  splash.innerHTML = `
    <div class="splash-console">
      <div class="splash-frame">
        <div class="splash-burst"></div>
        <img class="splash-logo" src="https://sleepystudio.xyz/SleepyStudioBlackShadowed.png" alt="Sleepy Studio" />
        <div class="splash-ring"></div>
      </div>
      <div class="splash-flash"></div>
    </div>
  `;
  return splash;
};
