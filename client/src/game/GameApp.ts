import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { InputState } from '../input/InputState';
import { RoomClient } from '../net/RoomClient';
import {
  getGameModelFileUrl,
  getGameAnimation,
  getGameAvatarUrl,
  getGamePlayer,
  getGameScenes,
  listGameAnimations,
  type SceneObstacleRecord,
  type SceneRecord,
} from '../services/game-api';
import { RetroRenderer } from '../rendering/RetroRenderer';
import { RetroPostProcessor } from '../postprocessing/RetroPostProcessor';
import { RetroShaderMaterial } from '../materials/RetroShaderMaterial';
import { retroRenderSettings } from '../settings/RetroRenderSettings';
import {
  buildAnimationClipFromData,
  isClipData,
  mirrorClipData,
  parseClipPayload,
  type ClipData,
} from './clip';
import { retargetMixamoClip } from './retarget';
import {
  PlayerSnapshot,
  PlayerInput,
  WorldSnapshot,
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
  type Obstacle,
  resolveCircleAabb,
  resolveCircleCircle,
  type CrowdSnapshot,
  type ObstacleDynamicsSnapshot,
  type Vec3,
} from '@sleepy/shared';
import {
  createDefaultControllerModeConfigs,
  normalizeControllerModeConfigs,
  resolveRuntimeControllerMode,
  type ControllerMode,
  type ControllerModeConfigs,
  type ControllerTuning,
  type RuntimeControllerMode,
} from './controllers/mode-config';
import {
  RAGDOLL_BONE_DEFS,
  RAGDOLL_JOINT_PROFILE,
  RAGDOLL_SEGMENT_PROFILE,
  getRagdollDriveForBone,
  getRagdollJointForChild,
} from './controllers/ragdoll-profile';
import {
  RAGDOLL_ALL_BODY_GROUPS,
  RAGDOLL_COLLISION_GROUP_ENV,
  computeRagdollSegmentFrame,
  getRagdollBodyGroup,
  resolveRagdollSegmentChildBone,
} from './controllers/ragdoll-core';
import {
  applyModelOriginOffset,
  loadFbxObject,
  loadTexture,
  normalizeModelRootPivot,
} from './model/model-utils';
import type * as RAPIER from '@dimforge/rapier3d-compat';

type TerrainPreset = 'cinematic' | 'alpine' | 'dunes' | 'islands';
type GroundTexturePreset = 'concrete' | 'grass' | 'sand' | 'rock' | 'snow' | 'lava';
type SceneGroundTerrainConfig = {
  enabled: boolean;
  preset: TerrainPreset;
  size: number;
  resolution: number;
  maxHeight: number;
  roughness: number;
  seed: number;
};
type SceneWaterConfig = {
  enabled: boolean;
  level: number;
  opacity: number;
  waveAmplitude: number;
  waveFrequency: number;
  waveSpeed: number;
  colorShallow: string;
  colorDeep: string;
  specularStrength: number;
};
type SceneGroundConfig = {
  type: 'concrete';
  width: number;
  depth: number;
  y: number;
  textureRepeat: number;
  texturePreset: GroundTexturePreset;
  water?: SceneWaterConfig;
  terrain?: SceneGroundTerrainConfig;
};
type SceneEnvironmentConfig = {
  preset: 'clear_day' | 'sunset' | 'night' | 'foggy' | 'overcast';
  fogNear: number;
  fogFar: number;
  skybox: {
    enabled: boolean;
    preset: 'clear_day' | 'sunset_clouds' | 'midnight_stars' | 'nebula';
    intensity: number;
  };
};

type RuntimeSceneModelComponent = {
  type: 'model_instance';
  name?: string;
  modelId?: string;
  sourceFile?: string;
  sourcePath?: string;
  files?: string[];
  originOffset?: { x?: number; y?: number; z?: number };
  collider?: {
    shape?: 'box' | 'sphere' | 'capsule' | 'mesh';
    size?: { x?: number; y?: number; z?: number };
    radius?: number;
    height?: number;
    offset?: { x?: number; y?: number; z?: number };
    isTrigger?: boolean;
  };
  physics?: {
    enabled?: boolean;
    bodyType?: 'static' | 'dynamic' | 'kinematic';
    mass?: number;
    friction?: number;
    restitution?: number;
    linearDamping?: number;
    angularDamping?: number;
    gravityScale?: number;
    spawnHeightOffset?: number;
    initialVelocity?: { x?: number; y?: number; z?: number };
  };
  textures?: {
    baseColor?: string;
    normal?: string;
    roughness?: string;
    metalness?: string;
    emissive?: string;
  };
};

type RuntimeObstacleColliderConfig = {
  shape: 'box' | 'sphere' | 'capsule' | 'mesh';
  isTrigger: boolean;
  bodyType: 'static' | 'dynamic' | 'kinematic';
  offset: { x: number; y: number; z: number };
  physicsEnabled: boolean;
  friction: number;
  restitution: number;
  linearDamping: number;
  gravityScale: number;
  spawnHeightOffset: number;
  initialVelocity: { x: number; y: number; z: number };
  proxy: Obstacle;
};
type RuntimePlayerConfig = {
  avatar: string;
  ikOffset: number;
  capsuleRadiusScale: number;
  capsuleHeightScale: number;
  capsuleYOffset: number;
  moveSpeed: number;
  sprintMultiplier: number;
  crouchMultiplier: number;
  slideAccel: number;
  slideFriction: number;
  gravity: number;
  jumpSpeed: number;
  walkThreshold: number;
  runThreshold: number;
  cameraDistance: number;
  cameraHeight: number;
  cameraShoulder: number;
  cameraShoulderHeight: number;
  cameraSensitivity: number;
  cameraSmoothing: number;
  cameraMinPitch: number;
  cameraMaxPitch: number;
  targetSmoothSpeed: number;
  profile?: { controller?: ControllerMode };
  controllerModes?: ControllerModeConfigs;
};
const JUMP_COYOTE_SECONDS = 0.14;
const DYNAMIC_PHYSICS_ITERATIONS = 3;
const PLAYER_PUSH_HEIGHT = 1.8;
const PLAYER_PUSH_IMPULSE = 0.85;
const PLAYER_PUSH_TANGENT = 0.35;
const PLAYER_PUSH_MAX_SPEED = 18;
const RUNTIME_RAGDOLL_DRIVE_STIFFNESS_SCALE = 0.42;
const RUNTIME_RAGDOLL_DRIVE_DAMPING_SCALE = 0.55;
const RUNTIME_RAGDOLL_DRIVE_FORCE_SCALE = 0.38;
const RUNTIME_RAGDOLL_MAX_LINEAR_VELOCITY = 12;
const RUNTIME_RAGDOLL_MAX_ANGULAR_VELOCITY = 10;
const RUNTIME_RAGDOLL_LINEAR_BLEED = 0.985;
const RUNTIME_RAGDOLL_ANGULAR_BLEED = 0.9;

type DynamicObstacleBody = {
  id: string;
  obstacle: Obstacle;
  config: RuntimeObstacleColliderConfig;
  velocity: THREE.Vector3;
};

type HumanBoneName = Parameters<VRM['humanoid']['getRawBoneNode']>[0];

type RuntimeRagdollMode = 'off' | 'reactive' | 'ragdoll';

type RuntimeRagdollBone = {
  name: string;
  driveGroup?: 'core' | 'neck' | 'arm' | 'leg';
  bone: THREE.Object3D;
  child: THREE.Object3D | null;
  body: RAPIER.RigidBody;
  bodyToBone?: THREE.Quaternion;
  targetLocalQuat?: THREE.Quaternion;
  muscleScale?: number;
  hingeAxisLocal?: THREE.Vector3;
  hingeMin?: number;
  hingeMax?: number;
  twistAxisLocal?: THREE.Vector3;
  swingLimitRad?: number;
  twistLimitRad?: number;
  parent?: RuntimeRagdollBone;
  radius?: number;
};

export class GameApp {
  private sceneName: string;
  private gameId: string;
  private obstacles: Obstacle[] = [];
  private obstacleGroup: THREE.Group | null = null;
  private obstaclePlaceholderMeshes = new Map<string, THREE.Mesh>();
  private obstacleModelRoots = new Map<string, THREE.Object3D>();
  private obstacleColliderConfig = new Map<string, RuntimeObstacleColliderConfig>();
  private obstaclePhysicsVelocity = new Map<string, THREE.Vector3>();
  private sceneComponents: Record<string, Record<string, unknown>> = {};
  private groundMesh: THREE.Mesh | null = null;
  private waterMesh: THREE.Mesh | null = null;
  private waterMaterial: THREE.ShaderMaterial | null = null;
  private groundConfig: SceneGroundConfig | null = null;
  private groundTextureCache = new Map<GroundTexturePreset, THREE.CanvasTexture>();
  private skyTextureCache = new Map<string, THREE.Texture>();
  private skyEnvironmentCache = new Map<string, THREE.Texture>();
  private skyDomeMesh: THREE.Mesh | null = null;
  private sceneAmbientLight: THREE.AmbientLight | null = null;
  private sceneDirectionalLight: THREE.DirectionalLight | null = null;
  private playerConfig: RuntimePlayerConfig = {
    avatar: '',
    ikOffset: 0.02,
    capsuleRadiusScale: 1,
    capsuleHeightScale: 1,
    capsuleYOffset: 0,
    moveSpeed: MOVE_SPEED,
    sprintMultiplier: SPRINT_MULTIPLIER,
    crouchMultiplier: CROUCH_MULTIPLIER,
    slideAccel: SLIDE_ACCEL,
    slideFriction: SLIDE_FRICTION,
    gravity: GRAVITY,
    jumpSpeed: JUMP_SPEED,
    walkThreshold: 0.15,
    runThreshold: MOVE_SPEED * 0.65,
    cameraDistance: 6,
    cameraHeight: 1.4,
    cameraShoulder: 1.2,
    cameraShoulderHeight: 0.4,
    cameraSensitivity: 1,
    cameraSmoothing: 0,
    cameraMinPitch: 0.2,
    cameraMaxPitch: Math.PI - 0.2,
    targetSmoothSpeed: 15,
    profile: {
      controller: 'third_person' as ControllerMode,
    },
    controllerModes: createDefaultControllerModeConfigs(),
  };
  private activeControllerMode: RuntimeControllerMode = 'third_person';
  private sceneControllerModeOverride: ControllerMode | null = null;
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private retroRenderer: RetroRenderer | null = null;
  private retroPostProcessor: RetroPostProcessor | null = null;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private orbitYaw = 0;
  private orbitPitch = Math.PI / 4;
  private orbitRadius = 6;
  private firstPersonMode = false;
  private cameraSmoothing = 0; // 0 = no smoothing (instant), 1 = full smoothing
  private cameraSensitivity = 1.0;
  private orbitOffset = new THREE.Vector3();
  private orbitSpherical = new THREE.Spherical();
  private cameraTarget = new THREE.Vector3();
  private cameraTargetSmooth = new THREE.Vector3(); // Smoothed follow target
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
  private modelLoadCache = new Map<string, Promise<THREE.Object3D>>();
  private meshCollisionRaycaster = new THREE.Raycaster();
  private meshCollisionRayOrigin = new THREE.Vector3();
  private meshCollisionRayDir = new THREE.Vector3();
  private meshCollisionMove = new THREE.Vector3();
  private meshCollisionNormal = new THREE.Vector3();
  private meshCollisionNormalMatrix = new THREE.Matrix3();
  private vrms: VRM[] = [];
  private localAvatarName = 'default.vrm';
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
  private hudVisible = false;
  private perfHud: HTMLDivElement;
  private perfVisible = false;
  private touchControls: HTMLDivElement | null = null;
  private touchMoveActive = false;
  private touchLookActive = false;
  private touchMoveId: number | null = null;
  private touchLookId: number | null = null;
  private touchMoveOrigin = new THREE.Vector2();
  private touchLookOrigin = new THREE.Vector2();
  private touchLookDelta = new THREE.Vector2();
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
  private crowdAvatarName = 'crowd.vrm';
  private crowdEnabled = false;
  private crowdLoaded = false;
  private localPlayer: THREE.Object3D;
  private rapier: typeof import('@dimforge/rapier3d-compat') | null = null;
  private rapierReady: Promise<void> | null = null;
  private runtimeRagdollWorld: RAPIER.World | null = null;
  private runtimeRagdollBones: Map<string, RuntimeRagdollBone> = new Map();
  private runtimeRagdollMode: RuntimeRagdollMode = 'off';
  private runtimeRagdollActivationTime = 0;
  private runtimeRagdollBuildInFlight = false;
  private runtimeRagdollControlKeys = new Set<string>();
  private runtimeRagdollHipsOffset = new THREE.Vector3();
  private localFirstPersonVisualHidden = false;
  private localAvatarLoaded = false;
  private playerAvatarEnabled = false;
  private localVelocityY = 0;
  private localJumpCoyoteTimer = 0;
  private localVelocityX = 0;
  private localVelocityZ = 0;
  private localVisualOffset = new THREE.Vector3(); // Visual smoothing for network corrections
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
  private remoteBufferSeconds = 0.1; // Adaptive: starts at 100ms
  private remoteBufferMin = 0.05; // Min 50ms
  private remoteBufferMax = 0.2; // Max 200ms
  private lastSnapshotTimes: number[] = []; // Track snapshot arrival times for adaptive buffer
  private crowdAgents = new Map<
    number,
    { agent: CrowdSnapshot['agents'][0]; lastUpdate: number }
  >(); // Track by ID with timestamp
  private readonly CROWD_TIMEOUT = 2; // Remove crowd agents not updated for 2 seconds
  private remoteLatest = new Map<string, { x: number; y: number; z: number }>();
  private remoteRagdoll = new Map<string, boolean>();
  private remoteLatestVel = new Map<string, Vec3>();
  private receivedObstacleDynamics = false;
  private lastObstacleDynamicsAt = 0;
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
  private cameraSettingsListeners = new Set<
    (settings: {
      orbitRadius: number;
      cameraSmoothing: number;
      cameraSensitivity: number;
      firstPersonMode: boolean;
    }) => void
  >();
  private onBackToMenu: (() => void) | null = null;
  private handleContainerClick = () => {
    this.container.focus();
  };
  private handleDebugKeyDown = (event: KeyboardEvent) => {
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
    if (event.code === 'KeyV') {
      this.firstPersonMode = !this.firstPersonMode;
      this.syncLocalFirstPersonVisuals();
      this.emitCameraSettingsChange();
    }
  };
  private handleRagdollControlKeyDown = (event: KeyboardEvent) => {
    if (this.activeControllerMode !== 'ragdoll' || this.runtimeRagdollMode !== 'ragdoll') return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT')
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (!['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key))
      return;
    this.runtimeRagdollControlKeys.add(key);
    event.preventDefault();
  };
  private handleRagdollControlKeyUp = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (!this.runtimeRagdollControlKeys.has(key)) return;
    this.runtimeRagdollControlKeys.delete(key);
  };
  private parseSceneGround(input: unknown): SceneGroundConfig | null {
    if (!input || typeof input !== 'object') return null;
    const ground = input as {
      type?: string;
      width?: number;
      depth?: number;
      y?: number;
      textureRepeat?: number;
      texturePreset?: string;
      water?: {
        enabled?: boolean;
        level?: number;
        opacity?: number;
        waveAmplitude?: number;
        waveFrequency?: number;
        waveSpeed?: number;
        colorShallow?: string;
        colorDeep?: string;
        specularStrength?: number;
      };
      terrain?: {
        enabled?: boolean;
        preset?: string;
        size?: number;
        resolution?: number;
        maxHeight?: number;
        roughness?: number;
        seed?: number;
      };
    };
    const terrain = ground.terrain
      ? {
          enabled: ground.terrain.enabled === true,
          preset: (ground.terrain.preset ?? 'cinematic') as TerrainPreset,
          size: Math.max(16, Number(ground.terrain.size ?? ground.width ?? 120)),
          resolution: Math.max(8, Math.min(128, Number(ground.terrain.resolution ?? 48))),
          maxHeight: Math.max(1, Number(ground.terrain.maxHeight ?? 12)),
          roughness: Math.max(0.2, Math.min(0.95, Number(ground.terrain.roughness ?? 0.56))),
          seed: Math.floor(Number(ground.terrain.seed ?? 1337)),
        }
      : undefined;
    return {
      type: 'concrete',
      width: Math.max(1, Number(ground.width ?? 120)),
      depth: Math.max(1, Number(ground.depth ?? 120)),
      y: Number(ground.y ?? 0),
      textureRepeat: Math.max(1, Number(ground.textureRepeat ?? 12)),
      texturePreset: this.parseGroundTexturePreset(ground.texturePreset),
      water: this.parseSceneWater(ground.water),
      terrain,
    };
  }

  private parseSceneEnvironment(input: SceneRecord['environment'] | undefined): SceneEnvironmentConfig {
    const presetRaw = String(input?.preset ?? 'clear_day').toLowerCase();
    const preset: SceneEnvironmentConfig['preset'] =
      presetRaw === 'sunset' ||
      presetRaw === 'night' ||
      presetRaw === 'foggy' ||
      presetRaw === 'overcast' ||
      presetRaw === 'clear_day'
        ? presetRaw
        : 'clear_day';
    const skyboxPresetRaw = String(input?.skybox?.preset ?? 'clear_day').toLowerCase();
    const skyboxPreset: SceneEnvironmentConfig['skybox']['preset'] =
      skyboxPresetRaw === 'sunset_clouds' ||
      skyboxPresetRaw === 'midnight_stars' ||
      skyboxPresetRaw === 'nebula' ||
      skyboxPresetRaw === 'clear_day'
        ? skyboxPresetRaw
        : 'clear_day';
    return {
      preset,
      fogNear: Math.max(2, Number(input?.fogNear ?? 20)),
      fogFar: Math.max(8, Number(input?.fogFar ?? 120)),
      skybox: {
        enabled: input?.skybox?.enabled === true,
        preset: skyboxPreset,
        intensity: THREE.MathUtils.clamp(Number(input?.skybox?.intensity ?? 1), 0.2, 2),
      },
    };
  }

  private applySceneEnvironment(config: SceneEnvironmentConfig) {
    const fogPalette =
      config.preset === 'sunset'
        ? { background: 0x2a1f36, fog: 0x3d2a3f, ambient: 0.52, directional: 0.68 }
        : config.preset === 'night'
          ? { background: 0x070b14, fog: 0x0d1420, ambient: 0.35, directional: 0.45 }
          : config.preset === 'foggy'
            ? { background: 0x5b6977, fog: 0x7a8795, ambient: 0.7, directional: 0.5 }
            : config.preset === 'overcast'
              ? { background: 0x505865, fog: 0x656f7d, ambient: 0.62, directional: 0.56 }
              : { background: 0x0b0c12, fog: 0x19212d, ambient: 0.6, directional: 0.8 };
    if (config.skybox.enabled) {
      const key = `${config.skybox.preset}:${config.skybox.intensity.toFixed(2)}`;
      const skyTexture = this.getSkyTexture(config.skybox.preset, config.skybox.intensity);
      const skyEnv = this.getSkyEnvironment(key, skyTexture);
      this.ensureSkyDome();
      const material = this.skyDomeMesh?.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.map = skyTexture;
        material.needsUpdate = true;
      }
      if (this.skyDomeMesh) {
        this.skyDomeMesh.visible = true;
        this.skyDomeMesh.position.copy(this.camera.position);
      }
      this.scene.background = null;
      this.scene.environment = skyEnv;
    } else {
      if (this.skyDomeMesh) this.skyDomeMesh.visible = false;
      this.scene.background = new THREE.Color(fogPalette.background);
      this.scene.environment = null;
    }
    this.scene.fog = new THREE.Fog(fogPalette.fog, config.fogNear, config.fogFar);
    if (this.sceneAmbientLight) this.sceneAmbientLight.intensity = fogPalette.ambient;
    if (this.sceneDirectionalLight) this.sceneDirectionalLight.intensity = fogPalette.directional;
  }

  private ensureSkyDome() {
    if (this.skyDomeMesh) return;
    const radius = Math.max(60, this.camera.far * 0.9);
    const geometry = new THREE.SphereGeometry(radius, 48, 32);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.skyDomeMesh = new THREE.Mesh(geometry, material);
    this.skyDomeMesh.renderOrder = -1000;
    this.scene.add(this.skyDomeMesh);
  }

  private getSkyTexture(
    preset: SceneEnvironmentConfig['skybox']['preset'],
    intensity: number,
  ) {
    const key = `${preset}:${intensity.toFixed(2)}`;
    const cached = this.skyTextureCache.get(key);
    if (cached) return cached;
    const sky = this.createProceduralSkyTexture(preset, intensity);
    this.skyTextureCache.set(key, sky);
    return sky;
  }

  private getSkyEnvironment(key: string, skyTexture: THREE.Texture) {
    const cached = this.skyEnvironmentCache.get(key);
    if (cached) return cached;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(skyTexture);
    const env = rt.texture;
    this.skyEnvironmentCache.set(key, env);
    rt.dispose();
    pmrem.dispose();
    return env;
  }

  private createProceduralSkyTexture(
    preset: SceneEnvironmentConfig['skybox']['preset'],
    intensity: number,
  ) {
    const width = 2048;
    const height = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallback = new THREE.CanvasTexture(canvas);
      fallback.colorSpace = THREE.SRGBColorSpace;
      return fallback;
    }
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const tint = THREE.MathUtils.clamp(intensity, 0.2, 2);
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    if (preset === 'sunset_clouds') {
      grad.addColorStop(0, '#ffb45e');
      grad.addColorStop(0.45, '#ff7f6f');
      grad.addColorStop(1, '#613a7a');
    } else if (preset === 'midnight_stars') {
      grad.addColorStop(0, '#040814');
      grad.addColorStop(0.5, '#0b1430');
      grad.addColorStop(1, '#121838');
    } else if (preset === 'nebula') {
      grad.addColorStop(0, '#051326');
      grad.addColorStop(0.45, '#102a56');
      grad.addColorStop(1, '#1d1745');
    } else {
      grad.addColorStop(0, '#6fc0ff');
      grad.addColorStop(0.55, '#8dd2ff');
      grad.addColorStop(1, '#dff3ff');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    if (preset === 'sunset_clouds' || preset === 'clear_day') {
      for (let i = 0; i < 280; i += 1) {
        const x = Math.random() * width;
        const y = Math.random() * height * 0.8;
        const r = 36 + Math.random() * 120;
        const a = preset === 'sunset_clouds' ? 0.03 + Math.random() * 0.06 : 0.02 + Math.random() * 0.04;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    if (preset === 'midnight_stars' || preset === 'nebula') {
      for (let i = 0; i < 1200; i += 1) {
        const x = Math.random() * width;
        const y = Math.random() * height;
        const bright = clamp01(0.55 + Math.random() * 0.45);
        ctx.fillStyle = `rgba(210,230,255,${bright * 0.9})`;
        ctx.fillRect(x, y, 1 + Math.floor(Math.random() * 2), 1 + Math.floor(Math.random() * 2));
      }
    }
    if (preset === 'nebula') {
      for (let i = 0; i < 80; i += 1) {
        const x = Math.random() * width;
        const y = Math.random() * height;
        const r = 80 + Math.random() * 220;
        const color = i % 2 === 0 ? '110,140,255' : '180,90,220';
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${color},0.12)`);
        g.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }

    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      data[i] = Math.min(255, r * tint);
      data[i + 1] = Math.min(255, g * tint);
      data[i + 2] = Math.min(255, b * tint);
    }
    ctx.putImageData(image, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  private parseSceneWater(input: unknown): SceneWaterConfig {
    const value = (input ?? {}) as {
      enabled?: boolean;
      level?: number;
      opacity?: number;
      waveAmplitude?: number;
      waveFrequency?: number;
      waveSpeed?: number;
      colorShallow?: string;
      colorDeep?: string;
      specularStrength?: number;
    };
    const parseColor = (raw: unknown, fallback: string) => {
      const text = String(raw ?? fallback).trim();
      return /^#([0-9a-f]{6})$/i.test(text) ? text : fallback;
    };
    return {
      enabled: value.enabled === true,
      level: Number(value.level ?? 0.08),
      opacity: THREE.MathUtils.clamp(Number(value.opacity ?? 0.78), 0.1, 1),
      waveAmplitude: THREE.MathUtils.clamp(Number(value.waveAmplitude ?? 0.22), 0, 3),
      waveFrequency: THREE.MathUtils.clamp(Number(value.waveFrequency ?? 0.16), 0.01, 2),
      waveSpeed: THREE.MathUtils.clamp(Number(value.waveSpeed ?? 1.1), 0, 8),
      colorShallow: parseColor(value.colorShallow, '#2f97d0'),
      colorDeep: parseColor(value.colorDeep, '#081c47'),
      specularStrength: THREE.MathUtils.clamp(Number(value.specularStrength ?? 1.35), 0, 4),
    };
  }

  private parseGroundTexturePreset(value: unknown): GroundTexturePreset {
    const preset = String(value ?? 'concrete').toLowerCase();
    if (
      preset === 'grass' ||
      preset === 'sand' ||
      preset === 'rock' ||
      preset === 'snow' ||
      preset === 'lava' ||
      preset === 'concrete'
    ) {
      return preset;
    }
    return 'concrete';
  }

  private parseSceneObstacles(obstacles: SceneRecord['obstacles']): Obstacle[] {
    if (!Array.isArray(obstacles)) return [];
    return obstacles.map((obstacle, index) => this.parseSceneObstacle(obstacle, index));
  }

  private parseSceneObstacle(obstacle: SceneObstacleRecord, index: number): Obstacle {
    if ('position' in obstacle && 'size' in obstacle) {
      return {
        id: obstacle.id ?? `obstacle_${index}`,
        position: {
          x: Number(obstacle.position.x ?? 0),
          y: Number(obstacle.position.y ?? 0),
          z: Number(obstacle.position.z ?? 0),
        },
        size: {
          x: Number(obstacle.size.x ?? 1),
          y: Number(obstacle.size.y ?? 1),
          z: Number(obstacle.size.z ?? 1),
        },
      };
    }

    return {
      id: obstacle.id ?? `obstacle_${index}`,
      position: {
        x: Number(obstacle.x ?? 0),
        y: Number(obstacle.y ?? 0),
        z: Number(obstacle.z ?? 0),
      },
      size: {
        x: Number(obstacle.width ?? 1),
        y: Number(obstacle.height ?? 1),
        z: Number(obstacle.depth ?? 1),
      },
    };
  }

  constructor(
    container: HTMLElement | null,
    sceneName = 'main',
    gameId = 'prototype',
    onBackToMenu: (() => void) | null = null,
  ) {
    if (!container) {
      throw new Error('Missing #app container');
    }
    this.container = container;
    this.sceneName = sceneName;
    this.gameId = gameId;
    this.onBackToMenu = onBackToMenu;
    this.container.tabIndex = 0;
    this.container.addEventListener('click', this.handleContainerClick);
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

    // Initialize retro rendering system
    const retroRes = retroRenderSettings.getResolution();
    this.retroRenderer = new RetroRenderer(this.renderer, {
      baseWidth: retroRes.width,
      baseHeight: retroRes.height,
      enabled: retroRenderSettings.config.enabled,
      pixelated: retroRenderSettings.config.pixelated,
    });

    this.retroPostProcessor = new RetroPostProcessor(this.renderer, this.scene, this.camera, {
      enabled: retroRenderSettings.config.enabled,
      blur: retroRenderSettings.config.blur,
      blurStrength: retroRenderSettings.config.blurStrength,
      colorQuantization: retroRenderSettings.config.colorQuantization,
      colorBits: retroRenderSettings.config.colorBits,
      dithering: retroRenderSettings.config.dithering,
      ditherStrength: retroRenderSettings.config.ditherStrength,
      crtEffects: retroRenderSettings.config.crtEffects,
      scanlineIntensity: retroRenderSettings.config.scanlineIntensity,
      curvature: retroRenderSettings.config.curvature,
      vignette: retroRenderSettings.config.vignette,
      brightness: retroRenderSettings.config.brightness,
      chromaticAberration: retroRenderSettings.config.chromaticAberration,
      chromaticOffset: retroRenderSettings.config.chromaticOffset,
      contrast: retroRenderSettings.config.contrast,
      saturation: retroRenderSettings.config.saturation,
      gamma: retroRenderSettings.config.gamma,
      exposure: retroRenderSettings.config.exposure,
    });

    this.orbitRadius = this.playerConfig.cameraDistance ?? this.orbitRadius;
    this.cameraSensitivity = this.playerConfig.cameraSensitivity ?? this.cameraSensitivity;
    this.cameraSmoothing = this.playerConfig.cameraSmoothing ?? this.cameraSmoothing;
    this.orbitOffset.copy(this.camera.position);
    this.orbitSpherical.setFromVector3(this.orbitOffset);
    this.orbitYaw = this.orbitSpherical.theta;
    this.orbitPitch = this.orbitSpherical.phi;
    this.orbitRadius = this.orbitSpherical.radius;
    this.applyControllerModeFromConfig();

    this.clock = new THREE.Clock();
    this.hud = this.createHud();
    this.perfHud = this.createPerfHud();
    void this.loadSceneConfig();
    this.crowd = this.createCrowd();
    this.input = new InputState();
    const envUrl = import.meta.env.VITE_PUBLIC_WS_URL;
    const isLocalPage = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    const pageProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const pageDefaultUrl = `${pageProtocol}//${window.location.host}`;

    const normalizeWsUrl = (raw: string) => {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      return parsed.toString().replace(/\/$/, '');
    };

    const envLooksLocal = (raw: string) => {
      try {
        const host = new URL(raw).hostname;
        return ['localhost', '127.0.0.1', '::1'].includes(host);
      } catch {
        return false;
      }
    };

    // Production-safe endpoint resolution:
    // - local dev defaults to ws://127.0.0.1:2567
    // - hosted pages default to same-origin ws/wss
    // - ignore localhost env WS URL when page itself is not local
    const wsUrl = (() => {
      if (!envUrl) {
        return isLocalPage ? 'ws://127.0.0.1:2567' : pageDefaultUrl;
      }
      if (!isLocalPage && envLooksLocal(envUrl)) {
        console.warn(
          'Ignoring localhost VITE_PUBLIC_WS_URL on non-local page; using same-origin websocket URL.',
        );
        return pageDefaultUrl;
      }
      try {
        return normalizeWsUrl(envUrl);
      } catch {
        return isLocalPage ? 'ws://127.0.0.1:2567' : pageDefaultUrl;
      }
    })();
    this.roomClient = new RoomClient(wsUrl);
    this.localPlayer = this.createPlayer();

    this.container.appendChild(this.renderer.domElement);
    this.container.appendChild(this.hud);
    this.container.appendChild(this.perfHud);
    this.hud.style.display = this.hudVisible ? 'block' : 'none';
    this.touchControls = this.createTouchControls();
    if (this.touchControls) this.container.appendChild(this.touchControls);
    this.container.focus();
    window.addEventListener('keydown', this.handleDebugKeyDown);
    window.addEventListener('keydown', this.handleRagdollControlKeyDown);
    window.addEventListener('keyup', this.handleRagdollControlKeyUp);
    this.obstacleGroup = this.createObstacles();
    this.scene.add(this.createLights(), this.obstacleGroup, this.localPlayer, this.crowd);

    this.renderer.domElement.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mouseup', this.handleMouseUp);
    this.renderer.domElement.addEventListener('wheel', this.handleWheel, { passive: true });
    this.renderer.domElement.addEventListener('click', this.requestPointerLock);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);

    window.addEventListener('resize', this.handleResize);

    // Listen for global retro settings changes
    window.addEventListener('retro-settings-changed', this.handleRetroRenderSettingsChange);
  }

  private handleRetroRenderSettingsChange = () => {
    // Update retro renderers when settings change globally
    if (this.retroRenderer) {
      const res = retroRenderSettings.getResolution();
      this.retroRenderer.setEnabled(retroRenderSettings.config.enabled);
      this.retroRenderer.setResolution(res.width, res.height);
      this.retroRenderer.setPixelated(retroRenderSettings.config.pixelated);
    }

    if (this.retroPostProcessor) {
      this.retroPostProcessor.setEnabled(retroRenderSettings.config.enabled);
      this.retroPostProcessor.setBlur(retroRenderSettings.config.blur, retroRenderSettings.config.blurStrength);
      this.retroPostProcessor.setColorQuantization(
        retroRenderSettings.config.colorQuantization,
        retroRenderSettings.config.colorBits,
      );
      this.retroPostProcessor.setDithering(
        retroRenderSettings.config.dithering,
        retroRenderSettings.config.ditherStrength,
      );
      this.retroPostProcessor.setCRTEffects(retroRenderSettings.config.crtEffects);
      this.retroPostProcessor.setChromaticAberration(
        retroRenderSettings.config.chromaticAberration,
        retroRenderSettings.config.chromaticOffset,
      );
      this.retroPostProcessor.setBrightness(retroRenderSettings.config.brightness);
      this.retroPostProcessor.setContrast(retroRenderSettings.config.contrast);
      this.retroPostProcessor.setSaturation(retroRenderSettings.config.saturation);
      this.retroPostProcessor.setGamma(retroRenderSettings.config.gamma);
      this.retroPostProcessor.setExposure(retroRenderSettings.config.exposure);
    }
  };

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
    this.container.removeEventListener('click', this.handleContainerClick);
    window.removeEventListener('keydown', this.handleDebugKeyDown);
    window.removeEventListener('keydown', this.handleRagdollControlKeyDown);
    window.removeEventListener('keyup', this.handleRagdollControlKeyUp);
    this.renderer.domElement.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mouseup', this.handleMouseUp);
    this.renderer.domElement.removeEventListener('wheel', this.handleWheel);
    this.renderer.domElement.removeEventListener('click', this.requestPointerLock);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('retro-settings-changed', this.handleRetroRenderSettingsChange);
    this.pointerLocked = false;
    this.disableRuntimeRagdoll();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.input.dispose();
    if (this.waterMesh) {
      this.scene.remove(this.waterMesh);
      this.waterMesh.geometry.dispose();
      this.waterMesh = null;
    }
    if (this.waterMaterial) {
      this.waterMaterial.dispose();
      this.waterMaterial = null;
    }
    for (const texture of this.groundTextureCache.values()) texture.dispose();
    this.groundTextureCache.clear();
    if (this.skyDomeMesh) {
      this.scene.remove(this.skyDomeMesh);
      this.skyDomeMesh.geometry.dispose();
      if (this.skyDomeMesh.material instanceof THREE.Material) this.skyDomeMesh.material.dispose();
      this.skyDomeMesh = null;
    }
    for (const texture of this.skyTextureCache.values()) texture.dispose();
    this.skyTextureCache.clear();
    for (const env of this.skyEnvironmentCache.values()) env.dispose();
    this.skyEnvironmentCache.clear();
    void this.roomClient.disconnect();
  }

  private emitCameraSettingsChange() {
    const settings = this.getUiCameraSettings();
    for (const listener of this.cameraSettingsListeners) {
      listener(settings);
    }
  }

  public getUiCameraSettings() {
    return {
      orbitRadius: this.orbitRadius,
      cameraSmoothing: this.cameraSmoothing,
      cameraSensitivity: this.cameraSensitivity,
      firstPersonMode: this.firstPersonMode,
    };
  }

  public setUiCameraSettings(
    patch: Partial<{
      orbitRadius: number;
      cameraSmoothing: number;
      cameraSensitivity: number;
      firstPersonMode: boolean;
    }>,
  ) {
    if (typeof patch.orbitRadius === 'number') {
      this.orbitRadius = Math.min(40, Math.max(1, patch.orbitRadius));
    }
    if (typeof patch.cameraSmoothing === 'number') {
      this.cameraSmoothing = Math.min(1, Math.max(0, patch.cameraSmoothing));
    }
    if (typeof patch.cameraSensitivity === 'number') {
      this.cameraSensitivity = Math.min(3, Math.max(0.1, patch.cameraSensitivity));
    }
    if (typeof patch.firstPersonMode === 'boolean') {
      this.firstPersonMode = patch.firstPersonMode;
    }
    this.syncLocalFirstPersonVisuals();
    this.emitCameraSettingsChange();
  }

  private getActiveControllerTuning(): ControllerTuning {
    const mode = this.activeControllerMode;
    const normalized = normalizeControllerModeConfigs(this.playerConfig.controllerModes);
    this.playerConfig.controllerModes = normalized;
    return normalized[mode];
  }

  private applyControllerModeFromConfig() {
    this.playerConfig.controllerModes = normalizeControllerModeConfigs(this.playerConfig.controllerModes);
    const profileController = this.playerConfig.profile?.controller;
    const preferred = this.sceneControllerModeOverride ?? profileController ?? 'third_person';
    const mode = resolveRuntimeControllerMode(preferred);
    this.activeControllerMode = mode;
    if (mode === 'first_person') {
      this.firstPersonMode = true;
    } else if (mode === 'third_person' || mode === 'ragdoll') {
      this.firstPersonMode = false;
    }
    const tuning = this.getActiveControllerTuning();
    const modeCameraDistance =
      tuning.cameraDistance ?? this.playerConfig.cameraDistance ?? this.orbitRadius;
    this.orbitRadius = Math.min(40, Math.max(0.02, modeCameraDistance));
    if (mode === 'ragdoll') {
      void this.ensureRuntimeRagdollReady();
    } else {
      this.disableRuntimeRagdoll();
    }
    this.syncLocalFirstPersonVisuals();
    this.emitCameraSettingsChange();
  }

  private tickController(delta: number) {
    const tuning = this.getActiveControllerTuning();
    if (this.isFirstPersonControllerActive()) {
      this.firstPersonMode = true;
      this.animateLocalFirstPerson(delta, tuning);
      return;
    }
    if (this.activeControllerMode === 'ragdoll') {
      this.firstPersonMode = false;
      if (this.runtimeRagdollMode === 'ragdoll' && this.runtimeRagdollWorld) {
        this.stepRuntimeRagdoll(delta);
        return;
      }
      this.animateLocalPlayer(delta, true, tuning);
      return;
    }
    this.firstPersonMode = false;
    this.animateLocalPlayer(delta, false, tuning);
  }

  public onUiCameraSettingsChange(
    listener: (settings: {
      orbitRadius: number;
      cameraSmoothing: number;
      cameraSensitivity: number;
      firstPersonMode: boolean;
    }) => void,
  ) {
    this.cameraSettingsListeners.add(listener);
    listener(this.getUiCameraSettings());
    return () => {
      this.cameraSettingsListeners.delete(listener);
    };
  }

  private tick = () => {
    const now = performance.now();
    const delta = Math.max(0, Math.min(0.1, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const elapsed = this.clock.getElapsedTime();
    this.simulateObstaclePhysics(delta);
    this.animateCrowd(elapsed, delta);
    this.input.updateGamepad();

    // Check for Select button press to toggle first person mode
    if (this.input.wasSelectJustPressed() && this.activeControllerMode !== 'ragdoll') {
      this.firstPersonMode = !this.firstPersonMode;
      this.syncLocalFirstPersonVisuals();
      this.emitCameraSettingsChange();
    }
    if (this.activeControllerMode === 'ragdoll' && this.runtimeRagdollMode !== 'ragdoll') {
      void this.ensureRuntimeRagdollReady();
    }

    this.tickController(delta);
    this.syncLocalFirstPersonVisuals();

    // Smooth out visual offset from network corrections (30x per second = fast and imperceptible)
    const offsetSmoothSpeed = Math.min(1, delta * 30);
    this.localVisualOffset.lerp(new THREE.Vector3(0, 0, 0), offsetSmoothSpeed);

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
    if (this.skyDomeMesh?.visible) {
      this.skyDomeMesh.position.copy(this.camera.position);
    }
    if (this.waterMaterial) {
      const uTime = this.waterMaterial.uniforms.uTime;
      if (uTime) uTime.value += delta;
    }

    // Apply visual offset for rendering (hides network corrections)
    this.localPlayer.position.add(this.localVisualOffset);

    // Update retro material resolutions before rendering
    if (retroRenderSettings.config.enabled && this.retroRenderer) {
      const res = this.retroRenderer.getResolution();
      this.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof RetroShaderMaterial) {
          obj.material.updateResolution(res.width, res.height);
        }
      });
    }

    // Render with retro effects or standard
    if (retroRenderSettings.config.enabled && this.retroPostProcessor) {
      this.retroPostProcessor.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    // Restore physics position
    this.localPlayer.position.sub(this.localVisualOffset);

    this.updatePerfHud(delta);
    this.animationId = requestAnimationFrame(this.tick);
  };

  private handleResize = () => {
    const { innerWidth, innerHeight } = window;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);

    // Update retro resolution
    if (this.retroRenderer) {
      const retroRes = retroRenderSettings.getResolution();
      this.retroRenderer.setResolution(retroRes.width, retroRes.height);
    }

    if (this.retroPostProcessor) {
      this.retroPostProcessor.setSize(innerWidth, innerHeight);
    }
  };

  private createLights() {
    const group = new THREE.Group();
    const ambient = new THREE.AmbientLight(0x8fa0bf, 0.6);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(20, 30, 10);
    const rim = new THREE.DirectionalLight(0xff5566, 0.5);
    rim.position.set(-20, 15, -10);
    group.add(ambient, key, rim);
    this.sceneAmbientLight = ambient;
    this.sceneDirectionalLight = key;
    return group;
  }

  private terrainHash2d(x: number, z: number, seed: number) {
    const value = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453123;
    return value - Math.floor(value);
  }

  private terrainNoise2d(x: number, z: number, seed: number) {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = x0 + 1;
    const z1 = z0 + 1;
    const tx = x - x0;
    const tz = z - z0;
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const n00 = this.terrainHash2d(x0, z0, seed);
    const n10 = this.terrainHash2d(x1, z0, seed);
    const n01 = this.terrainHash2d(x0, z1, seed);
    const n11 = this.terrainHash2d(x1, z1, seed);
    const ix0 = n00 + (n10 - n00) * sx;
    const ix1 = n01 + (n11 - n01) * sx;
    return ix0 + (ix1 - ix0) * sz;
  }

  private terrainFbm(x: number, z: number, seed: number, octaves: number, roughness: number) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i += 1) {
      sum += this.terrainNoise2d(x * freq, z * freq, seed + i * 17.41) * amp;
      norm += amp;
      amp *= roughness;
      freq *= 2;
    }
    return norm > 0 ? sum / norm : 0;
  }

  private sampleTerrainHeight(options: {
    preset: TerrainPreset;
    size: number;
    maxHeight: number;
    roughness: number;
    seed: number;
    x: number;
    z: number;
  }) {
    const size = Math.max(16, Math.min(320, options.size));
    const maxHeight = Math.max(1, Math.min(64, options.maxHeight));
    const roughness = Math.max(0.2, Math.min(0.95, options.roughness));
    const nx = options.x / size;
    const nz = options.z / size;
    const macro = this.terrainFbm(nx * 4.2, nz * 4.2, options.seed, 5, roughness);
    const detail = this.terrainFbm(nx * 10.5, nz * 10.5, options.seed + 101, 3, roughness);
    const ridge = 1 - Math.abs(2 * this.terrainFbm(nx * 6.5, nz * 6.5, options.seed + 53, 4, 0.6) - 1);
    const radius = Math.sqrt(nx * nx + nz * nz);
    const islandMask = Math.max(0, 1 - Math.min(1, Math.pow(radius / 0.68, 2.4)));
    const spawnMask = Math.min(1, Math.max(0, (radius - 0.09) / 0.16));

    let elevation = macro * 0.68 + detail * 0.22 + ridge * 0.35;
    if (options.preset === 'alpine') elevation = macro * 0.55 + ridge * 0.6 + detail * 0.25;
    if (options.preset === 'dunes') elevation = macro * 0.45 + detail * 0.2;
    if (options.preset === 'islands') elevation = (macro * 0.58 + ridge * 0.26) * islandMask;
    if (options.preset === 'cinematic') {
      elevation = (macro * 0.64 + ridge * 0.4 + detail * 0.18) * (0.55 + islandMask * 0.45);
    }
    elevation *= spawnMask;
    return Math.max(0, elevation * maxHeight);
  }

  private createGround(config: SceneGroundConfig) {
    const terrain = config.terrain?.enabled ? config.terrain : null;
    const width = terrain ? Math.max(16, Number(terrain.size ?? config.width)) : config.width;
    const depth = terrain ? Math.max(16, Number(terrain.size ?? config.depth)) : config.depth;
    const resolution = terrain
      ? Math.max(8, Math.min(128, Math.floor(Number(terrain.resolution ?? 48))))
      : 1;
    const geometry = new THREE.PlaneGeometry(width, depth, resolution, resolution);
    geometry.rotateX(-Math.PI / 2);
    if (terrain) {
      const position = geometry.getAttribute('position');
      for (let i = 0; i < position.count; i += 1) {
        const x = position.getX(i);
        const z = position.getZ(i);
        const h = this.sampleTerrainHeight({
          preset: terrain.preset,
          size: terrain.size,
          maxHeight: terrain.maxHeight,
          roughness: terrain.roughness,
          seed: terrain.seed,
          x,
          z,
        });
        position.setY(i, h);
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();
    }
    const texture = this.getGroundTexture(config.texturePreset);
    texture.repeat.set(config.textureRepeat, config.textureRepeat);
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.95,
      metalness: 0.05,
      color: 0xffffff,
      flatShading: terrain !== null,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = config.y;
    return mesh;
  }

  private createWaterMesh(config: SceneGroundConfig) {
    const water = config.water;
    if (!water?.enabled) return null;
    const terrain = config.terrain?.enabled ? config.terrain : null;
    const width = terrain ? Math.max(16, Number(terrain.size ?? config.width)) : config.width;
    const depth = terrain ? Math.max(16, Number(terrain.size ?? config.depth)) : config.depth;
    const segments = terrain
      ? Math.max(48, Math.min(240, Math.floor(Number(terrain.resolution ?? 64) * 2)))
      : 80;
    const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const colorShallow = new THREE.Color(water.colorShallow);
    const colorDeep = new THREE.Color(water.colorDeep);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: water.opacity },
        uWaveAmplitude: { value: water.waveAmplitude },
        uWaveFrequency: { value: water.waveFrequency },
        uWaveSpeed: { value: water.waveSpeed },
        uColorShallow: { value: colorShallow },
        uColorDeep: { value: colorDeep },
        uSpecularStrength: { value: water.specularStrength },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uWaveAmplitude;
        uniform float uWaveFrequency;
        uniform float uWaveSpeed;
        varying vec3 vWorldPos;
        varying vec3 vViewDir;
        varying float vWave;
        void main() {
          vec3 p = position;
          float t = uTime * uWaveSpeed;
          float waveA = sin((p.x * uWaveFrequency * 1.3) + t * 1.7);
          float waveB = cos((p.z * uWaveFrequency * 1.1) - t * 1.25);
          float waveC = sin((p.x + p.z) * uWaveFrequency * 0.72 + t * 0.95);
          float wave = (waveA * 0.55 + waveB * 0.3 + waveC * 0.15) * uWaveAmplitude;
          p.y += wave;
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorldPos = world.xyz;
          vViewDir = normalize(cameraPosition - world.xyz);
          vWave = wave;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        uniform vec3 uColorShallow;
        uniform vec3 uColorDeep;
        uniform float uSpecularStrength;
        varying vec3 vWorldPos;
        varying vec3 vViewDir;
        varying float vWave;
        void main() {
          float depthMix = clamp((vWorldPos.y + 1.0) * 0.4, 0.0, 1.0);
          vec3 base = mix(uColorDeep, uColorShallow, depthMix);
          float fresnel = pow(1.0 - max(dot(normalize(vViewDir), vec3(0.0, 1.0, 0.0)), 0.0), 2.8);
          float crest = smoothstep(0.45, 1.0, abs(vWave));
          float sparkle = pow(max(dot(normalize(vViewDir), normalize(vec3(0.3, 1.0, 0.2))), 0.0), 26.0);
          vec3 color = base + fresnel * vec3(0.28, 0.42, 0.55) + crest * vec3(0.09, 0.14, 0.18);
          color += sparkle * uSpecularStrength * vec3(0.9, 0.98, 1.0);
          gl_FragColor = vec4(color, clamp(uOpacity + fresnel * 0.12, 0.0, 1.0));
        }
      `,
    });
    this.waterMaterial = material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = config.y + water.level + 0.02;
    mesh.renderOrder = 20;
    return mesh;
  }

  private getGroundTexture(preset: GroundTexturePreset) {
    const cached = this.groundTextureCache.get(preset);
    if (cached) return cached;
    const texture = this.createGroundTexture(preset);
    this.groundTextureCache.set(preset, texture);
    return texture;
  }

  private createGroundTexture(preset: GroundTexturePreset) {
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
    const palette =
      preset === 'grass'
        ? { base: '#36503a', grid: '#2b3f2f', jitter: 0.08 }
        : preset === 'sand'
          ? { base: '#9f8f6e', grid: '#857657', jitter: 0.1 }
          : preset === 'rock'
            ? { base: '#5a5e67', grid: '#454a52', jitter: 0.12 }
            : preset === 'snow'
              ? { base: '#d9e2ea', grid: '#c0ccd8', jitter: 0.06 }
              : preset === 'lava'
                ? { base: '#3d2522', grid: '#5b2f2a', jitter: 0.14 }
                : { base: '#4a4f57', grid: '#2f343b', jitter: 0.1 };
    const presetSeed =
      preset === 'grass'
        ? 1117
        : preset === 'sand'
          ? 2237
          : preset === 'rock'
            ? 3319
            : preset === 'snow'
              ? 4451
              : preset === 'lava'
                ? 5563
                : 6673;
    ctx.fillStyle = palette.base;
    ctx.fillRect(0, 0, size, size);
    const imageData = ctx.getImageData(0, 0, size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const pixel = i / 4;
      const x = pixel % size;
      const y = Math.floor(pixel / size);
      const n = (this.terrainHash2d(x * 0.17, y * 0.17, presetSeed) * 2 - 1) * 255 * palette.jitter;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      data[i] = Math.min(255, Math.max(0, r + n));
      data[i + 1] = Math.min(255, Math.max(0, g + n));
      data[i + 2] = Math.min(255, Math.max(0, b + n));
    }
    ctx.putImageData(imageData, 0, 0);
    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = palette.grid;
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
    this.obstaclePlaceholderMeshes.clear();
    this.obstacleColliderConfig.clear();
    const activeIds = new Set<string>();
    const material = new THREE.MeshStandardMaterial({
      color: 0x2a2f3c,
      roughness: 0.85,
      metalness: 0.1,
    });
    for (const obstacle of this.obstacles) {
      const obstacleId = String(obstacle.id ?? '').trim();
      const componentRaw = this.sceneComponents[`obstacle:${obstacleId}`];
      const colliderShapeRaw =
        componentRaw && typeof componentRaw === 'object'
          ? String(
              ((componentRaw as RuntimeSceneModelComponent).collider as
                | RuntimeSceneModelComponent['collider']
                | undefined)?.shape ?? 'box',
            ).toLowerCase()
          : 'box';
      const colliderShape: 'box' | 'sphere' | 'capsule' | 'mesh' =
        colliderShapeRaw === 'sphere' ||
        colliderShapeRaw === 'capsule' ||
        colliderShapeRaw === 'mesh'
          ? colliderShapeRaw
          : 'box';
      const component = (componentRaw as RuntimeSceneModelComponent | undefined) ?? undefined;
      const collider = component?.collider;
      const physics = component?.physics;
      const colliderOffset = {
        x: Number(collider?.offset?.x ?? 0),
        y: Number(collider?.offset?.y ?? 0),
        z: Number(collider?.offset?.z ?? 0),
      };
      const radius = Math.max(0.05, Number(collider?.radius ?? obstacle.size.x * 0.5));
      const height = Math.max(0.1, Number(collider?.height ?? obstacle.size.y));
      const size =
        colliderShape === 'sphere'
          ? { x: radius * 2, y: radius * 2, z: radius * 2 }
          : colliderShape === 'capsule'
            ? { x: radius * 2, y: height, z: radius * 2 }
            : {
                x: Math.max(0.05, Number(collider?.size?.x ?? obstacle.size.x)),
                y: Math.max(0.05, Number(collider?.size?.y ?? obstacle.size.y)),
                z: Math.max(0.05, Number(collider?.size?.z ?? obstacle.size.z)),
              };
      const proxy: Obstacle = {
        id: obstacle.id,
        position: {
          x: obstacle.position.x + colliderOffset.x,
          y: obstacle.position.y + colliderOffset.y,
          z: obstacle.position.z + colliderOffset.z,
        },
        size,
      };
      const bodyTypeRaw = String(physics?.bodyType ?? 'static').toLowerCase();
      const bodyType: 'static' | 'dynamic' | 'kinematic' =
        bodyTypeRaw === 'dynamic' || bodyTypeRaw === 'kinematic' ? bodyTypeRaw : 'static';
      const spawnHeightOffset = THREE.MathUtils.clamp(Number(physics?.spawnHeightOffset ?? 0), -10, 50);
      const initialVelocity = {
        x: THREE.MathUtils.clamp(Number(physics?.initialVelocity?.x ?? 0), -30, 30),
        y: THREE.MathUtils.clamp(Number(physics?.initialVelocity?.y ?? 0), -30, 30),
        z: THREE.MathUtils.clamp(Number(physics?.initialVelocity?.z ?? 0), -30, 30),
      };
      const shouldInitializePhysicsState =
        obstacleId.length > 0 &&
        physics?.enabled === true &&
        bodyType === 'dynamic' &&
        collider?.isTrigger !== true &&
        !this.obstaclePhysicsVelocity.has(obstacleId);
      if (shouldInitializePhysicsState && Math.abs(spawnHeightOffset) > 0.0001) {
        proxy.position.y += spawnHeightOffset;
        obstacle.position.y = proxy.position.y - colliderOffset.y;
      }
      if (obstacleId) {
        activeIds.add(obstacleId);
        this.obstacleColliderConfig.set(obstacleId, {
          shape: colliderShape,
          isTrigger: collider?.isTrigger === true,
          bodyType,
          offset: colliderOffset,
          physicsEnabled: physics?.enabled === true,
          friction: Math.max(0, Number(physics?.friction ?? 0.7)),
          restitution: THREE.MathUtils.clamp(Number(physics?.restitution ?? 0.05), 0, 1),
          linearDamping: Math.max(0, Number(physics?.linearDamping ?? 0)),
          gravityScale: Number(physics?.gravityScale ?? 1),
          spawnHeightOffset,
          initialVelocity,
          proxy,
        });
        if (shouldInitializePhysicsState) {
          this.obstaclePhysicsVelocity.set(
            obstacleId,
            new THREE.Vector3(initialVelocity.x, initialVelocity.y, initialVelocity.z),
          );
        }
      }
      const geometry = new THREE.BoxGeometry(proxy.size.x, proxy.size.y, proxy.size.z);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(proxy.position.x, proxy.position.y + proxy.size.y / 2, proxy.position.z);
      group.add(mesh);
      this.obstaclePlaceholderMeshes.set(obstacleId, mesh);
    }
    for (const id of Array.from(this.obstaclePhysicsVelocity.keys())) {
      if (!activeIds.has(id)) this.obstaclePhysicsVelocity.delete(id);
    }
    return group;
  }

  private isMeshColliderObstacle(obstacleId: string) {
    return this.obstacleColliderConfig.get(obstacleId)?.shape === 'mesh';
  }

  private getObstacleColliderProxy(obstacle: Obstacle) {
    const obstacleId = String(obstacle.id ?? '').trim();
    const config = this.obstacleColliderConfig.get(obstacleId);
    if (!config) return obstacle;
    if (config.isTrigger) return null;
    // Static mesh colliders use triangle tests; dynamic mesh colliders must use proxy collision.
    if (
      config.shape === 'mesh' &&
      this.obstacleModelRoots.has(obstacleId) &&
      config.bodyType !== 'dynamic'
    ) {
      return null;
    }
    return config.proxy;
  }

  private getMeshColliderRoots(ignoreObstacleId: string | null = null) {
    const roots: THREE.Object3D[] = [];
    for (const [id, root] of this.obstacleModelRoots) {
      if (ignoreObstacleId && id === ignoreObstacleId) continue;
      const config = this.obstacleColliderConfig.get(id);
      if (!config || config.shape !== 'mesh' || config.isTrigger) continue;
      roots.push(root);
    }
    return roots;
  }

  private sampleMeshColliderHeight(x: number, z: number, ignoreObstacleId: string | null = null) {
    const roots = this.getMeshColliderRoots(ignoreObstacleId);
    if (roots.length === 0) return Number.NEGATIVE_INFINITY;
    let best = Number.NEGATIVE_INFINITY;
    this.meshCollisionRayOrigin.set(x, 400, z);
    this.meshCollisionRayDir.set(0, -1, 0);
    this.meshCollisionRaycaster.set(this.meshCollisionRayOrigin, this.meshCollisionRayDir);
    this.meshCollisionRaycaster.far = 800;
    for (const root of roots) {
      const hits = this.meshCollisionRaycaster.intersectObject(root, true);
      if (hits.length === 0) continue;
      for (const hit of hits) {
        if (hit.point.y > best) best = hit.point.y;
      }
    }
    return best;
  }

  private sampleGroundHeightWithoutObstacle(x: number, z: number, ignoreObstacleId: string) {
    const terrain = this.groundConfig?.terrain?.enabled ? this.groundConfig.terrain : null;
    const baseHeight = this.groundConfig?.y ?? GROUND_Y;
    let height = baseHeight;
    if (terrain) {
      const terrainHalf = Math.max(16, terrain.size) * 0.5;
      if (Math.abs(x) <= terrainHalf && Math.abs(z) <= terrainHalf) {
        height = baseHeight + this.sampleTerrainHeight({ ...terrain, x, z });
      }
    }
    for (const obstacle of this.obstacles) {
      const obstacleId = String(obstacle.id ?? '').trim();
      if (!obstacleId || obstacleId === ignoreObstacleId) continue;
      const proxy = this.getObstacleColliderProxy(obstacle);
      if (!proxy) continue;
      const halfX = proxy.size.x / 2;
      const halfZ = proxy.size.z / 2;
      if (Math.abs(x - proxy.position.x) <= halfX && Math.abs(z - proxy.position.z) <= halfZ) {
        height = Math.max(height, proxy.size.y + proxy.position.y);
      }
    }
    const meshHeight = this.sampleMeshColliderHeight(x, z, ignoreObstacleId);
    if (Number.isFinite(meshHeight)) height = Math.max(height, meshHeight);
    return height;
  }

  private resolveCircleMeshCollisions(
    current: { x: number; y: number; z: number },
    next: { x: number; y: number; z: number },
    radius: number,
  ) {
    const roots = this.getMeshColliderRoots();
    if (roots.length === 0) return next;
    this.meshCollisionMove.set(next.x - current.x, 0, next.z - current.z);
    const moveLength = this.meshCollisionMove.length();
    if (moveLength < 1e-5) return next;
    const dir = this.meshCollisionMove.clone().normalize();
    this.meshCollisionRayOrigin.set(current.x, next.y + 0.9, current.z);
    this.meshCollisionRaycaster.set(this.meshCollisionRayOrigin, dir);
    this.meshCollisionRaycaster.far = moveLength + radius + 0.2;
    let nearestHit: THREE.Intersection | null = null;
    for (const root of roots) {
      const hits = this.meshCollisionRaycaster.intersectObject(root, true);
      if (hits.length === 0) continue;
      const hit = hits[0];
      if (!hit) continue;
      if (!nearestHit || hit.distance < nearestHit.distance) nearestHit = hit;
    }
    if (!nearestHit || !nearestHit.face) return next;
    const allowed = Math.max(0, nearestHit.distance - radius - 0.03);
    if (allowed >= moveLength) return next;
    const clipped = this.meshCollisionMove.clone().setLength(Math.min(moveLength, allowed));
    const remaining = this.meshCollisionMove.clone().sub(clipped);
    this.meshCollisionNormalMatrix.getNormalMatrix(nearestHit.object.matrixWorld);
    this.meshCollisionNormal
      .copy(nearestHit.face.normal)
      .applyMatrix3(this.meshCollisionNormalMatrix)
      .normalize();
    if (Math.abs(this.meshCollisionNormal.y) > 0.5) return next;
    this.meshCollisionNormal.y = 0;
    if (this.meshCollisionNormal.lengthSq() < 1e-6) {
      return {
        x: current.x + clipped.x,
        y: next.y,
        z: current.z + clipped.z,
      };
    }
    this.meshCollisionNormal.normalize();
    const slide = remaining.sub(
      this.meshCollisionNormal.clone().multiplyScalar(remaining.dot(this.meshCollisionNormal)),
    );
    const adjusted = clipped.add(slide.multiplyScalar(0.9));
    return {
      x: current.x + adjusted.x,
      y: next.y,
      z: current.z + adjusted.z,
    };
  }

  private getMeshObstacleStepHeightAhead(dir: THREE.Vector3, forward: number) {
    const pos = this.localPlayer.position;
    const probeX = pos.x + dir.x * forward;
    const probeZ = pos.z + dir.z * forward;
    const meshHeight = this.sampleMeshColliderHeight(probeX, probeZ);
    if (!Number.isFinite(meshHeight)) return 0;
    return Math.max(0, meshHeight - pos.y);
  }

  private getModelFileUrl(modelId: string, file: string) {
    if (/^(https?:)?\/\//i.test(file) || file.startsWith('/')) return file;
    return getGameModelFileUrl(this.gameId, modelId, file);
  }

  private loadFbxObject(url: string) {
    return loadFbxObject(this.fbxLoader, url);
  }

  private loadTexture(url: string, colorSpace: THREE.ColorSpace) {
    return loadTexture(url, colorSpace);
  }

  private normalizeModelRootPivot(root: THREE.Object3D) {
    normalizeModelRootPivot(root);
  }

  private applyModelOriginOffset(root: THREE.Object3D, originOffset?: { x?: number; y?: number; z?: number }) {
    applyModelOriginOffset(root, originOffset);
  }

  private async loadModelAssetObject(component: RuntimeSceneModelComponent) {
    const modelId = String(component.modelId ?? '').trim();
    const sourceCandidates = new Set<string>();
    if (component.sourceFile) sourceCandidates.add(component.sourceFile);
    if (component.sourcePath) sourceCandidates.add(component.sourcePath);
    for (const file of component.files ?? []) sourceCandidates.add(file);
    const candidates = Array.from(sourceCandidates).filter((value) => value.trim().length > 0);
    if (!modelId || candidates.length === 0) {
      throw new Error('missing_model_source');
    }
    const key = `${this.gameId}:${modelId}:${candidates.join('|')}:${component.originOffset?.x ?? 0}:${component.originOffset?.y ?? 0}:${component.originOffset?.z ?? 0}:${JSON.stringify(component.textures ?? {})}`;
    let pending = this.modelLoadCache.get(key);
    if (!pending) {
      pending = (async () => {
        let root: THREE.Object3D | null = null;
        let lastError: unknown = null;
        for (const candidate of candidates) {
          try {
            root = await this.loadFbxObject(this.getModelFileUrl(modelId, candidate));
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!root) throw lastError instanceof Error ? lastError : new Error('failed_to_load_model');
        this.normalizeModelRootPivot(root);
        this.applyModelOriginOffset(root, component.originOffset);
        const textures = component.textures ?? {};
        const [baseColor, normal, roughness, metalness, emissive] = await Promise.all([
          textures.baseColor
            ? this.loadTexture(this.getModelFileUrl(modelId, textures.baseColor), THREE.SRGBColorSpace)
            : Promise.resolve<THREE.Texture | null>(null),
          textures.normal
            ? this.loadTexture(this.getModelFileUrl(modelId, textures.normal), THREE.NoColorSpace)
            : Promise.resolve<THREE.Texture | null>(null),
          textures.roughness
            ? this.loadTexture(this.getModelFileUrl(modelId, textures.roughness), THREE.NoColorSpace)
            : Promise.resolve<THREE.Texture | null>(null),
          textures.metalness
            ? this.loadTexture(this.getModelFileUrl(modelId, textures.metalness), THREE.NoColorSpace)
            : Promise.resolve<THREE.Texture | null>(null),
          textures.emissive
            ? this.loadTexture(this.getModelFileUrl(modelId, textures.emissive), THREE.SRGBColorSpace)
            : Promise.resolve<THREE.Texture | null>(null),
        ]);
        root.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          obj.castShadow = true;
          obj.receiveShadow = true;
          const asArray = Array.isArray(obj.material) ? obj.material : [obj.material];
          const nextMaterials = asArray.map((base) => {
            const material =
              base instanceof THREE.MeshStandardMaterial
                ? base
                : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.1 });
            if (baseColor) material.map = baseColor;
            if (normal) material.normalMap = normal;
            if (roughness) material.roughnessMap = roughness;
            if (metalness) material.metalnessMap = metalness;
            if (emissive) {
              material.emissiveMap = emissive;
              material.emissive.set(0xffffff);
              material.emissiveIntensity = 0.6;
            }
            material.needsUpdate = true;
            return material;
          });
          obj.material = Array.isArray(obj.material) ? nextMaterials : nextMaterials[0];
        });
        return root;
      })();
      this.modelLoadCache.set(key, pending);
    }
    const loaded = await pending;
    return loaded.clone(true);
  }

  private async attachSceneModelInstances() {
    if (!this.obstacleGroup) return;
    for (const obstacle of this.obstacles) {
      const obstacleId = String(obstacle.id ?? '').trim();
      if (!obstacleId) continue;
      const componentRaw = this.sceneComponents[`obstacle:${obstacleId}`];
      if (!componentRaw || typeof componentRaw !== 'object') continue;
      const component = componentRaw as RuntimeSceneModelComponent;
      if (component.type !== 'model_instance') continue;
      try {
        const instance = await this.loadModelAssetObject(component);
        instance.position.set(
          obstacle.position.x,
          obstacle.position.y + obstacle.size.y / 2,
          obstacle.position.z,
        );
        instance.scale.set(obstacle.size.x, obstacle.size.y, obstacle.size.z);
        this.obstacleGroup.add(instance);
        this.obstacleModelRoots.set(obstacleId, instance);
        const placeholder = this.obstaclePlaceholderMeshes.get(obstacleId);
        if (placeholder) placeholder.visible = false;
      } catch (error) {
        console.warn('Failed to load scene model instance', error);
      }
    }
  }

  private sampleGroundHeight(x: number, z: number) {
    const terrain = this.groundConfig?.terrain?.enabled ? this.groundConfig.terrain : null;
    const baseHeight = this.groundConfig?.y ?? GROUND_Y;
    let height = baseHeight;
    if (terrain) {
      const terrainHalf = Math.max(16, terrain.size) * 0.5;
      if (Math.abs(x) <= terrainHalf && Math.abs(z) <= terrainHalf) {
        height = baseHeight + this.sampleTerrainHeight({ ...terrain, x, z });
      }
    }
    for (const obstacle of this.obstacles) {
      const proxy = this.getObstacleColliderProxy(obstacle);
      if (!proxy) continue;
      const halfX = proxy.size.x / 2;
      const halfZ = proxy.size.z / 2;
      if (
        Math.abs(x - proxy.position.x) <= halfX &&
        Math.abs(z - proxy.position.z) <= halfZ
      ) {
        height = Math.max(height, proxy.size.y + proxy.position.y);
      }
    }
    const meshHeight = this.sampleMeshColliderHeight(x, z);
    if (Number.isFinite(meshHeight)) {
      height = Math.max(height, meshHeight);
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
    mesh.visible = false; // Hide collider
    group.add(mesh);
    group.userData.capsule = {
      mesh,
      baseRadius: radius,
      baseLength: length,
      hip: null as THREE.Object3D | null,
    };
    group.position.set(0, GROUND_Y, 0);
    return group;
  }

  private createCrowd() {
    const group = new THREE.Group();
    group.name = 'crowd';
    return group;
  }

  private getAvatarUrl(name: string) {
    return getGameAvatarUrl(this.gameId, name);
  }

  private showCapsuleFallback(group: THREE.Object3D, color: number) {
    const capsule = group.userData.capsule as
      | { mesh: THREE.Mesh; baseRadius: number; baseLength: number; hip: THREE.Object3D | null }
      | undefined;
    if (!capsule) return;
    const material = capsule.mesh.material;
    if (material instanceof THREE.MeshStandardMaterial) {
      material.color.set(color);
      material.opacity = 0.85;
      material.transparent = true;
      material.emissive.set(color);
      material.emissiveIntensity = 0.25;
    }
    capsule.mesh.visible = true;
    if (group === this.localPlayer) {
      this.syncLocalFirstPersonVisuals();
    }
  }

  private syncLocalFirstPersonVisuals() {
    if (!this.localPlayer) return;
    const shouldHide = this.firstPersonMode;
    if (!shouldHide && !this.localFirstPersonVisualHidden) return;
    const localVisibilityKey = '__localFirstPersonPrevVisible';
    this.localPlayer.traverse((obj) => {
      if (obj === this.localPlayer) return;
      if (shouldHide) {
        if (obj.userData[localVisibilityKey] === undefined) {
          obj.userData[localVisibilityKey] = obj.visible;
        }
        obj.visible = false;
        return;
      }
      if (obj.userData[localVisibilityKey] !== undefined) {
        obj.visible = Boolean(obj.userData[localVisibilityKey]);
        delete obj.userData[localVisibilityKey];
      }
    });
    this.localFirstPersonVisualHidden = shouldHide;
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
    const crowdUrl = this.getAvatarUrl(this.crowdAvatarName);
    this.gltfLoader.load(
      crowdUrl,
      async (gltf) => {
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          console.warn('Crowd VRM missing, fallback to cylinders.');
          return;
        }
        vrm.humanoid.autoUpdateHumanBones = true;
        this.crowdTemplate = vrm;
        this.crowdLoaded = true;
        await this.mixamoReady;
        const crowdPrefix = 'crowd_';
        const normalized = (vrm.humanoid.normalizedHumanBones ?? {}) as Record<
          string,
          { node?: THREE.Object3D }
        >;
        const normalizedMap = Object.entries(normalized).flatMap(([key, bone]) =>
          bone?.node ? [{ key, name: bone.node.name }] : [],
        );
        const rawKeys = Object.keys(normalized);
        const rawMap = rawKeys.flatMap((key) => {
          const node = vrm.humanoid.getRawBoneNode(
            key as Parameters<VRM['humanoid']['getRawBoneNode']>[0],
          );
          if (!node) return [];
          return [
            {
              key,
              name: node.name,
            },
          ];
        });
        const normalizedRootName = vrm.humanoid.normalizedHumanBonesRoot?.name ?? null;
        const idleClip = this.jsonClips.idle
          ? buildAnimationClipFromData('idle', this.jsonClips.idle, {
              prefix: crowdPrefix,
              rootKey: 'hips',
            })
          : null;
        const walkClip = this.jsonClips.walk
          ? buildAnimationClipFromData('walk', this.jsonClips.walk, {
              prefix: crowdPrefix,
              rootKey: 'hips',
            })
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
            action.loop =
              name === 'jump' ||
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
            const clip = buildAnimationClipFromData(name, clipData, {
              prefix: crowdPrefix,
              rootKey: 'hips',
            });
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
      () => {
        this.statusLines.crowd = `crowd: missing ${this.crowdAvatarName}`;
        const node = this.hud.querySelector('[data-hud-crowd]');
        if (node) node.textContent = this.statusLines.crowd;
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
    mesh.visible = false; // Hide collider
    group.add(mesh);
    group.userData.capsule = {
      mesh,
      baseRadius: radius,
      baseLength: length,
      hip: null as THREE.Object3D | null,
    };
    if (this.playerAvatarEnabled) {
      void this.loadVrmInto(group, id);
    } else {
      this.showCapsuleFallback(group, 0xff6b6b);
    }
    return group;
  }

  private animateCrowd(time: number, delta: number) {
    if (!this.crowdEnabled) return;
    if (this.crowdAvatars.length === 0) return;
    const firstAvatar = this.crowdAvatars[0];
    if (firstAvatar?.debug) {
      const dbg = firstAvatar.debug;
      const idleW = firstAvatar.actions.idle?.weight ?? 0;
      const walkW = firstAvatar.actions.walk?.weight ?? 0;
      this.statusLines.crowd = `crowd: idleTracks ${dbg.idleTracks}, walkTracks ${dbg.walkTracks}, idleW ${idleW.toFixed(2)}, walkW ${walkW.toFixed(2)}`;
      const node = this.hud.querySelector('[data-hud-crowd]');
      if (node) node.textContent = this.statusLines.crowd;
    }
    if (this.crowdAgents.size > 0) {
      const agents = Array.from(this.crowdAgents.values()).map((entry) => entry.agent);
      const count = Math.min(this.crowdAvatars.length, agents.length);
      for (let i = 0; i < count; i += 1) {
        const agent = agents[i];
        const avatar = this.crowdAvatars[i];
        if (!agent || !avatar || !this.crowdTemplate) continue;
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
          vrm: this.crowdTemplate,
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
      const avatar = this.crowdAvatars[i];
      if (!avatar) continue;
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
      `<div>VRM: ${this.playerAvatarEnabled ? `/api/games/${this.gameId}/avatars/${this.localAvatarName}` : 'none (capsule fallback)'}</div>`,
      '<div>Press H to toggle HUD</div>',
    ].join('');
    return hud;
  }

  private createPerfHud() {
    const hud = document.createElement('div');
    hud.className = 'hud hud-perf';
    hud.style.display = 'none';
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
      await this.roomClient.connect({ gameId: this.gameId, sceneName: this.sceneName });
      const sessionId = this.roomClient.getSessionId();
      if (!sessionId) return;
      this.localId = sessionId;
      this.setHud('connection', 'connected');
      this.roomClient.onSnapshot((players) => this.syncRemotePlayers(players));
      this.roomClient.onObstacleDynamics((snapshot) => this.syncObstacleDynamics(snapshot));
      this.roomClient.onCrowd((snapshot) => {
        if (!this.crowdEnabled) return;
        const now = performance.now() / 1000;
        // Update received agents
        for (const agent of snapshot.agents) {
          this.crowdAgents.set(agent.id, { agent, lastUpdate: now });
        }
        // Remove stale agents (not updated recently)
        for (const [id, entry] of this.crowdAgents.entries()) {
          if (now - entry.lastUpdate > this.CROWD_TIMEOUT) {
            this.crowdAgents.delete(id);
          }
        }
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
    const rotated = this.getControllerRelativeMovement(movement.x, movement.z);
    const flags = this.input.getFlags();
    const movementLocked = this.localMovementLockTimer > 0 || this.activeControllerMode === 'ragdoll';
    const moveX = movementLocked ? 0 : rotated.x;
    const moveZ = movementLocked ? 0 : rotated.z;
    this.updateInputHud(movement.x, movement.z);
    this.updateKeyHud();

    const ragdollPatch =
      this.activeControllerMode === 'ragdoll' ? ({ ragdoll: true } as Record<string, boolean>) : {};
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
      ...ragdollPatch,
    });
  }

  private animateLocalPlayer(
    delta: number,
    externalMovementLock = false,
    controllerTuning: ControllerTuning = {},
  ) {
    const prevPlayerPos = {
      x: this.localPlayer.position.x,
      y: this.localPlayer.position.y,
      z: this.localPlayer.position.z,
    };
    const flags = this.input.getFlags();
    const movement = this.input.getVector();
    const rotated = this.rotateMovementByCamera(movement.x, movement.z);
    const moveX = rotated.x;
    const moveZ = rotated.z;
    const groundHeight = this.sampleGroundHeight(
      this.localPlayer.position.x,
      this.localPlayer.position.z,
    );
    const nearGround = this.localPlayer.position.y <= groundHeight + 0.06;
    const descendingSlow = this.localVelocityY <= 0.65;
    const onGround = nearGround && descendingSlow;
    if (onGround) {
      this.localJumpCoyoteTimer = JUMP_COYOTE_SECONDS;
    } else {
      this.localJumpCoyoteTimer = Math.max(0, this.localJumpCoyoteTimer - delta);
    }
    const canJumpFromGround = onGround || this.localJumpCoyoteTimer > 0;
    const movementLocked = this.localMovementLockTimer > 0 || externalMovementLock;

    // Smooth velocity transition for better animation blending
    // Moderate acceleration (15x per second) stays tightly synced with server
    const moveSpeed = controllerTuning.moveSpeed ?? this.playerConfig.moveSpeed ?? MOVE_SPEED;
    const sprintMult =
      controllerTuning.sprintMultiplier ?? this.playerConfig.sprintMultiplier ?? SPRINT_MULTIPLIER;
    const crouchMult =
      controllerTuning.crouchMultiplier ?? this.playerConfig.crouchMultiplier ?? CROUCH_MULTIPLIER;
    const slideAccel = controllerTuning.slideAccel ?? this.playerConfig.slideAccel ?? SLIDE_ACCEL;
    const slideFriction =
      controllerTuning.slideFriction ?? this.playerConfig.slideFriction ?? SLIDE_FRICTION;
    const jumpSpeed = controllerTuning.jumpSpeed ?? this.playerConfig.jumpSpeed ?? JUMP_SPEED;
    const gravity = controllerTuning.gravity ?? this.playerConfig.gravity ?? GRAVITY;
    const walkThreshold = controllerTuning.walkThreshold ?? this.playerConfig.walkThreshold ?? 0.15;
    const runThreshold = controllerTuning.runThreshold ?? this.playerConfig.runThreshold ?? moveSpeed * 0.65;

    if (!movementLocked) {
      const speed = moveSpeed * (flags.sprint ? sprintMult : flags.crouch ? crouchMult : 1);
      const targetVx = moveX * speed;
      const targetVz = moveZ * speed;
      const accelRate = 25; // 25x per second = smooth and server-aligned
      const blend = Math.min(1, delta * accelRate);
      this.localVelocityX += (targetVx - this.localVelocityX) * blend;
      this.localVelocityZ += (targetVz - this.localVelocityZ) * blend;
    }
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

    const speedBase = moveSpeed * (flags.sprint ? sprintMult : flags.crouch ? crouchMult : 1);
    const accel = Math.min(1, slideAccel * delta);

    const startSlide =
      !movementLocked && canJumpFromGround && flags.crouch && flags.sprint && this.slideCooldown <= 0;
    const startVault =
      !movementLocked &&
      canJumpFromGround &&
      flags.jump &&
      this.vaultCooldown <= 0 &&
      this.checkVault(moveDir);
    const startClimb =
      !movementLocked &&
      !onGround &&
      flags.jump &&
      this.vaultCooldown <= 0 &&
      this.checkClimb(moveDir);
    const startFlip =
      !movementLocked &&
      canJumpFromGround &&
      flags.jump &&
      flags.sprint &&
      this.vaultCooldown <= 0 &&
      !startVault;

    if (startVault) {
      this.parkourState = 'vault';
      this.parkourTimer = 0.35;
      this.vaultCooldown = 0.4;
      this.localVelocityY = jumpSpeed * 0.6;
      this.localVelocityX = moveDir.x * speedBase * 1.2;
      this.localVelocityZ = moveDir.z * speedBase * 1.2;
    } else if (startClimb) {
      this.parkourState = 'climb';
      this.parkourTimer = 0.45;
      this.vaultCooldown = 0.5;
      this.localVelocityY = jumpSpeed * 0.9;
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
      this.localVelocityY = jumpSpeed * 1.15;
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
          const damping = Math.max(0, 1 - slideFriction * delta);
          this.localVelocityX *= damping;
          this.localVelocityZ *= damping;
        }
      } else {
        this.localVelocityX = targetVx;
        this.localVelocityZ = targetVz;
      }
    } else if (this.parkourState === 'slide') {
      const damping = Math.max(0, 1 - slideFriction * 1.4 * delta);
      this.localVelocityX *= damping;
      this.localVelocityZ *= damping;
    } else if (movementLocked) {
      this.localVelocityX = 0;
      this.localVelocityZ = 0;
    }

    if (!movementLocked && flags.jump && canJumpFromGround && this.parkourState === 'normal') {
      const speed = Math.hypot(this.localVelocityX, this.localVelocityZ);
      if (speed <= walkThreshold) this.localJumpMode = 'jump_up';
      else if (speed > runThreshold) this.localJumpMode = 'run_jump';
      else this.localJumpMode = 'jump';
      this.localVelocityY = jumpSpeed;
      this.localJumpCoyoteTimer = 0;
    }

    this.localVelocityY += gravity * delta;

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
    for (const obstacle of this.obstacles) {
      const proxy = this.getObstacleColliderProxy(obstacle);
      if (!proxy) continue;
      resolved = resolveCircleAabb(resolved, PLAYER_RADIUS, proxy);
    }
    resolved = this.resolveCircleMeshCollisions(this.localPlayer.position, resolved, PLAYER_RADIUS);
    for (const entry of this.crowdAgents.values()) {
      const agent = entry.agent;
      resolved = resolveCircleCircle(resolved, PLAYER_RADIUS, agent.position, CROWD_RADIUS);
    }
    for (const [id, pos] of this.remoteLatest.entries()) {
      if (this.localId && id === this.localId) continue;
      if (this.remoteRagdoll.get(id)) continue;
      resolved = resolveCircleCircle(resolved, PLAYER_RADIUS, pos, PLAYER_RADIUS);
    }

    const floor = this.sampleGroundHeight(resolved.x, resolved.z);
    const terrainStickRange = 0.7;
    const isNearGround = resolved.y <= floor + terrainStickRange;
    if (isNearGround && this.localVelocityY <= 0) {
      const stickStrength = Math.min(1, delta * 18);
      resolved.y = THREE.MathUtils.lerp(resolved.y, floor, stickStrength);
      if (Math.abs(resolved.y - floor) < 0.015) {
        resolved.y = floor;
      }
      this.localVelocityY = 0;
    }

    this.applyPlayerPushToDynamicObstacles(prevPlayerPos, resolved, delta);

    this.localPlayer.position.x = resolved.x;
    this.localPlayer.position.y = Math.max(resolved.y, floor - 0.02);
    this.localPlayer.position.z = resolved.z;
  }

  private animateLocalFirstPerson(
    delta: number,
    controllerTuning: ControllerTuning = {},
  ) {
    const prevPlayerPos = {
      x: this.localPlayer.position.x,
      y: this.localPlayer.position.y,
      z: this.localPlayer.position.z,
    };
    const flags = this.input.getFlags();
    const movement = this.input.getVector();
    const rotated = this.rotateMovementByYaw(movement.x, movement.z, -this.orbitYaw);
    const moveX = rotated.x;
    const moveZ = rotated.z;
    const groundHeight = this.sampleGroundHeight(
      this.localPlayer.position.x,
      this.localPlayer.position.z,
    );
    const nearGround = this.localPlayer.position.y <= groundHeight + 0.06;
    const descendingSlow = this.localVelocityY <= 0.65;
    const onGround = nearGround && descendingSlow;
    if (onGround) {
      this.localJumpCoyoteTimer = JUMP_COYOTE_SECONDS;
    } else {
      this.localJumpCoyoteTimer = Math.max(0, this.localJumpCoyoteTimer - delta);
    }
    const canJumpFromGround = onGround || this.localJumpCoyoteTimer > 0;
    const movementLocked = this.localMovementLockTimer > 0;

    const moveSpeed = controllerTuning.moveSpeed ?? this.playerConfig.moveSpeed ?? MOVE_SPEED;
    const sprintMult =
      controllerTuning.sprintMultiplier ?? this.playerConfig.sprintMultiplier ?? SPRINT_MULTIPLIER;
    const crouchMult =
      controllerTuning.crouchMultiplier ?? this.playerConfig.crouchMultiplier ?? CROUCH_MULTIPLIER;
    const jumpSpeed = controllerTuning.jumpSpeed ?? this.playerConfig.jumpSpeed ?? JUMP_SPEED;
    const gravity = controllerTuning.gravity ?? this.playerConfig.gravity ?? GRAVITY;
    const walkThreshold = controllerTuning.walkThreshold ?? this.playerConfig.walkThreshold ?? 0.15;
    const runThreshold = controllerTuning.runThreshold ?? this.playerConfig.runThreshold ?? moveSpeed * 0.65;

    if (!movementLocked) {
      const speed = moveSpeed * (flags.sprint ? sprintMult : flags.crouch ? crouchMult : 1);
      const targetVx = moveX * speed;
      const targetVz = moveZ * speed;
      const accelRate = 20;
      const blend = Math.min(1, delta * accelRate);
      this.localVelocityX += (targetVx - this.localVelocityX) * blend;
      this.localVelocityZ += (targetVz - this.localVelocityZ) * blend;
    } else {
      this.localVelocityX = 0;
      this.localVelocityZ = 0;
    }

    if (!movementLocked && flags.jump && canJumpFromGround) {
      const speed = Math.hypot(this.localVelocityX, this.localVelocityZ);
      if (speed <= walkThreshold) this.localJumpMode = 'jump_up';
      else if (speed > runThreshold) this.localJumpMode = 'run_jump';
      else this.localJumpMode = 'jump';
      this.localVelocityY = jumpSpeed;
      this.localJumpCoyoteTimer = 0;
    }

    this.localVelocityY += gravity * delta;

    const next = {
      x: this.localPlayer.position.x + this.localVelocityX * delta,
      y: this.localPlayer.position.y + this.localVelocityY * delta,
      z: this.localPlayer.position.z + this.localVelocityZ * delta,
    };
    const nextGround = this.sampleGroundHeight(next.x, next.z);
    if (next.y <= nextGround) {
      next.y = nextGround;
      this.localVelocityY = 0;
    }

    let resolved = next;
    for (const obstacle of this.obstacles) {
      const proxy = this.getObstacleColliderProxy(obstacle);
      if (!proxy) continue;
      resolved = resolveCircleAabb(resolved, PLAYER_RADIUS, proxy);
    }
    resolved = this.resolveCircleMeshCollisions(this.localPlayer.position, resolved, PLAYER_RADIUS);
    for (const entry of this.crowdAgents.values()) {
      const agent = entry.agent;
      resolved = resolveCircleCircle(resolved, PLAYER_RADIUS, agent.position, CROWD_RADIUS);
    }
    for (const [id, pos] of this.remoteLatest.entries()) {
      if (this.localId && id === this.localId) continue;
      if (this.remoteRagdoll.get(id)) continue;
      resolved = resolveCircleCircle(resolved, PLAYER_RADIUS, pos, PLAYER_RADIUS);
    }

    const floor = this.sampleGroundHeight(resolved.x, resolved.z);
    const terrainStickRange = 0.7;
    const isNearGround = resolved.y <= floor + terrainStickRange;
    if (isNearGround && this.localVelocityY <= 0) {
      const stickStrength = Math.min(1, delta * 18);
      resolved.y = THREE.MathUtils.lerp(resolved.y, floor, stickStrength);
      if (Math.abs(resolved.y - floor) < 0.015) {
        resolved.y = floor;
      }
      this.localVelocityY = 0;
    }

    this.applyPlayerPushToDynamicObstacles(prevPlayerPos, resolved, delta);

    this.localPlayer.position.x = resolved.x;
    this.localPlayer.position.y = Math.max(resolved.y, floor - 0.02);
    this.localPlayer.position.z = resolved.z;
    this.localPlayer.rotation.y = this.orbitYaw + Math.PI;
  }

  private async ensureRapierRuntime() {
    if (this.rapierReady) return this.rapierReady;
    this.rapierReady = import('@dimforge/rapier3d-compat')
      .then(async (mod) => {
        await mod.init();
        this.rapier = mod;
      })
      .catch((error) => {
        console.warn('Rapier init failed for runtime ragdoll:', error);
      });
    return this.rapierReady;
  }

  private getLocalRuntimeVrm() {
    return this.vrmActors.get('local')?.vrm ?? null;
  }

  private async ensureRuntimeRagdollReady() {
    if (this.activeControllerMode !== 'ragdoll') return;
    if (this.runtimeRagdollWorld || this.runtimeRagdollBuildInFlight) return;
    const vrm = this.getLocalRuntimeVrm();
    if (!vrm) return;
    this.runtimeRagdollBuildInFlight = true;
    try {
      await this.ensureRapierRuntime();
      if (!this.rapier || this.activeControllerMode !== 'ragdoll') return;
      this.buildRuntimeRagdoll(vrm);
      this.runtimeRagdollMode = 'ragdoll';
      this.runtimeRagdollActivationTime = 0;
    } finally {
      this.runtimeRagdollBuildInFlight = false;
    }
  }

  private buildRuntimeRagdoll(vrm: VRM) {
    if (!this.rapier) return;
    const RAPIER = this.rapier;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.runtimeRagdollWorld = world;
    this.runtimeRagdollBones.clear();
    this.runtimeRagdollControlKeys.clear();
    const humanoid = vrm.humanoid;
    const getBone = (name: string) => humanoid.getRawBoneNode(name as HumanBoneName);
    const tmpVec = new THREE.Vector3();
    const tmpVec2 = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const boneQuat = new THREE.Quaternion();
    const muscleScaleByBone: Record<string, number> = {
      hips: 1.25,
      chest: 1.15,
      head: 0.9,
      leftUpperArm: 0.85,
      leftLowerArm: 0.75,
      rightUpperArm: 0.85,
      rightLowerArm: 0.75,
      leftUpperLeg: 1.0,
      leftLowerLeg: 0.9,
      rightUpperLeg: 1.0,
      rightLowerLeg: 0.9,
    };

    const rootBone = getBone('hips');
    if (rootBone) {
      rootBone.getWorldPosition(tmpVec);
      this.runtimeRagdollHipsOffset.copy(tmpVec).sub(this.localPlayer.position);
    }

    for (const segment of RAGDOLL_SEGMENT_PROFILE) {
      const bone = getBone(segment.bone);
      if (!bone) continue;
      const child = resolveRagdollSegmentChildBone({
        segmentName: segment.name,
        sourceBone: bone,
        preferredChildBone: segment.childBone,
        jointProfileChildBone: RAGDOLL_JOINT_PROFILE.find((entry) => entry.parent === segment.name)
          ?.child,
        getBone,
      });
      bone.getWorldPosition(tmpVec);
      bone.getWorldQuaternion(boneQuat);
      child?.getWorldPosition(tmpVec2);
      const segmentFrame = computeRagdollSegmentFrame({
        segment,
        bonePosition: tmpVec,
        boneQuaternion: boneQuat,
        childPosition: child ? tmpVec2 : null,
      });
      const center = segmentFrame.center;
      tmpQuat.copy(segmentFrame.bodyQuaternion);
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setRotation({ x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w })
        .setLinearDamping(0.5)
        .setAngularDamping(1.5)
        .setCanSleep(true)
        .setCcdEnabled(true);
      const body = world.createRigidBody(bodyDesc);
      const membership = getRagdollBodyGroup(segment.name);
      const filter = RAGDOLL_COLLISION_GROUP_ENV | (RAGDOLL_ALL_BODY_GROUPS & ~membership);
      const collider =
        segment.shape === 'sphere'
          ? RAPIER.ColliderDesc.ball(
              (segment.dimensions as { radius: number }).radius,
            ).setCollisionGroups((membership << 16) | filter)
          : RAPIER.ColliderDesc.cuboid(
              (segment.dimensions as { width: number }).width / 2,
              (segment.dimensions as { height: number }).height / 2,
              (segment.dimensions as { depth: number }).depth / 2,
            ).setCollisionGroups((membership << 16) | filter);
      collider.setMass(segment.mass).setFriction(1.4).setRestitution(0);
      world.createCollider(collider, body);
      const drive = getRagdollDriveForBone(segment.name);
      const radius =
        segment.shape === 'sphere'
          ? (segment.dimensions as { radius: number }).radius
          : (segment.dimensions as { height: number }).height * 0.5;
      const ragBone: RuntimeRagdollBone = {
        name: segment.name,
        driveGroup: drive.group,
        bone,
        child,
        body,
        bodyToBone: segmentFrame.bodyQuaternion.clone().invert().multiply(boneQuat),
        muscleScale: muscleScaleByBone[segment.name] ?? 1,
        radius,
      };
      const jointProfile = getRagdollJointForChild(segment.name);
      const hinge =
        jointProfile?.type === 'hinge'
          ? {
              axis: jointProfile.axis ?? ([1, 0, 0] as [number, number, number]),
              min: jointProfile.limitMin ?? THREE.MathUtils.degToRad(-5),
              max: jointProfile.limitMax ?? THREE.MathUtils.degToRad(130),
            }
          : null;
      if (hinge) {
        ragBone.hingeAxisLocal = new THREE.Vector3(
          hinge.axis[0],
          hinge.axis[1],
          hinge.axis[2],
        ).normalize();
        ragBone.hingeMin = hinge.min;
        ragBone.hingeMax = hinge.max;
      }
      if (jointProfile?.type === 'socket') {
        ragBone.swingLimitRad = THREE.MathUtils.degToRad(
          Math.max(Number(jointProfile.limitYDeg ?? 0), Number(jointProfile.limitZDeg ?? 0)),
        );
        ragBone.twistLimitRad = THREE.MathUtils.degToRad(
          Math.max(
            Math.abs(Number(jointProfile.twistMinDeg ?? 0)),
            Math.abs(Number(jointProfile.twistMaxDeg ?? 0)),
          ),
        );
        const parentName = RAGDOLL_BONE_DEFS.find((def) => def.name === segment.name)?.parent;
        if (parentName) {
          const parentBone = getBone(parentName);
          if (parentBone) {
            const parentWorldQuat = parentBone.getWorldQuaternion(new THREE.Quaternion());
            ragBone.twistAxisLocal = segmentFrame.axis
              .clone()
              .applyQuaternion(parentWorldQuat.invert())
              .normalize();
          }
        }
      }
      this.runtimeRagdollBones.set(segment.name, ragBone);
    }

    for (const jointDef of RAGDOLL_JOINT_PROFILE) {
      const childBone = this.runtimeRagdollBones.get(jointDef.child);
      const parentBone = this.runtimeRagdollBones.get(jointDef.parent);
      if (!childBone || !parentBone) continue;
      const parentBody = parentBone.body;
      const childBody = childBone.body;
      const jointWorld = childBone.bone.getWorldPosition(new THREE.Vector3());
      const pPos = parentBody.translation();
      const pRot = parentBody.rotation();
      const cPos = childBody.translation();
      const cRot = childBody.rotation();
      const pQuatInv = new THREE.Quaternion(pRot.x, pRot.y, pRot.z, pRot.w).invert();
      const cQuatInv = new THREE.Quaternion(cRot.x, cRot.y, cRot.z, cRot.w).invert();
      const anchorParent = jointWorld
        .clone()
        .sub(new THREE.Vector3(pPos.x, pPos.y, pPos.z))
        .applyQuaternion(pQuatInv);
      const anchorChild = jointWorld
        .clone()
        .sub(new THREE.Vector3(cPos.x, cPos.y, cPos.z))
        .applyQuaternion(cQuatInv);
      const anchor1 = new RAPIER.Vector3(anchorParent.x, anchorParent.y, anchorParent.z);
      const anchor2 = new RAPIER.Vector3(anchorChild.x, anchorChild.y, anchorChild.z);
      const hinge =
        jointDef.type === 'hinge'
          ? {
              axis: jointDef.axis ?? ([1, 0, 0] as [number, number, number]),
              min: jointDef.limitMin ?? THREE.MathUtils.degToRad(-5),
              max: jointDef.limitMax ?? THREE.MathUtils.degToRad(130),
            }
          : null;
      const jointData = hinge
        ? RAPIER.JointData.revolute(
            anchor1,
            anchor2,
            new RAPIER.Vector3(hinge.axis[0], hinge.axis[1], hinge.axis[2]),
          )
        : RAPIER.JointData.spherical(anchor1, anchor2);
      jointData.stiffness = jointDef.stiffness;
      jointData.damping = jointDef.damping;
      const joint = world.createImpulseJoint(jointData, parentBody, childBody, true);
      if (hinge) {
        (joint as unknown as { setLimits?: (min: number, max: number) => void }).setLimits?.(
          hinge.min,
          hinge.max,
        );
      }
      childBone.parent = parentBone;
      const parentBoneQuat = parentBone.bone.getWorldQuaternion(new THREE.Quaternion());
      const childBoneQuat = childBone.bone.getWorldQuaternion(new THREE.Quaternion());
      childBone.targetLocalQuat = parentBoneQuat.invert().multiply(childBoneQuat).normalize();
      if (childBone.twistAxisLocal === undefined && jointDef.type === 'socket') {
        childBone.twistAxisLocal = new THREE.Vector3(0, 1, 0);
      }
    }
  }

  private disableRuntimeRagdoll() {
    this.runtimeRagdollWorld = null;
    this.runtimeRagdollBones.clear();
    this.runtimeRagdollMode = 'off';
    this.runtimeRagdollActivationTime = 0;
    this.runtimeRagdollBuildInFlight = false;
    this.runtimeRagdollControlKeys.clear();
  }

  private getRuntimeRagdollMoveDirection() {
    const move = this.input.getVector();
    if (Math.abs(move.x) < 0.001 && Math.abs(move.z) < 0.001) return null;
    const rotated = this.getControllerRelativeMovement(move.x, move.z);
    const dir = new THREE.Vector3(rotated.x, 0, rotated.z);
    if (dir.lengthSq() < 1e-6) return null;
    return dir.normalize();
  }

  private applyRuntimeRagdollSteering(delta: number) {
    if (this.runtimeRagdollMode !== 'ragdoll') return;
    const dir = this.getRuntimeRagdollMoveDirection();
    if (!dir) return;
    const hips = this.runtimeRagdollBones.get('hips');
    const chest = this.runtimeRagdollBones.get('chest');
    const targets = [hips, chest].filter(Boolean) as RuntimeRagdollBone[];
    if (targets.length === 0) return;
    const impulseMag = 18 * delta;
    const torqueAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    const torqueMag = 4 * delta;
    for (const rag of targets) {
      rag.body.applyImpulse({ x: dir.x * impulseMag, y: 0, z: dir.z * impulseMag }, true);
      if (Number.isFinite(torqueAxis.x)) {
        rag.body.applyTorqueImpulse(
          { x: torqueAxis.x * torqueMag, y: torqueAxis.y * torqueMag, z: torqueAxis.z * torqueMag },
          true,
        );
      }
    }
  }

  private applyRuntimeRagdollMuscles(delta: number) {
    if (this.runtimeRagdollMode !== 'ragdoll') return;
    const parentQuat = new THREE.Quaternion();
    const childQuat = new THREE.Quaternion();
    const parentInv = new THREE.Quaternion();
    const currentRel = new THREE.Quaternion();
    const errorQuat = new THREE.Quaternion();
    const axisLocal = new THREE.Vector3();
    const axisWorld = new THREE.Vector3();
    const parentAngVel = new THREE.Vector3();
    const childAngVel = new THREE.Vector3();
    const relAngVel = new THREE.Vector3();
    const transitionDuration = 0.25;
    const transitionStiffnessBoost = 3;
    const transitionT = THREE.MathUtils.clamp(this.runtimeRagdollActivationTime / transitionDuration, 0, 1);
    const transitionBoost = THREE.MathUtils.lerp(transitionStiffnessBoost, 1, transitionT);
    for (const ragBone of this.runtimeRagdollBones.values()) {
      if (!ragBone.parent || !ragBone.targetLocalQuat) continue;
      const drive = getRagdollDriveForBone(ragBone.name);
      const pRot = ragBone.parent.body.rotation();
      const cRot = ragBone.body.rotation();
      parentQuat.set(pRot.x, pRot.y, pRot.z, pRot.w);
      childQuat.set(cRot.x, cRot.y, cRot.z, cRot.w);
      parentInv.copy(parentQuat).invert();
      currentRel.copy(parentInv).multiply(childQuat).normalize();
      errorQuat.copy(currentRel).invert().multiply(ragBone.targetLocalQuat).normalize();
      if (errorQuat.w < 0) {
        errorQuat.set(-errorQuat.x, -errorQuat.y, -errorQuat.z, -errorQuat.w);
      }
      axisLocal.set(errorQuat.x, errorQuat.y, errorQuat.z);
      const axisLen = axisLocal.length();
      if (axisLen < 1e-6) continue;
      axisLocal.multiplyScalar(1 / axisLen);
      let angle = 2 * Math.atan2(axisLen, errorQuat.w);
      if (angle > Math.PI) angle -= Math.PI * 2;
      angle = THREE.MathUtils.clamp(angle, -0.8, 0.8);
      axisWorld.copy(axisLocal).applyQuaternion(parentQuat).normalize();
      const pVel = ragBone.parent.body.angvel();
      const cVel = ragBone.body.angvel();
      parentAngVel.set(pVel.x, pVel.y, pVel.z);
      childAngVel.set(cVel.x, cVel.y, cVel.z);
      relAngVel.copy(childAngVel).sub(parentAngVel);
      const axisVel = relAngVel.dot(axisWorld);
      const muscleScale = ragBone.muscleScale ?? 1;
      const kp =
        drive.stiffness *
        RUNTIME_RAGDOLL_DRIVE_STIFFNESS_SCALE *
        transitionBoost *
        muscleScale;
      const kd =
        drive.damping *
        RUNTIME_RAGDOLL_DRIVE_DAMPING_SCALE *
        Math.sqrt(Math.max(0.2, muscleScale));
      const maxTorque = drive.forceLimit * RUNTIME_RAGDOLL_DRIVE_FORCE_SCALE * muscleScale;
      const torqueMag = THREE.MathUtils.clamp(kp * angle - kd * axisVel, -maxTorque, maxTorque);
      if (!Number.isFinite(torqueMag) || Math.abs(torqueMag) < 1e-4) continue;
      const maxImpulse = maxTorque * delta * 0.45;
      const impulseMag = THREE.MathUtils.clamp(torqueMag * delta, -maxImpulse, maxImpulse);
      const impulse = axisWorld.clone().multiplyScalar(impulseMag);
      ragBone.body.applyTorqueImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
      ragBone.parent.body.applyTorqueImpulse({ x: -impulse.x, y: -impulse.y, z: -impulse.z }, true);
    }
  }

  private stepRuntimeRagdoll(delta: number) {
    if (!this.runtimeRagdollWorld || this.runtimeRagdollBones.size === 0) return;
    const vrm = this.getLocalRuntimeVrm();
    if (!vrm) return;
    this.runtimeRagdollActivationTime += delta;
    this.applyRuntimeRagdollSteering(delta);
    this.applyRuntimeRagdollMuscles(delta);
    const clampedDelta = THREE.MathUtils.clamp(delta, 1 / 180, 1 / 20);
    const maxSubsteps = 6;
    const substepHz = 90;
    const substeps = Math.max(1, Math.min(maxSubsteps, Math.ceil(clampedDelta / (1 / substepHz))));
    const stepDt = clampedDelta / substeps;
    this.runtimeRagdollWorld.timestep = stepDt;
    for (let i = 0; i < substeps; i += 1) {
      this.runtimeRagdollWorld.step();
    }

    const parentQuat = new THREE.Quaternion();
    const parentQuatInv = new THREE.Quaternion();
    const currentWorldQuat = new THREE.Quaternion();
    const childQuat = new THREE.Quaternion();
    const relQuat = new THREE.Quaternion();
    const twistQuat = new THREE.Quaternion();
    const swingQuat = new THREE.Quaternion();
    const clampedRelQuat = new THREE.Quaternion();
    const axisLocal = new THREE.Vector3();
    const twistVec = new THREE.Vector3();
    const childAng = new THREE.Vector3();
    for (const ragBone of this.runtimeRagdollBones.values()) {
      if (!ragBone.parent) continue;
      const pRot = ragBone.parent.body.rotation();
      const cRot = ragBone.body.rotation();
      parentQuat.set(pRot.x, pRot.y, pRot.z, pRot.w);
      childQuat.set(cRot.x, cRot.y, cRot.z, cRot.w);
      parentQuatInv.copy(parentQuat).invert();
      relQuat.copy(parentQuatInv).multiply(childQuat).normalize();
      let changed = false;
      const limitEpsilon = 0.03;
      if (ragBone.hingeAxisLocal) {
        const min = ragBone.hingeMin ?? -Math.PI;
        const max = ragBone.hingeMax ?? Math.PI;
        axisLocal.copy(ragBone.hingeAxisLocal).normalize();
        twistVec.set(relQuat.x, relQuat.y, relQuat.z);
        const proj = axisLocal.clone().multiplyScalar(twistVec.dot(axisLocal));
        twistQuat.set(proj.x, proj.y, proj.z, relQuat.w).normalize();
        if (twistQuat.lengthSq() >= 1e-10) {
          swingQuat.copy(relQuat).multiply(twistQuat.clone().invert()).normalize();
          const signedAngle =
            2 *
            Math.atan2(
              axisLocal.dot(new THREE.Vector3(twistQuat.x, twistQuat.y, twistQuat.z)),
              twistQuat.w,
            );
          const clampedAngle = THREE.MathUtils.clamp(signedAngle, min, max);
          if (Math.abs(clampedAngle - signedAngle) > limitEpsilon) {
            twistQuat.setFromAxisAngle(axisLocal, clampedAngle);
            clampedRelQuat.copy(swingQuat).multiply(twistQuat).normalize();
            relQuat.copy(clampedRelQuat);
            changed = true;
          }
        }
      }
      if (ragBone.swingLimitRad || ragBone.twistLimitRad) {
        const twistLimit = ragBone.twistLimitRad ?? Math.PI;
        const swingLimit = ragBone.swingLimitRad ?? Math.PI;
        axisLocal.copy(ragBone.twistAxisLocal ?? new THREE.Vector3(0, 1, 0)).normalize();
        twistVec.set(relQuat.x, relQuat.y, relQuat.z);
        const proj = axisLocal.clone().multiplyScalar(twistVec.dot(axisLocal));
        twistQuat.set(proj.x, proj.y, proj.z, relQuat.w).normalize();
        if (twistQuat.lengthSq() >= 1e-10) {
          swingQuat.copy(relQuat).multiply(twistQuat.clone().invert()).normalize();
          const signedTwist =
            2 *
            Math.atan2(
              axisLocal.dot(new THREE.Vector3(twistQuat.x, twistQuat.y, twistQuat.z)),
              twistQuat.w,
            );
          const clampedTwist = THREE.MathUtils.clamp(signedTwist, -twistLimit, twistLimit);
          const swingAngle = 2 * Math.acos(THREE.MathUtils.clamp(swingQuat.w, -1, 1));
          if (
            Math.abs(clampedTwist - signedTwist) > limitEpsilon ||
            swingAngle > swingLimit + limitEpsilon
          ) {
            twistQuat.setFromAxisAngle(axisLocal, clampedTwist);
            if (swingAngle > 1e-5 && swingLimit < Math.PI) {
              const scale = swingLimit / swingAngle;
              swingQuat.slerp(new THREE.Quaternion(), 1 - scale).normalize();
            }
            clampedRelQuat.copy(swingQuat).multiply(twistQuat).normalize();
            relQuat.copy(clampedRelQuat);
            changed = true;
          }
        }
      }
      if (!changed) continue;
      currentWorldQuat.set(cRot.x, cRot.y, cRot.z, cRot.w);
      childQuat.copy(parentQuat).multiply(relQuat).normalize();
      currentWorldQuat.slerp(childQuat, 0.45).normalize();
      ragBone.body.setRotation(
        {
          x: currentWorldQuat.x,
          y: currentWorldQuat.y,
          z: currentWorldQuat.z,
          w: currentWorldQuat.w,
        },
        false,
      );
      const avNow = ragBone.body.angvel();
      childAng.set(avNow.x, avNow.y, avNow.z).multiplyScalar(0.35);
      ragBone.body.setAngvel({ x: childAng.x, y: childAng.y, z: childAng.z }, false);
    }

    const lin = new THREE.Vector3();
    const ang = new THREE.Vector3();
    const maxLin = RUNTIME_RAGDOLL_MAX_LINEAR_VELOCITY;
    const maxAng = RUNTIME_RAGDOLL_MAX_ANGULAR_VELOCITY;
    for (const ragBone of this.runtimeRagdollBones.values()) {
      const p = ragBone.body.translation();
      const floor = this.sampleGroundHeight(p.x, p.z) + (ragBone.radius ?? 0.04);
      if (p.y < floor) {
        ragBone.body.setTranslation({ x: p.x, y: floor, z: p.z }, false);
        const lv = ragBone.body.linvel();
        ragBone.body.setLinvel({ x: lv.x * 0.7, y: Math.max(0, lv.y), z: lv.z * 0.7 }, false);
      }
      const lv = ragBone.body.linvel();
      lin.set(lv.x, lv.y, lv.z).multiplyScalar(RUNTIME_RAGDOLL_LINEAR_BLEED);
      ragBone.body.setLinvel({ x: lin.x, y: lin.y, z: lin.z }, false);
      const len = lin.length();
      if (len > maxLin) {
        lin.multiplyScalar(maxLin / len);
        ragBone.body.setLinvel({ x: lin.x, y: lin.y, z: lin.z }, false);
      }
      const av = ragBone.body.angvel();
      ang.set(av.x, av.y, av.z).multiplyScalar(RUNTIME_RAGDOLL_ANGULAR_BLEED);
      ragBone.body.setAngvel({ x: ang.x, y: ang.y, z: ang.z }, false);
      const angLen = ang.length();
      if (angLen > maxAng) {
        ang.multiplyScalar(maxAng / angLen);
        ragBone.body.setAngvel({ x: ang.x, y: ang.y, z: ang.z }, false);
      }
    }

    const parentWorld = new THREE.Quaternion();
    const invParent = new THREE.Quaternion();
    const bodyQuat = new THREE.Quaternion();
    const targetWorld = new THREE.Quaternion();
    const bodyPos = new THREE.Vector3();
    for (const ragBone of this.runtimeRagdollBones.values()) {
      const rot = ragBone.body.rotation();
      bodyQuat.set(rot.x, rot.y, rot.z, rot.w);
      targetWorld.copy(bodyQuat);
      if (ragBone.bodyToBone) {
        targetWorld.multiply(ragBone.bodyToBone);
      }
      if (ragBone.bone.parent) {
        ragBone.bone.parent.getWorldQuaternion(parentWorld);
        invParent.copy(parentWorld).invert();
        ragBone.bone.quaternion.copy(invParent.multiply(targetWorld));
      } else {
        ragBone.bone.quaternion.copy(targetWorld);
      }
    }
    vrm.scene.updateMatrixWorld(true);
    const hipsBody = this.runtimeRagdollBones.get('hips');
    if (hipsBody) {
      const pos = hipsBody.body.translation();
      bodyPos.set(pos.x, pos.y, pos.z);
      this.localPlayer.position.copy(bodyPos).sub(this.runtimeRagdollHipsOffset);
      const lv = hipsBody.body.linvel();
      this.localVelocityX = lv.x;
      this.localVelocityY = lv.y;
      this.localVelocityZ = lv.z;
      this.localAnimState = 'ragdoll';
    }
  }

  private checkVault(dir: THREE.Vector3) {
    if (dir.lengthSq() < 0.2) return false;
    const forward = 1.1;
    const pos = this.localPlayer.position;
    for (const obstacle of this.obstacles) {
      const proxy = this.getObstacleColliderProxy(obstacle);
      if (!proxy) continue;
      const halfX = proxy.size.x / 2 + PLAYER_RADIUS;
      const halfZ = proxy.size.z / 2 + PLAYER_RADIUS;
      const ox = proxy.position.x;
      const oz = proxy.position.z;
      const targetX = pos.x + dir.x * forward;
      const targetZ = pos.z + dir.z * forward;
      if (Math.abs(targetX - ox) <= halfX && Math.abs(targetZ - oz) <= halfZ) {
        return proxy.size.y <= 1.2;
      }
    }
    const meshStep = this.getMeshObstacleStepHeightAhead(dir, forward);
    if (meshStep > 0.2 && meshStep <= 1.2) return true;
    return false;
  }

  private checkClimb(dir: THREE.Vector3) {
    if (dir.lengthSq() < 0.2) return false;
    const forward = 0.9;
    const pos = this.localPlayer.position;
    for (const obstacle of this.obstacles) {
      const proxy = this.getObstacleColliderProxy(obstacle);
      if (!proxy) continue;
      const halfX = proxy.size.x / 2 + PLAYER_RADIUS;
      const halfZ = proxy.size.z / 2 + PLAYER_RADIUS;
      const ox = proxy.position.x;
      const oz = proxy.position.z;
      const targetX = pos.x + dir.x * forward;
      const targetZ = pos.z + dir.z * forward;
      if (Math.abs(targetX - ox) <= halfX && Math.abs(targetZ - oz) <= halfZ) {
        return proxy.size.y > 1.2 && proxy.size.y <= 2.4;
      }
    }
    const meshStep = this.getMeshObstacleStepHeightAhead(dir, forward);
    if (meshStep > 1.2 && meshStep <= 2.4) return true;
    return false;
  }

  private getStepUpHeight(dir: THREE.Vector3) {
    if (dir.lengthSq() < 0.2) return 0;
    const pos = this.localPlayer.position;
    const forward = 0.9;
    const probeX = pos.x + dir.x * forward;
    const probeZ = pos.z + dir.z * forward;
    let best = 0;
    for (const obstacle of this.obstacles) {
      const proxy = this.getObstacleColliderProxy(obstacle);
      if (!proxy) continue;
      const halfX = proxy.size.x / 2 + PLAYER_RADIUS;
      const halfZ = proxy.size.z / 2 + PLAYER_RADIUS;
      if (
        Math.abs(probeX - proxy.position.x) <= halfX &&
        Math.abs(probeZ - proxy.position.z) <= halfZ
      ) {
        if (proxy.size.y <= 1.6) {
          best = Math.max(best, proxy.size.y);
        }
      }
    }
    const meshStep = this.getMeshObstacleStepHeightAhead(dir, forward);
    if (meshStep > 0 && meshStep <= 1.6) best = Math.max(best, meshStep);
    return best;
  }

  private isDynamicObstacleBody(
    config: RuntimeObstacleColliderConfig | undefined | null,
  ): config is RuntimeObstacleColliderConfig {
    if (!config) return false;
    if (!config.physicsEnabled) return false;
    if (config.bodyType !== 'dynamic') return false;
    if (config.isTrigger) return false;
    return true;
  }

  private getDynamicObstacleBodies(): DynamicObstacleBody[] {
    const bodies: DynamicObstacleBody[] = [];
    for (const obstacle of this.obstacles) {
      const obstacleId = String(obstacle.id ?? '').trim();
      if (!obstacleId) continue;
      const config = this.obstacleColliderConfig.get(obstacleId);
      if (!this.isDynamicObstacleBody(config)) continue;
      const velocity =
        this.obstaclePhysicsVelocity.get(obstacleId) ?? new THREE.Vector3(0, 0, 0);
      bodies.push({
        id: obstacleId,
        obstacle,
        config,
        velocity,
      });
    }
    return bodies;
  }

  private getObstacleVerticalSpan(proxy: Obstacle) {
    return { minY: proxy.position.y, maxY: proxy.position.y + proxy.size.y };
  }

  private hasVerticalOverlap(a: Obstacle, b: Obstacle, epsilon = 0.01) {
    const aSpan = this.getObstacleVerticalSpan(a);
    const bSpan = this.getObstacleVerticalSpan(b);
    return aSpan.minY < bSpan.maxY - epsilon && bSpan.minY < aSpan.maxY - epsilon;
  }

  private syncDynamicObstacleTransform(
    body: DynamicObstacleBody,
    prevX: number,
    prevY: number,
    prevZ: number,
  ) {
    body.obstacle.position.x = body.config.proxy.position.x - body.config.offset.x;
    body.obstacle.position.y = body.config.proxy.position.y - body.config.offset.y;
    body.obstacle.position.z = body.config.proxy.position.z - body.config.offset.z;

    const placeholder = this.obstaclePlaceholderMeshes.get(body.id);
    if (placeholder) {
      placeholder.position.set(
        body.config.proxy.position.x,
        body.config.proxy.position.y + body.config.proxy.size.y / 2,
        body.config.proxy.position.z,
      );
    }

    const modelRoot = this.obstacleModelRoots.get(body.id);
    if (!modelRoot) return;
    modelRoot.position.x += body.config.proxy.position.x - prevX;
    modelRoot.position.y += body.config.proxy.position.y - prevY;
    modelRoot.position.z += body.config.proxy.position.z - prevZ;
  }

  private resolveDynamicBodyGroundContact(body: DynamicObstacleBody, delta: number) {
    const ground = this.sampleGroundHeightWithoutObstacle(
      body.config.proxy.position.x,
      body.config.proxy.position.z,
      body.id,
    );
    if (body.config.proxy.position.y > ground) return;
    body.config.proxy.position.y = ground;
    if (Math.abs(body.velocity.y) < 0.25) {
      body.velocity.y = 0;
    } else {
      body.velocity.y = -body.velocity.y * body.config.restitution;
    }
    const groundFriction = Math.max(0, 1 - body.config.friction * delta * 2);
    body.velocity.x *= groundFriction;
    body.velocity.z *= groundFriction;
  }

  private resolveDynamicBodyAgainstObstacle(body: DynamicObstacleBody, obstacle: Obstacle) {
    if (!this.hasVerticalOverlap(body.config.proxy, obstacle)) return;

    const bodyHalfX = body.config.proxy.size.x / 2;
    const bodyHalfZ = body.config.proxy.size.z / 2;
    const otherHalfX = obstacle.size.x / 2;
    const otherHalfZ = obstacle.size.z / 2;

    const dx = body.config.proxy.position.x - obstacle.position.x;
    const dz = body.config.proxy.position.z - obstacle.position.z;
    const overlapX = bodyHalfX + otherHalfX - Math.abs(dx);
    const overlapZ = bodyHalfZ + otherHalfZ - Math.abs(dz);
    if (overlapX <= 0 || overlapZ <= 0) return;

    if (overlapX < overlapZ) {
      const sign = dx >= 0 ? 1 : -1;
      body.config.proxy.position.x += overlapX * sign;
      const separating = body.velocity.x * sign;
      if (separating < 0) body.velocity.x = -body.velocity.x * body.config.restitution;
      body.velocity.z *= Math.max(0, 1 - body.config.friction * 0.15);
      return;
    }

    const sign = dz >= 0 ? 1 : -1;
    body.config.proxy.position.z += overlapZ * sign;
    const separating = body.velocity.z * sign;
    if (separating < 0) body.velocity.z = -body.velocity.z * body.config.restitution;
    body.velocity.x *= Math.max(0, 1 - body.config.friction * 0.15);
  }

  private resolveDynamicBodyPair(a: DynamicObstacleBody, b: DynamicObstacleBody) {
    if (!this.hasVerticalOverlap(a.config.proxy, b.config.proxy)) return;

    const aHalfX = a.config.proxy.size.x / 2;
    const aHalfZ = a.config.proxy.size.z / 2;
    const bHalfX = b.config.proxy.size.x / 2;
    const bHalfZ = b.config.proxy.size.z / 2;

    const dx = a.config.proxy.position.x - b.config.proxy.position.x;
    const dz = a.config.proxy.position.z - b.config.proxy.position.z;
    const overlapX = aHalfX + bHalfX - Math.abs(dx);
    const overlapZ = aHalfZ + bHalfZ - Math.abs(dz);
    if (overlapX <= 0 || overlapZ <= 0) return;

    const restitution = Math.min(a.config.restitution, b.config.restitution);
    const friction = Math.max(0, 1 - Math.max(a.config.friction, b.config.friction) * 0.08);

    if (overlapX < overlapZ) {
      const sign = dx >= 0 ? 1 : -1;
      const correction = overlapX * 0.5;
      a.config.proxy.position.x += correction * sign;
      b.config.proxy.position.x -= correction * sign;
      const relative = (a.velocity.x - b.velocity.x) * sign;
      if (relative < 0) {
        const impulse = (-(1 + restitution) * relative) * 0.5;
        a.velocity.x += impulse * sign;
        b.velocity.x -= impulse * sign;
      }
      a.velocity.z *= friction;
      b.velocity.z *= friction;
      return;
    }

    const sign = dz >= 0 ? 1 : -1;
    const correction = overlapZ * 0.5;
    a.config.proxy.position.z += correction * sign;
    b.config.proxy.position.z -= correction * sign;
    const relative = (a.velocity.z - b.velocity.z) * sign;
    if (relative < 0) {
      const impulse = (-(1 + restitution) * relative) * 0.5;
      a.velocity.z += impulse * sign;
      b.velocity.z -= impulse * sign;
    }
    a.velocity.x *= friction;
    b.velocity.x *= friction;
  }

  private applyPlayerPushToDynamicObstacles(
    prevPlayerPos: { x: number; y: number; z: number },
    nextPlayerPos: { x: number; y: number; z: number },
    delta: number,
  ) {
    if (delta <= 1e-5) return;
    const moveX = nextPlayerPos.x - prevPlayerPos.x;
    const moveZ = nextPlayerPos.z - prevPlayerPos.z;
    const moveLenSq = moveX * moveX + moveZ * moveZ;
    if (moveLenSq < 1e-8) return;

    const playerSpeedX = THREE.MathUtils.clamp(moveX / delta, -PLAYER_PUSH_MAX_SPEED, PLAYER_PUSH_MAX_SPEED);
    const playerSpeedZ = THREE.MathUtils.clamp(moveZ / delta, -PLAYER_PUSH_MAX_SPEED, PLAYER_PUSH_MAX_SPEED);
    const playerMinY = nextPlayerPos.y;
    const playerMaxY = nextPlayerPos.y + PLAYER_PUSH_HEIGHT;

    for (const body of this.getDynamicObstacleBodies()) {
      const bodyMinY = body.config.proxy.position.y;
      const bodyMaxY = body.config.proxy.position.y + body.config.proxy.size.y;
      if (playerMinY >= bodyMaxY || playerMaxY <= bodyMinY) continue;

      const halfX = body.config.proxy.size.x / 2;
      const halfZ = body.config.proxy.size.z / 2;
      const minX = body.config.proxy.position.x - halfX;
      const maxX = body.config.proxy.position.x + halfX;
      const minZ = body.config.proxy.position.z - halfZ;
      const maxZ = body.config.proxy.position.z + halfZ;
      const clampedX = THREE.MathUtils.clamp(nextPlayerPos.x, minX, maxX);
      const clampedZ = THREE.MathUtils.clamp(nextPlayerPos.z, minZ, maxZ);
      let normalX = nextPlayerPos.x - clampedX;
      let normalZ = nextPlayerPos.z - clampedZ;
      let distance = Math.hypot(normalX, normalZ);

      if (distance < 1e-5) {
        const left = Math.abs(nextPlayerPos.x - minX);
        const right = Math.abs(maxX - nextPlayerPos.x);
        const front = Math.abs(maxZ - nextPlayerPos.z);
        const back = Math.abs(nextPlayerPos.z - minZ);
        if (Math.min(left, right) < Math.min(front, back)) {
          normalX = left < right ? -1 : 1;
          normalZ = 0;
        } else {
          normalX = 0;
          normalZ = back < front ? -1 : 1;
        }
        distance = 0;
      } else {
        normalX /= distance;
        normalZ /= distance;
      }

      const penetration = PLAYER_RADIUS - distance;
      if (penetration <= 0) continue;

      const prevX = body.config.proxy.position.x;
      const prevY = body.config.proxy.position.y;
      const prevZ = body.config.proxy.position.z;
      body.config.proxy.position.x += normalX * penetration;
      body.config.proxy.position.z += normalZ * penetration;

      const normalSpeed = Math.max(0, playerSpeedX * normalX + playerSpeedZ * normalZ);
      const tangentX = playerSpeedX - normalX * normalSpeed;
      const tangentZ = playerSpeedZ - normalZ * normalSpeed;
      body.velocity.x += normalX * normalSpeed * PLAYER_PUSH_IMPULSE + tangentX * PLAYER_PUSH_TANGENT;
      body.velocity.z += normalZ * normalSpeed * PLAYER_PUSH_IMPULSE + tangentZ * PLAYER_PUSH_TANGENT;

      this.resolveDynamicBodyGroundContact(body, delta);
      this.syncDynamicObstacleTransform(body, prevX, prevY, prevZ);
      this.obstaclePhysicsVelocity.set(body.id, body.velocity);
    }
  }

  private simulateObstaclePhysics(delta: number) {
    if (delta <= 0) return;
    const hasRecentAuthoritativeDynamics =
      this.receivedObstacleDynamics && performance.now() - this.lastObstacleDynamicsAt <= 500;
    if (hasRecentAuthoritativeDynamics) return;
    const dynamicBodies = this.getDynamicObstacleBodies();
    if (dynamicBodies.length === 0) return;

    const previousPositions = new Map<string, { x: number; y: number; z: number }>();
    for (const body of dynamicBodies) {
      previousPositions.set(body.id, {
        x: body.config.proxy.position.x,
        y: body.config.proxy.position.y,
        z: body.config.proxy.position.z,
      });
      body.velocity.y += (GRAVITY * body.config.gravityScale) * delta;
      const airDamping = Math.max(0, 1 - body.config.linearDamping * delta);
      body.velocity.multiplyScalar(airDamping);
      body.config.proxy.position.x += body.velocity.x * delta;
      body.config.proxy.position.y += body.velocity.y * delta;
      body.config.proxy.position.z += body.velocity.z * delta;
      this.resolveDynamicBodyGroundContact(body, delta);
    }

    for (let i = 0; i < DYNAMIC_PHYSICS_ITERATIONS; i += 1) {
      for (const body of dynamicBodies) {
        for (const obstacle of this.obstacles) {
          const obstacleId = String(obstacle.id ?? '').trim();
          if (!obstacleId || obstacleId === body.id) continue;
          const otherConfig = this.obstacleColliderConfig.get(obstacleId);
          if (this.isDynamicObstacleBody(otherConfig)) continue;
          const proxy = this.getObstacleColliderProxy(obstacle);
          if (!proxy) continue;
          this.resolveDynamicBodyAgainstObstacle(body, proxy);
        }
        this.resolveDynamicBodyGroundContact(body, delta);
      }

      for (let a = 0; a < dynamicBodies.length; a += 1) {
        for (let b = a + 1; b < dynamicBodies.length; b += 1) {
          const bodyA = dynamicBodies[a];
          const bodyB = dynamicBodies[b];
          if (!bodyA || !bodyB) continue;
          this.resolveDynamicBodyPair(bodyA, bodyB);
        }
      }

      for (const body of dynamicBodies) {
        this.resolveDynamicBodyGroundContact(body, delta);
      }
    }

    for (const body of dynamicBodies) {
      const prev = previousPositions.get(body.id);
      if (!prev) continue;
      this.syncDynamicObstacleTransform(body, prev.x, prev.y, prev.z);
      this.obstaclePhysicsVelocity.set(body.id, body.velocity);
    }
  }

  private isFirstPersonControllerActive() {
    if (this.activeControllerMode === 'ragdoll') return false;
    if (this.activeControllerMode === 'first_person') return true;
    return this.firstPersonMode;
  }

  private updateCamera(delta: number) {
    const tuning = this.getActiveControllerTuning();
    const camHeight = tuning.cameraHeight ?? this.playerConfig.cameraHeight ?? 1.4;
    const camShoulder = tuning.cameraShoulder ?? this.playerConfig.cameraShoulder ?? 1.2;
    const camShoulderHeight =
      tuning.cameraShoulderHeight ?? this.playerConfig.cameraShoulderHeight ?? 0.4;
    const camSmooth = tuning.cameraSmoothing ?? this.playerConfig.cameraSmoothing ?? this.cameraSmoothing;
    const camSense =
      tuning.cameraSensitivity ?? this.playerConfig.cameraSensitivity ?? this.cameraSensitivity;
    const minPolar = tuning.cameraMinPitch ?? this.playerConfig.cameraMinPitch ?? 0.2;
    const maxPolar = tuning.cameraMaxPitch ?? this.playerConfig.cameraMaxPitch ?? Math.PI - 0.2;
    const targetSmoothSpeed = tuning.targetSmoothSpeed ?? this.playerConfig.targetSmoothSpeed ?? 15;

    // Desired target position (player position + visual offset for smooth corrections)
    const target = this.cameraTarget.set(
      this.localPlayer.position.x + this.localVisualOffset.x,
      this.localPlayer.position.y + this.localVisualOffset.y + camHeight,
      this.localPlayer.position.z + this.localVisualOffset.z,
    );

    // Smooth the target to decouple from sharp player movements
    // This prevents camera shake when player suddenly changes direction
    const smoothStep = Math.min(1, delta * targetSmoothSpeed);
    this.cameraTargetSmooth.lerp(target, smoothStep);

    const look = this.input.getLook();
    const rotateSpeed = 0.05 * camSense;
    if (Math.abs(look.x) > 0.01 || Math.abs(look.y) > 0.01) {
      this.orbitYaw -= look.x * rotateSpeed;
      this.orbitPitch -= look.y * rotateSpeed;
    }

    if (!this.isFirstPersonControllerActive()) {
      this.orbitPitch = Math.max(minPolar, Math.min(maxPolar, this.orbitPitch));
    }

    // Use smoothed target for all camera calculations
    const smoothTarget = this.cameraTargetSmooth;

    // First-person mode
    if (this.firstPersonMode) {
      // Camera at eye level (smoothTarget already has proper height from camHeight)
      this.cameraGoal.copy(smoothTarget);

      // Look direction from orbit angles (spherical to cartesian)
      const dir = new THREE.Vector3(
        Math.sin(this.orbitPitch) * Math.sin(this.orbitYaw),
        -Math.cos(this.orbitPitch),
        Math.sin(this.orbitPitch) * Math.cos(this.orbitYaw),
      );
      const lookTarget = this.cameraGoal.clone().add(dir);

      // Position camera (with optional smoothing)
      if (camSmooth > 0) {
        const smooth = 1 - Math.exp(-delta * (10 - camSmooth * 9));
        this.camera.position.lerp(this.cameraGoal, smooth);
      } else {
        this.camera.position.copy(this.cameraGoal);
      }
      this.camera.lookAt(lookTarget);
    } else {
      // Third-person mode
      this.orbitSpherical.set(this.orbitRadius, this.orbitPitch, this.orbitYaw);
      this.orbitOffset.setFromSpherical(this.orbitSpherical);
      this.cameraGoal.copy(smoothTarget).add(this.orbitOffset);

      // Cinematic right-shoulder offset
      this.cameraForward.subVectors(smoothTarget, this.cameraGoal).normalize();
      this.cameraRight.crossVectors(this.cameraForward, new THREE.Vector3(0, 1, 0)).normalize();
      this.cameraGoal.addScaledVector(this.cameraRight, camShoulder);
      this.cameraGoal.y += camShoulderHeight;

      // Prevent camera from dipping below floor (no physics, just Y clamp)
      const minCamY = GROUND_Y + 0.9;
      if (this.cameraGoal.y < minCamY) {
        this.cameraGoal.y = minCamY;
      }

      // Apply smoothing setting (camera position smoothing only, target already smoothed)
      if (camSmooth > 0) {
        const smooth = 1 - Math.exp(-delta * (10 - camSmooth * 9));
        this.camera.position.lerp(this.cameraGoal, smooth);
      } else {
        this.camera.position.copy(this.cameraGoal);
      }
      this.camera.lookAt(smoothTarget);
    }

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
    const world = new THREE.Vector3().addScaledVector(right, x).addScaledVector(forward, zAdjusted);
    const magnitude = Math.hypot(world.x, world.z);
    if (magnitude > 1) {
      world.multiplyScalar(1 / magnitude);
    }
    return { x: world.x, z: world.z };
  }

  private rotateMovementByYaw(x: number, z: number, yaw: number) {
    const zAdjusted = -z;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const worldX = x * cos + zAdjusted * sin;
    const worldZ = -x * sin + zAdjusted * cos;
    const magnitude = Math.hypot(worldX, worldZ);
    if (magnitude > 1) {
      return { x: worldX / magnitude, z: worldZ / magnitude };
    }
    return { x: worldX, z: worldZ };
  }

  private getControllerRelativeMovement(x: number, z: number) {
    if (this.isFirstPersonControllerActive()) {
      return this.rotateMovementByYaw(x, z, -this.orbitYaw);
    }
    return this.rotateMovementByCamera(x, z);
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
    this.emitCameraSettingsChange();
  };

  private requestPointerLock = () => {
    if (document.pointerLockElement === this.renderer.domElement) return;
    this.renderer.domElement.requestPointerLock();
  };

  private handlePointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
  };

  private syncObstacleDynamics(snapshot: ObstacleDynamicsSnapshot) {
    this.receivedObstacleDynamics = true;
    this.lastObstacleDynamicsAt = performance.now();
    for (const entry of snapshot.obstacles) {
      const obstacleId = String(entry.id ?? '').trim();
      if (!obstacleId) continue;
      const config = this.obstacleColliderConfig.get(obstacleId);
      if (!this.isDynamicObstacleBody(config)) continue;

      const prevX = config.proxy.position.x;
      const prevY = config.proxy.position.y;
      const prevZ = config.proxy.position.z;
      config.proxy.position.x = Number(entry.position?.x ?? prevX);
      config.proxy.position.y = Number(entry.position?.y ?? prevY);
      config.proxy.position.z = Number(entry.position?.z ?? prevZ);

      const obstacle = this.obstacles.find((item) => String(item.id ?? '').trim() === obstacleId);
      if (obstacle) {
        obstacle.position.x = config.proxy.position.x - config.offset.x;
        obstacle.position.y = config.proxy.position.y - config.offset.y;
        obstacle.position.z = config.proxy.position.z - config.offset.z;
      }

      const velocity = this.obstaclePhysicsVelocity.get(obstacleId) ?? new THREE.Vector3();
      const sampleDelta = 1 / 20;
      velocity.set(
        (config.proxy.position.x - prevX) / sampleDelta,
        (config.proxy.position.y - prevY) / sampleDelta,
        (config.proxy.position.z - prevZ) / sampleDelta,
      );
      this.obstaclePhysicsVelocity.set(obstacleId, velocity);

      const placeholder = this.obstaclePlaceholderMeshes.get(obstacleId);
      if (placeholder) {
        placeholder.position.set(
          config.proxy.position.x,
          config.proxy.position.y + config.proxy.size.y / 2,
          config.proxy.position.z,
        );
      }
      const modelRoot = this.obstacleModelRoots.get(obstacleId);
      if (modelRoot) {
        modelRoot.position.x += config.proxy.position.x - prevX;
        modelRoot.position.y += config.proxy.position.y - prevY;
        modelRoot.position.z += config.proxy.position.z - prevZ;
      }
    }
  }

  private syncRemotePlayers(snapshot: WorldSnapshot) {
    if (this.localId) {
      const staleLocalEntry = this.remotePlayers.get(this.localId);
      if (staleLocalEntry) {
        this.scene.remove(staleLocalEntry.mesh);
        this.remotePlayers.delete(this.localId);
        this.remoteLatest.delete(this.localId);
        this.remoteRagdoll.delete(this.localId);
        this.remoteLatestVel.delete(this.localId);
        this.remoteLatestAnim.delete(this.localId);
      }
    }
    this.setHud('players', `players: ${Object.keys(snapshot.players).length}`);
    this.statusLines.heat = this.formatHeat(snapshot.heat);
    this.statusLines.phase = `Phase: ${snapshot.phase}`;
    const heatNode = this.hud.querySelector('[data-hud-heat]');
    if (heatNode) heatNode.textContent = this.statusLines.heat;
    const phaseNode = this.hud.querySelector('[data-hud-phase]');
    if (phaseNode) phaseNode.textContent = this.statusLines.phase;

    // Track snapshot arrival time for adaptive buffering
    const now = performance.now() / 1000;
    this.lastSnapshotTimes.push(now);
    if (this.lastSnapshotTimes.length > 10) {
      this.lastSnapshotTimes.shift();
      // Calculate jitter (variance in snapshot arrival times)
      if (this.lastSnapshotTimes.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < this.lastSnapshotTimes.length; i++) {
          const current = this.lastSnapshotTimes[i];
          const previous = this.lastSnapshotTimes[i - 1];
          if (typeof current !== 'number' || typeof previous !== 'number') continue;
          intervals.push(current - previous);
        }
        if (intervals.length === 0) return;
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance =
          intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) /
          intervals.length;
        const jitter = Math.sqrt(variance);
        // Adaptive buffer: 2x average interval + 3x jitter (handles both latency and jitter)
        const targetBuffer = Math.min(
          this.remoteBufferMax,
          Math.max(this.remoteBufferMin, avgInterval * 2 + jitter * 3),
        );
        // Smooth adjustment
        this.remoteBufferSeconds += (targetBuffer - this.remoteBufferSeconds) * 0.1;
      }
    }
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
      const ragdoll = (playerSnap as { ragdoll?: boolean }).ragdoll === true;
      this.remoteRagdoll.set(id, ragdoll);
      // Velocity now set via interpolation in updateRemoteInterpolation
      this.remoteLatestLook.set(id, {
        yaw: playerSnap.lookYaw ?? 0,
        pitch: playerSnap.lookPitch ?? 0,
      });
      this.remoteLatestAnim.set(id, {
        state: playerSnap.animState ?? 'idle',
        time: playerSnap.animTime ?? 0,
      });
      // Keep only last 3 snapshots (enough for interpolation + 1 buffer)
      if (entry.snapshots.length > 3) {
        entry.snapshots.splice(0, entry.snapshots.length - 3);
      }
    }

    for (const [id, entry] of this.remotePlayers.entries()) {
      if (snapshot.players[id]) continue;
      this.scene.remove(entry.mesh);
      this.remotePlayers.delete(id);
      this.remoteLatest.delete(id);
      this.remoteRagdoll.delete(id);
      this.remoteLatestVel.delete(id);
      this.remoteLatestAnim.delete(id);
    }
  }

  private reconcileLocal(snapshot: PlayerSnapshot) {
    if (this.activeControllerMode === 'ragdoll') return;
    // Visual smoothing layer: physics position can snap instantly for server authority,
    // but rendered position smoothly interpolates via localVisualOffset

    const localFloor = this.sampleGroundHeight(this.localPlayer.position.x, this.localPlayer.position.z);
    const snapshotFloor = this.sampleGroundHeight(snapshot.position.x, snapshot.position.z);
    const localNearGround = this.localPlayer.position.y <= localFloor + 0.12;
    const localFallingSlowly = this.localVelocityY <= 0.5;
    const localGrounded = localNearGround && localFallingSlowly;
    const snapshotNearGround = snapshot.position.y <= snapshotFloor + 0.12;
    const snapshotFallingSlowly = snapshot.velocity.y <= 0.5;
    const serverGrounded = snapshotNearGround && snapshotFallingSlowly;
    const groundedContext = localGrounded || serverGrounded;
    const airborneContext =
      !groundedContext &&
      (this.localPlayer.position.y > localFloor + 0.22 ||
        snapshot.position.y > snapshotFloor + 0.22 ||
        this.localVelocityY > 0.15 ||
        snapshot.velocity.y > 0.15);
    const targetY = groundedContext ? Math.max(snapshot.position.y, snapshotFloor) : snapshot.position.y;

    const dx = snapshot.position.x - this.localPlayer.position.x;
    const dy = targetY - this.localPlayer.position.y;
    const dz = snapshot.position.z - this.localPlayer.position.z;
    const distSq = dx * dx + dz * dz;

    // Tight threshold (20cm) - catch drift early before it's noticeable
    const correctionThreshold = 0.2 * 0.2;

    const verticalCorrectionThreshold = groundedContext ? 0.1 : airborneContext ? 2.4 : 1.1;
    if (distSq > correctionThreshold || Math.abs(dy) > verticalCorrectionThreshold) {
      // Store old position before correction
      const oldX = this.localPlayer.position.x;
      const oldY = this.localPlayer.position.y;
      const oldZ = this.localPlayer.position.z;

      // Apply server correction to physics position (instant for gameplay)
      const correctedY = groundedContext
        ? targetY
        : airborneContext
          ? Math.abs(dy) > 2.8
            ? targetY
            : this.localPlayer.position.y
          : Math.abs(dy) > 2.2
            ? targetY
            : THREE.MathUtils.lerp(
                this.localPlayer.position.y,
                targetY,
                distSq > correctionThreshold ? 0.55 : 0.35,
              );
      this.localPlayer.position.set(snapshot.position.x, correctedY, snapshot.position.z);

      // Add correction delta to visual offset (accumulates smoothly)
      // The offset decays at 30x per second, so accumulation is balanced
      this.localVisualOffset.x += oldX - snapshot.position.x;
      this.localVisualOffset.y += oldY - correctedY;
      this.localVisualOffset.z += oldZ - snapshot.position.z;

      // Sync velocity to server completely
      this.localVelocityX = snapshot.velocity.x;
      this.localVelocityY = groundedContext
        ? 0
        : THREE.MathUtils.lerp(this.localVelocityY, snapshot.velocity.y, airborneContext ? 0.2 : 0.55);
      this.localVelocityZ = snapshot.velocity.z;
    } else {
      // Small drift - sync velocity moderately to stay aligned
      const velocityMatch = 0.3;
      this.localVelocityX += (snapshot.velocity.x - this.localVelocityX) * velocityMatch;
      this.localVelocityY +=
        (snapshot.velocity.y - this.localVelocityY) *
        (groundedContext ? velocityMatch : airborneContext ? 0.12 : 0.2);
      this.localVelocityZ += (snapshot.velocity.z - this.localVelocityZ) * velocityMatch;
    }
  }

  private updateRemoteInterpolation(nowSeconds: number) {
    const renderTime = nowSeconds - this.remoteBufferSeconds;
    for (const [id, entry] of this.remotePlayers.entries()) {
      const { mesh, snapshots } = entry;
      if (snapshots.length === 0) continue;
      if (snapshots.length === 1) {
        const snap = snapshots[0];
        if (!snap) continue;
        mesh.position.set(snap.position.x, snap.position.y, snap.position.z);
        if (Number.isFinite(snap.yaw)) {
          mesh.rotation.y = snap.yaw;
        }
        // Update velocity for animation
        this.remoteLatestVel.set(id, {
          x: snap.velocity.x,
          y: snap.velocity.y,
          z: snap.velocity.z,
        });
        continue;
      }

      const firstSnapshot = snapshots[0];
      const lastSnapshot = snapshots[snapshots.length - 1];
      if (!firstSnapshot || !lastSnapshot) continue;
      let older = firstSnapshot;
      let newer = lastSnapshot;
      for (let i = snapshots.length - 1; i >= 0; i -= 1) {
        const current = snapshots[i];
        if (!current) continue;
        if (current.t <= renderTime) {
          older = current;
          newer = snapshots[i + 1] ?? current;
          break;
        }
      }

      if (older === newer) {
        // Extrapolate with damping (packet loss/delayed snapshot case)
        const dt = Math.min(0.15, renderTime - older.t);
        // Apply damping factor based on how old the snapshot is
        const dampingFactor = Math.max(0, 1 - dt * 2); // Reduces to 0 after 500ms
        mesh.position.set(
          older.position.x + older.velocity.x * dt * dampingFactor,
          older.position.y + older.velocity.y * dt,
          older.position.z + older.velocity.z * dt * dampingFactor,
        );
        if (Number.isFinite(older.yaw)) {
          mesh.rotation.y = older.yaw;
        }
        // Update velocity for animation with damping
        this.remoteLatestVel.set(id, {
          x: older.velocity.x * dampingFactor,
          y: older.velocity.y,
          z: older.velocity.z * dampingFactor,
        });
        const floor = this.sampleGroundHeight(mesh.position.x, mesh.position.z);
        if (mesh.position.y <= floor + 0.75 && older.velocity.y <= 1.0) {
          mesh.position.y = THREE.MathUtils.lerp(mesh.position.y, floor, 0.3);
          if (Math.abs(mesh.position.y - floor) < 0.015) mesh.position.y = floor;
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
      // Use latest snapshot velocity for responsive animations (don't interpolate velocity)
      const latest = snapshots[snapshots.length - 1];
      if (!latest) continue;
      this.remoteLatestVel.set(id, {
        x: latest.velocity.x,
        y: latest.velocity.y,
        z: latest.velocity.z,
      });
      const floor = this.sampleGroundHeight(mesh.position.x, mesh.position.z);
      if (mesh.position.y <= floor + 0.75 && latest.velocity.y <= 1.0) {
        mesh.position.y = THREE.MathUtils.lerp(mesh.position.y, floor, 0.3);
        if (Math.abs(mesh.position.y - floor) < 0.015) mesh.position.y = floor;
      }
    }
  }

  private async loadVrmInto(group: THREE.Object3D, actorId: string) {
    const url = this.getAvatarUrl(this.localAvatarName);
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
          const isLocal = actorId === 'local';
          this.showCapsuleFallback(group, isLocal ? 0x6be9ff : 0xff6b6b);
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
        if (actorId === 'local') {
          this.syncLocalFirstPersonVisuals();
        }
        await this.mixamoReady;
        this.setupVrmActor(vrm, actorId);
        if (actorId === 'local' && this.activeControllerMode === 'ragdoll') {
          void this.ensureRuntimeRagdollReady();
        }
      },
      undefined,
      () => {
        const isLocal = actorId === 'local';
        this.showCapsuleFallback(group, isLocal ? 0x6be9ff : 0xff6b6b);
      },
    );
  }

  private updateCapsuleToVrm(group: THREE.Object3D, vrm: VRM) {
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
      const data = await getGamePlayer<Partial<typeof this.playerConfig>>(this.gameId);
      this.playerConfig = {
        ...this.playerConfig,
        ...data,
        controllerModes: normalizeControllerModeConfigs(
          (data as { controllerModes?: ControllerModeConfigs }).controllerModes ??
            this.playerConfig.controllerModes,
        ),
      };
      if (typeof this.playerConfig.cameraDistance === 'number') {
        this.orbitRadius = this.playerConfig.cameraDistance;
      }
      if (typeof this.playerConfig.cameraSensitivity === 'number') {
        this.cameraSensitivity = this.playerConfig.cameraSensitivity;
      }
      if (typeof this.playerConfig.cameraSmoothing === 'number') {
        this.cameraSmoothing = this.playerConfig.cameraSmoothing;
      }
      this.applyControllerModeFromConfig();
      for (const vrm of this.vrms) {
        const group = vrm.scene.parent as THREE.Group | null;
        if (group) this.updateCapsuleToVrm(group, vrm);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('request_failed:404')) return;
      console.warn('Player config load failed', error);
    }
  }

  private async loadSceneConfig() {
    try {
      const data = await getGameScenes(this.gameId);
      const scene = data.scenes?.find((entry) => entry.name === this.sceneName);
      const sceneController =
        typeof scene?.player?.controller === 'string' ? scene.player.controller : null;
      this.sceneControllerModeOverride = sceneController as ControllerMode | null;
      this.applyControllerModeFromConfig();
      const sceneAvatar = typeof scene?.player?.avatar === 'string' ? scene.player.avatar : '';
      const configAvatar =
        typeof this.playerConfig.avatar === 'string' ? this.playerConfig.avatar : '';
      const playerAvatar = sceneAvatar || configAvatar;
      this.playerAvatarEnabled = playerAvatar.length > 0;
      if (this.playerAvatarEnabled) {
        this.localAvatarName = playerAvatar;
        if (!this.localAvatarLoaded) {
          this.localAvatarLoaded = true;
          void this.loadVrmInto(this.localPlayer, 'local');
        }
      } else {
        this.showCapsuleFallback(this.localPlayer, 0x6be9ff);
      }

      const crowdConfig = scene?.crowd;
      this.crowdEnabled = crowdConfig?.enabled === true;
      if (typeof crowdConfig?.avatar === 'string' && crowdConfig.avatar.length > 0) {
        this.crowdAvatarName = crowdConfig.avatar;
      }
      if (this.crowdEnabled && !this.crowdLoaded) {
        void this.loadCrowdTemplate(this.crowd);
      }
      if (!this.crowdEnabled) {
        this.crowd.clear();
        this.crowdAvatars = [];
        this.crowdAgents.clear();
        this.statusLines.crowd = 'crowd: off';
        const crowdNode = this.hud.querySelector('[data-hud-crowd]');
        if (crowdNode) crowdNode.textContent = this.statusLines.crowd;
      }

      this.applySceneEnvironment(this.parseSceneEnvironment(scene?.environment));
      this.rebuildGroundMesh(this.parseSceneGround(scene?.ground));
      this.obstacles = this.parseSceneObstacles(scene?.obstacles);
      this.sceneComponents =
        scene?.components && typeof scene.components === 'object'
          ? (scene.components as Record<string, Record<string, unknown>>)
          : {};
      this.rebuildObstacleMeshes();
    } catch (err) {
      console.error('Failed to load scene config:', err);
    }
  }

  private rebuildObstacleMeshes() {
    if (this.obstacleGroup) {
      this.scene.remove(this.obstacleGroup);
    }
    this.obstacleModelRoots.clear();
    this.obstacleGroup = this.createObstacles();
    this.scene.add(this.obstacleGroup);
    void this.attachSceneModelInstances();
  }

  private rebuildGroundMesh(
    groundConfig: SceneGroundConfig | null,
  ) {
    if (this.groundMesh) {
      this.scene.remove(this.groundMesh);
      this.groundMesh.geometry.dispose();
      if (this.groundMesh.material instanceof THREE.MeshStandardMaterial) {
        this.groundMesh.material.dispose();
      }
      this.groundMesh = null;
    }
    if (this.waterMesh) {
      this.scene.remove(this.waterMesh);
      this.waterMesh.geometry.dispose();
      this.waterMesh = null;
    }
    if (this.waterMaterial) {
      this.waterMaterial.dispose();
      this.waterMaterial = null;
    }
    this.groundConfig = groundConfig;
    if (!groundConfig) return;
    this.groundMesh = this.createGround(groundConfig);
    this.scene.add(this.groundMesh);
    this.waterMesh = this.createWaterMesh(groundConfig);
    if (this.waterMesh) this.scene.add(this.waterMesh);
  }

  private updateVrms(delta: number) {
    for (const vrm of this.vrms) {
      vrm.update(delta);
    }
    for (const actor of this.vrmActors.values()) {
      if (actor.id === 'local' && this.runtimeRagdollMode === 'ragdoll') {
        this.syncCapsuleToHips(actor.vrm);
        continue;
      }
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

    // Load animations from game API
    let manifest: string[] | null = null;
    try {
      console.log('Loading animations from game:', this.gameId);
      const data = await listGameAnimations(this.gameId);
      if (Array.isArray(data.files)) {
        manifest = data.files;
        console.log('Found', data.files.length, 'animation files');
      }
    } catch (error) {
      console.warn('Failed to load animations manifest:', error);
    }

    const jsonEntries = (manifest ?? []).filter(
      (name) => name.toLowerCase().endsWith('.json') && !name.toLowerCase().startsWith('none'),
    );

    console.log('Loading', jsonEntries.length, 'animations from game');

    await Promise.all(
      jsonEntries.map(async (name) => {
        try {
          const payload = await getGameAnimation(this.gameId, name);
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
      console.log('No JSON clips found for this game yet.');
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
      action.loop =
        name === 'jump' ||
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
      const clip = buildAnimationClipFromData(name, clipData, {
        prefix: `${actorId}_`,
        rootKey: 'hips',
      });
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

  private updateActorAnimation(
    actor: {
      vrm: VRM;
      mixer: THREE.AnimationMixer;
      actions: Record<string, THREE.AnimationAction>;
      base: 'idle' | 'walk' | 'run';
      id: string;
      velocityOverride?: { x: number; y: number; z: number };
    },
    delta: number,
  ) {
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

    const state = this.animStates.get(actorId) ?? {
      mode: 'idle',
      timer: 0,
      lastGrounded: true,
      lookYaw: 0,
      lookPitch: 0,
      lastJumpMode: 'jump',
    };
    const prevMode = state.mode;

    const grounded =
      actorId === 'local'
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

    const forcedRemote = !local ? this.remoteLatestAnim.get(actorId) : undefined;
    if (forcedRemote) {
      state.mode = forcedRemote.state;
      state.timer = 0;
    } else if (!grounded) {
      state.mode =
        vy > 0.5 ? (local ? this.localJumpMode : (state.lastJumpMode ?? 'jump')) : 'fall';
    } else if (state.timer === 0) {
      const walkThreshold = this.playerConfig.walkThreshold ?? 0.15;
      const runThreshold = this.playerConfig.runThreshold ?? MOVE_SPEED * 0.65;
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
        const duration = action.getClip().duration || 1;
        const time = ((forcedRemote.time % duration) + duration) % duration;
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
      const remoteLook = this.remoteLatestLook.get(actorId);
      const targetLook = local
        ? { yaw: -this.localLookYaw, pitch: -this.localLookPitch }
        : remoteLook
          ? {
              yaw: -remoteLook.yaw,
              pitch: -remoteLook.pitch,
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

      // TODO: Re-enable IK after fixing rotation accumulation
      // 2-bone IK for legs (proper knee bending)
      // const leftUpperLeg = actor.vrm.humanoid.getRawBoneNode('leftUpperLeg');
      // const leftLowerLeg = actor.vrm.humanoid.getRawBoneNode('leftLowerLeg');
      // const leftFoot = actor.vrm.humanoid.getRawBoneNode('leftFoot');
      // const rightUpperLeg = actor.vrm.humanoid.getRawBoneNode('rightUpperLeg');
      // const rightLowerLeg = actor.vrm.humanoid.getRawBoneNode('rightLowerLeg');
      // const rightFoot = actor.vrm.humanoid.getRawBoneNode('rightFoot');

      // if (leftUpperLeg && leftLowerLeg && leftFoot) {
      //   this.applyLegIK(leftUpperLeg, leftLowerLeg, leftFoot);
      // }
      // if (rightUpperLeg && rightLowerLeg && rightFoot) {
      //   this.applyLegIK(rightUpperLeg, rightLowerLeg, rightFoot);
      // }
    }
  }

  private applyLegIK(upperLeg: THREE.Object3D, lowerLeg: THREE.Object3D, foot: THREE.Object3D) {
    // Get world positions
    const hipPos = new THREE.Vector3();
    const kneePos = new THREE.Vector3();
    const footPos = new THREE.Vector3();
    upperLeg.getWorldPosition(hipPos);
    lowerLeg.getWorldPosition(kneePos);
    foot.getWorldPosition(footPos);

    // Calculate target foot position (ground height)
    const targetY = this.sampleGroundHeight(footPos.x, footPos.z) + this.playerConfig.ikOffset;
    const targetPos = footPos.clone();

    // Clamp foot adjustment to prevent extreme poses
    const deltaY = THREE.MathUtils.clamp(targetY - footPos.y, -0.15, 0.3);
    targetPos.y += deltaY;

    // Calculate bone lengths
    const upperLength = hipPos.distanceTo(kneePos);
    const lowerLength = kneePos.distanceTo(footPos);
    const totalLength = upperLength + lowerLength;

    // Vector from hip to target
    const toTarget = targetPos.clone().sub(hipPos);
    const targetDist = toTarget.length();

    // Clamp target to reachable distance
    const reachDist = Math.min(targetDist, totalLength * 0.99);
    toTarget.normalize().multiplyScalar(reachDist);
    const clampedTarget = hipPos.clone().add(toTarget);

    // Law of cosines for knee angle
    const upperAngle = Math.acos(
      THREE.MathUtils.clamp(
        (upperLength * upperLength + reachDist * reachDist - lowerLength * lowerLength) /
          (2 * upperLength * reachDist),
        -1,
        1,
      ),
    );

    // Calculate rotations
    const targetDir = clampedTarget.clone().sub(hipPos).normalize();
    const currentDir = kneePos.clone().sub(hipPos).normalize();

    // Apply upper leg rotation toward target
    const upperRotQuat = new THREE.Quaternion().setFromUnitVectors(currentDir, targetDir);
    upperLeg.quaternion.premultiply(upperRotQuat);

    // Apply knee bend
    if (lowerLeg.parent) {
      const kneeAxis = new THREE.Vector3(1, 0, 0); // X-axis for knee bend
      lowerLeg.parent.updateMatrixWorld(true);
      const localKneeAxis = kneeAxis
        .clone()
        .applyQuaternion(lowerLeg.parent.quaternion.clone().invert());
      const kneeBendQuat = new THREE.Quaternion().setFromAxisAngle(localKneeAxis, -upperAngle);
      lowerLeg.quaternion.premultiply(kneeBendQuat);
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

  private createTouchControls() {
    const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!isTouch) return null;

    const root = document.createElement('div');
    root.className = 'touch-controls';
    root.innerHTML = [
      '<div class="touch-left">',
      '<div class="touch-stick" data-touch-stick>',
      '<div class="touch-stick-thumb" data-touch-thumb></div>',
      '</div>',
      '</div>',
      '<div class="touch-right">',
      '<button class="touch-btn" data-touch-jump>Jump</button>',
      '<button class="touch-btn" data-touch-sprint>Sprint</button>',
      '<button class="touch-btn" data-touch-crouch>Crouch</button>',
      '<button class="touch-btn" data-touch-attack>Attack</button>',
      '</div>',
      '<div class="touch-look" data-touch-look></div>',
    ].join('');

    const stick = root.querySelector('[data-touch-stick]') as HTMLDivElement;
    const thumb = root.querySelector('[data-touch-thumb]') as HTMLDivElement;
    const lookZone = root.querySelector('[data-touch-look]') as HTMLDivElement;
    const jumpBtn = root.querySelector('[data-touch-jump]') as HTMLButtonElement;
    const sprintBtn = root.querySelector('[data-touch-sprint]') as HTMLButtonElement;
    const crouchBtn = root.querySelector('[data-touch-crouch]') as HTMLButtonElement;
    const attackBtn = root.querySelector('[data-touch-attack]') as HTMLButtonElement;

    const setThumb = (dx: number, dy: number) => {
      thumb.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const handleMoveStart = (event: PointerEvent) => {
      event.preventDefault();
      if (this.touchMoveActive) return;
      this.touchMoveActive = true;
      this.touchMoveId = event.pointerId;
      stick.setPointerCapture(event.pointerId);
      this.touchMoveOrigin.set(event.clientX, event.clientY);
      setThumb(0, 0);
    };

    const handleMove = (event: PointerEvent) => {
      event.preventDefault();
      if (!this.touchMoveActive || event.pointerId !== this.touchMoveId) return;
      const dx = event.clientX - this.touchMoveOrigin.x;
      const dy = event.clientY - this.touchMoveOrigin.y;
      const radius = 50;
      const dist = Math.hypot(dx, dy);
      const scale = dist > radius ? radius / dist : 1;
      const clampedX = dx * scale;
      const clampedY = dy * scale;
      setThumb(clampedX, clampedY);
      this.input.setTouchVector(clampedX / radius, -clampedY / radius);
    };

    const handleMoveEnd = (event: PointerEvent) => {
      event.preventDefault();
      if (event.pointerId !== this.touchMoveId) return;
      this.touchMoveActive = false;
      this.touchMoveId = null;
      this.input.setTouchVector(0, 0);
      setThumb(0, 0);
    };

    const handleLookStart = (event: PointerEvent) => {
      event.preventDefault();
      if (this.touchLookActive) return;
      this.touchLookActive = true;
      this.touchLookId = event.pointerId;
      lookZone.setPointerCapture(event.pointerId);
      this.touchLookOrigin.set(event.clientX, event.clientY);
      this.touchLookDelta.set(0, 0);
    };

    const handleLook = (event: PointerEvent) => {
      event.preventDefault();
      if (!this.touchLookActive || event.pointerId !== this.touchLookId) return;
      const dx = event.clientX - this.touchLookOrigin.x;
      const dy = event.clientY - this.touchLookOrigin.y;
      this.touchLookOrigin.set(event.clientX, event.clientY);
      this.touchLookDelta.set(dx, dy);
      const scale = 0.04;
      this.input.setTouchLook(dx * scale, dy * scale);
    };

    const handleLookEnd = (event: PointerEvent) => {
      event.preventDefault();
      if (event.pointerId !== this.touchLookId) return;
      this.touchLookActive = false;
      this.touchLookId = null;
      this.input.setTouchLook(0, 0);
    };

    stick.addEventListener('pointerdown', handleMoveStart);
    stick.addEventListener('pointermove', handleMove);
    stick.addEventListener('pointerup', handleMoveEnd);
    stick.addEventListener('pointercancel', handleMoveEnd);

    lookZone.addEventListener('pointerdown', handleLookStart);
    lookZone.addEventListener('pointermove', handleLook);
    lookZone.addEventListener('pointerup', handleLookEnd);
    lookZone.addEventListener('pointercancel', handleLookEnd);

    const setFlag = (name: 'jump' | 'sprint' | 'crouch' | 'attack', active: boolean) => {
      this.input.setTouchFlags({ [name]: active });
    };

    const bindButton = (btn: HTMLButtonElement, name: 'jump' | 'sprint' | 'crouch' | 'attack') => {
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        setFlag(name, true);
      });
      const clear = (event: PointerEvent) => {
        event.preventDefault();
        setFlag(name, false);
      };
      btn.addEventListener('pointerup', clear);
      btn.addEventListener('pointerleave', clear);
      btn.addEventListener('pointercancel', clear);
    };

    bindButton(jumpBtn, 'jump');
    bindButton(sprintBtn, 'sprint');
    bindButton(crouchBtn, 'crouch');
    bindButton(attackBtn, 'attack');

    return root;
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
    const state = this.procedural.get(id) ?? {
      bob: 0,
      landKick: 0,
      lookYaw: 0,
      lookPitch: 0,
      springYaw: 0,
      springPitch: 0,
      prevVel: new THREE.Vector3(),
      prevGrounded: true,
    };

    const grounded =
      id === 'local'
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
    const accel = velocity
      .clone()
      .sub(state.prevVel)
      .multiplyScalar(1 / Math.max(delta, 0.001));
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
    const stride = THREE.MathUtils.clamp(speed / (this.playerConfig.moveSpeed ?? MOVE_SPEED), 0, 1);
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
      leftLowerLeg.rotation.x =
        (base.leftLowerLeg?.x ?? leftLowerLeg.rotation.x) + Math.max(0, -swing) * 0.8;
    }
    if (rightLowerLeg) {
      rightLowerLeg.rotation.x =
        (base.rightLowerLeg?.x ?? rightLowerLeg.rotation.x) + Math.max(0, swing) * 0.8;
    }
    if (leftFoot) {
      leftFoot.rotation.x = (base.leftFoot?.x ?? leftFoot.rotation.x) + lift * 0.2;
    }
    if (rightFoot) {
      rightFoot.rotation.x =
        (base.rightFoot?.x ?? rightFoot.rotation.x) + (1 - lift) * 0.2 * stride;
    }
    const armDrop = THREE.MathUtils.lerp(0.6, 0.3, stride);
    const armOut = THREE.MathUtils.lerp(0.38, 0.45, stride);
    const leftBias = THREE.MathUtils.lerp(0.18, 0.08, stride);
    const rightBias = THREE.MathUtils.lerp(0.08, 0.04, stride);
    if (leftUpperArm) {
      leftUpperArm.rotation.x = (base.leftUpperArm?.x ?? leftUpperArm.rotation.x) - swing * 0.6;
      leftUpperArm.rotation.y =
        (base.leftUpperArm?.y ?? leftUpperArm.rotation.y) - armOut - leftBias;
      leftUpperArm.rotation.z = (base.leftUpperArm?.z ?? leftUpperArm.rotation.z) + armDrop;
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.x = (base.rightUpperArm?.x ?? rightUpperArm.rotation.x) + swing * 0.6;
      rightUpperArm.rotation.y =
        (base.rightUpperArm?.y ?? rightUpperArm.rotation.y) + armOut + rightBias;
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
