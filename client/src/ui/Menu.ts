import { PSXSettingsPanel } from './PSXSettingsPanel';

type SceneOption = { name: string };

export function createMenu(onSelect: (choice: 'game' | 'editor', scene?: string, projectId?: string) => void) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = [
    '<div class="menu-card">',
    '<h1>Sleepy Engine</h1>',
    '<p>Choose a game project</p>',
    '<label class="menu-field"><span>Project</span><select data-project></select></label>',
    '<label class="menu-field"><span>Scene</span><select data-scene></select></label>',
    '<button data-game>Play Scene</button>',
    '<button data-editor>Editor</button>',
    '<button data-settings>Settings</button>',
    '</div>',
    '<div class="menu-settings" style="display: none;"></div>',
  ].join('');

  const gameBtn = menu.querySelector('[data-game]') as HTMLButtonElement;
  const editorBtn = menu.querySelector('[data-editor]') as HTMLButtonElement;
  const settingsBtn = menu.querySelector('[data-settings]') as HTMLButtonElement;
  const projectSelect = menu.querySelector('[data-project]') as HTMLSelectElement;
  const sceneSelect = menu.querySelector('[data-scene]') as HTMLSelectElement;
  const settingsContainer = menu.querySelector('.menu-settings') as HTMLElement;

  let currentProjectId: string | null = null;

  const loadProjects = async () => {
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!res.ok) throw new Error('failed to load projects');
      const data = (await res.json()) as { projects: { id: string; name: string }[] };
      projectSelect.innerHTML = '';
      for (const project of data.projects) {
        const opt = document.createElement('option');
        opt.value = project.id;
        opt.textContent = project.name;
        projectSelect.appendChild(opt);
      }
      // Auto-select prototype if available
      if (data.projects.find((p) => p.id === 'prototype')) {
        projectSelect.value = 'prototype';
        currentProjectId = 'prototype';
      } else if (data.projects.length > 0) {
        currentProjectId = data.projects[0]?.id ?? null;
      }
      await loadScenes();
    } catch (err) {
      console.error('Failed to load projects:', err);
      const opt = document.createElement('option');
      opt.value = 'prototype';
      opt.textContent = 'prototype';
      projectSelect.appendChild(opt);
      currentProjectId = 'prototype';
    }
  };

  const loadScenes = async () => {
    if (!currentProjectId) {
      sceneSelect.innerHTML = '<option value="">-- Select project first --</option>';
      return;
    }
    try {
      const res = await fetch(`/api/projects/${currentProjectId}/scenes`, { cache: 'no-store' });
      if (!res.ok) throw new Error('failed to load scenes');
      const data = (await res.json()) as { scenes?: SceneOption[] };
      const scenes = data.scenes?.length ? data.scenes : [{ name: 'prototype' }];
      sceneSelect.innerHTML = '';
      for (const scene of scenes) {
        const opt = document.createElement('option');
        opt.value = scene.name;
        opt.textContent = scene.name;
        sceneSelect.appendChild(opt);
      }
    } catch (err) {
      console.error('Failed to load scenes:', err);
      const opt = document.createElement('option');
      opt.value = 'prototype';
      opt.textContent = 'prototype';
      sceneSelect.appendChild(opt);
    }
  };

  projectSelect.addEventListener('change', () => {
    currentProjectId = projectSelect.value;
    void loadScenes();
  });

  void loadProjects();

  // Create PSX settings panel
  const psxPanel = new PSXSettingsPanel();
  settingsContainer.appendChild(psxPanel.getElement());

  // Menu navigation
  const menuCard = menu.querySelector('.menu-card') as HTMLElement;

  gameBtn.addEventListener('click', () => onSelect('game', sceneSelect.value || 'prototype', currentProjectId || 'prototype'));
  editorBtn.addEventListener('click', () => onSelect('editor'));

  settingsBtn.addEventListener('click', () => {
    menuCard.style.display = 'none';
    settingsContainer.style.display = 'block';
  });

  // Add back button to settings
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Back to Menu';
  backBtn.style.cssText = 'margin-top: 20px; padding: 10px; width: 100%;';
  backBtn.addEventListener('click', () => {
    settingsContainer.style.display = 'none';
    menuCard.style.display = 'block';
  });
  settingsContainer.appendChild(backBtn);

  return menu;
}
