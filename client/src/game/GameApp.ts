import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { InputState } from '../input/InputState';
import { RoomClient } from '../net/RoomClient';
import { retargetMixamoClip } from './retarget';
import {
  PlayerSnapshot,
  WorldSnapshot,
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
  CROWD_RADIUS,
  CROWD_COUNT,
  resolveCircleAabb,
  resolveCircleCircle,
  type CrowdSnapshot,
  type Vec3,
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
  private gltfLoader = new GLTFLoader();
  private fbxLoader = new FBXLoader();
  private vrms: VRM[] = [];
  private readonly vrmUrl = '/avatars/default.vrm';
  private mixamoClips: Record<string, { clip: THREE.AnimationClip; rig: THREE.Object3D }> = {};
  private mixamoReady: Promise<void>;
  private lastRetargetTracks = 0;
  private lastMixamoTrack = 'none';
  private lastRetargetSample = 'none';
  private lastMixamoTrackCount = 0;
  private lastRetargetSkipped = 'n/a';
  private vrmActors = new Map<
    string,
    {
      vrm: VRM;
      mixer: THREE.AnimationMixer;
      actions: Record<string, THREE.AnimationAction>;
      base: 'idle' | 'walk' | 'run';
      id: string;
    }
  >();
  private procedural = new Map<
    string,
    {
      bob: number;
      landKick: number;
      lookYaw: number;
      lookPitch: number;
      springYaw: number;
      springPitch: number;
      prevVel: THREE.Vector3;
      prevGrounded: boolean;
      baseHipY?: number;
      baseRot?: Record<string, { x: number; y: number; z: number }>;
    }
  >();
  private clock: THREE.Clock;
  private lastTime = performance.now();
  private animationId: number | null = null;
  private hud: HTMLDivElement;
  private hudVisible = true;
  private perfHud: HTMLDivElement;
  private perfVisible = false;
  private perfFrames = 0;
  private perfAccum = 0;
  private perfFps = 0;
  private perfMs = 0;
  private crowd: THREE.Group;
  private crowdAvatars: Array<{
    root: THREE.Object3D;
    baseY: number;
    mixer: THREE.AnimationMixer;
    actions: { idle?: THREE.AnimationAction; walk?: THREE.AnimationAction };
  }> = [];
  private crowdTemplate: VRM | null = null;
  private readonly crowdVrmUrl = '/avatars/crowd.vrm';
  private localPlayer: THREE.Object3D;
  private localVelocityY = 0;
  private localVelocityX = 0;
  private localVelocityZ = 0;
  private parkourState: 'normal' | 'slide' | 'vault' | 'climb' | 'wallrun' | 'roll' = 'normal';
  private parkourTimer = 0;
  private wallrunTimer = 0;
  private wallrunCooldown = 0;
  private vaultCooldown = 0;
  private rollCooldown = 0;
  private slideCooldown = 0;
  private input: InputState;
  private roomClient: RoomClient;
  private seq = 0;
  private networkAccumulator = 0;
  private remotePlayers = new Map<
    string,
    {
      mesh: THREE.Object3D;
      snapshots: Array<{
        t: number;
        position: { x: number; y: number; z: number };
        velocity: { x: number; y: number; z: number };
      }>;
    }
  >();
  private localId: string | null = null;
  private readonly remoteBufferSeconds = 0.12;
  private crowdAgents: CrowdSnapshot['agents'] = [];
  private remoteLatest = new Map<string, { x: number; y: number; z: number }>();
  private remoteLatestVel = new Map<string, Vec3>();
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
    heat: 'Heat: 0.00 (low)',
    phase: 'Phase: 0',
    anim: 'anim: mixamo 0, vrm 0, tracks 0',
  };
  private inputDebugTimer = 0;

  constructor(container: HTMLElement | null) {
    if (!container) {
      throw new Error('Missing #app container');
    }
    this.container = container;
    this.container.tabIndex = 0;
    this.container.addEventListener('click', () => this.container.focus());
    this.gltfLoader.register((parser) => new VRMLoaderPlugin(parser));
    this.mixamoReady = this.loadMixamoClips();
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
    this.perfHud = this.createPerfHud();
    this.crowd = this.createCrowd();
    this.input = new InputState();
    const host =
      window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
    this.roomClient = new RoomClient(`http://${host}:2567`);
    this.localPlayer = this.createPlayer();

    this.container.appendChild(this.renderer.domElement);
    this.container.appendChild(this.hud);
    this.container.appendChild(this.perfHud);
    this.container.focus();
    window.addEventListener('keydown', (event) => {
      const value = `raw: ${event.code || event.key}`;
      this.statusLines.key = `key: ${value}`;
      const node = this.hud.querySelector('[data-hud-key]');
      if (node) node.textContent = `key: ${value}`;
      if (event.code === 'KeyH') {
        this.hudVisible = !this.hudVisible;
        this.hud.style.display = this.hudVisible ? 'block' : 'none';
      }
      if (event.code === 'KeyP') {
        this.perfVisible = !this.perfVisible;
        this.perfHud.style.display = this.perfVisible ? 'block' : 'none';
      }
    });
    this.scene.add(
      this.createLights(),
      this.createGround(),
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
    this.updateVrms(delta);
    this.updateFocusHud();
    this.updateKeysHud();
    this.updatePosHud();
    this.updatePadHud();
    this.updateLookHud();
    this.updateOrbitHud();
    this.updateMoveHud();
    this.updateDtHud(delta);
    this.updateHeatHud();
    this.updateAnimHud();
    this.tickNetwork(delta);
    this.updateRemoteInterpolation(now / 1000);
    this.renderer.render(this.scene, this.camera);
    this.updatePerfHud(delta);
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
    const texture = this.createConcreteTexture();
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.95,
      metalness: 0.05,
      color: 0xffffff,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    return mesh;
  }

  private createConcreteTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallback = new THREE.CanvasTexture(canvas);
      fallback.wrapS = THREE.RepeatWrapping;
      fallback.wrapT = THREE.RepeatWrapping;
      fallback.repeat.set(12, 12);
      return fallback;
    }
    ctx.fillStyle = '#4a4f57';
    ctx.fillRect(0, 0, size, size);
    const imageData = ctx.getImageData(0, 0, size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const n = (Math.random() * 0.2 - 0.1) * 255;
      data[i] = Math.min(255, Math.max(0, data[i]! + n));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1]! + n));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2]! + n));
    }
    ctx.putImageData(imageData, 0, 0);
    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = '#2f343b';
    for (let i = 0; i < size; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 12);
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    return texture;
  }

  private createLandmark() {
    const group = new THREE.Group();
    const baseHeight = 0.4;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(2, baseHeight, 2),
      new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.6, metalness: 0.2 }),
    );
    base.position.set(12, baseHeight / 2, 6);
    const pillarHeight = 5;
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.6, pillarHeight, 12),
      new THREE.MeshStandardMaterial({ color: 0xef476f, roughness: 0.4, metalness: 0.3 }),
    );
    pillar.position.set(12, pillarHeight / 2, 6);
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
      mesh.position.set(obstacle.position.x, obstacle.size.y / 2, obstacle.position.z);
      group.add(mesh);
    }
    return group;
  }

  private createPlayer() {
    const group = new THREE.Group();
    const radius = 0.6;
    const length = 1.2;
    const geometry = new THREE.CapsuleGeometry(radius, length, 6, 12);
    const material = new THREE.MeshStandardMaterial({
      color: 0x6be9ff,
      emissive: 0x0a1f2f,
      transparent: true,
      opacity: 0.2,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = radius + length / 2;
    group.add(mesh);
    group.position.set(0, GROUND_Y, 0);
    void this.loadVrmInto(group, 'local');
    return group;
  }

  private createCrowd() {
    const group = new THREE.Group();
    group.name = 'crowd';
    void this.loadCrowdTemplate(group);
    return group;
  }

  private computeVrmGroundOffset(vrm: VRM) {
    vrm.scene.updateMatrixWorld(true);
    const footBones = [
      vrm.humanoid.getRawBoneNode('leftFoot'),
      vrm.humanoid.getRawBoneNode('rightFoot'),
      vrm.humanoid.getRawBoneNode('leftToes'),
      vrm.humanoid.getRawBoneNode('rightToes'),
    ].filter(Boolean) as THREE.Object3D[];
    let offsetY = 0;
    if (footBones.length > 0) {
      let minY = Infinity;
      const temp = new THREE.Vector3();
      for (const bone of footBones) {
        bone.getWorldPosition(temp);
        vrm.scene.worldToLocal(temp);
        if (temp.y < minY) minY = temp.y;
      }
      if (Number.isFinite(minY)) {
        offsetY = -minY;
      }
    } else {
      const box = new THREE.Box3().setFromObject(vrm.scene);
      offsetY = -box.min.y;
    }
    return offsetY;
  }

  private async loadCrowdTemplate(group: THREE.Group) {
    this.gltfLoader.load(
      this.crowdVrmUrl,
      async (gltf) => {
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          console.warn('Crowd VRM missing, fallback to cylinders.');
          return;
        }
        vrm.humanoid.autoUpdateHumanBones = true;
        this.crowdTemplate = vrm;
        await this.mixamoReady;
        const idleClip = this.mixamoClips.idle
          ? retargetMixamoClip(this.mixamoClips.idle, vrm, 'crowd', { includePosition: false })
          : null;
        const walkClip = this.mixamoClips.walk
          ? retargetMixamoClip(this.mixamoClips.walk, vrm, 'crowd', { includePosition: false })
          : idleClip;
        const baseY = this.computeVrmGroundOffset(vrm);
        const count = CROWD_COUNT;
        this.crowdAvatars = [];
        for (let i = 0; i < count; i += 1) {
          const clone = SkeletonUtils.clone(vrm.scene) as THREE.Object3D;
          clone.traverse((obj) => {
            obj.frustumCulled = false;
          });
          const scale = 0.92 + Math.random() * 0.12;
          clone.scale.set(scale, scale, scale);
          const radius = 18 + Math.random() * 26;
          const angle = Math.random() * Math.PI * 2;
          clone.position.set(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius);
          clone.rotation.y = Math.random() * Math.PI * 2 + Math.PI;
          const mixer = new THREE.AnimationMixer(clone);
          const actions: { idle?: THREE.AnimationAction; walk?: THREE.AnimationAction } = {};
          if (idleClip) {
            const action = mixer.clipAction(idleClip);
            action.play();
            action.enabled = true;
            action.setEffectiveWeight(1);
            actions.idle = action;
          }
          if (walkClip) {
            const action = mixer.clipAction(walkClip);
            action.play();
            action.enabled = true;
            action.setEffectiveWeight(0);
            actions.walk = action;
          }
          group.add(clone);
          this.crowdAvatars.push({ root: clone, baseY, mixer, actions });
        }
      },
      undefined,
      (error) => {
        console.warn('Crowd VRM load failed:', error);
      },
    );
  }

  private createRemotePlayer(id: string) {
    const group = new THREE.Group();
    const radius = 0.5;
    const length = 1.1;
    const geometry = new THREE.CapsuleGeometry(radius, length, 6, 10);
    const material = new THREE.MeshStandardMaterial({
      color: 0xff6b6b,
      emissive: 0x2a0b0b,
      transparent: true,
      opacity: 0.15,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = radius + length / 2;
    group.add(mesh);
    void this.loadVrmInto(group, id);
    return group;
  }

  private animateCrowd(time: number) {
    if (this.crowdAvatars.length === 0) return;
    if (this.crowdAgents.length > 0) {
      const count = Math.min(this.crowdAvatars.length, this.crowdAgents.length);
      for (let i = 0; i < count; i += 1) {
        const agent = this.crowdAgents[i]!;
        const avatar = this.crowdAvatars[i]!;
        avatar.root.position.set(agent.position.x, avatar.baseY, agent.position.z);
        avatar.root.rotation.y = Math.atan2(agent.velocity.x, agent.velocity.z) + Math.PI;
        const speed = Math.hypot(agent.velocity.x, agent.velocity.z);
        if (avatar.actions.walk && avatar.actions.idle) {
          const walkWeight = THREE.MathUtils.clamp(speed / 1.2, 0, 1);
          avatar.actions.walk.weight = THREE.MathUtils.lerp(avatar.actions.walk.weight, walkWeight, 0.2);
          avatar.actions.idle.weight = THREE.MathUtils.lerp(avatar.actions.idle.weight, 1 - walkWeight, 0.2);
        }
      }
      return;
    }
    for (let i = 0; i < this.crowdAvatars.length; i += 1) {
      const avatar = this.crowdAvatars[i]!;
      avatar.root.position.x += Math.sin(time * 0.6 + i) * 0.002;
      avatar.root.position.z += Math.cos(time * 0.6 + i) * 0.002;
      if (avatar.actions.idle) {
        avatar.actions.idle.weight = 1;
      }
      if (avatar.actions.walk) {
        avatar.actions.walk.weight = 0;
      }
    }
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
      `<div data-hud-anim>${this.statusLines.anim}</div>`,
      `<div data-hud-heat>${this.statusLines.heat}</div>`,
      `<div data-hud-phase>${this.statusLines.phase}</div>`,
      '<div>Objective: ignite 3 hotspots</div>',
      '<div>WASD move, Shift sprint, Space jump, C/Ctrl crouch, F attack</div>',
      '<div>Attack: short-range knockback + damage (server-authoritative)</div>',
      '<div>VRM: place a model at /avatars/default.vrm</div>',
      '<div>Press H to toggle HUD</div>',
    ].join('');
    return hud;
  }

  private createPerfHud() {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.style.display = 'none';
    hud.style.top = '12px';
    hud.style.right = '12px';
    hud.style.left = 'auto';
    hud.style.width = 'auto';
    hud.innerHTML = [
      '<strong>Performance</strong>',
      '<div data-perf-fps>fps: --</div>',
      '<div data-perf-ms>ms: --</div>',
      '<div data-perf-calls>draw: --</div>',
      '<div data-perf-tris>tris: --</div>',
    ].join('');
    return hud;
  }

  private async connect() {
    try {
      await this.roomClient.connect();
      this.localId = this.roomClient.getSessionId();
      this.setHud('connection', 'connected');
      this.roomClient.onSnapshot((players) => this.syncRemotePlayers(players));
      this.roomClient.onCrowd((snapshot) => {
        this.crowdAgents = snapshot.agents;
      });
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
    const onGround = this.localPlayer.position.y <= GROUND_Y + 0.001;
    const moveDir = new THREE.Vector3(moveX, 0, moveZ);
    if (moveDir.lengthSq() > 1e-6) moveDir.normalize();

    this.parkourTimer = Math.max(0, this.parkourTimer - delta);
    this.wallrunTimer = Math.max(0, this.wallrunTimer - delta);
    this.wallrunCooldown = Math.max(0, this.wallrunCooldown - delta);
    this.vaultCooldown = Math.max(0, this.vaultCooldown - delta);
    this.rollCooldown = Math.max(0, this.rollCooldown - delta);
    this.slideCooldown = Math.max(0, this.slideCooldown - delta);

    const speedBase = MOVE_SPEED * (flags.sprint ? SPRINT_MULTIPLIER : flags.crouch ? CROUCH_MULTIPLIER : 1);
    const accel = Math.min(1, SLIDE_ACCEL * delta);

    const startSlide = onGround && flags.crouch && flags.sprint && this.slideCooldown <= 0;
    const startVault = onGround && flags.jump && this.vaultCooldown <= 0 && this.checkVault(moveDir);
    const startClimb = !onGround && flags.jump && this.vaultCooldown <= 0 && this.checkClimb(moveDir);
    const startWallrun = !onGround && this.wallrunCooldown <= 0 && this.checkWallrun(moveDir);
    const startFlip = onGround && flags.jump && flags.sprint && this.vaultCooldown <= 0 && !startVault;

    if (startVault) {
      this.parkourState = 'vault';
      this.parkourTimer = 0.35;
      this.vaultCooldown = 0.4;
      this.localVelocityY = JUMP_SPEED * 0.6;
      this.localVelocityX = moveDir.x * speedBase * 1.2;
      this.localVelocityZ = moveDir.z * speedBase * 1.2;
    } else if (startClimb) {
      this.parkourState = 'climb';
      this.parkourTimer = 0.45;
      this.vaultCooldown = 0.5;
      this.localVelocityY = JUMP_SPEED * 0.9;
      this.localVelocityX = moveDir.x * speedBase * 0.4;
      this.localVelocityZ = moveDir.z * speedBase * 0.4;
    } else if (startWallrun) {
      this.parkourState = 'wallrun';
      this.wallrunTimer = 0.6;
      this.wallrunCooldown = 0.8;
      const wall = this.getWallNormal();
      if (wall) {
        const along = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), wall).normalize();
        const dot = along.dot(moveDir) < 0 ? -1 : 1;
        along.multiplyScalar(dot);
        this.localVelocityX = along.x * speedBase * 1.1;
        this.localVelocityZ = along.z * speedBase * 1.1;
        this.localVelocityY = Math.max(this.localVelocityY, 3.5);
      }
    } else if (startSlide) {
      this.parkourState = 'slide';
      this.parkourTimer = 0.5;
      this.slideCooldown = 0.4;
      this.localVelocityX = moveDir.x * speedBase * 1.15;
      this.localVelocityZ = moveDir.z * speedBase * 1.15;
    } else if (startFlip) {
      this.parkourState = 'roll';
      this.parkourTimer = 0.35;
      this.rollCooldown = 0.4;
      this.localVelocityY = JUMP_SPEED * 1.15;
      this.localVelocityX = moveDir.x * speedBase * 1.1;
      this.localVelocityZ = moveDir.z * speedBase * 1.1;
    } else if (this.parkourTimer <= 0 && this.wallrunTimer <= 0) {
      this.parkourState = 'normal';
    }

    if (this.parkourState === 'normal') {
      const targetVx = moveX * speedBase;
      const targetVz = moveZ * speedBase;
      if (flags.sprint || flags.crouch) {
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
    } else if (this.parkourState === 'slide') {
      const damping = Math.max(0, 1 - (SLIDE_FRICTION * 1.4) * delta);
      this.localVelocityX *= damping;
      this.localVelocityZ *= damping;
    }

    if (flags.jump && onGround && this.parkourState === 'normal') {
      this.localVelocityY = JUMP_SPEED;
    }

    if (this.parkourState === 'wallrun' && this.wallrunTimer > 0) {
      this.localVelocityY = Math.max(this.localVelocityY, 1.5);
    } else {
      this.localVelocityY += GRAVITY * delta;
    }

    const next = {
      x: this.localPlayer.position.x + this.localVelocityX * delta,
      y: this.localPlayer.position.y + this.localVelocityY * delta,
      z: this.localPlayer.position.z + this.localVelocityZ * delta,
    };
    if (next.y <= GROUND_Y) {
      next.y = GROUND_Y;
      if (this.localVelocityY < -8 && this.rollCooldown <= 0) {
        this.parkourState = 'roll';
        this.parkourTimer = 0.3;
        this.rollCooldown = 0.6;
      }
      this.localVelocityY = 0;
    }

    let resolved = next;
    const stepHeight = this.getStepUpHeight(moveDir);
    if (onGround && stepHeight > 0) {
      resolved = { ...resolved, y: Math.max(resolved.y, stepHeight) };
    }
    for (const obstacle of OBSTACLES) {
      if (resolved.y > obstacle.size.y * 0.6) continue;
      resolved = resolveCircleAabb(resolved, PLAYER_RADIUS, obstacle);
    }
    for (const agent of this.crowdAgents) {
      resolved = resolveCircleCircle(resolved, PLAYER_RADIUS, agent.position, CROWD_RADIUS);
    }
    for (const [id, pos] of this.remoteLatest.entries()) {
      if (this.localId && id === this.localId) continue;
      resolved = resolveCircleCircle(resolved, PLAYER_RADIUS, pos, PLAYER_RADIUS);
    }

    this.localPlayer.position.x = resolved.x;
    this.localPlayer.position.y = resolved.y;
    this.localPlayer.position.z = resolved.z;
  }

  private checkVault(dir: THREE.Vector3) {
    if (dir.lengthSq() < 0.2) return false;
    const forward = 1.1;
    const pos = this.localPlayer.position;
    for (const obstacle of OBSTACLES) {
      const halfX = obstacle.size.x / 2 + PLAYER_RADIUS;
      const halfZ = obstacle.size.z / 2 + PLAYER_RADIUS;
      const ox = obstacle.position.x;
      const oz = obstacle.position.z;
      const targetX = pos.x + dir.x * forward;
      const targetZ = pos.z + dir.z * forward;
      if (Math.abs(targetX - ox) <= halfX && Math.abs(targetZ - oz) <= halfZ) {
        return obstacle.size.y <= 1.2;
      }
    }
    return false;
  }

  private checkClimb(dir: THREE.Vector3) {
    if (dir.lengthSq() < 0.2) return false;
    const forward = 0.9;
    const pos = this.localPlayer.position;
    for (const obstacle of OBSTACLES) {
      const halfX = obstacle.size.x / 2 + PLAYER_RADIUS;
      const halfZ = obstacle.size.z / 2 + PLAYER_RADIUS;
      const ox = obstacle.position.x;
      const oz = obstacle.position.z;
      const targetX = pos.x + dir.x * forward;
      const targetZ = pos.z + dir.z * forward;
      if (Math.abs(targetX - ox) <= halfX && Math.abs(targetZ - oz) <= halfZ) {
        return obstacle.size.y > 1.2 && obstacle.size.y <= 2.4;
      }
    }
    return false;
  }

  private checkWallrun(dir: THREE.Vector3) {
    if (dir.lengthSq() < 0.2) return false;
    return this.getWallNormal() !== null;
  }

  private getWallNormal() {
    const pos = this.localPlayer.position;
    const reach = PLAYER_RADIUS + 0.25;
    for (const obstacle of OBSTACLES) {
      const halfX = obstacle.size.x / 2;
      const halfZ = obstacle.size.z / 2;
      const dx = pos.x - obstacle.position.x;
      const dz = pos.z - obstacle.position.z;
      const ox = halfX - Math.abs(dx);
      const oz = halfZ - Math.abs(dz);
      if (ox > -reach && oz > -reach) {
        if (ox < oz) {
          return new THREE.Vector3(Math.sign(dx), 0, 0);
        }
        return new THREE.Vector3(0, 0, Math.sign(dz));
      }
    }
    return null;
  }

  private getStepUpHeight(dir: THREE.Vector3) {
    if (dir.lengthSq() < 0.2) return 0;
    const pos = this.localPlayer.position;
    const forward = 0.9;
    const probeX = pos.x + dir.x * forward;
    const probeZ = pos.z + dir.z * forward;
    let best = 0;
    for (const obstacle of OBSTACLES) {
      const halfX = obstacle.size.x / 2 + PLAYER_RADIUS;
      const halfZ = obstacle.size.z / 2 + PLAYER_RADIUS;
      if (Math.abs(probeX - obstacle.position.x) <= halfX && Math.abs(probeZ - obstacle.position.z) <= halfZ) {
        if (obstacle.size.y <= 1.6) {
          best = Math.max(best, obstacle.size.y);
        }
      }
    }
    return best;
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

    // Face the player toward the camera-forward direction.
    const forward = new THREE.Vector3().subVectors(target, this.camera.position);
    forward.y = 0;
    if (forward.lengthSq() > 1e-6) {
      forward.normalize();
      this.localPlayer.rotation.y = Math.atan2(forward.x, forward.z) + Math.PI;
    }
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

  private syncRemotePlayers(snapshot: WorldSnapshot) {
    this.setHud('players', `players: ${Object.keys(snapshot.players).length}`);
    this.statusLines.heat = this.formatHeat(snapshot.heat);
    this.statusLines.phase = `Phase: ${snapshot.phase}`;
    const heatNode = this.hud.querySelector('[data-hud-heat]');
    if (heatNode) heatNode.textContent = this.statusLines.heat;
    const phaseNode = this.hud.querySelector('[data-hud-phase]');
    if (phaseNode) phaseNode.textContent = this.statusLines.phase;
    for (const [id, playerSnap] of Object.entries(snapshot.players)) {
      if (this.localId && id === this.localId) {
        this.reconcileLocal(playerSnap);
        continue;
      }
      let entry = this.remotePlayers.get(id);
      if (!entry) {
        const mesh = this.createRemotePlayer(id);
        entry = { mesh, snapshots: [] };
        this.remotePlayers.set(id, entry);
        this.scene.add(mesh);
      }
      const now = performance.now() / 1000;
      entry.snapshots.push({
        t: now,
        position: { ...playerSnap.position },
        velocity: { ...playerSnap.velocity },
      });
      this.remoteLatest.set(id, { ...playerSnap.position });
      this.remoteLatestVel.set(id, { ...playerSnap.velocity });
      if (entry.snapshots.length > 5) {
        entry.snapshots.splice(0, entry.snapshots.length - 5);
      }
    }

    for (const [id, entry] of this.remotePlayers.entries()) {
      if (snapshot.players[id]) continue;
      this.scene.remove(entry.mesh);
      this.remotePlayers.delete(id);
      this.remoteLatest.delete(id);
      this.remoteLatestVel.delete(id);
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

  private updateRemoteInterpolation(nowSeconds: number) {
    const renderTime = nowSeconds - this.remoteBufferSeconds;
    for (const entry of this.remotePlayers.values()) {
      const { mesh, snapshots } = entry;
      if (snapshots.length === 0) continue;
      if (snapshots.length === 1) {
        const snap = snapshots[0]!;
        mesh.position.set(snap.position.x, snap.position.y, snap.position.z);
        continue;
      }

      let older = snapshots[0]!;
      let newer = snapshots[snapshots.length - 1]!;
      for (let i = snapshots.length - 1; i >= 0; i -= 1) {
        const current = snapshots[i]!;
        if (current.t <= renderTime) {
          older = current;
          newer = snapshots[i + 1] ?? current;
          break;
        }
      }

      if (older === newer) {
        const dt = Math.min(0.1, renderTime - older.t);
        mesh.position.set(
          older.position.x + older.velocity.x * dt,
          older.position.y + older.velocity.y * dt,
          older.position.z + older.velocity.z * dt,
        );
        continue;
      }

      const span = newer.t - older.t;
      const alpha = span > 0.0001 ? (renderTime - older.t) / span : 0;
      mesh.position.set(
        THREE.MathUtils.lerp(older.position.x, newer.position.x, alpha),
        THREE.MathUtils.lerp(older.position.y, newer.position.y, alpha),
        THREE.MathUtils.lerp(older.position.z, newer.position.z, alpha),
      );
    }
  }

  private async loadVrmInto(group: THREE.Group, actorId: string) {
    const url = this.vrmUrl;
    this.gltfLoader.load(
      url,
      async (gltf) => {
        if (typeof VRMUtils.removeUnnecessaryVertices === 'function') {
          VRMUtils.removeUnnecessaryVertices(gltf.scene);
        }
        if (typeof VRMUtils.removeUnnecessaryJoints === 'function') {
          VRMUtils.removeUnnecessaryJoints(gltf.scene);
        }
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      console.warn('VRM load failed: no VRM in glTF');
      return;
    }
    vrm.humanoid.autoUpdateHumanBones = true;
    vrm.scene.position.y = this.computeVrmGroundOffset(vrm);
        vrm.scene.scale.set(1, 1, 1);
        vrm.scene.visible = true;
        vrm.scene.traverse((obj) => {
          obj.visible = true;
          obj.frustumCulled = false;
        });
        group.add(vrm.scene);
        this.vrms.push(vrm);
        await this.mixamoReady;
        this.setupVrmActor(vrm, actorId);
      },
      undefined,
      (error) => {
        console.warn('VRM load failed:', error);
      },
    );
  }

  private updateVrms(delta: number) {
    for (const vrm of this.vrms) {
      vrm.update(delta);
    }
    for (const actor of this.vrmActors.values()) {
      actor.mixer.update(delta);
      this.updateActorAnimation(actor);
      this.applyProcedural(actor, delta);
    }
    for (const avatar of this.crowdAvatars) {
      avatar.mixer.update(delta);
    }
  }

  private async loadMixamoClips() {
    const resolveKey = (filename: string) => {
      const base = filename.replace(/\.[^/.]+$/, '');
      const lower = base.toLowerCase().replace(/[_-]+/g, ' ');
      if (lower.includes('idle')) return 'idle';
      if (lower.includes('walk')) return 'walk';
      if (lower.includes('run')) return 'run';
      if (lower.includes('jump')) return 'jump';
      if (lower.includes('fall')) return 'fall';
      if (lower.includes('attack') || lower.includes('punch') || lower.includes('kick')) {
        return 'attack';
      }
      if (lower.includes('hit') || lower.includes('damage')) return 'hit';
      if (lower.includes('knock') || lower.includes('down')) return 'knockdown';
      if (lower.includes('strafe') && lower.includes('left')) return 'strafeLeft';
      if (lower.includes('strafe') && lower.includes('right')) return 'strafeRight';
      if (lower.includes('turn') && lower.includes('left')) return 'turnLeft';
      if (lower.includes('turn') && lower.includes('right')) return 'turnRight';
      return base;
    };

    let manifest: string[] | null = null;
    try {
      const res = await fetch('/animations/manifest.json', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { files?: string[] };
        if (Array.isArray(data.files)) {
          manifest = data.files;
        }
      }
    } catch (error) {
      console.warn('Failed to load animations manifest:', error);
    }

    const entries: Array<[string, string]> = (manifest ?? [])
      .filter((name) => name.toLowerCase().endsWith('.fbx'))
      .map((name) => [resolveKey(name), `/animations/${encodeURIComponent(name)}`]);
    if (entries.length === 0) {
      const files: Record<string, string> = {
        idle: '/animations/idle.fbx',
        walk: '/animations/walk.fbx',
        run: '/animations/run.fbx',
        jump: '/animations/jump.fbx',
        fall: '/animations/fall.fbx',
        attack: '/animations/attack.fbx',
        hit: '/animations/hit.fbx',
        knockdown: '/animations/knockdown.fbx',
      };
      entries.push(...Object.entries(files));
    }

    const usedKeys = new Set<string>();
    await Promise.all(
      entries.map(async ([rawKey, url]) => {
        const key = usedKeys.has(rawKey) ? `${rawKey}_${Math.random().toString(36).slice(2, 6)}` : rawKey;
        usedKeys.add(key);
        const fbx = await this.fbxLoader.loadAsync(url);
        const clip = fbx.animations[0];
        if (!clip) {
          console.warn('Missing animation clip for', key);
          return;
        }
        this.lastMixamoTrackCount = clip.tracks.length;
        if (clip.tracks[0]) {
          this.lastMixamoTrack = clip.tracks[0].name;
        }
        clip.name = key;
        this.mixamoClips[key] = { clip, rig: fbx };
      }),
    );

    const ensureClip = (key: string, fallbacks: string[]) => {
      if (this.mixamoClips[key]) return;
      for (const fallback of fallbacks) {
        const entry = this.mixamoClips[fallback];
        if (entry) {
          this.mixamoClips[key] = entry;
          return;
        }
      }
    };
    ensureClip('walk', ['walking', 'walk', 'idle']);
    ensureClip('run', ['run', 'walk', 'idle']);
    ensureClip('fall', ['fall', 'jump', 'idle']);
    ensureClip('jump', ['jump', 'fall', 'idle']);
    ensureClip('attack', ['attack', 'hit', 'idle']);
    ensureClip('hit', ['hit', 'attack', 'idle']);
    ensureClip('knockdown', ['knockdown', 'hit', 'fall', 'idle']);
    if (Object.keys(this.mixamoClips).length === 0) {
      console.warn('Mixamo clips failed to load.');
    }
  }

  private setupVrmActor(vrm: VRM, actorId: string) {
    if (this.vrmActors.has(actorId)) return;
    const root = vrm.humanoid.normalizedHumanBonesRoot;
    if (root && root.parent == null) {
      vrm.scene.add(root);
    }
    const bones = (vrm.humanoid.normalizedHumanBones ?? {}) as Record<
      string,
      { node?: THREE.Object3D }
    >;
    for (const [key, bone] of Object.entries(bones)) {
      if (bone?.node) {
        bone.node.name = `${actorId}_${key}`;
      }
    }
    const mixer = new THREE.AnimationMixer(vrm.scene);
    const actions: Record<string, THREE.AnimationAction> = {};
    const applyActionSettings = (name: string, action: THREE.AnimationAction) => {
      action.enabled = true;
      action.clampWhenFinished = true;
      action.loop = name === 'jump' || name === 'attack' || name === 'hit' || name === 'knockdown'
        ? THREE.LoopOnce
        : THREE.LoopRepeat;
      action.play();
      action.weight = name === 'idle' ? 1 : 0;
    };
    for (const [name, entry] of Object.entries(this.mixamoClips)) {
      if (actions[name]) continue;
      const retargeted = retargetMixamoClip(entry, vrm, actorId, { includePosition: false });
      this.lastRetargetTracks = retargeted.tracks.length;
      this.lastRetargetSample = retargeted.tracks[0]?.name ?? 'none';
      const action = mixer.clipAction(retargeted);
      applyActionSettings(name, action);
      actions[name] = action;
    }
    const ensureAction = (key: string, fallbacks: string[]) => {
      if (actions[key]) return;
      for (const fallback of fallbacks) {
        if (actions[fallback]) {
          actions[key] = actions[fallback];
          return;
        }
      }
    };
    ensureAction('walk', ['walking', 'walk', 'idle']);
    ensureAction('run', ['run', 'walk', 'idle']);
    ensureAction('fall', ['fall', 'jump', 'idle']);
    ensureAction('jump', ['jump', 'fall', 'idle']);
    ensureAction('attack', ['attack', 'hit', 'idle']);
    ensureAction('hit', ['hit', 'attack', 'idle']);
    ensureAction('knockdown', ['knockdown', 'hit', 'fall', 'idle']);
    this.vrmActors.set(actorId, {
      vrm,
      mixer,
      actions,
      base: 'idle',
      id: actorId,
    });
  }

  private updateActorAnimation(actor: {
    vrm: VRM;
    mixer: THREE.AnimationMixer;
    actions: Record<string, THREE.AnimationAction>;
    base: 'idle' | 'walk' | 'run';
    id: string;
  }) {
    const actorId = actor.id;
    const local = actorId === 'local';
    let speed = 0;
    let vy = 0;
    if (local) {
      speed = Math.hypot(this.localVelocityX, this.localVelocityZ);
      vy = this.localVelocityY;
    } else if (actorId) {
      const vel = this.remoteLatestVel.get(actorId);
      if (vel) {
        speed = Math.hypot(vel.x, vel.z);
        vy = vel.y;
      }
    }

    const idle = actor.actions.idle;
    const walk = actor.actions.walk ?? idle;
    const run = actor.actions.run ?? walk;
    const jump = actor.actions.jump ?? idle;
    const fall = actor.actions.fall ?? idle;
    if (!idle || !walk || !run || !jump || !fall) return;

    const walkThreshold = 0.15;
    const runThreshold = MOVE_SPEED * 0.65;
    // Freeze locomotion clips on first frame so we get a base pose.
    for (const action of [idle, walk, run]) {
      if (!action) continue;
      action.enabled = true;
      action.paused = true;
      action.time = 0;
      action.weight = 1;
    }

    if (vy > 0.5) {
      jump.weight = THREE.MathUtils.lerp(jump.weight, 1, 0.2);
      fall.weight = THREE.MathUtils.lerp(fall.weight, 0, 0.2);
    } else if (vy < -0.5) {
      fall.weight = THREE.MathUtils.lerp(fall.weight, 1, 0.2);
      jump.weight = THREE.MathUtils.lerp(jump.weight, 0, 0.2);
    } else {
      jump.weight = THREE.MathUtils.lerp(jump.weight, 0, 0.2);
      fall.weight = THREE.MathUtils.lerp(fall.weight, 0, 0.2);
    }
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

  private updateHeatHud() {
    const heatNode = this.hud.querySelector('[data-hud-heat]');
    if (heatNode && heatNode.textContent !== this.statusLines.heat) {
      heatNode.textContent = this.statusLines.heat;
    }
    const phaseNode = this.hud.querySelector('[data-hud-phase]');
    if (phaseNode && phaseNode.textContent !== this.statusLines.phase) {
      phaseNode.textContent = this.statusLines.phase;
    }
  }

  private formatHeat(value: number) {
    const label = value > 0.7 ? 'high' : value > 0.4 ? 'medium' : 'low';
    return `Heat: ${value.toFixed(2)} (${label})`;
  }

  private updateAnimHud() {
    const value = `anim: mixamo ${Object.keys(this.mixamoClips).length}(${this.lastMixamoTrackCount}), vrm ${this.vrmActors.size}, tracks ${this.lastRetargetTracks}, mixamo ${this.lastMixamoTrack}, retarget ${this.lastRetargetSample}, skip ${this.lastRetargetSkipped}`;
    if (value === this.statusLines.anim) return;
    this.statusLines.anim = value;
    const node = this.hud.querySelector('[data-hud-anim]');
    if (node) node.textContent = value;
  }

  private applyProcedural(
    actor: {
      vrm: VRM;
      id: string;
      actions: Record<string, THREE.AnimationAction>;
    },
    delta: number,
  ) {
    const vrm = actor.vrm;
    const id = actor.id;
    const state =
      this.procedural.get(id) ??
      {
        bob: 0,
        landKick: 0,
        lookYaw: 0,
        lookPitch: 0,
        springYaw: 0,
        springPitch: 0,
        prevVel: new THREE.Vector3(),
        prevGrounded: true,
      };

    const grounded = id === 'local'
      ? this.localPlayer.position.y <= GROUND_Y + 0.001
      : (this.remoteLatest.get(id)?.y ?? GROUND_Y) <= GROUND_Y + 0.001;
    if (state.prevGrounded === false && grounded === true) {
      state.landKick = Math.min(1, state.landKick + 0.35);
    }
    state.prevGrounded = grounded;
    state.landKick = Math.max(0, state.landKick - delta * 2.5);

    const velocity =
      id === 'local'
        ? new THREE.Vector3(this.localVelocityX, this.localVelocityY, this.localVelocityZ)
        : new THREE.Vector3(
            this.remoteLatestVel.get(id)?.x ?? 0,
            this.remoteLatestVel.get(id)?.y ?? 0,
            this.remoteLatestVel.get(id)?.z ?? 0,
          );
    const speed = Math.hypot(velocity.x, velocity.z);
    const accel = velocity.clone().sub(state.prevVel).multiplyScalar(1 / Math.max(delta, 0.001));
    state.prevVel.copy(velocity);

    state.bob += delta * (1.2 + Math.min(speed, 6) * 0.2);
    const bob = Math.sin(state.bob) * Math.min(0.06, speed * 0.01);

    const targetYaw = -THREE.MathUtils.clamp(accel.x * 0.002, -0.2, 0.2);
    const targetPitch = THREE.MathUtils.clamp(-accel.z * 0.002, -0.2, 0.2);
    state.springYaw = THREE.MathUtils.lerp(state.springYaw, targetYaw, 0.1);
    state.springPitch = THREE.MathUtils.lerp(state.springPitch, targetPitch, 0.1);

    if (id === 'local') {
      const target = new THREE.Vector3(
        this.localPlayer.position.x,
        this.localPlayer.position.y + 1.5,
        this.localPlayer.position.z,
      );
      const dir = new THREE.Vector3().subVectors(target, this.camera.position).normalize();
      const yaw = Math.atan2(dir.x, dir.z) + Math.PI;
      const pitch = -Math.asin(THREE.MathUtils.clamp(dir.y, -0.5, 0.5));
      const clampedYaw = THREE.MathUtils.clamp(yaw, -0.9, 0.9);
      const clampedPitch = THREE.MathUtils.clamp(pitch, -0.6, 0.6);
      state.lookYaw = THREE.MathUtils.lerp(state.lookYaw, clampedYaw, 0.08);
      state.lookPitch = THREE.MathUtils.lerp(state.lookPitch, clampedPitch, 0.08);
    } else {
      state.lookYaw *= 0.9;
      state.lookPitch *= 0.9;
    }

    const hips = vrm.humanoid.getRawBoneNode('hips');
    const spine = vrm.humanoid.getRawBoneNode('spine');
    const chest = vrm.humanoid.getRawBoneNode('chest');
    const upperChest = vrm.humanoid.getRawBoneNode('upperChest');
    const neck = vrm.humanoid.getRawBoneNode('neck');
    const head = vrm.humanoid.getRawBoneNode('head');
    const leftFoot = vrm.humanoid.getRawBoneNode('leftFoot');
    const rightFoot = vrm.humanoid.getRawBoneNode('rightFoot');
    const leftUpperLeg = vrm.humanoid.getRawBoneNode('leftUpperLeg');
    const rightUpperLeg = vrm.humanoid.getRawBoneNode('rightUpperLeg');
    const leftLowerLeg = vrm.humanoid.getRawBoneNode('leftLowerLeg');
    const rightLowerLeg = vrm.humanoid.getRawBoneNode('rightLowerLeg');
    const leftUpperArm = vrm.humanoid.getRawBoneNode('leftUpperArm');
    const rightUpperArm = vrm.humanoid.getRawBoneNode('rightUpperArm');
    const leftLowerArm = vrm.humanoid.getRawBoneNode('leftLowerArm');
    const rightLowerArm = vrm.humanoid.getRawBoneNode('rightLowerArm');
    const leftHand = vrm.humanoid.getRawBoneNode('leftHand');
    const rightHand = vrm.humanoid.getRawBoneNode('rightHand');

    if (!state.baseRot && Object.keys(actor.actions).length > 0) {
      const capture = (bone: THREE.Object3D | null, key: string) => {
        if (!bone) return;
        state.baseRot![key] = { x: bone.rotation.x, y: bone.rotation.y, z: bone.rotation.z };
      };
      state.baseRot = {};
      capture(hips, 'hips');
      capture(spine, 'spine');
      capture(chest, 'chest');
      capture(upperChest, 'upperChest');
      capture(neck, 'neck');
      capture(head, 'head');
      capture(leftUpperLeg, 'leftUpperLeg');
      capture(rightUpperLeg, 'rightUpperLeg');
      capture(leftLowerLeg, 'leftLowerLeg');
      capture(rightLowerLeg, 'rightLowerLeg');
      capture(leftFoot, 'leftFoot');
      capture(rightFoot, 'rightFoot');
      capture(leftUpperArm, 'leftUpperArm');
      capture(rightUpperArm, 'rightUpperArm');
      capture(leftLowerArm, 'leftLowerArm');
      capture(rightLowerArm, 'rightLowerArm');
    }

    const base = state.baseRot ?? {};
    if (hips) {
      if (state.baseHipY === undefined) {
        state.baseHipY = hips.position.y;
      }
      hips.position.y = state.baseHipY + bob * 0.5;
      hips.rotation.x = (base.hips?.x ?? hips.rotation.x) - state.landKick * 0.25;
      hips.rotation.y = base.hips?.y ?? hips.rotation.y;
      hips.rotation.z = base.hips?.z ?? hips.rotation.z;
    }
    const leanYaw = state.springYaw * 0.6;
    const leanPitch = state.springPitch * 0.6;

    if (spine) {
      spine.rotation.y = (base.spine?.y ?? spine.rotation.y) + leanYaw * 0.4;
      spine.rotation.x = (base.spine?.x ?? spine.rotation.x) + leanPitch * 0.4;
    }
    if (chest) {
      chest.rotation.y = (base.chest?.y ?? chest.rotation.y) + leanYaw * 0.6;
      chest.rotation.x = (base.chest?.x ?? chest.rotation.x) + leanPitch * 0.6;
    }
    if (upperChest) {
      upperChest.rotation.y = (base.upperChest?.y ?? upperChest.rotation.y) + leanYaw * 0.6;
      upperChest.rotation.x = (base.upperChest?.x ?? upperChest.rotation.x) + leanPitch * 0.6;
    }
    if (neck) {
      neck.rotation.y = (base.neck?.y ?? neck.rotation.y) + state.lookYaw * 0.4;
      neck.rotation.x = (base.neck?.x ?? neck.rotation.x) + state.lookPitch * 0.4;
    }
    if (head) {
      head.rotation.y = (base.head?.y ?? head.rotation.y) + state.lookYaw * 0.6;
      head.rotation.x = (base.head?.x ?? head.rotation.x) + state.lookPitch * 0.6;
    }

    // Procedural locomotion: stride + arm swing
    const stride = THREE.MathUtils.clamp(speed / MOVE_SPEED, 0, 1);
    const stepRate = 2.2 + stride * 1.6;
    const phase = this.clock.getElapsedTime() * stepRate;
    const swing = Math.sin(phase) * stride;
    const lift = Math.max(0, Math.sin(phase + Math.PI / 2)) * stride;

    if (leftUpperLeg) {
      leftUpperLeg.rotation.x = (base.leftUpperLeg?.x ?? leftUpperLeg.rotation.x) + swing * 0.6;
    }
    if (rightUpperLeg) {
      rightUpperLeg.rotation.x = (base.rightUpperLeg?.x ?? rightUpperLeg.rotation.x) - swing * 0.6;
    }
    if (leftLowerLeg) {
      leftLowerLeg.rotation.x = (base.leftLowerLeg?.x ?? leftLowerLeg.rotation.x) + Math.max(0, -swing) * 0.8;
    }
    if (rightLowerLeg) {
      rightLowerLeg.rotation.x = (base.rightLowerLeg?.x ?? rightLowerLeg.rotation.x) + Math.max(0, swing) * 0.8;
    }
    if (leftFoot) {
      leftFoot.rotation.x = (base.leftFoot?.x ?? leftFoot.rotation.x) + lift * 0.2;
    }
    if (rightFoot) {
      rightFoot.rotation.x = (base.rightFoot?.x ?? rightFoot.rotation.x) + (1 - lift) * 0.2 * stride;
    }
    const armDrop = THREE.MathUtils.lerp(0.6, 0.3, stride);
    const armOut = THREE.MathUtils.lerp(0.38, 0.45, stride);
    const leftBias = THREE.MathUtils.lerp(0.18, 0.08, stride);
    const rightBias = THREE.MathUtils.lerp(0.08, 0.04, stride);
    if (leftUpperArm) {
      leftUpperArm.rotation.x = (base.leftUpperArm?.x ?? leftUpperArm.rotation.x) - swing * 0.6;
      leftUpperArm.rotation.y = (base.leftUpperArm?.y ?? leftUpperArm.rotation.y) - armOut - leftBias;
      leftUpperArm.rotation.z = (base.leftUpperArm?.z ?? leftUpperArm.rotation.z) + armDrop;
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.x = (base.rightUpperArm?.x ?? rightUpperArm.rotation.x) + swing * 0.6;
      rightUpperArm.rotation.y = (base.rightUpperArm?.y ?? rightUpperArm.rotation.y) + armOut + rightBias;
      rightUpperArm.rotation.z = (base.rightUpperArm?.z ?? rightUpperArm.rotation.z) - armDrop;
    }
    if (leftLowerArm) {
      leftLowerArm.rotation.x = (base.leftLowerArm?.x ?? leftLowerArm.rotation.x) - swing * 0.2;
      leftLowerArm.rotation.z = base.leftLowerArm?.z ?? leftLowerArm.rotation.z;
    }
    if (rightLowerArm) {
      rightLowerArm.rotation.x = (base.rightLowerArm?.x ?? rightLowerArm.rotation.x) + swing * 0.2;
      rightLowerArm.rotation.z = base.rightLowerArm?.z ?? rightLowerArm.rotation.z;
    }

    // Simple ragdoll-like arm separation against torso sphere.
    if (chest && leftUpperArm && rightUpperArm && leftHand && rightHand) {
      const torso = new THREE.Vector3();
      const lHand = new THREE.Vector3();
      const rHand = new THREE.Vector3();
      chest.getWorldPosition(torso);
      leftHand.getWorldPosition(lHand);
      rightHand.getWorldPosition(rHand);
      const minRadius = 0.34;
      const lDist = torso.distanceTo(lHand);
      const rDist = torso.distanceTo(rHand);
      if (lDist < minRadius) {
        const push = (minRadius - lDist) * 3.0;
        leftUpperArm.rotation.z += push;
      }
      if (rDist < minRadius) {
        const push = (minRadius - rDist) * 2.2;
        rightUpperArm.rotation.z -= push;
      }
    }

    if (leftFoot && rightFoot) {
      const temp = new THREE.Vector3();
      leftFoot.getWorldPosition(temp);
      const leftOffset = GROUND_Y - temp.y;
      rightFoot.getWorldPosition(temp);
      const rightOffset = GROUND_Y - temp.y;
      const pelvisLift = Math.max(leftOffset, rightOffset, 0);
      if (hips) {
        hips.position.y = (state.baseHipY ?? hips.position.y) + bob * 0.5 + pelvisLift;
      }
    }

    this.procedural.set(id, state);
  }

  private updatePerfHud(delta: number) {
    if (!this.perfVisible) return;
    this.perfFrames += 1;
    this.perfAccum += delta;
    if (this.perfAccum < 0.5) return;
    this.perfFps = this.perfFrames / this.perfAccum;
    this.perfMs = (this.perfAccum / this.perfFrames) * 1000;
    this.perfFrames = 0;
    this.perfAccum = 0;

    const info = this.renderer.info;
    const fpsNode = this.perfHud.querySelector('[data-perf-fps]');
    if (fpsNode) fpsNode.textContent = `fps: ${this.perfFps.toFixed(1)}`;
    const msNode = this.perfHud.querySelector('[data-perf-ms]');
    if (msNode) msNode.textContent = `ms: ${this.perfMs.toFixed(1)}`;
    const callsNode = this.perfHud.querySelector('[data-perf-calls]');
    if (callsNode) callsNode.textContent = `draw: ${info.render.calls}`;
    const trisNode = this.perfHud.querySelector('[data-perf-tris]');
    if (trisNode) trisNode.textContent = `tris: ${info.render.triangles}`;
  }
}
