type SceneOption = { name: string };

export function createMenu(onSelect: (choice: 'game' | 'editor', scene?: string) => void) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = [
    '<div class="menu-card">',
    '<h1>Sleepy Engine</h1>',
    '<p>Choose a scene</p>',
    '<label class="menu-field"><span>Scene</span><select data-scene></select></label>',
    '<button data-game>Play Scene</button>',
    '<button data-editor>Editor</button>',
    '</div>',
  ].join('');

  const gameBtn = menu.querySelector('[data-game]') as HTMLButtonElement;
  const editorBtn = menu.querySelector('[data-editor]') as HTMLButtonElement;
  const sceneSelect = menu.querySelector('[data-scene]') as HTMLSelectElement;

  const loadScenes = async () => {
    try {
      const res = await fetch('/config/scenes.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as { scenes?: SceneOption[] };
      const scenes = data.scenes?.length ? data.scenes : [{ name: 'prototype' }];
      sceneSelect.innerHTML = '';
      for (const scene of scenes) {
        const opt = document.createElement('option');
        opt.value = scene.name;
        opt.textContent = scene.name;
        sceneSelect.appendChild(opt);
      }
    } catch {
      const opt = document.createElement('option');
      opt.value = 'prototype';
      opt.textContent = 'prototype';
      sceneSelect.appendChild(opt);
    }
  };
  void loadScenes();

  gameBtn.addEventListener('click', () => onSelect('game', sceneSelect.value || 'prototype'));
  editorBtn.addEventListener('click', () => onSelect('editor'));

  return menu;
}
