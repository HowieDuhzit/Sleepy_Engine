import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { InputState } from '../input/InputState';
import { RoomClient } from '../net/RoomClient';
import { buildAnimationClipFromData, isClipData, mirrorClipData, parseClipPayload, type ClipData } from './clip';
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
} from '@sleepy/shared';

export class GameApp {
  private playerConfig = {
    ikOffset: 0.02,
    capsuleRadiusScale: 1,
    capsuleHeightScale: 1,
    capsuleYOffset: 0,
  };
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private orbitYaw = 0;
  private orbitPitch = Math.PI / 4;
  private orbitRadius = 6;
  private orbitOffset = new THREE.Vector3();
  private orbitSpherical = new THREE.Spherical();
  private cameraTarget = new THREE.Vector3();
  private cameraGoal = new THREE.Vector3();
  private cameraForward = new THREE.Vector3();
  private cameraRight = new THREE.Vector3();
  private cameraQuat = new THREE.Quaternion();
  private localLookYaw = 0;
  private localLookPitch = 0;
  private remoteLatestLook = new Map<string, { yaw: number; pitch: number }>();
  private localAnimState = 'idle';
  private localAnimTime = 0;
  private remoteLatestAnim = new Map<string, { state: string; time: number }>();
  private localJumpMode: 'jump' | 'jump_up' | 'run_jump' = 'jump';
  private localMovementLock: 'land' | 'attack' | null = null;
  private localMovementLockTimer = 0;
  private lastMoveDir = new THREE.Vector3();
  private lastMoveInput = { x: 0, z: 0 };
  private lastYawDelta = 0;
  private animStates = new Map<
    string,
    {
      mode: string;
      timer: number;
      lastGrounded: boolean;
      lookYaw: number;
      lookPitch: number;
      leftFootY?: number;
      rightFootY?: number;
      lastJumpMode?: string;
    }
  >();
  private tempVec = new THREE.Vector3();
  private tempVec2 = new THREE.Vector3();
  private isDragging = false;
  private lastMouse = { x: 0, y: 0 };
  private pointerLocked = false;
  private gltfLoader = new GLTFLoader();
  private fbxLoader = new FBXLoader();
  private vrms: VRM[] = [];
  private readonly vrmUrl = '/avatars/default.vrm';
  private mixamoClips: Record<string, { clip: THREE.AnimationClip; rig: THREE.Object3D }> = {};
  private jsonClips: Record<string, ClipData> = {};
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
    debug?: { idleTracks: number; walkTracks: number; idleName?: string; walkName?: string };
  }> = [];
  private crowdTemplate: VRM | null = null;
  private readonly crowdVrmUrl = '/avatars/crowd.vrm';
  private localPlayer: THREE.Object3D;
  private localVelocityY = 0;
  private localVelocityX = 0;
  private localVelocityZ = 0;
  private parkourState: 'normal' | 'slide' | 'vault' | 'climb' | 'roll' = 'normal';
  private parkourTimer = 0;
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
        lookYaw: number;
        lookPitch: number;
        animState: string;
        animTime: number;
        yaw: number;
      }>;
    }
  >();
  private localId: string | null = null;
  private readonly remoteBufferSeconds = 0.12;
  private crowdAgents: CrowdSnapshot['agents'] = [];
  private remoteLatest = new Map<string, { x: number; y: number; z: number }>();
  private remoteLatestVel = new Map<string, Vec3>();
  private readonly disableProcedural = true;
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
    crowd: 'crowd: none',
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
    void this.loadPlayerConfig();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0b0c12, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0b0c12, 20, 120);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 300);
    this.camera.position.set(0, 4, 6);
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
    this.animateCrowd(elapsed, delta);
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

  private sampleGroundHeight(x: number, z: number) {
    let height = GROUND_Y;
    for (const obstacle of OBSTACLES) {
      const halfX = obstacle.size.x / 2;
      const halfZ = obstacle.size.z / 2;
      if (Math.abs(x - obstacle.position.x) <= halfX && Math.abs(z - obstacle.position.z) <= halfZ) {
        height = Math.max(height, obstacle.size.y + obstacle.position.y);
      }
    }
    return height;
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
    group.userData.capsule = { mesh, baseRadius: radius, baseLength: length, hip: null as THREE.Object3D | null };
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
      vrm.humanoid.getRawBoneNode('leftFoot') ?? undefined,
      vrm.humanoid.getRawBoneNode('rightFoot') ?? undefined,
      vrm.humanoid.getRawBoneNode('leftToes') ?? undefined,
      vrm.humanoid.getRawBoneNode('rightToes') ?? undefined,
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
        const crowdPrefix = 'crowd_';
        const normalized = (vrm.humanoid.normalizedHumanBones ?? {}) as Record<
          string,
          { node?: THREE.Object3D }
        >;
        const normalizedMap = Object.entries(normalized)
          .filter(([, bone]) => bone?.node)
          .map(([key, bone]) => ({ key, name: bone!.node!.name }));
        const rawKeys = Object.keys(normalized);
        const rawMap = rawKeys
          .map((key) => ({ key, node: vrm.humanoid.getRawBoneNode(key as any) }))
          .filter((entry) => entry.node)
          .map((entry) => ({ key: entry.key, name: entry.node!.name }));
        const normalizedRootName = vrm.humanoid.normalizedHumanBonesRoot?.name ?? null;
        const idleClip = this.jsonClips.idle
          ? buildAnimationClipFromData('idle', this.jsonClips.idle, { prefix: crowdPrefix, rootKey: 'hips' })
          : null;
        const walkClip = this.jsonClips.walk
          ? buildAnimationClipFromData('walk', this.jsonClips.walk, { prefix: crowdPrefix, rootKey: 'hips' })
          : idleClip;
        const baseY = this.computeVrmGroundOffset(vrm);
        const count = CROWD_COUNT;
        this.crowdAvatars = [];
        for (let i = 0; i < count; i += 1) {
          const clone = SkeletonUtils.clone(vrm.scene) as THREE.Object3D;
          clone.traverse((obj) => {
            obj.frustumCulled = false;
          });
          for (const mapping of rawMap) {
            const target = clone.getObjectByName(mapping.name);
            if (target) {
              target.name = `${crowdPrefix}${mapping.key}`;
            }
          }
          for (const mapping of normalizedMap) {
            const target = clone.getObjectByName(mapping.name);
            if (target) {
              target.name = `${crowdPrefix}${mapping.key}`;
            }
          }
          if (normalizedRootName) {
            const rootNode = clone.getObjectByName(normalizedRootName);
            if (rootNode && !rootNode.parent) {
              clone.add(rootNode);
            }
          }
          const scale = 0.92 + Math.random() * 0.12;
          clone.scale.set(scale, scale, scale);
          const radius = 18 + Math.random() * 26;
          const angle = Math.random() * Math.PI * 2;
          clone.position.set(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius);
          clone.rotation.y = Math.random() * Math.PI * 2 + Math.PI;
          const mixer = new THREE.AnimationMixer(clone);
          const actions: Record<string, THREE.AnimationAction> = {};
          const applyActionSettings = (name: string, action: THREE.AnimationAction) => {
            action.enabled = true;
            action.clampWhenFinished = true;
            action.loop = name === 'jump' ||
              name === 'jump_up' ||
              name === 'run_jump' ||
              name === 'land' ||
              name === 'hang_wall' ||
              name === 'climb_up' ||
              name === 'slide' ||
              name === 'attack' ||
              name === 'hit' ||
              name === 'knockdown'
              ? THREE.LoopOnce
              : THREE.LoopRepeat;
            action.play();
            action.weight = name === 'idle' ? 1 : 0;
          };
          for (const [name, clipData] of Object.entries(this.jsonClips)) {
            const clip = buildAnimationClipFromData(name, clipData, { prefix: crowdPrefix, rootKey: 'hips' });
            const action = mixer.clipAction(clip);
            applyActionSettings(name, action);
            actions[name] = action;
          }
          if (!actions.idle && idleClip) {
            const action = mixer.clipAction(idleClip);
            applyActionSettings('idle', action);
            actions.idle = action;
          }
          if (!actions.walk && walkClip) {
            const action = mixer.clipAction(walkClip);
            applyActionSettings('walk', action);
            actions.walk = action;
          }
          group.add(clone);
          const debug = !this.crowdAvatars.length
            ? {
                idleTracks: idleClip?.tracks.length ?? 0,
                walkTracks: walkClip?.tracks.length ?? 0,
                idleName: actions.idle?.getClip().name,
                walkName: actions.walk?.getClip().name,
              }
            : undefined;
          this.crowdAvatars.push({
            root: clone,
            baseY,
            mixer,
            actions: actions as { idle?: THREE.AnimationAction; walk?: THREE.AnimationAction },
            debug,
          });
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
    group.userData.capsule = { mesh, baseRadius: radius, baseLength: length, hip: null as THREE.Object3D | null };
    void this.loadVrmInto(group, id);
    return group;
  }

  private animateCrowd(time: number, delta: number) {
    if (this.crowdAvatars.length === 0) return;
    if (this.crowdAvatars[0]?.debug) {
      const dbg = this.crowdAvatars[0].debug!;
      const idleW = this.crowdAvatars[0].actions.idle?.weight ?? 0;
      const walkW = this.crowdAvatars[0].actions.walk?.weight ?? 0;
      this.statusLines.crowd = `crowd: idleTracks ${dbg.idleTracks}, walkTracks ${dbg.walkTracks}, idleW ${idleW.toFixed(2)}, walkW ${walkW.toFixed(2)}`;
      const node = this.hud.querySelector('[data-hud-crowd]');
      if (node) node.textContent = this.statusLines.crowd;
    }
    if (this.crowdAgents.length > 0) {
      const count = Math.min(this.crowdAvatars.length, this.crowdAgents.length);
      for (let i = 0; i < count; i += 1) {
        const agent = this.crowdAgents[i]!;
        const avatar = this.crowdAvatars[i]!;
        avatar.root.position.set(agent.position.x, avatar.baseY, agent.position.z);
        if (Math.hypot(agent.velocity.x, agent.velocity.z) > 0.05) {
          avatar.root.rotation.y = Math.atan2(agent.velocity.x, agent.velocity.z) + Math.PI;
        }
        const crowdId = `crowd_${i}`;
        if (agent.state === 'attack' || agent.state === 'hit') {
          this.remoteLatestAnim.set(crowdId, {
            state: agent.state,
            time: agent.stateTime ?? 0,
          });
        } else {
          this.remoteLatestAnim.delete(crowdId);
        }
        const crowdActor = {
          vrm: this.crowdTemplate!,
          mixer: avatar.mixer,
          actions: avatar.actions,
          base: 'idle' as const,
          id: crowdId,
          velocityOverride: agent.velocity,
        };
        this.updateActorAnimation(crowdActor, delta);
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
      '<strong>Sleepy Engine Prototype</strong>',
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
      `<div data-hud-crowd>${this.statusLines.crowd}</div>`,
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
    const movementLocked = this.localMovementLockTimer > 0;
    const moveX = movementLocked ? 0 : rotated.x;
    const moveZ = movementLocked ? 0 : rotated.z;
    this.updateInputHud(movement.x, movement.z);
    this.updateKeyHud();

    this.roomClient.sendInput({
      seq: this.seq++,
      moveX,
      moveZ,
      lookYaw: this.localLookYaw,
      lookPitch: this.localLookPitch,
      animState: this.localAnimState,
      animTime: this.localAnimTime,
      sprint: movementLocked ? false : flags.sprint,
      attack: flags.attack,
      interact: flags.interact,
      jump: movementLocked ? false : flags.jump,
      crouch: movementLocked ? false : flags.crouch,
    });
  }

  private animateLocalPlayer(delta: number) {
    const flags = this.input.getFlags();
    const movement = this.input.getVector();
    const rotated = this.rotateMovementByCamera(movement.x, movement.z);
    const moveX = rotated.x;
    const moveZ = rotated.z;
    const groundHeight = this.sampleGroundHeight(this.localPlayer.position.x, this.localPlayer.position.z);
    const onGround = this.localPlayer.position.y <= groundHeight + 0.001;
    const movementLocked = this.localMovementLockTimer > 0;
    const moveDir = new THREE.Vector3(moveX, 0, moveZ);
    if (moveDir.lengthSq() > 1e-6) moveDir.normalize();
    this.lastMoveInput = { x: movement.x, z: movement.z };
    this.lastMoveDir.copy(moveDir);
    if (!movementLocked && moveDir.lengthSq() > 1e-6) {
      const desiredYaw = Math.atan2(moveDir.x, moveDir.z) + Math.PI;
      const currentYaw = this.localPlayer.rotation.y;
      let deltaYaw = desiredYaw - currentYaw;
      deltaYaw = Math.atan2(Math.sin(deltaYaw), Math.cos(deltaYaw));
      this.lastYawDelta = deltaYaw;
      this.localPlayer.rotation.y = desiredYaw;
    } else {
      this.lastYawDelta = 0;
    }

    this.parkourTimer = Math.max(0, this.parkourTimer - delta);
    this.vaultCooldown = Math.max(0, this.vaultCooldown - delta);
    this.rollCooldown = Math.max(0, this.rollCooldown - delta);
    this.slideCooldown = Math.max(0, this.slideCooldown - delta);

    const speedBase = MOVE_SPEED * (flags.sprint ? SPRINT_MULTIPLIER : flags.crouch ? CROUCH_MULTIPLIER : 1);
    const accel = Math.min(1, SLIDE_ACCEL * delta);

    const startSlide = !movementLocked && onGround && flags.crouch && flags.sprint && this.slideCooldown <= 0;
    const startVault = !movementLocked && onGround && flags.jump && this.vaultCooldown <= 0 && this.checkVault(moveDir);
    const startClimb = !movementLocked && !onGround && flags.jump && this.vaultCooldown <= 0 && this.checkClimb(moveDir);
    const startFlip = !movementLocked && onGround && flags.jump && flags.sprint && this.vaultCooldown <= 0 && !startVault;

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
    } else if (this.parkourTimer <= 0) {
      this.parkourState = 'normal';
    }

    if (this.parkourState === 'normal' && !movementLocked) {
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
    } else if (movementLocked) {
      this.localVelocityX = 0;
      this.localVelocityZ = 0;
    }

    if (!movementLocked && flags.jump && onGround && this.parkourState === 'normal') {
      const walkThreshold = 0.15;
      const runThreshold = MOVE_SPEED * 0.65;
      const speed = Math.hypot(this.localVelocityX, this.localVelocityZ);
      if (speed <= walkThreshold) this.localJumpMode = 'jump_up';
      else if (speed > runThreshold) this.localJumpMode = 'run_jump';
      else this.localJumpMode = 'jump';
      this.localVelocityY = JUMP_SPEED;
    }

    this.localVelocityY += GRAVITY * delta;

    const next = {
      x: this.localPlayer.position.x + this.localVelocityX * delta,
      y: this.localPlayer.position.y + this.localVelocityY * delta,
      z: this.localPlayer.position.z + this.localVelocityZ * delta,
    };
    const nextGround = this.sampleGroundHeight(next.x, next.z);
    if (next.y <= nextGround) {
      next.y = nextGround;
      if (this.localVelocityY < -8 && this.rollCooldown <= 0) {
        this.parkourState = 'roll';
        this.parkourTimer = 0.3;
        this.rollCooldown = 0.6;
      }
      this.localVelocityY = 0;
    }

    let resolved = next;
    for (const obstacle of OBSTACLES) {
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
    this.localPlayer.position.y = Math.max(
      resolved.y,
      this.sampleGroundHeight(resolved.x, resolved.z),
    );
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
    const target = this.cameraTarget.set(
      this.localPlayer.position.x,
      this.localPlayer.position.y + 1.4,
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
    this.cameraGoal.copy(target).add(this.orbitOffset);

    // Cinematic right-shoulder offset.
    this.cameraForward.subVectors(target, this.cameraGoal).normalize();
    this.cameraRight.crossVectors(this.cameraForward, new THREE.Vector3(0, 1, 0)).normalize();
    this.cameraGoal.addScaledVector(this.cameraRight, 1.2);
    this.cameraGoal.y += 0.4;

    // Prevent camera from dipping below the floor.
    const minCamY = GROUND_Y + 0.9;
    if (this.cameraGoal.y < minCamY) {
      this.cameraGoal.y = minCamY;
    }

    const smooth = 1 - Math.exp(-delta * 6);
    this.camera.position.lerp(this.cameraGoal, smooth);
    this.camera.lookAt(target);

    const forward = this.camera.getWorldDirection(this.cameraForward).normalize();
    const inv = this.cameraQuat.copy(this.localPlayer.getWorldQuaternion(this.cameraQuat)).invert();
    const localDir = forward.applyQuaternion(inv);
    const yaw = Math.atan2(localDir.x, localDir.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(-localDir.y, -0.7, 0.7));
    this.localLookYaw = THREE.MathUtils.clamp(yaw, -0.8, 0.8);
    this.localLookPitch = THREE.MathUtils.clamp(pitch, -0.6, 0.6);

    // Camera no longer rotates the player directly.
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
        lookYaw: playerSnap.lookYaw ?? 0,
        lookPitch: playerSnap.lookPitch ?? 0,
        animState: playerSnap.animState ?? 'idle',
        animTime: playerSnap.animTime ?? 0,
        yaw: playerSnap.yaw ?? 0,
      });
      this.remoteLatest.set(id, { ...playerSnap.position });
      this.remoteLatestVel.set(id, { ...playerSnap.velocity });
      this.remoteLatestLook.set(id, {
        yaw: playerSnap.lookYaw ?? 0,
        pitch: playerSnap.lookPitch ?? 0,
      });
      this.remoteLatestAnim.set(id, {
        state: playerSnap.animState ?? 'idle',
        time: playerSnap.animTime ?? 0,
      });
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
      this.remoteLatestAnim.delete(id);
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
        if (Number.isFinite(snap.yaw)) {
          mesh.rotation.y = snap.yaw;
        }
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
        if (Number.isFinite(older.yaw)) {
          mesh.rotation.y = older.yaw;
        }
        continue;
      }

      const span = newer.t - older.t;
      const alpha = span > 0.0001 ? (renderTime - older.t) / span : 0;
      mesh.position.set(
        THREE.MathUtils.lerp(older.position.x, newer.position.x, alpha),
        THREE.MathUtils.lerp(older.position.y, newer.position.y, alpha),
        THREE.MathUtils.lerp(older.position.z, newer.position.z, alpha),
      );
      if (Number.isFinite(older.yaw) && Number.isFinite(newer.yaw)) {
        const dy = Math.atan2(Math.sin(newer.yaw - older.yaw), Math.cos(newer.yaw - older.yaw));
        mesh.rotation.y = older.yaw + dy * alpha;
      }
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
        this.updateCapsuleToVrm(group, vrm);
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

  private updateCapsuleToVrm(group: THREE.Group, vrm: VRM) {
    const capsule = group.userData.capsule as
      | { mesh: THREE.Mesh; baseRadius: number; baseLength: number; hip: THREE.Object3D | null }
      | undefined;
    if (!capsule) return;
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const height = Math.max(1, size.y);
    const width = Math.max(size.x, size.z);
    const desiredRadius = Math.max(0.25, width * 0.2) * this.playerConfig.capsuleRadiusScale;
    const desiredHeight = height * 0.92 * this.playerConfig.capsuleHeightScale;
    const baseHeight = capsule.baseLength + capsule.baseRadius * 2;
    const scaleY = desiredHeight / baseHeight;
    const scaleXZ = desiredRadius / capsule.baseRadius;
    capsule.mesh.scale.set(scaleXZ, scaleY, scaleXZ);
    capsule.mesh.position.y = (baseHeight * scaleY) / 2 + this.playerConfig.capsuleYOffset;
    capsule.hip = vrm.humanoid.getRawBoneNode('hips');
  }

  private syncCapsuleToHips(vrm: VRM) {
    const group = vrm.scene.parent as THREE.Group | null;
    if (!group) return;
    const capsule = group.userData.capsule as
      | { mesh: THREE.Mesh; baseRadius: number; baseLength: number; hip: THREE.Object3D | null }
      | undefined;
    if (!capsule?.hip) return;
    this.tempVec.set(0, 0, 0);
    capsule.hip.getWorldPosition(this.tempVec);
    group.worldToLocal(this.tempVec);
    capsule.mesh.position.x = this.tempVec.x;
    capsule.mesh.position.z = this.tempVec.z;
    capsule.mesh.rotation.y = capsule.hip.rotation.y;
  }

  private async loadPlayerConfig() {
    try {
      const res = await fetch('/config/player.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as Partial<typeof this.playerConfig>;
      this.playerConfig = { ...this.playerConfig, ...data };
      for (const vrm of this.vrms) {
        const group = vrm.scene.parent as THREE.Group | null;
        if (group) this.updateCapsuleToVrm(group, vrm);
      }
    } catch (error) {
      console.warn('Player config load failed', error);
    }
  }

  private updateVrms(delta: number) {
    for (const vrm of this.vrms) {
      vrm.update(delta);
    }
    for (const actor of this.vrmActors.values()) {
      actor.mixer.update(delta);
      this.updateActorAnimation(actor, delta);
      this.syncCapsuleToHips(actor.vrm);
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
      if (lower.includes('run') && lower.includes('jump')) return 'run_jump';
      if (lower.includes('run')) return 'run';
      if (lower.includes('jump up') || lower.includes('jump_up')) return 'jump_up';
      if (lower.includes('jump')) return 'jump';
      if (lower.includes('hang') && lower.includes('wall')) return 'hang_wall';
      if (lower.includes('climb up') || lower.includes('climb_up')) return 'climb_up';
      if (lower.includes('slide')) return 'slide';
      if (lower.includes('fall')) return 'fall';
      if (lower.includes('land')) return 'land';
      if (lower.includes('attack') || lower.includes('punch') || lower.includes('kick')) {
        return 'attack';
      }
      if (lower.includes('hit') || lower.includes('damage')) return 'hit';
      if (lower.includes('knock') || lower.includes('down')) return 'knockdown';
      if (lower.includes('strafe') && lower.includes('left')) return 'strafeLeft';
      if (lower.includes('strafe') && lower.includes('right')) return 'strafeRight';
      if (lower.includes('strafe')) return 'strafeLeft';
      if (lower.includes('turn') && lower.includes('left')) return 'turnLeft';
      if (lower.includes('turn') && lower.includes('right')) return 'turnRight';
      if (lower.includes('turn')) return 'turnLeft';
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

    const jsonEntries = (manifest ?? []).filter(
      (name) => name.toLowerCase().endsWith('.json') && !name.toLowerCase().startsWith('none'),
    );

    await Promise.all(
      jsonEntries.map(async (name) => {
        try {
          const res = await fetch(`/animations/${encodeURIComponent(name)}`, { cache: 'no-store' });
          if (!res.ok) return;
          const payload = (await res.json()) as unknown;
          const data = parseClipPayload(payload);
          if (!data) return;
          const key = resolveKey(name);
          this.jsonClips[key] = data;
        } catch (err) {
          console.warn('Failed to load clip json', name, err);
        }
      }),
    );

    if (Object.keys(this.jsonClips).length === 0) {
      console.warn('JSON clips failed to load.');
    }

    const maybeMirror = (leftKey: string, rightKey: string) => {
      if (!this.jsonClips[rightKey] && this.jsonClips[leftKey]) {
        this.jsonClips[rightKey] = mirrorClipData(this.jsonClips[leftKey]);
      }
      if (!this.jsonClips[leftKey] && this.jsonClips[rightKey]) {
        this.jsonClips[leftKey] = mirrorClipData(this.jsonClips[rightKey]);
      }
    };
    maybeMirror('strafeLeft', 'strafeRight');
    maybeMirror('turnLeft', 'turnRight');
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
      action.loop = name === 'jump' ||
        name === 'jump_up' ||
        name === 'run_jump' ||
        name === 'land' ||
        name === 'hang_wall' ||
        name === 'climb_up' ||
        name === 'slide' ||
        name === 'attack' ||
        name === 'hit' ||
        name === 'knockdown'
        ? THREE.LoopOnce
        : THREE.LoopRepeat;
      action.play();
      action.weight = name === 'idle' ? 1 : 0;
    };
    for (const [name, clipData] of Object.entries(this.jsonClips)) {
      const clip = buildAnimationClipFromData(name, clipData, { prefix: `${actorId}_`, rootKey: 'hips' });
      const action = mixer.clipAction(clip);
      applyActionSettings(name, action);
      actions[name] = action;
    }
    if (!actions.idle) {
      const fallback = Object.values(actions)[0];
      if (fallback) {
        actions.idle = fallback;
        actions.idle.weight = 1;
      }
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
    ensureAction('walk', ['walk', 'idle']);
    ensureAction('run', ['run', 'walk', 'idle']);
    ensureAction('strafeLeft', ['strafeLeft', 'walk', 'idle']);
    ensureAction('strafeRight', ['strafeRight', 'strafeLeft', 'walk', 'idle']);
    ensureAction('turnLeft', ['turnLeft', 'turnRight', 'idle']);
    ensureAction('turnRight', ['turnRight', 'turnLeft', 'idle']);
    ensureAction('jump_up', ['jump_up', 'jump', 'fall', 'idle']);
    ensureAction('jump', ['jump', 'jump_up', 'fall', 'idle']);
    ensureAction('run_jump', ['run_jump', 'jump', 'jump_up', 'fall', 'idle']);
    ensureAction('fall', ['fall', 'jump', 'jump_up', 'idle']);
    ensureAction('land', ['land', 'idle']);
    ensureAction('hang_wall', ['hang_wall', 'idle']);
    ensureAction('climb_up', ['climb_up', 'hang_wall', 'idle']);
    ensureAction('slide', ['slide', 'run', 'walk', 'idle']);
    ensureAction('attack', ['attack', 'hit', 'idle']);
    ensureAction('hit', ['hit', 'attack', 'idle']);
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
    velocityOverride?: { x: number; y: number; z: number };
  }, delta: number) {
    const actorId = actor.id;
    const local = actorId === 'local';
    let speed = 0;
    let vy = 0;
    if (actor.velocityOverride) {
      speed = Math.hypot(actor.velocityOverride.x, actor.velocityOverride.z);
      vy = actor.velocityOverride.y;
    } else if (local) {
      speed = Math.hypot(this.localVelocityX, this.localVelocityZ);
      vy = this.localVelocityY;
    } else if (actorId) {
      const vel = this.remoteLatestVel.get(actorId);
      if (vel) {
        speed = Math.hypot(vel.x, vel.z);
        vy = vel.y;
      }
    }

    const actions = actor.actions;
    const idle = actions.idle;
    const walk = actions.walk ?? idle;
    const run = actions.run ?? walk;
    const strafeLeft = actions.strafeLeft ?? walk;
    const strafeRight = actions.strafeRight ?? walk;
    const turnLeft = actions.turnLeft ?? idle;
    const turnRight = actions.turnRight ?? idle;
    const jumpUp = actions.jump_up ?? actions.jump ?? idle;
    const jump = actions.jump ?? jumpUp ?? idle;
    const runJump = actions.run_jump ?? jump ?? jumpUp ?? idle;
    const fall = actions.fall ?? jump ?? idle;
    const land = actions.land ?? idle;
    const hangWall = actions.hang_wall ?? idle;
    const climbUp = actions.climb_up ?? hangWall ?? idle;
    const slide = actions.slide ?? run ?? walk ?? idle;
    const attack = actions.attack ?? idle;
    const hit = actions.hit ?? idle;
    if (!idle || !walk || !run) return;

    const state =
      this.animStates.get(actorId) ??
      { mode: 'idle', timer: 0, lastGrounded: true, lookYaw: 0, lookPitch: 0, lastJumpMode: 'jump' };
    const prevMode = state.mode;

    const grounded = actorId === 'local'
      ? this.localPlayer.position.y <=
        this.sampleGroundHeight(this.localPlayer.position.x, this.localPlayer.position.z) + 0.001
      : (() => {
          const pos = this.remoteLatest.get(actorId);
          if (!pos) return true;
          const floor = this.sampleGroundHeight(pos.x, pos.z);
          return pos.y <= floor + 0.001;
        })();

    if (!state.lastGrounded && grounded) {
      state.mode = 'land';
      state.timer = land?.getClip().duration ?? 0.2;
    }
    state.lastGrounded = grounded;

    if (actorId === 'local' && this.input.getFlags().attack) {
      state.mode = 'attack';
      state.timer = attack?.getClip().duration ?? 0.35;
    }
    if (actorId === 'local') {
      const flags = this.input.getFlags();
      if (flags.sprint && flags.crouch && grounded && state.mode !== 'slide' && state.timer === 0) {
        state.mode = 'slide';
        state.timer = slide?.getClip().duration ?? 0.4;
      }
    }

    if (state.timer > 0) {
      state.timer = Math.max(0, state.timer - delta);
      if (state.timer === 0 && ['attack', 'land', 'hit'].includes(state.mode)) {
        state.mode = 'idle';
      }
    }

    if (local && this.parkourState === 'climb' && state.timer === 0) {
      const pick = vy > 0.2 ? 'climb_up' : 'hang_wall';
      state.mode = pick;
      state.timer = (pick === 'climb_up' ? climbUp : hangWall)?.getClip().duration ?? 0.35;
    }

    const forcedRemote = !local && this.remoteLatestAnim.get(actorId);
    if (forcedRemote) {
      const remote = this.remoteLatestAnim.get(actorId)!;
      state.mode = remote.state;
      state.timer = 0;
    } else if (!grounded) {
      state.mode = vy > 0.5 ? (local ? this.localJumpMode : (state.lastJumpMode ?? 'jump')) : 'fall';
    } else if (state.timer === 0) {
      const walkThreshold = 0.15;
      const runThreshold = MOVE_SPEED * 0.65;
      let desired = 'idle';
      if (speed > runThreshold) desired = 'run';
      else if (speed > walkThreshold) desired = 'walk';

      if (actorId === 'local') {
        const yawDelta = this.lastYawDelta;
        if (speed < 0.15 && Math.abs(yawDelta) > 0.35) {
          desired = yawDelta > 0 ? 'turnLeft' : 'turnRight';
        } else if (speed > walkThreshold) {
          const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            this.localPlayer.rotation.y,
          );
          const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
          const side = right.dot(this.lastMoveDir);
          const fwd = forward.dot(this.lastMoveDir);
          if (Math.abs(side) > 0.6 && Math.abs(fwd) < 0.4) {
            desired = side > 0 ? 'strafeRight' : 'strafeLeft';
          }
        }
      }
      state.mode = desired;
    }

    if (grounded && ['fall', 'jump', 'jump_up', 'run_jump'].includes(prevMode)) {
      state.mode = 'land';
      state.timer = land?.getClip().duration ?? 0.2;
    }

    if (state.mode === 'land' && prevMode !== 'land') {
      for (const key of ['fall', 'jump', 'jump_up', 'run_jump']) {
        const action = actions[key];
        if (action) {
          action.stop();
          action.reset();
          action.weight = 0;
        }
      }
    }

    const weights: {
      idle: number;
      walk: number;
      run: number;
      strafeLeft: number;
      strafeRight: number;
      turnLeft: number;
      turnRight: number;
      jump: number;
      jump_up: number;
      run_jump: number;
      fall: number;
      land: number;
      hang_wall: number;
      climb_up: number;
      slide: number;
      attack: number;
      hit: number;
    } = {
      idle: 0,
      walk: 0,
      run: 0,
      strafeLeft: 0,
      strafeRight: 0,
      turnLeft: 0,
      turnRight: 0,
      jump: 0,
      jump_up: 0,
      run_jump: 0,
      fall: 0,
      land: 0,
      hang_wall: 0,
      climb_up: 0,
      slide: 0,
      attack: 0,
      hit: 0,
    };

    switch (state.mode) {
      case 'run':
        weights.run = 1;
        break;
      case 'walk':
        weights.walk = 1;
        break;
      case 'strafeLeft':
        weights.strafeLeft = 1;
        break;
      case 'strafeRight':
        weights.strafeRight = 1;
        break;
      case 'turnLeft':
        weights.turnLeft = 1;
        break;
      case 'turnRight':
        weights.turnRight = 1;
        break;
      case 'jump_up':
        weights.jump_up = 1;
        break;
      case 'run_jump':
        weights.run_jump = 1;
        break;
      case 'jump':
        weights.jump = 1;
        break;
      case 'fall':
        weights.fall = 1;
        break;
      case 'land':
        weights.land = 1;
        break;
      case 'hang_wall':
        weights.hang_wall = 1;
        break;
      case 'climb_up':
        weights.climb_up = 1;
        break;
      case 'slide':
        weights.slide = 1;
        break;
      case 'attack':
        weights.attack = 1;
        break;
      case 'hit':
        weights.hit = 1;
        break;
      default:
        weights.idle = 1;
    }

    const apply = (
      action: THREE.AnimationAction | undefined,
      weight: number,
      oneShot = false,
      name?: string,
    ) => {
      if (!action) return;
      action.enabled = true;
      action.paused = false;
      if (!action.isRunning()) action.play();
      if (forcedRemote && name && name === state.mode) {
        const remote = this.remoteLatestAnim.get(actorId)!;
        const duration = action.getClip().duration || 1;
        const time = ((remote.time % duration) + duration) % duration;
        action.time = time;
      }
      const target = weight;
      action.weight = THREE.MathUtils.lerp(action.weight, target, 0.25);
      if (oneShot && weight > 0.8 && name && name !== prevMode) {
        action.reset().play();
      }
    };

    apply(idle, weights.idle, false, 'idle');
    apply(walk, weights.walk, false, 'walk');
    apply(run, weights.run, false, 'run');
    apply(strafeLeft, weights.strafeLeft, false, 'strafeLeft');
    apply(strafeRight, weights.strafeRight, false, 'strafeRight');
    apply(turnLeft, weights.turnLeft, true, 'turnLeft');
    apply(turnRight, weights.turnRight, true, 'turnRight');
    apply(jumpUp, weights.jump_up, true, 'jump_up');
    apply(runJump, weights.run_jump, true, 'run_jump');
    apply(jump, weights.jump, true, 'jump');
    apply(fall, weights.fall, false, 'fall');
    apply(land, weights.land, true, 'land');
    apply(hangWall, weights.hang_wall, true, 'hang_wall');
    apply(climbUp, weights.climb_up, true, 'climb_up');
    apply(slide, weights.slide, true, 'slide');
    apply(attack, weights.attack, true, 'attack');
    apply(hit, weights.hit, true, 'hit');

    this.animStates.set(actorId, state);
    if (local) {
      if (['land', 'attack'].includes(state.mode) && state.timer > 0) {
        this.localMovementLock = state.mode as 'land' | 'attack';
        this.localMovementLockTimer = state.timer;
      } else {
        this.localMovementLock = null;
        this.localMovementLockTimer = 0;
      }
      this.localAnimState = state.mode;
      const active = actions[state.mode] ?? actions.idle;
      if (active) {
        this.localAnimTime = active.time ?? 0;
      }
    }

    if (!actorId.startsWith('crowd_')) {
      const neck = actor.vrm.humanoid.getRawBoneNode('neck');
      const head = actor.vrm.humanoid.getRawBoneNode('head');
      const targetLook = local
        ? { yaw: -this.localLookYaw, pitch: -this.localLookPitch }
        : this.remoteLatestLook.get(actorId)
          ? {
              yaw: -(this.remoteLatestLook.get(actorId)!.yaw),
              pitch: -(this.remoteLatestLook.get(actorId)!.pitch),
            }
          : { yaw: 0, pitch: 0 };
      const smooth = 1 - Math.exp(-delta * 8);
      state.lookYaw = THREE.MathUtils.lerp(state.lookYaw, targetLook.yaw, smooth);
      state.lookPitch = THREE.MathUtils.lerp(state.lookPitch, targetLook.pitch, smooth);
      this.animStates.set(actorId, state);
      if (neck) {
        neck.rotation.y += state.lookYaw * 0.25;
        neck.rotation.x += state.lookPitch * 0.25;
      }
      if (head) {
        head.rotation.y += state.lookYaw * 0.45;
        head.rotation.x += state.lookPitch * 0.45;
      }

      const leftFoot = actor.vrm.humanoid.getRawBoneNode('leftFoot');
      const rightFoot = actor.vrm.humanoid.getRawBoneNode('rightFoot');
      if (leftFoot && rightFoot) {
        if (state.leftFootY === undefined) state.leftFootY = leftFoot.position.y;
        if (state.rightFootY === undefined) state.rightFootY = rightFoot.position.y;
        const applyFoot = (foot: THREE.Object3D, baseY: number) => {
          foot.getWorldPosition(this.tempVec);
          const targetY = this.sampleGroundHeight(this.tempVec.x, this.tempVec.z) + this.playerConfig.ikOffset;
          const deltaY = THREE.MathUtils.clamp(targetY - this.tempVec.y, -0.12, 0.25);
          foot.position.y = baseY + deltaY;
        };
        applyFoot(leftFoot, state.leftFootY);
        applyFoot(rightFoot, state.rightFootY);
      }
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
      const capture = (bone: THREE.Object3D | null | undefined, key: string) => {
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
