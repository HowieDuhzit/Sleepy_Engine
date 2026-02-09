type KeyState = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  attack: boolean;
  interact: boolean;
  jump: boolean;
  crouch: boolean;
};

export class InputState {
  private keys: KeyState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    sprint: false,
    attack: false,
    interact: false,
    jump: false,
    crouch: false,
  };
  private keyDownHandler = this.handleKey(true);
  private keyUpHandler = this.handleKey(false);
  private lastKey = 'none';
  private lastPad = 'pad: none';
  private padVector = { x: 0, z: 0 };
  private padLook = { x: 0, y: 0 };
  private padFlags = { sprint: false, attack: false, interact: false, jump: false, crouch: false };

  constructor() {
    document.addEventListener('keydown', this.keyDownHandler, { capture: true });
    document.addEventListener('keyup', this.keyUpHandler, { capture: true });
    window.addEventListener('blur', this.reset);
  }

  dispose() {
    document.removeEventListener('keydown', this.keyDownHandler, { capture: true });
    document.removeEventListener('keyup', this.keyUpHandler, { capture: true });
    window.removeEventListener('blur', this.reset);
  }

  getVector() {
    const keyX = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    const keyZ = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
    const padX = this.padVector.x;
    const padZ = this.padVector.z;
    const x = Math.abs(padX) > 0.01 ? padX : keyX;
    const z = Math.abs(padZ) > 0.01 ? padZ : keyZ;
    return { x, z: -z };
  }

  getFlags() {
    return {
      sprint: this.padFlags.sprint || this.keys.sprint,
      attack: this.padFlags.attack || this.keys.attack,
      interact: this.padFlags.interact || this.keys.interact,
      jump: this.padFlags.jump || this.keys.jump,
      crouch: this.padFlags.crouch || this.keys.crouch,
    };
  }

  getLastKey() {
    return this.lastKey;
  }

  getLastPad() {
    return this.lastPad;
  }

  getLook() {
    return { ...this.padLook };
  }

  getKeyState() {
    return { ...this.keys };
  }

  updateGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && pads.length ? pads[0] : null;
    if (!pad) {
      this.padVector = { x: 0, z: 0 };
      this.padFlags = { sprint: false, attack: false, interact: false, jump: false, crouch: false };
      this.lastPad = 'pad: none';
      return;
    }

    const deadzone = 0.2;
    const ax = pad.axes[0] ?? 0;
    const az = pad.axes[1] ?? 0;
    let rx = pad.axes[2] ?? 0;
    let ry = pad.axes[3] ?? 0;
    const filteredX = Math.abs(ax) > deadzone ? ax : 0;
    const filteredZ = Math.abs(az) > deadzone ? az : 0;
    let filteredRx = Math.abs(rx) > deadzone ? rx : 0;
    let filteredRy = Math.abs(ry) > deadzone ? ry : 0;
    if (Math.abs(filteredRx) < 0.01 && Math.abs(filteredRy) < 0.01 && pad.axes.length >= 5) {
      rx = pad.axes[3] ?? 0;
      ry = pad.axes[4] ?? 0;
      filteredRx = Math.abs(rx) > deadzone ? rx : 0;
      filteredRy = Math.abs(ry) > deadzone ? ry : 0;
    }
    this.padVector = { x: filteredX, z: -filteredZ };
    this.padLook = { x: filteredRx, y: filteredRy };

    this.padFlags = {
      sprint: !!pad.buttons[0]?.pressed,
      attack: !!pad.buttons[1]?.pressed,
      interact: !!pad.buttons[2]?.pressed,
      jump: !!pad.buttons[3]?.pressed,
      crouch: !!pad.buttons[6]?.pressed,
    };

    this.lastPad = `pad: ${pad.id}`;
  }

  private handleKey(active: boolean) {
    return (event: KeyboardEvent) => {
      this.lastKey = `${event.type}:${event.code}`;
      if (
        ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space', 'KeyE', 'KeyF', 'KeyC', 'ControlLeft'].includes(
          event.code,
        )
      ) {
        event.preventDefault();
      }
      switch (event.code) {
        case 'KeyW':
          this.keys.forward = active;
          break;
        case 'KeyS':
          this.keys.back = active;
          break;
        case 'KeyA':
          this.keys.left = active;
          break;
        case 'KeyD':
          this.keys.right = active;
          break;
        case 'ShiftLeft':
          this.keys.sprint = active;
          break;
        case 'KeyE':
          this.keys.interact = active;
          break;
        case 'Space':
          this.keys.jump = active;
          break;
        case 'KeyC':
        case 'ControlLeft':
          this.keys.crouch = active;
          break;
        case 'KeyF':
          this.keys.attack = active;
          break;
        default:
          break;
      }
    };
  }

  private reset = () => {
    this.keys.forward = false;
    this.keys.back = false;
    this.keys.left = false;
    this.keys.right = false;
    this.keys.sprint = false;
    this.keys.attack = false;
    this.keys.interact = false;
    this.keys.jump = false;
    this.keys.crouch = false;
  };
}
