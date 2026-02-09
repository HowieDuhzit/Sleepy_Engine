import * as THREE from 'three';
import { InputState } from '../input/InputState';
import { RoomClient } from '../net/RoomClient';
import {
  PlayerSnapshot,
  OBSTACLES,
  PLAYER_RADIUS,
  MOVE_SPEED,
  SPRINT_MULTIPLIER,
  CROUCH_MULTIPLIER,
  SLIDE_ACCEL,
  SLIDE_FRICTION,
  GRAVITY,
  JUMP_SPEED,
  GROUND_Y,
  resolveCircleAabb,
} from '@trashy/shared';

export class GameApp {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private orbitYaw = 0;
  private orbitPitch = Math.PI / 4;
  private orbitRadius = 18;
  private orbitOffset = new THREE.Vector3();
  private orbitSpherical = new THREE.Spherical();
  private isDragging = false;
  private lastMouse = { x: 0, y: 0 };
  private pointerLocked = false;
  private clock: THREE.Clock;
  private lastTime = performance.now();
  private animationId: number | null = null;
  private hud: HTMLDivElement;
  private crowd: THREE.InstancedMesh;
  private localPlayer: THREE.Mesh;
  private localVelocityY = 0;
  private localVelocityX = 0;
  private localVelocityZ = 0;
  private input: InputState;
  private roomClient: RoomClient;
  private seq = 0;
  private networkAccumulator = 0;
  private remotePlayers = new Map<string, THREE.Mesh>();
  private localId: string | null = null;
  private statusLines = {
    connection: 'connecting...',
    players: 'players: 0',
    input: 'input: 0, 0',
    key: 'key: none',
    focus: 'focus: unknown',
    keys: 'keys: -',
    pos: 'pos: 0.0, 0.0',
    pad: 'pad: none',
    look: 'look: 0.00, 0.00',
    orbit: 'orbit: 0.00, 0.00',
    move: 'move: 0.00, 0.00',
    dt: 'dt: 0.000',
  };
  private inputDebugTimer = 0;

  constructor(container: HTMLElement | null) {
    if (!container) {
      throw new Error('Missing #app container');
    }
    this.container = container;
    this.container.tabIndex = 0;
    this.container.addEventListener('click', () => this.container.focus());
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0b0c12, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0b0c12, 20, 120);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 300);
    this.camera.position.set(0, 12, 18);
    this.camera.lookAt(0, 0, 0);
    this.orbitOffset.copy(this.camera.position);
    this.orbitSpherical.setFromVector3(this.orbitOffset);
    this.orbitYaw = this.orbitSpherical.theta;
    this.orbitPitch = this.orbitSpherical.phi;
    this.orbitRadius = this.orbitSpherical.radius;

    this.clock = new THREE.Clock();
    this.hud = this.createHud();
    this.crowd = this.createCrowd();
    this.input = new InputState();
    const host =
      window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
    this.roomClient = new RoomClient(`http://${host}:2567`);
    this.localPlayer = this.createPlayer();

    this.container.appendChild(this.renderer.domElement);
    this.container.appendChild(this.hud);
    this.container.focus();
    window.addEventListener('keydown', (event) => {
      const value = `raw: ${event.code || event.key}`;
      this.statusLines.key = `key: ${value}`;
      const node = this.hud.querySelector('[data-hud-key]');
      if (node) node.textContent = `key: ${value}`;
    });
    this.scene.add(
      this.createLights(),
      this.createGround(),
      this.createGrid(),
      this.createLandmark(),
      this.createObstacles(),
      this.localPlayer,
      this.crowd,
    );

    this.renderer.domElement.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mouseup', this.handleMouseUp);
    this.renderer.domElement.addEventListener('wheel', this.handleWheel, { passive: true });
    this.renderer.domElement.addEventListener('click', this.requestPointerLock);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);

    window.addEventListener('resize', this.handleResize);
  }

  start() {
    if (this.animationId !== null) return;
    this.clock.start();
    this.lastTime = performance.now();
    this.connect();
    this.tick();
  }

  stop() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    window.removeEventListener('resize', this.handleResize);
  }

  private tick = () => {
    const now = performance.now();
    const delta = Math.max(0, Math.min(0.1, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const elapsed = this.clock.getElapsedTime();
    this.animateCrowd(elapsed);
    this.input.updateGamepad();
    this.animateLocalPlayer(delta);
    this.updateCamera(delta);
    this.updateFocusHud();
    this.updateKeysHud();
    this.updatePosHud();
    this.updatePadHud();
    this.updateLookHud();
    this.updateOrbitHud();
    this.updateMoveHud();
    this.updateDtHud(delta);
    this.tickNetwork(delta);
    this.renderer.render(this.scene, this.camera);
    this.animationId = requestAnimationFrame(this.tick);
  };

  private handleResize = () => {
    const { innerWidth, innerHeight } = window;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  };

  private createLights() {
    const group = new THREE.Group();
    const ambient = new THREE.AmbientLight(0x8fa0bf, 0.6);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(20, 30, 10);
    const rim = new THREE.DirectionalLight(0xff5566, 0.5);
    rim.position.set(-20, 15, -10);
    group.add(ambient, key, rim);
    return group;
  }

  private createGround() {
    const geometry = new THREE.PlaneGeometry(120, 120, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x1c212b, roughness: 0.9, metalness: 0.1 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.5;
    return mesh;
  }

  private createGrid() {
    const grid = new THREE.GridHelper(120, 24, 0x3b4252, 0x2d3340);
    grid.position.y = -0.49;
    return grid;
  }

  private createLandmark() {
    const group = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(2, 0.4, 2),
      new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.6, metalness: 0.2 }),
    );
    base.position.set(12, -0.1, 6);
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.6, 5, 12),
      new THREE.MeshStandardMaterial({ color: 0xef476f, roughness: 0.4, metalness: 0.3 }),
    );
    pillar.position.set(12, 2.5, 6);
    group.add(base, pillar);
    return group;
  }

  private createObstacles() {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0x2a2f3c, roughness: 0.85, metalness: 0.1 });
    for (const obstacle of OBSTACLES) {
      const geometry = new THREE.BoxGeometry(
        obstacle.size.x,
        obstacle.size.y,
        obstacle.size.z,
      );
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(obstacle.position.x, obstacle.position.y, obstacle.position.z);
      group.add(mesh);
    }
    return group;
  }

  private createPlayer() {
    const geometry = new THREE.CapsuleGeometry(0.6, 1.2, 6, 12);
    const material = new THREE.MeshStandardMaterial({ color: 0x6be9ff, emissive: 0x0a1f2f });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, GROUND_Y, 0);
    return mesh;
  }

  private createCrowd() {
    const count = 300;
    const geometry = new THREE.CylinderGeometry(0.2, 0.3, 1.1, 6);
    const material = new THREE.MeshStandardMaterial({ color: 0xffb86b });
    const instanced = new THREE.InstancedMesh(geometry, material, count);
    const temp = new THREE.Object3D();

    for (let i = 0; i < count; i += 1) {
      const radius = 18 + Math.random() * 26;
      const angle = Math.random() * Math.PI * 2;
      temp.position.set(Math.cos(angle) * radius, 0.05, Math.sin(angle) * radius);
      temp.rotation.y = Math.random() * Math.PI * 2;
      temp.updateMatrix();
      instanced.setMatrixAt(i, temp.matrix);
    }

    return instanced;
  }

  private animateCrowd(time: number) {
    const temp = new THREE.Object3D();
    for (let i = 0; i < this.crowd.count; i += 1) {
      this.crowd.getMatrixAt(i, temp.matrix);
      temp.position.setFromMatrixPosition(temp.matrix);
      temp.position.x += Math.sin(time * 0.6 + i) * 0.002;
      temp.position.z += Math.cos(time * 0.6 + i) * 0.002;
      temp.updateMatrix();
      this.crowd.setMatrixAt(i, temp.matrix);
    }
    this.crowd.instanceMatrix.needsUpdate = true;
  }

  private createHud() {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = [
      '<strong>Trashy Game Prototype</strong>',
      `<div data-hud-connection>${this.statusLines.connection}</div>`,
      `<div data-hud-players>${this.statusLines.players}</div>`,
      `<div data-hud-input>${this.statusLines.input}</div>`,
      `<div data-hud-key>${this.statusLines.key}</div>`,
      `<div data-hud-focus>${this.statusLines.focus}</div>`,
      `<div data-hud-keys>${this.statusLines.keys}</div>`,
      `<div data-hud-pos>${this.statusLines.pos}</div>`,
      `<div data-hud-pad>${this.statusLines.pad}</div>`,
      `<div data-hud-look>${this.statusLines.look}</div>`,
      `<div data-hud-orbit>${this.statusLines.orbit}</div>`,
      `<div data-hud-move>${this.statusLines.move}</div>`,
      `<div data-hud-dt>${this.statusLines.dt}</div>`,
      '<div>Heat: 0.12 (low)</div>',
      '<div>Objective: ignite 3 hotspots</div>',
      '<div>WASD move, Shift sprint, Space jump, C/Ctrl crouch, F attack</div>',
    ].join('');
    return hud;
  }

  private async connect() {
    try {
      await this.roomClient.connect();
      this.localId = this.roomClient.getSessionId();
      this.setHud('connection', 'connected');
      this.roomClient.onSnapshot((players) => this.syncRemotePlayers(players));
    } catch (error) {
      this.setHud('connection', 'offline (server not running)');
      console.error(error);
    }
  }

  private tickNetwork(delta: number) {
    this.networkAccumulator += delta;
    if (this.networkAccumulator < 1 / 20) return;
    this.networkAccumulator = 0;

    const movement = this.input.getVector();
    const rotated = this.rotateMovementByCamera(movement.x, movement.z);
    const flags = this.input.getFlags();
    this.updateInputHud(movement.x, movement.z);
    this.updateKeyHud();

    this.roomClient.sendInput({
      seq: this.seq++,
      moveX: rotated.x,
      moveZ: rotated.z,
      lookYaw: 0,
      sprint: flags.sprint,
      attack: flags.attack,
      interact: flags.interact,
      jump: flags.jump,
      crouch: flags.crouch,
    });
  }

  private animateLocalPlayer(delta: number) {
    const flags = this.input.getFlags();
    const movement = this.input.getVector();
    const rotated = this.rotateMovementByCamera(movement.x, movement.z);
    const moveX = rotated.x;
    const moveZ = rotated.z;
    const speed = MOVE_SPEED * (flags.sprint ? SPRINT_MULTIPLIER : flags.crouch ? CROUCH_MULTIPLIER : 1);
    const slideMode = flags.sprint || flags.crouch;
    const accel = Math.min(1, SLIDE_ACCEL * delta);
    const targetVx = moveX * speed;
    const targetVz = moveZ * speed;
    if (slideMode) {
      this.localVelocityX += (targetVx - this.localVelocityX) * accel;
      this.localVelocityZ += (targetVz - this.localVelocityZ) * accel;
      if (Math.abs(moveX) < 0.05 && Math.abs(moveZ) < 0.05) {
        const damping = Math.max(0, 1 - SLIDE_FRICTION * delta);
        this.localVelocityX *= damping;
        this.localVelocityZ *= damping;
      }
    } else {
      this.localVelocityX = targetVx;
      this.localVelocityZ = targetVz;
    }
    if (flags.jump && this.localPlayer.position.y <= GROUND_Y + 0.001) {
      this.localVelocityY = JUMP_SPEED;
    }
    this.localVelocityY += GRAVITY * delta;
    const next = {
      x: this.localPlayer.position.x + this.localVelocityX * delta,
      y: this.localPlayer.position.y + this.localVelocityY * delta,
      z: this.localPlayer.position.z + this.localVelocityZ * delta,
    };
    if (next.y <= GROUND_Y) {
      next.y = GROUND_Y;
      this.localVelocityY = 0;
    }

    let resolved = next;
    for (const obstacle of OBSTACLES) {
      resolved = resolveCircleAabb(resolved, PLAYER_RADIUS, obstacle);
    }

    this.localPlayer.position.x = resolved.x;
    this.localPlayer.position.y = resolved.y;
    this.localPlayer.position.z = resolved.z;
  }

  private updateCamera(delta: number) {
    const target = new THREE.Vector3(
      this.localPlayer.position.x,
      this.localPlayer.position.y,
      this.localPlayer.position.z,
    );
    const look = this.input.getLook();
    const rotateSpeed = 0.05;
    if (Math.abs(look.x) > 0.01 || Math.abs(look.y) > 0.01) {
      this.orbitYaw -= look.x * rotateSpeed;
      this.orbitPitch -= look.y * rotateSpeed;
    }

    const minPolar = 0.2;
    const maxPolar = Math.PI - 0.2;
    this.orbitPitch = Math.max(minPolar, Math.min(maxPolar, this.orbitPitch));

    this.orbitSpherical.set(this.orbitRadius, this.orbitPitch, this.orbitYaw);
    this.orbitOffset.setFromSpherical(this.orbitSpherical);
    this.camera.position.copy(target).add(this.orbitOffset);
    this.camera.lookAt(target);
  }

  private rotateMovementByCamera(x: number, z: number) {
    // Project camera forward onto XZ so "forward" matches where the camera looks.
    const zAdjusted = -z;
    const target = new THREE.Vector3(
      this.localPlayer.position.x,
      this.localPlayer.position.y,
      this.localPlayer.position.z,
    );
    const forward = new THREE.Vector3().subVectors(target, this.camera.position);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      forward.set(0, 0, -1);
    } else {
      forward.normalize();
    }
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const world = new THREE.Vector3()
      .addScaledVector(right, x)
      .addScaledVector(forward, zAdjusted);
    return { x: world.x, z: world.z };
  }

  private handleMouseDown = (event: MouseEvent) => {
    if (this.pointerLocked) return;
    this.isDragging = true;
    this.lastMouse = { x: event.clientX, y: event.clientY };
  };

  private handleMouseMove = (event: MouseEvent) => {
    if (this.pointerLocked) {
      const sensitivity = 0.0025;
      this.orbitYaw -= event.movementX * sensitivity;
      this.orbitPitch -= event.movementY * sensitivity;
      return;
    }
    if (!this.isDragging) return;
    const dx = event.clientX - this.lastMouse.x;
    const dy = event.clientY - this.lastMouse.y;
    this.lastMouse = { x: event.clientX, y: event.clientY };
    const sensitivity = 0.005;
    this.orbitYaw -= dx * sensitivity;
    this.orbitPitch -= dy * sensitivity;
  };

  private handleMouseUp = () => {
    this.isDragging = false;
  };

  private handleWheel = (event: WheelEvent) => {
    const zoomSpeed = 0.01;
    this.orbitRadius = Math.min(40, Math.max(6, this.orbitRadius + event.deltaY * zoomSpeed));
  };

  private requestPointerLock = () => {
    if (document.pointerLockElement === this.renderer.domElement) return;
    this.renderer.domElement.requestPointerLock();
  };

  private handlePointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
  };

  private syncRemotePlayers(players: Record<string, PlayerSnapshot>) {
    this.setHud('players', `players: ${Object.keys(players).length}`);
    for (const [id, snapshot] of Object.entries(players)) {
      if (this.localId && id === this.localId) {
        this.reconcileLocal(snapshot);
        continue;
      }
      let mesh = this.remotePlayers.get(id);
      if (!mesh) {
        mesh = this.createRemotePlayer();
        this.remotePlayers.set(id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    }
  }

  private reconcileLocal(snapshot: PlayerSnapshot) {
    const dx = snapshot.position.x - this.localPlayer.position.x;
    const dz = snapshot.position.z - this.localPlayer.position.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > 0.04) {
      this.localPlayer.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
      this.localVelocityX = snapshot.velocity.x;
      this.localVelocityY = snapshot.velocity.y;
      this.localVelocityZ = snapshot.velocity.z;
    } else if (distSq > 0.0001) {
      this.localPlayer.position.lerp(
        new THREE.Vector3(snapshot.position.x, snapshot.position.y, snapshot.position.z),
        0.35,
      );
    }
  }

  private createRemotePlayer() {
    const geometry = new THREE.CapsuleGeometry(0.5, 1.1, 6, 10);
    const material = new THREE.MeshStandardMaterial({ color: 0xff6b6b, emissive: 0x2a0b0b });
    return new THREE.Mesh(geometry, material);
  }

  private setHud(key: 'connection' | 'players', value: string) {
    this.statusLines[key] = value;
    const selector = key === 'connection' ? '[data-hud-connection]' : '[data-hud-players]';
    const node = this.hud.querySelector(selector);
    if (node) node.textContent = value;
  }

  private updateInputHud(x: number, z: number) {
    this.inputDebugTimer += 1;
    if (this.inputDebugTimer % 5 !== 0) return;
    const value = `input: ${x.toFixed(2)}, ${z.toFixed(2)}`;
    this.statusLines.input = value;
    const node = this.hud.querySelector('[data-hud-input]');
    if (node) node.textContent = value;
  }

  private updateKeyHud() {
    const value = `key: ${this.input.getLastKey()}`;
    if (value === this.statusLines.key) return;
    this.statusLines.key = value;
    const node = this.hud.querySelector('[data-hud-key]');
    if (node) node.textContent = value;
  }

  private updateFocusHud() {
    const active = document.activeElement ? document.activeElement.tagName.toLowerCase() : 'none';
    const value = `focus: ${document.hasFocus() ? 'yes' : 'no'} (${active})`;
    if (value === this.statusLines.focus) return;
    this.statusLines.focus = value;
    const node = this.hud.querySelector('[data-hud-focus]');
    if (node) node.textContent = value;
  }

  private updateKeysHud() {
    const state = this.input.getKeyState();
    const value = `keys: ${state.forward ? 'W' : '-'}${state.left ? 'A' : '-'}${state.back ? 'S' : '-'}${state.right ? 'D' : '-'}`;
    if (value === this.statusLines.keys) return;
    this.statusLines.keys = value;
    const node = this.hud.querySelector('[data-hud-keys]');
    if (node) node.textContent = value;
  }

  private updatePosHud() {
    const value = `pos: ${this.localPlayer.position.x.toFixed(2)}, ${this.localPlayer.position.z.toFixed(2)}`;
    if (value === this.statusLines.pos) return;
    this.statusLines.pos = value;
    const node = this.hud.querySelector('[data-hud-pos]');
    if (node) node.textContent = value;
  }

  private updatePadHud() {
    const value = this.input.getLastPad();
    if (value === this.statusLines.pad) return;
    this.statusLines.pad = value;
    const node = this.hud.querySelector('[data-hud-pad]');
    if (node) node.textContent = value;
  }

  private updateLookHud() {
    const look = this.input.getLook();
    const value = `look: ${look.x.toFixed(2)}, ${look.y.toFixed(2)}`;
    if (value === this.statusLines.look) return;
    this.statusLines.look = value;
    const node = this.hud.querySelector('[data-hud-look]');
    if (node) node.textContent = value;
  }

  private updateOrbitHud() {
    const value = `orbit: ${this.orbitYaw.toFixed(2)}, ${this.orbitPitch.toFixed(2)}`;
    if (value === this.statusLines.orbit) return;
    this.statusLines.orbit = value;
    const node = this.hud.querySelector('[data-hud-orbit]');
    if (node) node.textContent = value;
  }

  private updateMoveHud() {
    const movement = this.input.getVector();
    const value = `move: ${movement.x.toFixed(2)}, ${movement.z.toFixed(2)}`;
    if (value === this.statusLines.move) return;
    this.statusLines.move = value;
    const node = this.hud.querySelector('[data-hud-move]');
    if (node) node.textContent = value;
  }

  private updateDtHud(delta: number) {
    const value = `dt: ${delta.toFixed(3)}`;
    if (value === this.statusLines.dt) return;
    this.statusLines.dt = value;
    const node = this.hud.querySelector('[data-hud-dt]');
    if (node) node.textContent = value;
  }
}
