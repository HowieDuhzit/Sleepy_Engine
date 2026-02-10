export function createMenu(onSelect: (choice: 'game' | 'editor') => void) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = [
    '<div class="menu-card">',
    '<h1>Trashy Engine</h1>',
    '<p>Choose a scene</p>',
    '<button data-game>Play Prototype</button>',
    '<button data-editor>Animation Editor</button>',
    '</div>',
  ].join('');

  const gameBtn = menu.querySelector('[data-game]') as HTMLButtonElement;
  const editorBtn = menu.querySelector('[data-editor]') as HTMLButtonElement;

  gameBtn.addEventListener('click', () => onSelect('game'));
  editorBtn.addEventListener('click', () => onSelect('editor'));

  return menu;
}
