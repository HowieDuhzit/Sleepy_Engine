import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import { RetroRenderer } from '../rendering/RetroRenderer';
import { RetroPostProcessor } from '../postprocessing/RetroPostProcessor';
import { retroRenderSettings } from '../settings/RetroRenderSettings';
import { retargetMixamoClip } from '../game/retarget';
import {
  RAGDOLL_BONE_DEFS,
  RAGDOLL_JOINT_PROFILE,
  RAGDOLL_SEGMENT_PROFILE,
  getRagdollDriveForBone,
  getRagdollJointForChild,
} from '../game/controllers/ragdoll-profile';
import {
  RAGDOLL_ALL_BODY_GROUPS,
  RAGDOLL_COLLISION_GROUP_ENV,
  computeRagdollSegmentFrame,
  getRagdollBodyGroup,
  resolveRagdollSegmentChildBone,
} from '../game/controllers/ragdoll-core';
import {
  applyModelOriginOffset,
  loadFbxObject,
  loadTexture,
  normalizeModelRootPivot,
} from '../game/model/model-utils';
import {
  createGame,
  deleteGameModel,
  deleteGame,
  getGameAnimation,
  getGameModel,
  getGameModelFileUrl,
  getGameAvatarUrl,
  type GameModelRecord,
  listGameAvatars,
  listGameModels,
  getGameScenes,
  listGames,
  saveGameModel,
  saveGameAnimation,
  uploadGameModelFile,
  uploadGameAvatar,
  saveGameScenes,
} from '../services/game-api';
import type * as RAPIER from '@dimforge/rapier3d-compat';
import {
  buildAnimationClipFromData,
  parseClipPayload,
  type BoneFrame,
  type ClipData,
} from '../game/clip';
import {
  LevelHistory,
  areLevelHistorySnapshotsEqual,
  type LevelHistorySnapshot,
} from './level/history';
import {
  runLevelLogicPreview,
  type LogicPreviewTrigger,
} from './level/logic-preview';
import { ZoneGizmos, type ZoneGizmoDefinition } from './level/zone-gizmos';

const MAX_DURATION = 10;
const SAMPLE_RATE = 30;
const DEFAULT_TIMELINE_FRAMES = 65;
const ROOT_BONE_KEY = 'hips';

type MixamoEntry = {
  name: string;
  clip: THREE.AnimationClip;
  rig: THREE.Object3D;
  source: 'mixamo' | 'generic';
};

type RestPose = {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
};

type Vec3 = { x: number; y: number; z: number };
type LevelObstacle = {
  id?: string;
  x?: number;
  y?: number;
  z?: number;
  width?: number;
  height?: number;
  depth?: number;
};
type LevelZone = {
  id?: string;
  name?: string;
  tag?: string;
  x?: number;
  y?: number;
  z?: number;
  width?: number;
  height?: number;
  depth?: number;
  type?: 'trigger' | 'spawn' | 'damage' | 'safe';
};
type LevelGround = {
  type?: 'concrete';
  width?: number;
  depth?: number;
  y?: number;
  textureRepeat?: number;
  texturePreset?: 'concrete' | 'grass' | 'sand' | 'rock' | 'snow' | 'lava';
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
    preset?: 'cinematic' | 'alpine' | 'dunes' | 'islands';
    size?: number;
    resolution?: number;
    maxHeight?: number;
    roughness?: number;
    seed?: number;
    sculptStamps?: Array<{
      x?: number;
      z?: number;
      radius?: number;
      strength?: number;
      mode?: 'raise' | 'lower' | 'smooth' | 'flatten';
      targetHeight?: number;
    }>;
  };
};
type LevelTerrainConfig = NonNullable<LevelGround['terrain']>;
type LevelWaterConfig = NonNullable<LevelGround['water']>;
type GroundTexturePreset = NonNullable<LevelGround['texturePreset']>;
type LevelRoad = {
  id?: string;
  name?: string;
  width?: number;
  yOffset?: number;
  material?: 'asphalt' | 'dirt' | 'neon';
  points?: Array<{ x?: number; y?: number; z?: number }>;
};
type LevelEnvironment = {
  preset?: 'clear_day' | 'sunset' | 'night' | 'foggy' | 'overcast';
  fogNear?: number;
  fogFar?: number;
  skybox?: {
    enabled?: boolean;
    preset?: 'clear_day' | 'sunset_clouds' | 'midnight_stars' | 'nebula';
    intensity?: number;
  };
};
type LevelSkyboxConfig = NonNullable<LevelEnvironment['skybox']>;
type NormalizedLevelEnvironment = {
  preset: 'clear_day' | 'sunset' | 'night' | 'foggy' | 'overcast';
  fogNear: number;
  fogFar: number;
  skybox: Required<LevelSkyboxConfig>;
};
type NormalizedLevelGround = {
  type: 'concrete';
  width: number;
  depth: number;
  y: number;
  textureRepeat: number;
  texturePreset: GroundTexturePreset;
  water: Required<LevelWaterConfig>;
  terrain?: Required<LevelTerrainConfig>;
};
type NormalizedLevelRoad = {
  id: string;
  name: string;
  width: number;
  yOffset: number;
  material: 'asphalt' | 'dirt' | 'neon';
  points: Array<{ x: number; y: number; z: number }>;
};
type LevelScene = {
  name: string;
  obstacles?: LevelObstacle[];
  zones?: LevelZone[];
  roads?: LevelRoad[];
  environment?: LevelEnvironment;
  components?: Record<string, Record<string, unknown>>;
  logic?: {
    nodes?: Array<Record<string, unknown>>;
    links?: Array<Record<string, unknown>>;
  };
  ground?: LevelGround;
  player?: {
    avatar?: string;
    controller?: 'third_person' | 'first_person' | 'ragdoll' | 'ai_only' | 'hybrid';
    x?: number;
    y?: number;
    z?: number;
    yaw?: number;
  };
  crowd?: {
    enabled?: boolean;
    avatar?: string;
    x?: number;
    y?: number;
    z?: number;
    radius?: number;
  };
};

type EditorModelTextures = {
  baseColor: string;
  normal: string;
  roughness: string;
  metalness: string;
  emissive: string;
};

type EditorModelOriginOffset = {
  x: number;
  y: number;
  z: number;
};

type EditorModelCollider = {
  shape: 'box' | 'sphere' | 'capsule' | 'mesh';
  size: { x: number; y: number; z: number };
  radius: number;
  height: number;
  offset: { x: number; y: number; z: number };
  isTrigger: boolean;
};

type EditorModelPhysics = {
  enabled: boolean;
  bodyType: 'static' | 'dynamic' | 'kinematic';
  mass: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  spawnHeightOffset: number;
  initialVelocity: { x: number; y: number; z: number };
};

type EditorModelRecord = {
  id: string;
  name: string;
  sourceFile: string;
  sourcePath?: string;
  originOffset?: EditorModelOriginOffset;
  collider?: EditorModelCollider;
  physics?: EditorModelPhysics;
  textures: EditorModelTextures;
  materials?: Array<{
    id: string;
    name: string;
    textures: Record<string, string>;
  }>;
  files?: string[];
  createdAt?: string;
  updatedAt?: string;
};

type LevelObjectKind = 'ground' | 'player' | 'crowd' | 'obstacle' | 'zone';
type LevelSceneObjectRef = {
  id: string;
  label: string;
  kind: LevelObjectKind;
  object: THREE.Object3D;
  obstacleId?: string;
  zoneId?: string;
};

type CharacterRole = 'player' | 'npc' | 'boss' | 'neutral';
type ControllerMode = 'third_person' | 'first_person' | 'ragdoll' | 'ai_only' | 'hybrid';

type StateMachineStateDef = {
  id: string;
  clip: string;
  speed: number;
  loop: boolean;
  tags?: string[];
};

type StateMachineTransitionDef = {
  from: string;
  to: string;
  condition: string;
  blendMs: number;
  priority: number;
  interruptible: boolean;
};

type HumanBoneName = Parameters<VRM['humanoid']['getRawBoneNode']>[0];
type TransformControlsInternal = TransformControls & {
  _root?: THREE.Object3D;
  axis?: string | null;
  object?: THREE.Object3D | null;
};
type TransformControlsObject3D = TransformControls & THREE.Object3D;
type RevoluteJointLike = { setLimits?: (min: number, max: number) => void };
type SleepingBodyLike = { isSleeping?: () => boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const parseStateMachineState = (value: unknown): StateMachineStateDef => {
  const state = isRecord(value) ? value : {};
  return {
    id: String(state.id ?? '').trim(),
    clip: String(state.clip ?? '').trim(),
    speed: Number(state.speed ?? 1) || 1,
    loop: Boolean(state.loop ?? true),
    tags: Array.isArray(state.tags) ? state.tags.map((tag) => String(tag)) : [],
  };
};

const parseStateMachineTransition = (value: unknown): StateMachineTransitionDef => {
  const transition = isRecord(value) ? value : {};
  return {
    from: String(transition.from ?? 'any'),
    to: String(transition.to ?? '').trim(),
    condition: String(transition.condition ?? '').trim(),
    blendMs: Math.max(0, Number(transition.blendMs ?? 120) || 120),
    priority: Math.max(0, Number(transition.priority ?? 1) || 1),
    interruptible: Boolean(transition.interruptible ?? true),
  };
};

const transformControlsInternal = (control: TransformControls): TransformControlsInternal =>
  control as TransformControlsInternal;

const setTransformControlsVisible = (control: TransformControls | null, visible: boolean) => {
  if (!control) return;
  (control as TransformControlsObject3D).visible = visible;
};

type PlayerCapsuleConfig = {
  preview: boolean;
  baseRadius: number;
  baseHeight: number;
  skinWidth: number;
  stepHeight: number;
  slopeLimitDeg: number;
};

type PlayerNpcConfig = {
  enabled: boolean;
  archetype: string;
  aggression: number;
  perceptionRange: number;
  fovDeg: number;
  patrolSpeed: number;
  chaseSpeed: number;
  attackRange: number;
  reactionMs: number;
  goals: string[];
};

type CharacterProfile = {
  name: string;
  role: CharacterRole;
  controller: ControllerMode;
  faction: string;
  health: number;
  stamina: number;
  description: string;
  tags: string[];
};

type ControllerModeTuning = {
  moveSpeed?: number;
  sprintMultiplier?: number;
  crouchMultiplier?: number;
  slideAccel?: number;
  slideFriction?: number;
  gravity?: number;
  jumpSpeed?: number;
  walkThreshold?: number;
  runThreshold?: number;
  cameraDistance?: number;
  cameraHeight?: number;
  cameraShoulder?: number;
  cameraShoulderHeight?: number;
  cameraSensitivity?: number;
  cameraSmoothing?: number;
  cameraMinPitch?: number;
  cameraMaxPitch?: number;
  targetSmoothSpeed?: number;
  lockMovement?: boolean;
};

type ControllerModeConfigs = {
  third_person: ControllerModeTuning;
  first_person: ControllerModeTuning;
  ragdoll: ControllerModeTuning;
};

type PlayerConfig = {
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
  controllerModes: ControllerModeConfigs;
  ragdollMuscle: {
    enabled: boolean;
    stiffness: number;
    damping: number;
    maxTorque: number;
  };
  ragdollSim: {
    jointStiffnessScale: number;
    jointDampingScale: number;
    bodyLinearDampingScale: number;
    bodyAngularDampingScale: number;
    groundFriction: number;
    bodyFriction: number;
    maxSubsteps: number;
    substepHz: number;
    limitBlend: number;
    linearBleed: number;
    angularBleed: number;
    groundSlideDamping: number;
    groundSlideYThreshold: number;
    groundSlideDeadzone: number;
    maxLinearVelocity: number;
    maxAngularVelocity: number;
    startImpulseY: number;
  };
  ragdollRig: Record<
    string,
    {
      radiusScale: number;
      lengthScale: number;
      sourceBone?: string;
      childBone?: string;
      offset?: Vec3;
      rot?: Vec3;
      swingLimit?: number;
      twistLimit?: number;
    }
  >;
  profile: CharacterProfile;
  capsule: PlayerCapsuleConfig;
  stateMachine: {
    initial: string;
    states: StateMachineStateDef[];
    transitions: StateMachineTransitionDef[];
  };
  npc: PlayerNpcConfig;
};

const DEFAULT_STATE_MACHINE_STATES: StateMachineStateDef[] = [
  { id: 'idle', clip: 'idle', speed: 1, loop: true, tags: ['base'] },
  { id: 'walk', clip: 'walk', speed: 1, loop: true, tags: ['locomotion'] },
  { id: 'run', clip: 'run', speed: 1, loop: true, tags: ['locomotion'] },
  { id: 'jump', clip: 'jump', speed: 1, loop: false, tags: ['air'] },
];

const DEFAULT_STATE_MACHINE_TRANSITIONS: StateMachineTransitionDef[] = [
  {
    from: 'idle',
    to: 'walk',
    condition: 'speed > 0.15',
    blendMs: 120,
    priority: 1,
    interruptible: true,
  },
  {
    from: 'walk',
    to: 'run',
    condition: 'speed > 3.9',
    blendMs: 90,
    priority: 1,
    interruptible: true,
  },
  {
    from: 'run',
    to: 'walk',
    condition: 'speed <= 3.9',
    blendMs: 100,
    priority: 1,
    interruptible: true,
  },
  {
    from: 'walk',
    to: 'idle',
    condition: 'speed <= 0.15',
    blendMs: 140,
    priority: 1,
    interruptible: true,
  },
  {
    from: 'any',
    to: 'jump',
    condition: 'jumpPressed && grounded',
    blendMs: 70,
    priority: 5,
    interruptible: true,
  },
];

function createDefaultPlayerConfig(): PlayerConfig {
  return {
    avatar: 'default.vrm',
    ikOffset: 0.02,
    capsuleRadiusScale: 1,
    capsuleHeightScale: 1,
    capsuleYOffset: 0,
    moveSpeed: 6,
    sprintMultiplier: 1.6,
    crouchMultiplier: 0.55,
    slideAccel: 10,
    slideFriction: 6,
    gravity: -22,
    jumpSpeed: 8,
    walkThreshold: 0.15,
    runThreshold: 3.9,
    cameraDistance: 6,
    cameraHeight: 1.4,
    cameraShoulder: 1.2,
    cameraShoulderHeight: 0.4,
    cameraSensitivity: 1.0,
    cameraSmoothing: 0,
    cameraMinPitch: 0.2,
    cameraMaxPitch: Math.PI - 0.2,
    targetSmoothSpeed: 15,
    controllerModes: {
      third_person: {},
      first_person: {
        cameraDistance: 0.02,
        cameraHeight: 1.62,
        cameraShoulder: 0,
        cameraShoulderHeight: 0,
        cameraSmoothing: 0.08,
      },
      ragdoll: {
        lockMovement: true,
        moveSpeed: 0,
        jumpSpeed: 0,
      },
    },
    ragdollMuscle: {
      enabled: false,
      stiffness: 70,
      damping: 16,
      maxTorque: 70,
    },
    ragdollSim: {
      jointStiffnessScale: 1,
      jointDampingScale: 1,
      bodyLinearDampingScale: 1,
      bodyAngularDampingScale: 1,
      groundFriction: 2.2,
      bodyFriction: 1.6,
      maxSubsteps: 4,
      substepHz: 90,
      limitBlend: 0.45,
      linearBleed: 0.985,
      angularBleed: 0.88,
      groundSlideDamping: 0.92,
      groundSlideYThreshold: 0.5,
      groundSlideDeadzone: 0.08,
      maxLinearVelocity: 16,
      maxAngularVelocity: 12,
      startImpulseY: -0.35,
    },
    ragdollRig: {},
    profile: {
      name: 'Default Character',
      role: 'player',
      controller: 'third_person',
      faction: 'neutral',
      health: 100,
      stamina: 100,
      description: '',
      tags: ['humanoid'],
    },
    capsule: {
      preview: true,
      baseRadius: 0.35,
      baseHeight: 1.72,
      skinWidth: 0.03,
      stepHeight: 0.35,
      slopeLimitDeg: 50,
    },
    stateMachine: {
      initial: 'idle',
      states: DEFAULT_STATE_MACHINE_STATES.map((state) => ({
        ...state,
        tags: [...(state.tags ?? [])],
      })),
      transitions: DEFAULT_STATE_MACHINE_TRANSITIONS.map((transition) => ({ ...transition })),
    },
    npc: {
      enabled: false,
      archetype: 'grunt',
      aggression: 0.5,
      perceptionRange: 20,
      fovDeg: 120,
      patrolSpeed: 2,
      chaseSpeed: 4,
      attackRange: 1.8,
      reactionMs: 220,
      goals: ['patrol', 'investigate', 'chase'],
    },
  };
}

type RagdollBone = {
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
  parent?: RagdollBone;
  baseLength?: number;
  radius?: number;
  settleTime?: number;
  axis?: THREE.Vector3;
  basePos?: THREE.Vector3;
  baseRot?: THREE.Quaternion;
  boneWorldQuat?: THREE.Quaternion;
};

type RagdollMode = 'off' | 'reactive' | 'ragdoll';

type UndoEntry = {
  clip: ClipData;
  time: number;
};

const UNDO_MAX = 50;
const DISABLED_MOUSE_BUTTON = -1 as unknown as THREE.MOUSE;

export class EditorApp {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private retroRenderer: RetroRenderer | null = null;
  private retroPostProcessor: RetroPostProcessor | null = null;

  // Separate scenes for each tab
  private characterScene: THREE.Scene; // Shared by animation and player tabs
  private levelScene: THREE.Scene;
  private settingsScene: THREE.Scene;

  // Legacy scene reference (points to current active scene)
  private get scene(): THREE.Scene {
    return this.getActiveScene();
  }

  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private viewport: HTMLDivElement | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private viewportObserver: ResizeObserver | null = null;
  // Undo / redo stacks
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  // Clipboard for copy/paste keyframe
  private keyframeClipboard: {
    bones: Record<string, { x: number; y: number; z: number; w: number }>;
    rootPos?: { x: number; y: number; z: number };
  } | null = null;
  // Callbacks wired by createHud
  private updateUndoInfo: (() => void) | null = null;
  private updateBoneList: (() => void) | null = null;
  // Stylus/pointer state tracking
  private pointerPressure = 0;
  private pointerTiltX = 0;
  private pointerTiltY = 0;
  private pointerType: 'mouse' | 'pen' | 'touch' = 'mouse';
  private isBarrelButtonPressed = false;
  // Timeline interaction state
  private timelineScrubbing = false;
  private timelineLongPressTimer: number | null = null;
  private timelineLongPressThreshold = 500; // ms
  private timelineLastFrame = -1;
  private timelineScrubVelocity = 0;
  private timelineScrubLastX = 0;
  private timelineScrubLastTime = 0;
  private timelinePaintMode: 'enable' | 'disable' | null = null;
  private timelinePaintChanged = false;
  private timelineDownFrame = -1;
  private timelineLastDrawnFrame = -1;
  private timelineLastUiUpdateMs = 0;
  private lastAxisDrawMs = 0;
  private lastBoneVisualUpdateMs = 0;
  private lastVrmUpdateMs = 0;
  private lastHipsTargetUpdateMs = 0;
  private renderPixelRatio = 1;
  private disabledFrameCache = new Map<number, BoneFrame>();
  // Multi-touch gesture state
  private activePointers = new Map<number, { x: number; y: number; type: string }>();
  private gestureStartDistance = 0;
  private gestureStartCameraDistance = 0;
  private gestureStartRotation = 0;
  private gestureStartCameraRotation = { yaw: 0, pitch: 0 };
  private isGesturing = false;
  private boneMarkers: Map<string, THREE.Mesh> = new Map();
  private boneMarkerObjects: THREE.Object3D[] = [];
  private boneMarkerWorldPos = new THREE.Vector3();
  private boneScale = 0.08;
  private clipKeyMap: Map<string, THREE.Object3D> = new Map();
  private gltfLoader = new GLTFLoader();
  private fbxLoader = new FBXLoader();
  private clock = new THREE.Clock();
  private animationId: number | null = null;
  private vrm: VRM | null = null;
  private hud: HTMLDivElement;
  private timeline: HTMLCanvasElement | null = null;
  private timelineHeader: HTMLDivElement | null = null;
  private timelineWrap: HTMLDivElement | null = null;
  private axisCanvas: HTMLCanvasElement | null = null;
  private axisDrawInvQuat = new THREE.Quaternion();
  private axisDrawVec = new THREE.Vector3();
  private axisDrawNegVec = new THREE.Vector3();
  private axisBasisX = new THREE.Vector3(1, 0, 0);
  private axisBasisY = new THREE.Vector3(0, 1, 0);
  private axisBasisZ = new THREE.Vector3(0, 0, 1);
  private bones: THREE.Object3D[] = [];
  private boneByName = new Map<string, THREE.Object3D>();
  private boneByKey = new Map<string, THREE.Object3D>();
  private selectedBone: THREE.Object3D | null = null;
  private restPose = new Map<string, RestPose>();
  private time = 0;
  private isPlaying = false;
  private clip: ClipData = { duration: DEFAULT_TIMELINE_FRAMES / SAMPLE_RATE, frames: [] };
  private mixer: THREE.AnimationMixer | null = null;
  private mixamoEntries: MixamoEntry[] = [];
  private currentMixamo: THREE.AnimationAction | null = null;
  private retargetedClip: THREE.AnimationClip | null = null;
  private retargetedName = 'none';
  private fps = SAMPLE_RATE;
  private rapier: typeof import('@dimforge/rapier3d-compat') | null = null;
  private rapierReady: Promise<void> | null = null;
  private ragdollWorld: RAPIER.World | null = null;
  private ragdollBones: Map<string, RagdollBone> = new Map();
  private ragdollMode: RagdollMode = 'off';
  private ragdollEnabled = false;
  private ragdollVisible = false;
  private ragdollRecording = false;
  private ragdollTime = 0;
  private ragdollActivationTime = 0;
  private ragdollNextSample = 0;
  private ragdollControlKeys = new Set<string>();
  private overrideRangeStartFrame = 0;
  private overrideRangeEndFrame = 0;
  private hipsOffset = new THREE.Vector3();
  private clipInterpQuatA = new THREE.Quaternion();
  private clipInterpQuatB = new THREE.Quaternion();
  private clipInterpQuatOut = new THREE.Quaternion();
  private dpr = Math.min(window.devicePixelRatio, 2);
  private skeletonHelper: THREE.SkeletonHelper | null = null;
  private ragdollDebugMeshes: THREE.Object3D[] = [];
  private dragActive = false;
  private boneOverlay: HTMLDivElement | null = null;
  private boneGizmoGroup: THREE.Group | null = null;
  private boneGizmos: Map<
    string,
    { joint: THREE.Mesh; stick: THREE.Mesh; parent?: THREE.Object3D }
  > = new Map();
  private ragdollTransform: TransformControls | null = null;
  private selectedRagdoll: string | null = null;
  private ragdollHandles: THREE.Group | null = null;
  private ragdollHandleActive: 'start' | 'end' | null = null;
  private ragdollHandleRay = new THREE.Ray();
  private ragdollHandleLine = new THREE.Line3();
  private ragdollHandleTemp = new THREE.Vector3();
  private ragdollHandleTemp2 = new THREE.Vector3();
  private levelTransform: TransformControls | null = null;
  private levelObstacleGroup = new THREE.Group();
  private levelRoadGroup = new THREE.Group();
  private levelGroundMesh: THREE.Mesh | null = null;
  private levelWaterMesh: THREE.Mesh | null = null;
  private levelWaterMaterial: THREE.ShaderMaterial | null = null;
  private levelGroundTextureCache = new Map<GroundTexturePreset, THREE.CanvasTexture>();
  private levelSkyTextureCache = new Map<string, THREE.Texture>();
  private levelSkyEnvCache = new Map<string, THREE.Texture>();
  private levelSkyDomeMesh: THREE.Mesh | null = null;
  private levelAmbientLight: THREE.AmbientLight | null = null;
  private levelDirectionalLight: THREE.DirectionalLight | null = null;
  private levelCrowdMarker: THREE.Group | null = null;
  private levelPlayerMarker: THREE.Group | null = null;
  private levelObstacleMeshes = new Map<string, THREE.Mesh>();
  private levelModelInstanceRoots = new Map<string, THREE.Object3D>();
  private levelZoneMeshes = new Map<string, THREE.Mesh>();
  private levelRoadMeshes = new Map<string, THREE.Mesh>();
  private modelLoadCache = new Map<string, Promise<THREE.Object3D>>();
  private zoneGizmos: ZoneGizmos | null = null;
  private selectedLevelObjectId: string | null = null;
  private selectedLevelObjectIds = new Set<string>();
  private levelSceneObjects = new Map<string, LevelSceneObjectRef>();
  private levelSceneListEl: HTMLSelectElement | null = null;
  private levelSceneObstaclesEl: HTMLTextAreaElement | null = null;
  private levelSceneJsonEl: HTMLTextAreaElement | null = null;
  private levelObjectSelectEl: HTMLSelectElement | null = null;
  private levelHierarchyEl: HTMLDivElement | null = null;
  private levelInspectorIdEl: HTMLInputElement | null = null;
  private levelComponentPresetEl: HTMLSelectElement | null = null;
  private levelComponentJsonEl: HTMLTextAreaElement | null = null;
  private levelZoneNameEl: HTMLInputElement | null = null;
  private levelZoneTagEl: HTMLInputElement | null = null;
  private levelZoneTypeEl: HTMLSelectElement | null = null;
  private levelLogicListEl: HTMLDivElement | null = null;
  private levelLogicGraphEl: HTMLDivElement | null = null;
  private levelLogicGraphStatusEl: HTMLDivElement | null = null;
  private levelLogicMinimapEl: HTMLCanvasElement | null = null;
  private levelLogicSelectedNodeIds = new Set<string>();
  private levelLogicDrag:
    | {
        id: string;
        pointerId: number;
        offsetX: number;
        offsetY: number;
        startMouseX: number;
        startMouseY: number;
        selectionStart: Map<string, { x: number; y: number }>;
      }
    | null = null;
  private levelLogicBoxSelect:
    | { pointerId: number; startX: number; startY: number; additive: boolean }
    | null = null;
  private levelLogicLinkDrag:
    | { pointerId: number; fromId: string; x: number; y: number }
    | null = null;
  private levelLogicLinkHoverTargetId: string | null = null;
  private levelLogicClipboard:
    | { nodes: Array<Record<string, unknown>>; links: Array<{ from: string; to: string }> }
    | null = null;
  private levelContextSelectionIdEl: HTMLElement | null = null;
  private levelContextSelectionKindEl: HTMLElement | null = null;
  private levelContextSelectionCountEl: HTMLElement | null = null;
  private levelContextTransformEl: HTMLTextAreaElement | null = null;
  private levelContextHintsEl: HTMLElement | null = null;
  private levelContextActionsEl: HTMLElement | null = null;
  private levelSceneStateRef: { scenes: LevelScene[] } | null = null;
  private captureLevelHistorySnapshot: (() => LevelHistorySnapshot<LevelScene> | null) | null =
    null;
  private applyLevelHistorySnapshot: ((snapshot: LevelHistorySnapshot<LevelScene>) => void) | null =
    null;
  private updateLevelHistoryControls: (() => void) | null = null;
  private levelHistory = new LevelHistory<LevelScene>(100);
  private isApplyingLevelHistory = false;
  private levelTransformDragSnapshot: LevelHistorySnapshot<LevelScene> | null = null;
  private levelCameraMode: 'free' | 'locked' = 'free';
  private levelCameraModeButton: HTMLButtonElement | null = null;
  private setLevelTransformModeHotkey: ((mode: 'translate' | 'rotate' | 'scale') => void) | null =
    null;
  private levelFreeFlyActive = false;
  private levelFreeFlyPointerId: number | null = null;
  private levelFreeFlyLastMouse = { x: 0, y: 0 };
  private levelFreeFlyKeys = new Set<string>();
  private levelFreeFlyVelocity = new THREE.Vector3();
  private levelFreeFlyBaseSpeed = 16;
  private levelBuildTool:
    | 'select'
    | 'drop_box'
    | 'drop_zone'
    | 'drop_ground'
    | 'drop_player'
    | 'drop_crowd'
    | 'drop_road_point'
    | 'sculpt_raise'
    | 'sculpt_lower'
    | 'sculpt_smooth'
    | 'sculpt_flatten' = 'select';
  private levelSculptRadiusValue = 5;
  private levelSculptStrengthValue = 0.35;
  private levelRoadEditName = 'Road 1';
  private levelRoadEditWidth = 3;
  private levelRoadEditMaterial: 'asphalt' | 'dirt' | 'neon' = 'asphalt';
  private levelModelSpawnId = '';
  private playerCapsulePreview: THREE.Group | null = null;
  private playerCapsulePreviewMaterial = new THREE.MeshBasicMaterial({
    color: 0x36d4ff,
    transparent: true,
    opacity: 0.2,
    wireframe: false,
    depthWrite: false,
  });
  private playerCapsuleWireframe = new THREE.MeshBasicMaterial({
    color: 0x8ff6ff,
    wireframe: true,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  });
  private playerCapsuleTemp = new THREE.Vector3();

  // Game management
  private currentGameId: string | null = null;
  private initialGameId: string | null = null;
  private currentTab: 'animation' | 'player' | 'level' | 'model' | 'settings' = 'animation';
  private refreshClipsFunction: (() => Promise<void>) | null = null;
  private refreshScenesFunction: (() => Promise<void>) | null = null;
  private refreshModelsFunction: (() => Promise<void>) | null = null;
  private modelPreviewRoot = new THREE.Group();
  private modelPreviewObject: THREE.Object3D | null = null;
  private refreshPlayerInputsFunction: (() => void) | null = null;
  private refreshPlayerAvatarsFunction: (() => Promise<void>) | null = null;
  private loadGamesListFunction: (() => Promise<void>) | null = null;
  private selectGameFunction: ((gameId: string) => Promise<void>) | null = null;
  private applyTabFunction: ((
    tab: 'animation' | 'player' | 'level' | 'model' | 'settings',
  ) => void) | null =
    null;
  private externalPanelNodes = new Map<string, HTMLDivElement>();
  private onBackToMenu: (() => void) | null = null;

  private closestPointOnLineToRay(line: THREE.Line3, ray: THREE.Ray, target: THREE.Vector3) {
    const p1 = line.start;
    const p2 = line.end;
    const p3 = ray.origin;
    const p4 = this.ragdollHandleTemp2.copy(ray.origin).add(ray.direction);
    const p13 = this.ragdollHandleTemp.copy(p1).sub(p3);
    const p43 = this.ragdollHandleTemp2.copy(p4).sub(p3);
    const p21 = new THREE.Vector3().copy(p2).sub(p1);
    const d1343 = p13.dot(p43);
    const d4321 = p43.dot(p21);
    const d1321 = p13.dot(p21);
    const d4343 = p43.dot(p43);
    const d2121 = p21.dot(p21);
    const denom = d2121 * d4343 - d4321 * d4321;
    let mua = 0;
    if (Math.abs(denom) > 1e-6) {
      mua = (d1343 * d4321 - d1321 * d4343) / denom;
    }
    target.copy(p1).addScaledVector(p21, mua);
    return target;
  }

  /**
   * Get pressure-based manipulation multiplier for stylus input.
   * Light pressure = fine control (0.3x), heavy pressure = coarse control (1.0x)
   */
  private getPressureMultiplier(): number {
    if (this.pointerType !== 'pen' || this.pointerPressure <= 0) {
      return 1.0;
    }
    // Map pressure (0-1) to multiplier (0.3-1.0)
    return 0.3 + this.pointerPressure * 0.7;
  }

  /**
   * Get stylus tilt-based direction vector for additional manipulation axes.
   * Returns normalized direction based on tilt angles.
   */
  private getTiltDirection(): THREE.Vector2 {
    if (this.pointerType !== 'pen') {
      return new THREE.Vector2(0, 0);
    }
    // Tilt angles are in degrees (-90 to 90)
    // Convert to normalized direction vector
    const tiltRadX = (this.pointerTiltX * Math.PI) / 180;
    const tiltRadY = (this.pointerTiltY * Math.PI) / 180;
    return new THREE.Vector2(Math.sin(tiltRadX), Math.sin(tiltRadY)).normalize();
  }

  /**
   * Trigger haptic feedback if available (for stylus/touch devices).
   * Provides tactile confirmation for interactions like bone selection, keyframe placement.
   */
  private triggerHapticFeedback(intensity: 'light' | 'medium' | 'heavy' = 'light') {
    if (!navigator.vibrate) return;

    const duration = {
      light: 10,
      medium: 20,
      heavy: 40,
    }[intensity];

    try {
      navigator.vibrate(duration);
    } catch {
      // Ignore if vibration not supported
    }
  }

  /**
   * Track active pointers for multi-touch gestures.
   */
  private handleGestureStart = (event: PointerEvent) => {
    // Only track touch pointers for gestures
    if (event.pointerType !== 'touch') return;

    this.activePointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
    });

    // Detect gesture start (2+ fingers)
    if (this.activePointers.size >= 2) {
      this.isGesturing = true;

      // Disable OrbitControls during gestures
      if (this.controls) {
        this.controls.enabled = false;
      }

      // Calculate initial gesture state for pinch and rotation
      const pointers = Array.from(this.activePointers.values());
      if (pointers.length >= 2) {
        const first = pointers[0];
        const second = pointers[1];
        if (!first || !second) return;
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        this.gestureStartDistance = Math.sqrt(dx * dx + dy * dy);
        this.gestureStartRotation = Math.atan2(dy, dx);

        if (this.controls) {
          this.gestureStartCameraDistance = this.controls.getDistance();
          // Store camera rotation (spherical coordinates)
          const offset = new THREE.Vector3();
          offset.copy(this.camera.position).sub(this.controls.target);
          const radius = offset.length();
          const theta = Math.atan2(offset.x, offset.z); // yaw
          const phi = Math.acos(Math.max(-1, Math.min(1, offset.y / radius))); // pitch
          this.gestureStartCameraRotation = { yaw: theta, pitch: phi };
        }
      }

      this.triggerHapticFeedback('light');
    }
  };

  /**
   * Handle multi-touch gestures: pinch to zoom, two-finger rotate camera.
   */
  private handleGestureMove = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;

    // Update pointer position
    if (this.activePointers.has(event.pointerId)) {
      this.activePointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
      });
    }

    if (!this.isGesturing || this.activePointers.size < 2) return;

    const pointers = Array.from(this.activePointers.values());

    // Two-finger gestures
    if (pointers.length === 2 && this.controls) {
      const first = pointers[0];
      const second = pointers[1];
      if (!first || !second) return;
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const currentDistance = Math.sqrt(dx * dx + dy * dy);
      const currentRotation = Math.atan2(dy, dx);

      // Pinch to zoom (adjust camera distance)
      if (this.gestureStartDistance > 0) {
        const scale = currentDistance / this.gestureStartDistance;
        const newDistance = this.gestureStartCameraDistance / scale;

        // Clamp to OrbitControls limits
        const clampedDistance = Math.max(
          this.controls.minDistance,
          Math.min(this.controls.maxDistance, newDistance),
        );

        // Apply to camera
        const offset = new THREE.Vector3();
        offset.copy(this.camera.position).sub(this.controls.target);
        offset.setLength(clampedDistance);
        this.camera.position.copy(this.controls.target).add(offset);
      }

      // Two-finger rotation (rotate camera around target)
      const rotationDelta = currentRotation - this.gestureStartRotation;
      if (Math.abs(rotationDelta) > 0.01) {
        const sensitivity = 0.5;
        const newYaw = this.gestureStartCameraRotation.yaw + rotationDelta * sensitivity;

        // Apply rotation
        const radius = this.controls.getDistance();
        const phi = this.gestureStartCameraRotation.pitch;
        const offset = new THREE.Vector3(
          radius * Math.sin(phi) * Math.sin(newYaw),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.cos(newYaw),
        );
        this.camera.position.copy(this.controls.target).add(offset);
        this.camera.lookAt(this.controls.target);
      }
    }

    // Three-finger swipe for undo/redo
    if (pointers.length === 3) {
      // Calculate average horizontal movement
      let totalDx = 0;
      this.activePointers.forEach((pointer, id) => {
        const initial = Array.from(this.activePointers.values())[0];
        if (initial) {
          totalDx += pointer.x - initial.x;
        }
      });
      const avgDx = totalDx / pointers.length;

      // Swipe right = undo, swipe left = redo (threshold: 100px)
      if (Math.abs(avgDx) > 100) {
        if (avgDx > 0) {
          this.triggerHapticFeedback('heavy');
          if (this.currentTab === 'level') this.levelUndo();
          else this.undo();
        } else {
          this.triggerHapticFeedback('heavy');
          if (this.currentTab === 'level') this.levelRedo();
          else this.redo();
        }
        // Reset gesture to prevent repeated triggers
        this.isGesturing = false;
        this.activePointers.clear();
      }
    }
  };

  /**
   * End gesture tracking when pointers are lifted.
   */
  private handleGestureEnd = (event: PointerEvent) => {
    this.activePointers.delete(event.pointerId);

    // Re-enable OrbitControls when no more gestures
    if (this.activePointers.size < 2) {
      this.isGesturing = false;
      if (this.controls) {
        this.controls.enabled = true;
      }
    }

    // Update gesture state if still 2+ fingers
    if (this.activePointers.size >= 2) {
      const pointers = Array.from(this.activePointers.values());
      const first = pointers[0];
      const second = pointers[1];
      if (!first || !second) return;
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      this.gestureStartDistance = Math.sqrt(dx * dx + dy * dy);
      this.gestureStartRotation = Math.atan2(dy, dx);

      if (this.controls) {
        this.gestureStartCameraDistance = this.controls.getDistance();
        const offset = new THREE.Vector3();
        offset.copy(this.camera.position).sub(this.controls.target);
        const radius = offset.length();
        const theta = Math.atan2(offset.x, offset.z);
        const phi = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)));
        this.gestureStartCameraRotation = { yaw: theta, pitch: phi };
      }
    }
  };
  private boneVisualsVisible = true;
  private overrideMode = false;
  public updateLevelVisualization: (obstacles: LevelObstacle[]) => void = () => {};
  private readonly ragdollDefs = RAGDOLL_BONE_DEFS;
  private playerConfig: PlayerConfig = createDefaultPlayerConfig();

  constructor(
    container: HTMLElement | null,
    initialGameId: string | null = null,
    onBackToMenu: (() => void) | null = null,
  ) {
    if (!container) throw new Error('Missing #app container');
    this.container = container;
    this.initialGameId = initialGameId;
    this.onBackToMenu = onBackToMenu;
    this.container.tabIndex = 0;

    this.gltfLoader.register((parser) => new VRMLoaderPlugin(parser));
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderPixelRatio = this.getTargetRenderPixelRatio();
    this.renderer.setPixelRatio(this.renderPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0b0c12, 1);

    // Initialize scenes
    this.characterScene = new THREE.Scene();
    this.characterScene.fog = new THREE.Fog(0x0b0c12, 12, 90);

    this.levelScene = new THREE.Scene();
    this.levelScene.fog = new THREE.Fog(0x0b0c12, 12, 90);

    this.settingsScene = new THREE.Scene();
    this.settingsScene.background = new THREE.Color(0x1a1a1a);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(0, 1.6, -4.2);
    this.camera.lookAt(0, 1.4, 0);

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

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 1.2, 0);
    this.controls.minDistance = 1.4;
    this.controls.maxDistance = 20;
    this.applyBlenderCameraPreset();

    this.ragdollTransform = new TransformControls(this.camera, this.renderer.domElement);
    setTransformControlsVisible(this.ragdollTransform, false);
    this.ragdollTransform.setMode('translate');
    this.ragdollTransform.addEventListener('dragging-changed', (event) => {
      if (this.controls) this.controls.enabled = !event.value;
    });
    const ragdollRoot = transformControlsInternal(this.ragdollTransform)._root;
    if (ragdollRoot) {
      this.characterScene.add(ragdollRoot);
    }

    this.levelTransform = new TransformControls(this.camera, this.renderer.domElement);
    setTransformControlsVisible(this.levelTransform, false);
    this.levelTransform.setMode('translate');
    this.levelTransform.addEventListener('dragging-changed', (event) => {
      if (this.controls) this.controls.enabled = !event.value;
      if (event.value) {
        this.levelTransformDragSnapshot =
          this.currentTab === 'level' ? this.getLevelHistorySnapshot() : null;
      } else if (this.levelTransformDragSnapshot) {
        const before = this.levelTransformDragSnapshot;
        this.levelTransformDragSnapshot = null;
        const after = this.getLevelHistorySnapshot();
        if (after && !areLevelHistorySnapshotsEqual(before, after)) {
          this.pushLevelHistorySnapshot(before);
        }
      }
    });
    this.levelTransform.addEventListener('objectChange', this.handleLevelTransformObjectChange);
    const levelRoot = transformControlsInternal(this.levelTransform)._root;
    if (levelRoot) {
      this.levelScene.add(levelRoot);
    }

    this.hud = this.createHud();
    this.viewport?.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.container.appendChild(this.hud);
    this.resizeRenderer();
    requestAnimationFrame(() => {
      this.resizeTimeline();
      this.drawTimeline();
    });
    this.renderer.domElement.addEventListener('pointerdown', this.handleViewportPick);
    window.addEventListener('pointermove', this.handleLevelFreeFlyPointerMove);
    window.addEventListener('pointerup', this.handleLevelFreeFlyPointerUp);
    document.addEventListener('pointerlockchange', this.handleLevelFreeFlyPointerLockChange);
    this.renderer.domElement.addEventListener('contextmenu', this.handleLevelFreeFlyContextMenu);
    this.renderer.domElement.addEventListener('wheel', this.handleLevelFreeFlyWheel, {
      passive: false,
    });
    window.addEventListener('pointermove', this.handleRagdollDrag);
    window.addEventListener('pointerup', this.handleRagdollDragEnd);
    this.viewport?.addEventListener('dragover', this.handleDragOver);
    this.viewport?.addEventListener('drop', this.handleDrop);
    this.viewport?.addEventListener('dragleave', this.handleDragLeave);

    // Multi-touch gesture support
    this.renderer.domElement.addEventListener('pointerdown', this.handleGestureStart);
    this.renderer.domElement.addEventListener('pointermove', this.handleGestureMove);
    this.renderer.domElement.addEventListener('pointerup', this.handleGestureEnd);
    this.renderer.domElement.addEventListener('pointercancel', this.handleGestureEnd);

    window.addEventListener('resize', this.handleResize);
    window.addEventListener('keydown', this.handleKeyboard);
    window.addEventListener('keydown', this.handleRagdollControlKeyDown);
    window.addEventListener('keydown', this.handleLevelFreeFlyKeyDown);
    window.addEventListener('keyup', this.handleLevelFreeFlyKeyUp);
    window.addEventListener('keyup', this.handleRagdollControlKeyUp);
    window.addEventListener('retro-settings-changed', this.handleRetroRenderSettingsChange);
    if (this.viewport) {
      this.viewportObserver = new ResizeObserver(() => {
        this.resizeRenderer();
        this.resizeTimeline();
        this.drawTimeline();
        this.fitCameraToVrm();
      });
      this.viewportObserver.observe(this.viewport);
    }
    this.createCharacterScene();
    this.createLevelScene();
    this.createSettingsScene();
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
    this.tick();
  }

  public getCurrentTab() {
    return this.currentTab;
  }

  public setTabFromUi(tab: 'animation' | 'player' | 'level' | 'model' | 'settings') {
    this.applyTabFunction?.(tab);
  }

  public getCurrentGameId() {
    return this.currentGameId;
  }

  public async listAvailableGamesFromUi() {
    return await listGames();
  }

  public async selectGameFromUi(gameId: string) {
    if (!gameId) return;
    if (!this.selectGameFunction) return;
    await this.selectGameFunction(gameId);
  }

  public async createGameFromUi(name: string, description = '') {
    const data = await createGame({ name, description });
    this.currentGameId = data.id;
    localStorage.setItem('editorGameId', data.id);
    if (this.loadGamesListFunction) {
      await this.loadGamesListFunction();
    }
    if (this.selectGameFunction) {
      await this.selectGameFunction(data.id);
    } else {
      await this.loadGameAssets();
    }
    return data;
  }

  public async deleteCurrentGameFromUi() {
    const gameId = this.currentGameId;
    if (!gameId) {
      throw new Error('No game selected');
    }
    if (gameId === 'prototype') {
      throw new Error('Cannot delete prototype');
    }
    await deleteGame(gameId);
    if (localStorage.getItem('editorGameId') === gameId) {
      localStorage.removeItem('editorGameId');
    }
    if (this.loadGamesListFunction) {
      await this.loadGamesListFunction();
    }
    return { ok: true, id: gameId };
  }

  public setExternalShellEnabled(enabled: boolean) {
    if (!this.hud) return;
    this.hud.classList.toggle('external-shell', enabled);
    const header = this.hud.querySelector('.editor-header') as HTMLDivElement | null;
    if (header) {
      header.style.display = enabled ? 'none' : '';
    }
    this.resizeRenderer();
    this.resizeTimeline();
  }

  public mountExternalPanel(
    tab: 'animation' | 'player' | 'level' | 'model' | 'settings',
    area: 'left' | 'bottom' | 'right',
    host: HTMLElement,
  ) {
    const key = `${area}:${tab}`;
    const selector =
      area === 'left'
        ? `.editor-left[data-tab-panel="${tab}"]`
        : area === 'right'
          ? `.editor-right[data-tab-panel="${tab}"]`
          : `.editor-bottom[data-tab-panel="${tab}"]`;
    const panel =
      this.externalPanelNodes.get(key) ??
      (this.hud.querySelector(selector) as HTMLDivElement | null);
    if (!panel) return false;
    host.innerHTML = '';
    panel.style.display = area === 'left' || area === 'right' ? 'flex' : '';
    panel.style.visibility = '';
    panel.hidden = false;
    if (area === 'left' || area === 'right') {
      panel.style.flexDirection = 'column';
      panel.style.minHeight = '0';
      panel.style.overflowY = tab === 'player' || tab === 'level' || tab === 'model' ? 'auto' : '';
    }
    if (host instanceof HTMLDivElement) {
      host.style.display = 'block';
      host.style.minWidth = '0';
    }
    host.appendChild(panel);
    requestAnimationFrame(() => {
      this.resizeRenderer();
      if (tab === 'animation') {
        this.resizeTimeline();
        this.updateTimeline();
        this.drawTimeline();
      }
    });
    return true;
  }

  stop() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeyboard);
    window.removeEventListener('keydown', this.handleRagdollControlKeyDown);
    window.removeEventListener('keydown', this.handleLevelFreeFlyKeyDown);
    window.removeEventListener('keyup', this.handleLevelFreeFlyKeyUp);
    window.removeEventListener('keyup', this.handleRagdollControlKeyUp);
    window.removeEventListener('retro-settings-changed', this.handleRetroRenderSettingsChange);
    this.renderer.domElement.removeEventListener('pointerdown', this.handleViewportPick);
    window.removeEventListener('pointermove', this.handleLevelFreeFlyPointerMove);
    window.removeEventListener('pointerup', this.handleLevelFreeFlyPointerUp);
    document.removeEventListener('pointerlockchange', this.handleLevelFreeFlyPointerLockChange);
    this.renderer.domElement.removeEventListener('contextmenu', this.handleLevelFreeFlyContextMenu);
    this.renderer.domElement.removeEventListener('wheel', this.handleLevelFreeFlyWheel);
    window.removeEventListener('pointermove', this.handleRagdollDrag);
    window.removeEventListener('pointerup', this.handleRagdollDragEnd);
    // Remove gesture listeners
    this.renderer.domElement.removeEventListener('pointerdown', this.handleGestureStart);
    this.renderer.domElement.removeEventListener('pointermove', this.handleGestureMove);
    this.renderer.domElement.removeEventListener('pointerup', this.handleGestureEnd);
    this.renderer.domElement.removeEventListener('pointercancel', this.handleGestureEnd);
    if (this.viewportObserver && this.viewport) {
      this.viewportObserver.unobserve(this.viewport);
      this.viewportObserver.disconnect();
      this.viewportObserver = null;
    }
    this.viewport?.removeEventListener('dragover', this.handleDragOver);
    this.viewport?.removeEventListener('drop', this.handleDrop);
    this.viewport?.removeEventListener('dragleave', this.handleDragLeave);
    if (this.playerCapsulePreview) {
      for (const child of this.playerCapsulePreview.children) {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      }
      this.characterScene.remove(this.playerCapsulePreview);
      this.playerCapsulePreview = null;
    }
    this.playerCapsulePreviewMaterial.dispose();
    this.playerCapsuleWireframe.dispose();
    this.zoneGizmos?.dispose();
    this.zoneGizmos = null;
    if (this.levelWaterMesh) {
      this.levelScene.remove(this.levelWaterMesh);
      this.levelWaterMesh.geometry.dispose();
      this.levelWaterMesh = null;
    }
    if (this.levelWaterMaterial) {
      this.levelWaterMaterial.dispose();
      this.levelWaterMaterial = null;
    }
    for (const texture of this.levelGroundTextureCache.values()) texture.dispose();
    this.levelGroundTextureCache.clear();
    if (this.levelSkyDomeMesh) {
      this.levelScene.remove(this.levelSkyDomeMesh);
      this.levelSkyDomeMesh.geometry.dispose();
      if (this.levelSkyDomeMesh.material instanceof THREE.Material) this.levelSkyDomeMesh.material.dispose();
      this.levelSkyDomeMesh = null;
    }
    for (const texture of this.levelSkyTextureCache.values()) texture.dispose();
    this.levelSkyTextureCache.clear();
    for (const env of this.levelSkyEnvCache.values()) env.dispose();
    this.levelSkyEnvCache.clear();
    this.stopLevelFreeFly();
    this.renderer.dispose();
    this.levelTransform?.removeEventListener('objectChange', this.handleLevelTransformObjectChange);
    this.container.innerHTML = '';
  }

  private handleResize = () => {
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.syncRenderPixelRatio();
    this.resizeRenderer();
    this.resizeTimeline();
    this.drawTimeline();
    this.fitCameraToVrm();

    // Update retro resolution
    if (this.retroRenderer) {
      const retroRes = retroRenderSettings.getResolution();
      this.retroRenderer.setResolution(retroRes.width, retroRes.height);
    }

    if (this.retroPostProcessor) {
      const { innerWidth, innerHeight } = window;
      this.retroPostProcessor.setSize(innerWidth, innerHeight);
    }
  };

  private getTargetRenderPixelRatio() {
    const device = Math.min(window.devicePixelRatio, 2);
    const base = Math.min(device, 1.5);
    if (this.currentTab === 'animation' && this.isPlaying) return Math.min(base, 1);
    if (this.currentTab === 'level') return Math.min(base, 1.25);
    return base;
  }

  private syncRenderPixelRatio() {
    const target = this.getTargetRenderPixelRatio();
    if (Math.abs(target - this.renderPixelRatio) < 0.01) return;
    this.renderPixelRatio = target;
    this.renderer.setPixelRatio(target);
    this.resizeRenderer();
  }

  private handleKeyboard = (e: KeyboardEvent) => {
    if (this.currentTab === 'level' && this.handleLevelKeyboardShortcut(e)) {
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (this.currentTab === 'level') this.levelUndo();
      else this.undo();
    } else if (mod && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      if (this.currentTab === 'level') this.levelRedo();
      else this.redo();
    } else if (mod && e.key === 'y') {
      e.preventDefault();
      if (this.currentTab === 'level') this.levelRedo();
      else this.redo();
    } else if (mod && e.key === 'c') {
      e.preventDefault();
      if (this.currentTab === 'level') {
        (this.hud.querySelector('[data-level-logic-node-copy]') as HTMLButtonElement | null)?.click();
      } else {
        this.copyKeyframeAtTime(this.time);
      }
    } else if (mod && e.key === 'v') {
      e.preventDefault();
      if (this.currentTab === 'level') {
        (this.hud.querySelector('[data-level-logic-node-paste]') as HTMLButtonElement | null)?.click();
      } else {
        this.pasteKeyframeAtTime(this.time);
      }
    }
  };

  private isKeyboardEventInEditableField(event: KeyboardEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  private setLevelStatusText(text: string) {
    const levelStatus = this.hud.querySelector('[data-level-status]') as HTMLDivElement | null;
    if (levelStatus) levelStatus.textContent = text;
  }

  private toggleSelectAllLevelObjects() {
    const allIds = Array.from(this.levelSceneObjects.keys());
    if (allIds.length === 0) {
      this.selectLevelObject(null);
      return false;
    }
    const selectedIds = this.getSelectedLevelObjectIds();
    const allSelected =
      selectedIds.length === allIds.length && allIds.every((id) => this.selectedLevelObjectIds.has(id));
    if (allSelected) {
      this.selectLevelObject(null);
      return false;
    }
    const preferredPrimary =
      this.selectedLevelObjectId && allIds.includes(this.selectedLevelObjectId)
        ? this.selectedLevelObjectId
        : (allIds[0] ?? null);
    this.selectLevelObjects(allIds, preferredPrimary);
    return true;
  }

  private handleLevelKeyboardShortcut(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (this.isKeyboardEventInEditableField(event)) return false;
    if (mod) return false;

    if (event.shiftKey && key === 'd') {
      event.preventDefault();
      this.recordLevelEdit(() => {
        const result = this.duplicateSelectedLevelObjects();
        if (!result) return;
        this.setLevelStatusText(
          `Duplicated ${result.total} object(s): ${result.duplicatedObstacles} obstacle(s), ${result.duplicatedZones} zone(s)`,
        );
      });
      return true;
    }

    if (key === 'x' || event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.recordLevelEdit(() => {
        const result = this.deleteSelectedLevelObjects();
        if (!result || result.total === 0) return;
        const removedItems = [
          result.ground > 0 ? 'ground' : '',
          result.player > 0 ? 'player' : '',
          result.crowd > 0 ? 'crowd' : '',
        ]
          .filter(Boolean)
          .join(', ');
        this.setLevelStatusText(
          `Deleted ${result.total} object(s): ${result.obstacles} obstacle(s), ${result.zones} zone(s)${
            removedItems ? `, ${removedItems}` : ''
          }`,
        );
      });
      return true;
    }

    if (key === 'g') {
      event.preventDefault();
      this.setLevelTransformModeHotkey?.('translate');
      return true;
    }
    if (key === 'r') {
      event.preventDefault();
      this.setLevelTransformModeHotkey?.('rotate');
      return true;
    }
    if (key === 's') {
      event.preventDefault();
      this.setLevelTransformModeHotkey?.('scale');
      return true;
    }
    if (key === 'f') {
      event.preventDefault();
      const focused = this.focusSelectedLevelObjects();
      if (focused) {
        const count = this.getSelectedLevelObjectIds().length;
        this.setLevelStatusText(
          `Focused camera on ${count > 1 ? `${count} selected objects` : this.selectedLevelObjectId ?? 'selection'}`,
        );
      }
      return true;
    }
    if (key === 'a') {
      event.preventDefault();
      const selectedAll = this.toggleSelectAllLevelObjects();
      this.setLevelStatusText(selectedAll ? 'Selected all level objects' : 'Cleared selection');
      return true;
    }
    return false;
  }

  private getActiveScene(): THREE.Scene {
    switch (this.currentTab) {
      case 'animation':
      case 'player':
        return this.characterScene;
      case 'level':
        return this.levelScene;
      case 'model':
      case 'settings':
        return this.settingsScene;
      default:
        return this.characterScene;
    }
  }

  private switchToTab(tab: 'animation' | 'player' | 'level' | 'model' | 'settings') {
    this.currentTab = tab;
    this.modelPreviewRoot.visible = tab === 'model';
    if (tab !== 'level') {
      this.stopLevelFreeFly();
    }

    // VRM stays in character scene for both animation and player tabs
    // No need to move it between scenes anymore since they're consolidated

    // Update retro post-processor to use the new scene
    if (this.retroPostProcessor) {
      // We need to recreate the post-processor with the new scene
      this.retroPostProcessor.dispose();
      this.retroPostProcessor = new RetroPostProcessor(
        this.renderer,
        this.getActiveScene(),
        this.camera,
        {
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
        },
      );
    }

    // Adjust camera for different tabs
    if (tab === 'level') {
      this.camera.position.set(0, 5, 10);
      if (this.controls) {
        this.controls.target.set(0, 0, 0);
        this.controls.enablePan = this.levelCameraMode === 'free';
      }
      this.syncLevelCameraTarget();
    } else if (tab === 'settings' || tab === 'model') {
      // Minimal camera setup for settings
      this.camera.position.set(0, 2, 5);
      if (this.controls) {
        this.controls.target.set(0, 1, 0);
        this.controls.enablePan = true;
      }
    } else {
      // Animation and player tabs
      this.camera.position.set(0, 1.6, -4.2);
      if (this.controls) {
        this.controls.target.set(0, 1.2, 0);
        this.controls.enablePan = true;
      }
    }
    this.applyBlenderCameraPreset();
    if (tab !== 'level' && this.levelTransform) {
      this.levelTransform.detach();
      setTransformControlsVisible(this.levelTransform, false);
    }
    if (
      (tab !== 'animation' && tab !== 'player') ||
      (!this.ragdollVisible && !this.ragdollEnabled)
    ) {
      this.detachRagdollTransform();
      if (this.ragdollHandles) this.ragdollHandles.visible = false;
    }
    this.syncPlayerCapsulePreview();
    this.syncRenderPixelRatio();
  }

  private normalizeLevelObstacle(obstacle: LevelObstacle, index: number): Required<LevelObstacle> {
    return {
      id: obstacle.id ?? `obstacle_${index + 1}`,
      x: Number(obstacle.x ?? 0),
      y: Number(obstacle.y ?? 0),
      z: Number(obstacle.z ?? 0),
      width: Math.max(0.1, Number(obstacle.width ?? 1)),
      height: Math.max(0.1, Number(obstacle.height ?? 1)),
      depth: Math.max(0.1, Number(obstacle.depth ?? 1)),
    };
  }

  private normalizeLevelZone(zone: LevelZone, index: number): Required<LevelZone> {
    const rawType = String(zone.type ?? 'trigger').toLowerCase();
    const type: Required<LevelZone>['type'] =
      rawType === 'spawn' || rawType === 'damage' || rawType === 'safe' ? rawType : 'trigger';
    const id = String(zone.id ?? `zone_${index + 1}`).trim() || `zone_${index + 1}`;
    return {
      id,
      name: String(zone.name ?? id).trim() || id,
      tag: String(zone.tag ?? '').trim(),
      x: Number(zone.x ?? 0),
      y: Number(zone.y ?? 1),
      z: Number(zone.z ?? 0),
      width: Math.max(0.5, Number(zone.width ?? 4)),
      height: Math.max(0.5, Number(zone.height ?? 2)),
      depth: Math.max(0.5, Number(zone.depth ?? 4)),
      type,
    };
  }

  private getLevelComponentTemplate(
    preset: 'none' | 'door' | 'pickup' | 'checkpoint' | 'spawner',
    objectId: string,
  ): Record<string, unknown> {
    if (preset === 'door') {
      return {
        type: 'door',
        locked: false,
        openAngle: 90,
        openSeconds: 0.35,
        trigger: 'interact',
        target: objectId,
      };
    }
    if (preset === 'pickup') {
      return {
        type: 'pickup',
        itemId: 'coin',
        amount: 1,
        respawnSeconds: 8,
        trigger: 'touch',
        target: objectId,
      };
    }
    if (preset === 'checkpoint') {
      return {
        type: 'checkpoint',
        saveHealth: true,
        trigger: 'touch',
        target: objectId,
      };
    }
    if (preset === 'spawner') {
      return {
        type: 'spawner',
        archetype: 'enemy_basic',
        count: 3,
        intervalSeconds: 2,
        radius: 4,
        trigger: 'onStart',
        target: objectId,
      };
    }
    return {};
  }

  private getSelectedLevelEntries(): LevelSceneObjectRef[] {
    const selectedIds = this.getSelectedLevelObjectIds();
    if (selectedIds.length === 0) return [];
    return selectedIds
      .map((id) => this.levelSceneObjects.get(id) ?? null)
      .filter((entry): entry is LevelSceneObjectRef => entry !== null);
  }

  private formatLevelVector(vector: THREE.Vector3) {
    return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
  }

  private refreshLevelContextDrawer() {
    if (
      !this.levelContextSelectionIdEl ||
      !this.levelContextSelectionKindEl ||
      !this.levelContextSelectionCountEl ||
      !this.levelContextTransformEl ||
      !this.levelContextHintsEl ||
      !this.levelContextActionsEl
    ) {
      return;
    }

    const entries = this.getSelectedLevelEntries();
    const selectedId =
      entries.length > 1 && this.selectedLevelObjectId
        ? `${this.selectedLevelObjectId} (+${entries.length - 1})`
        : (this.selectedLevelObjectId ?? 'none');
    const kindSummary =
      entries.length === 0 ? 'none' : entries.length === 1 ? (entries[0]?.kind ?? 'unknown') : 'mixed';

    this.levelContextSelectionIdEl.textContent = selectedId;
    this.levelContextSelectionKindEl.textContent = kindSummary;
    this.levelContextSelectionCountEl.textContent = String(entries.length);

    this.levelContextActionsEl.dataset.selectionCount = String(entries.length);
    this.levelContextActionsEl.dataset.selectionKind = kindSummary;
    this.levelContextActionsEl.dataset.selectionId = selectedId;

    if (entries.length === 0) {
      this.levelContextTransformEl.value = 'Position: none\nRotation: none\nScale: none';
      this.levelContextHintsEl.textContent =
        'Select an object in Scene Hierarchy or click one in the viewport to inspect it.';
      return;
    }

    if (entries.length === 1) {
      const entry = entries[0];
      if (!entry) return;
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      const worldScale = new THREE.Vector3();
      const worldEuler = new THREE.Euler();
      entry.object.getWorldPosition(worldPos);
      entry.object.getWorldQuaternion(worldQuat);
      entry.object.getWorldScale(worldScale);
      worldEuler.setFromQuaternion(worldQuat, 'YXZ');
      const rotationDeg = new THREE.Vector3(
        THREE.MathUtils.radToDeg(worldEuler.x),
        THREE.MathUtils.radToDeg(worldEuler.y),
        THREE.MathUtils.radToDeg(worldEuler.z),
      );
      this.levelContextTransformEl.value = [
        `Position: ${this.formatLevelVector(worldPos)}`,
        `Rotation(deg): ${this.formatLevelVector(rotationDeg)}`,
        `Scale: ${this.formatLevelVector(worldScale)}`,
      ].join('\n');
      this.levelContextHintsEl.textContent =
        'Readout updates from transform gizmo changes. Use Focus, Duplicate, or Delete for quick iteration.';
      return;
    }

    const centroid = new THREE.Vector3();
    for (const entry of entries) {
      const point = new THREE.Vector3();
      entry.object.getWorldPosition(point);
      centroid.add(point);
    }
    centroid.multiplyScalar(1 / entries.length);
    this.levelContextTransformEl.value = [
      `Centroid: ${this.formatLevelVector(centroid)}`,
      'Rotation(deg): mixed',
      'Scale: mixed',
    ].join('\n');
    this.levelContextHintsEl.textContent =
      'Multiple objects selected. Transform readout uses centroid position.';
  }

  private refreshLevelInspector() {
    if (
      !this.levelInspectorIdEl ||
      !this.levelComponentJsonEl ||
      !this.levelComponentPresetEl ||
      !this.levelZoneNameEl ||
      !this.levelZoneTagEl ||
      !this.levelZoneTypeEl
    )
      return;
    const selectedId = this.selectedLevelObjectId ?? '';
    this.levelInspectorIdEl.value = selectedId || 'none';
    this.levelComponentPresetEl.value = 'none';
    const scene = this.getCurrentLevelSceneEntry();
    const components = scene?.components ?? {};
    const current = selectedId ? components[selectedId] ?? {} : {};
    this.levelComponentJsonEl.value = JSON.stringify(current, null, 2);
    const selectedZoneId = selectedId.startsWith('zone:') ? selectedId.replace('zone:', '') : '';
    const zoneIndex =
      selectedZoneId && scene
        ? (scene.zones ?? []).findIndex(
            (item, idx) => this.normalizeLevelZone(item ?? {}, idx).id === selectedZoneId,
          )
        : -1;
    if (scene && zoneIndex >= 0) {
      const zone = this.normalizeLevelZone((scene.zones ?? [])[zoneIndex] ?? {}, zoneIndex);
      this.levelZoneNameEl.value = zone.name;
      this.levelZoneTagEl.value = zone.tag;
      this.levelZoneTypeEl.value = zone.type;
      this.levelZoneNameEl.disabled = false;
      this.levelZoneTagEl.disabled = false;
      this.levelZoneTypeEl.disabled = false;
    } else {
      this.levelZoneNameEl.value = '';
      this.levelZoneTagEl.value = '';
      this.levelZoneTypeEl.value = 'trigger';
      this.levelZoneNameEl.disabled = true;
      this.levelZoneTagEl.disabled = true;
      this.levelZoneTypeEl.disabled = true;
    }
    this.refreshLevelContextDrawer();
  }

  private renderLevelLogicList() {
    if (!this.levelLogicListEl) return;
    const scene = this.getCurrentLevelSceneEntry();
    const nodes = Array.isArray(scene?.logic?.nodes) ? scene?.logic?.nodes : [];
    const links = Array.isArray(scene?.logic?.links) ? scene?.logic?.links : [];
    this.levelLogicListEl.innerHTML = '';
    if (!nodes || nodes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'clip-status';
      empty.textContent = 'No logic rules yet.';
      this.levelLogicListEl.appendChild(empty);
      return;
    }
    let shown = 0;
    for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
      const link = links[linkIndex];
      const from = typeof link?.from === 'string' ? link.from : '';
      const to = typeof link?.to === 'string' ? link.to : '';
      const trigger = nodes.find((node) => node && typeof node.id === 'string' && node.id === from);
      const action = nodes.find((node) => node && typeof node.id === 'string' && node.id === to);
      if (!trigger || !action) continue;
      const row = document.createElement('div');
      row.className = 'panel-actions';
      const text = document.createElement('div');
      text.className = 'clip-status';
      text.style.flex = '1';
      text.textContent = `${String(trigger.trigger ?? 'trigger')} -> ${String(action.action ?? 'action')} (${String(action.target ?? 'scene')})`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.dataset.levelLogicRemove = String(linkIndex);
      removeBtn.textContent = 'Remove';
      row.append(text, removeBtn);
      this.levelLogicListEl.appendChild(row);
      shown += 1;
      if (shown >= 12) break;
    }
    if (shown === 0) {
      const empty = document.createElement('div');
      empty.className = 'clip-status';
      empty.textContent = `Nodes: ${nodes.length}, Links: ${links.length}`;
      this.levelLogicListEl.appendChild(empty);
    }
    this.renderLevelLogicGraph();
  }

  private getLevelLogicGraphNodePosition(node: Record<string, unknown>, index: number) {
    const x = Number(node.x ?? 40 + (index % 4) * 180);
    const y = Number(node.y ?? 20 + Math.floor(index / 4) * 110);
    return {
      x: Math.max(8, Math.min(820, x)),
      y: Math.max(8, Math.min(480, y)),
    };
  }

  private getLevelLogicNodeById(
    nodes: Array<Record<string, unknown>>,
    id: string,
  ): Record<string, unknown> | null {
    return nodes.find((node) => String(node.id ?? '') === id) ?? null;
  }

  private canConnectLevelLogicNodes(
    nodes: Array<Record<string, unknown>>,
    links: Array<Record<string, unknown>>,
    fromId: string,
    toId: string,
  ) {
    if (!fromId || !toId) return { ok: false, reason: 'Missing node id.' };
    if (fromId === toId) return { ok: false, reason: 'Cannot connect node to itself.' };
    if (
      links.some(
        (link) =>
          link &&
          typeof link.from === 'string' &&
          typeof link.to === 'string' &&
          link.from === fromId &&
          link.to === toId,
      )
    ) {
      return { ok: false, reason: 'Link already exists.' };
    }
    const from = this.getLevelLogicNodeById(nodes, fromId);
    const to = this.getLevelLogicNodeById(nodes, toId);
    if (!from || !to) return { ok: false, reason: 'Invalid node endpoint.' };
    if (String(from.kind ?? '') === 'action' && String(to.kind ?? '') === 'trigger') {
      return { ok: false, reason: 'Action to trigger links are not allowed.' };
    }
    return { ok: true, reason: '' };
  }

  private renderLevelLogicMinimap(
    nodes: Array<Record<string, unknown>>,
    links: Array<Record<string, unknown>>,
  ) {
    const canvas = this.levelLogicMinimapEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(6, 12, 22, 0.92)';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(132, 168, 226, 0.35)';
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
    if (nodes.length === 0) return;

    const positions = nodes.map((node, index) => this.getLevelLogicGraphNodePosition(node, index));
    const minX = Math.min(...positions.map((p) => p.x));
    const minY = Math.min(...positions.map((p) => p.y));
    const maxX = Math.max(...positions.map((p) => p.x + 160));
    const maxY = Math.max(...positions.map((p) => p.y + 58));
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const pad = 8;
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const toMap = (x: number, y: number) => ({
      x: pad + (x - minX) * scale,
      y: pad + (y - minY) * scale,
    });

    ctx.strokeStyle = 'rgba(133, 174, 246, 0.4)';
    ctx.lineWidth = 1;
    for (const link of links) {
      const fromId = typeof link?.from === 'string' ? link.from : '';
      const toId = typeof link?.to === 'string' ? link.to : '';
      const fromNode = nodes.find((node) => String(node.id ?? '') === fromId);
      const toNode = nodes.find((node) => String(node.id ?? '') === toId);
      if (!fromNode || !toNode) continue;
      const from = toMap(Number(fromNode.x ?? 0) + 80, Number(fromNode.y ?? 0) + 29);
      const to = toMap(Number(toNode.x ?? 0) + 80, Number(toNode.y ?? 0) + 29);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    for (const node of nodes) {
      const id = String(node.id ?? '');
      const kind = String(node.kind ?? 'node');
      const pos = toMap(Number(node.x ?? 0), Number(node.y ?? 0));
      const w = Math.max(3, 160 * scale);
      const h = Math.max(3, 58 * scale);
      const selected = this.levelLogicSelectedNodeIds.has(id);
      ctx.fillStyle =
        kind === 'trigger'
          ? selected
            ? 'rgba(203, 170, 255, 1)'
            : 'rgba(151, 120, 232, 0.9)'
          : selected
            ? 'rgba(147, 255, 232, 1)'
            : 'rgba(85, 202, 173, 0.9)';
      ctx.fillRect(pos.x, pos.y, w, h);
    }
  }

  private renderLevelLogicGraph() {
    if (!this.levelLogicGraphEl) return;
    const scene = this.getCurrentLevelSceneEntry();
    const logic = scene?.logic ?? { nodes: [], links: [] };
    const nodes = (Array.isArray(logic.nodes) ? logic.nodes : []).filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { kind?: unknown }).kind === 'string',
    );
    const links = Array.isArray(logic.links) ? logic.links : [];
    this.levelLogicGraphEl.innerHTML = '';
    const invalidIds: string[] = [];
    for (const selectedId of this.levelLogicSelectedNodeIds) {
      if (!nodes.some((node) => String(node.id) === selectedId)) invalidIds.push(selectedId);
    }
    for (const id of invalidIds) this.levelLogicSelectedNodeIds.delete(id);

    const linkSummary = document.createElement('div');
    linkSummary.className = 'clip-status';
    linkSummary.style.marginBottom = '6px';
    linkSummary.textContent = `Graph: ${nodes.length} node(s), ${links.length} link(s)`;
    this.levelLogicGraphEl.appendChild(linkSummary);

    const board = document.createElement('div');
    board.className = 'level-logic-graph-board';
    this.levelLogicGraphEl.appendChild(board);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'level-logic-links');
    svg.setAttribute('viewBox', '0 0 1000 640');
    board.appendChild(svg);
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'logic-arrow');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '4');
    marker.setAttribute('orient', 'auto-start-reverse');
    const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    markerPath.setAttribute('d', 'M0,0 L8,4 L0,8 z');
    markerPath.setAttribute('fill', '#9ec3ff');
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    svg.appendChild(defs);
    const positionById = new Map<string, { x: number; y: number }>();
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) continue;
      const id = String(node.id ?? '');
      const kind = String(node.kind ?? 'node');
      const label =
        kind === 'trigger'
          ? String(node.trigger ?? 'trigger')
          : kind === 'action'
            ? String(node.action ?? 'action')
            : kind;
      const target = String(node.target ?? 'scene');
      const position = this.getLevelLogicGraphNodePosition(node, index);
      node.x = position.x;
      node.y = position.y;
      positionById.set(id, position);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `level-logic-node ${kind === 'trigger' ? 'trigger' : 'action'}${
        this.levelLogicSelectedNodeIds.has(id) ? ' active' : ''
      }`;
      if (this.levelLogicLinkHoverTargetId && this.levelLogicLinkHoverTargetId === id) {
        card.classList.add('hover-target');
      }
      card.dataset.levelLogicNodeId = id;
      card.style.left = `${position.x}px`;
      card.style.top = `${position.y}px`;
      card.innerHTML =
        '<span class="level-logic-port in"></span>' +
        `<strong>${label}</strong><span>${target}</span>` +
        '<span class="level-logic-port out"></span>';
      board.appendChild(card);
    }
    for (const link of links) {
      const from = typeof link?.from === 'string' ? link.from : '';
      const to = typeof link?.to === 'string' ? link.to : '';
      const fromPos = positionById.get(from);
      const toPos = positionById.get(to);
      if (!fromPos || !toPos) continue;
      const startX = fromPos.x + 160;
      const startY = fromPos.y + 29;
      const endX = toPos.x;
      const endY = toPos.y + 29;
      const dx = Math.max(40, Math.abs(endX - startX) * 0.45);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`,
      );
      path.setAttribute('class', 'logic-link');
      path.setAttribute('marker-end', 'url(#logic-arrow)');
      svg.appendChild(path);
    }
    if (this.levelLogicLinkDrag) {
      const fromPos = positionById.get(this.levelLogicLinkDrag.fromId);
      if (fromPos) {
        const startX = fromPos.x + 160;
        const startY = fromPos.y + 29;
        const endX = this.levelLogicLinkDrag.x;
        const endY = this.levelLogicLinkDrag.y;
        const dx = Math.max(40, Math.abs(endX - startX) * 0.45);
        const connectCheck = this.canConnectLevelLogicNodes(
          nodes,
          links as Array<Record<string, unknown>>,
          this.levelLogicLinkDrag.fromId,
          this.levelLogicLinkHoverTargetId ?? '',
        );
        const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempPath.setAttribute(
          'd',
          `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`,
        );
        tempPath.setAttribute(
          'class',
          `logic-link logic-link-temp${connectCheck.ok ? ' valid' : ' invalid'}`,
        );
        tempPath.setAttribute('marker-end', 'url(#logic-arrow)');
        svg.appendChild(tempPath);
      }
    }

    if (this.levelLogicGraphStatusEl) {
      this.levelLogicGraphStatusEl.textContent =
        this.levelLogicSelectedNodeIds.size > 0
          ? `Selected nodes: ${this.levelLogicSelectedNodeIds.size}`
          : 'Select nodes (Ctrl/Cmd for multi-select). Drag nodes to layout the graph.';
    }
    this.renderLevelLogicMinimap(nodes, links as Array<Record<string, unknown>>);
  }

  private normalizeLevelGround(ground: LevelGround | undefined): NormalizedLevelGround | null {
    if (!ground) return null;
    const terrain = ground.terrain
      ? {
          enabled: ground.terrain.enabled === true,
          preset: (ground.terrain.preset ?? 'cinematic') as
            | 'cinematic'
            | 'alpine'
            | 'dunes'
            | 'islands',
          size: Math.max(16, Number(ground.terrain.size ?? ground.width ?? 120)),
          resolution: Math.max(8, Math.min(128, Number(ground.terrain.resolution ?? 48))),
          maxHeight: Math.max(1, Number(ground.terrain.maxHeight ?? 12)),
          roughness: Math.max(0.2, Math.min(0.95, Number(ground.terrain.roughness ?? 0.56))),
          seed: Math.floor(Number(ground.terrain.seed ?? 1337)),
          sculptStamps: Array.isArray(ground.terrain.sculptStamps)
            ? ground.terrain.sculptStamps
                .map((stamp) => {
                  const modeRaw = String(stamp?.mode ?? 'raise').toLowerCase();
                  const mode: 'raise' | 'lower' | 'smooth' | 'flatten' =
                    modeRaw === 'lower' ||
                    modeRaw === 'smooth' ||
                    modeRaw === 'flatten' ||
                    modeRaw === 'raise'
                      ? modeRaw
                      : 'raise';
                  return {
                    x: Number(stamp?.x ?? 0),
                    z: Number(stamp?.z ?? 0),
                    radius: Math.max(0.5, Number(stamp?.radius ?? 6)),
                    strength: Math.max(0.02, Math.min(2, Number(stamp?.strength ?? 0.35))),
                    mode,
                    targetHeight: Number(stamp?.targetHeight ?? 0),
                  };
                })
                .slice(-512)
            : [],
        }
      : undefined;
    return {
      type: 'concrete',
      width: Math.max(1, Number(ground.width ?? 120)),
      depth: Math.max(1, Number(ground.depth ?? 120)),
      y: Number(ground.y ?? 0),
      textureRepeat: Math.max(1, Number(ground.textureRepeat ?? 12)),
      texturePreset: this.parseGroundTexturePreset(ground.texturePreset),
      water: this.normalizeLevelWater(ground.water),
      terrain,
    };
  }

  private normalizeLevelWater(water: LevelGround['water'] | undefined): Required<LevelWaterConfig> {
    const parseColor = (raw: unknown, fallback: string) => {
      const text = String(raw ?? fallback).trim();
      return /^#([0-9a-f]{6})$/i.test(text) ? text : fallback;
    };
    return {
      enabled: water?.enabled === true,
      level: Number(water?.level ?? 0.08),
      opacity: THREE.MathUtils.clamp(Number(water?.opacity ?? 0.78), 0.1, 1),
      waveAmplitude: THREE.MathUtils.clamp(Number(water?.waveAmplitude ?? 0.22), 0, 3),
      waveFrequency: THREE.MathUtils.clamp(Number(water?.waveFrequency ?? 0.16), 0.01, 2),
      waveSpeed: THREE.MathUtils.clamp(Number(water?.waveSpeed ?? 1.1), 0, 8),
      colorShallow: parseColor(water?.colorShallow, '#2f97d0'),
      colorDeep: parseColor(water?.colorDeep, '#081c47'),
      specularStrength: THREE.MathUtils.clamp(Number(water?.specularStrength ?? 1.35), 0, 4),
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

  private normalizeLevelRoad(road: LevelRoad, index: number): NormalizedLevelRoad {
    const materialRaw = String(road.material ?? 'asphalt').toLowerCase();
    const material: 'asphalt' | 'dirt' | 'neon' =
      materialRaw === 'dirt' || materialRaw === 'neon' || materialRaw === 'asphalt'
        ? materialRaw
        : 'asphalt';
    const points = Array.isArray(road.points)
      ? road.points.map((point) => ({
          x: Number(point?.x ?? 0),
          y: Number(point?.y ?? 0),
          z: Number(point?.z ?? 0),
        }))
      : [];
    return {
      id: String(road.id ?? `road_${index + 1}`).trim() || `road_${index + 1}`,
      name: String(road.name ?? `Road ${index + 1}`).trim() || `Road ${index + 1}`,
      width: Math.max(1, Number(road.width ?? 3)),
      yOffset: Number(road.yOffset ?? 0.08),
      material,
      points,
    };
  }

  private normalizeLevelEnvironment(environment: LevelEnvironment | undefined): NormalizedLevelEnvironment {
    const presetRaw = String(environment?.preset ?? 'clear_day').toLowerCase();
    const preset: NormalizedLevelEnvironment['preset'] =
      presetRaw === 'sunset' ||
      presetRaw === 'night' ||
      presetRaw === 'foggy' ||
      presetRaw === 'overcast' ||
      presetRaw === 'clear_day'
        ? presetRaw
        : 'clear_day';
    const skyboxPresetRaw = String(environment?.skybox?.preset ?? 'clear_day').toLowerCase();
    const skyboxPreset: Required<LevelSkyboxConfig>['preset'] =
      skyboxPresetRaw === 'sunset_clouds' ||
      skyboxPresetRaw === 'midnight_stars' ||
      skyboxPresetRaw === 'nebula' ||
      skyboxPresetRaw === 'clear_day'
        ? skyboxPresetRaw
        : 'clear_day';
    return {
      preset,
      fogNear: Math.max(2, Number(environment?.fogNear ?? 12)),
      fogFar: Math.max(8, Number(environment?.fogFar ?? 140)),
      skybox: {
        enabled: environment?.skybox?.enabled === true,
        preset: skyboxPreset,
        intensity: THREE.MathUtils.clamp(Number(environment?.skybox?.intensity ?? 1), 0.2, 2),
      },
    };
  }

  private applyLevelEnvironmentPreset(environment: NormalizedLevelEnvironment) {
    const fogPalette =
      environment.preset === 'sunset'
        ? { background: 0x2a1f36, fog: 0x3d2a3f, ambient: 0.52, directional: 0.68 }
        : environment.preset === 'night'
          ? { background: 0x070b14, fog: 0x0d1420, ambient: 0.35, directional: 0.45 }
          : environment.preset === 'foggy'
            ? { background: 0x5b6977, fog: 0x7a8795, ambient: 0.7, directional: 0.5 }
            : environment.preset === 'overcast'
              ? { background: 0x505865, fog: 0x656f7d, ambient: 0.62, directional: 0.56 }
              : { background: 0x0b0c12, fog: 0x19212d, ambient: 0.6, directional: 0.8 };
    if (environment.skybox.enabled) {
      const key = `${environment.skybox.preset}:${environment.skybox.intensity.toFixed(2)}`;
      const skyTexture = this.getLevelSkyTexture(environment.skybox.preset, environment.skybox.intensity);
      const skyEnv = this.getLevelSkyEnvironment(key, skyTexture);
      this.ensureLevelSkyDome();
      const material = this.levelSkyDomeMesh?.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.map = skyTexture;
        material.needsUpdate = true;
      }
      if (this.levelSkyDomeMesh) {
        this.levelSkyDomeMesh.visible = true;
        this.levelSkyDomeMesh.position.copy(this.camera.position);
      }
      this.levelScene.background = null;
      this.levelScene.environment = skyEnv;
    } else {
      if (this.levelSkyDomeMesh) this.levelSkyDomeMesh.visible = false;
      this.levelScene.background = new THREE.Color(fogPalette.background);
      this.levelScene.environment = null;
    }
    this.levelScene.fog = new THREE.Fog(fogPalette.fog, environment.fogNear, environment.fogFar);
    if (this.levelAmbientLight) this.levelAmbientLight.intensity = fogPalette.ambient;
    if (this.levelDirectionalLight) this.levelDirectionalLight.intensity = fogPalette.directional;
  }

  private ensureLevelSkyDome() {
    if (this.levelSkyDomeMesh) return;
    const radius = Math.max(40, this.camera.far * 0.9);
    const geometry = new THREE.SphereGeometry(radius, 48, 32);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.levelSkyDomeMesh = new THREE.Mesh(geometry, material);
    this.levelSkyDomeMesh.renderOrder = -1000;
    this.levelScene.add(this.levelSkyDomeMesh);
  }

  private getLevelSkyTexture(
    preset: Required<LevelSkyboxConfig>['preset'],
    intensity: number,
  ) {
    const key = `${preset}:${intensity.toFixed(2)}`;
    const cached = this.levelSkyTextureCache.get(key);
    if (cached) return cached;
    const sky = this.createProceduralSkyTexture(preset, intensity);
    this.levelSkyTextureCache.set(key, sky);
    return sky;
  }

  private getLevelSkyEnvironment(key: string, skyTexture: THREE.Texture) {
    const cached = this.levelSkyEnvCache.get(key);
    if (cached) return cached;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(skyTexture);
    const env = rt.texture;
    this.levelSkyEnvCache.set(key, env);
    rt.dispose();
    pmrem.dispose();
    return env;
  }

  private createProceduralSkyTexture(
    preset: Required<LevelSkyboxConfig>['preset'],
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

  private getLevelGroundTexture(preset: GroundTexturePreset) {
    const cached = this.levelGroundTextureCache.get(preset);
    if (cached) return cached;
    const texture = this.createEditorGroundTexture(preset);
    this.levelGroundTextureCache.set(preset, texture);
    return texture;
  }

  private createEditorGroundTexture(preset: GroundTexturePreset) {
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

  private createEditorWaterMesh(ground: NormalizedLevelGround) {
    const water = ground.water;
    if (!water.enabled) return null;
    const terrain = ground.terrain?.enabled ? ground.terrain : null;
    const width = terrain ? Math.max(16, Number(terrain.size ?? ground.width)) : ground.width;
    const depth = terrain ? Math.max(16, Number(terrain.size ?? ground.depth)) : ground.depth;
    const segments = terrain
      ? Math.max(48, Math.min(240, Math.floor(Number(terrain.resolution ?? 64) * 2)))
      : 80;
    const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
    geometry.rotateX(-Math.PI / 2);
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
        uColorShallow: { value: new THREE.Color(water.colorShallow) },
        uColorDeep: { value: new THREE.Color(water.colorDeep) },
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
    this.levelWaterMaterial = material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = ground.y + water.level + 0.02;
    mesh.renderOrder = 20;
    mesh.userData.levelObjectId = 'ground';
    return mesh;
  }

  private getCurrentLevelSceneEntry() {
    const sceneState = this.levelSceneStateRef;
    const sceneList = this.levelSceneListEl;
    if (!sceneState || !sceneList) return null;
    return sceneState.scenes.find((scene) => scene.name === sceneList.value) ?? null;
  }

  private getLevelHistorySnapshot() {
    return this.captureLevelHistorySnapshot?.() ?? null;
  }

  private pushLevelHistorySnapshot(snapshot?: LevelHistorySnapshot<LevelScene> | null) {
    if (this.isApplyingLevelHistory) return;
    const entry = snapshot ?? this.getLevelHistorySnapshot();
    if (!entry) return;
    if (!this.levelHistory.push(entry)) return;
    this.updateLevelHistoryControls?.();
  }

  private recordLevelEdit(edit: () => void) {
    if (this.isApplyingLevelHistory) {
      edit();
      return;
    }
    const before = this.getLevelHistorySnapshot();
    edit();
    const after = this.getLevelHistorySnapshot();
    if (!before || !after) return;
    if (areLevelHistorySnapshotsEqual(before, after)) return;
    this.pushLevelHistorySnapshot(before);
  }

  private levelUndo() {
    const current = this.getLevelHistorySnapshot();
    if (!current) return;
    const previous = this.levelHistory.undo(current);
    if (!previous) return;
    if (!this.applyLevelHistorySnapshot) return;
    this.isApplyingLevelHistory = true;
    try {
      this.applyLevelHistorySnapshot(previous);
    } finally {
      this.isApplyingLevelHistory = false;
    }
    this.updateLevelHistoryControls?.();
  }

  private levelRedo() {
    const current = this.getLevelHistorySnapshot();
    if (!current) return;
    const next = this.levelHistory.redo(current);
    if (!next) return;
    if (!this.applyLevelHistorySnapshot) return;
    this.isApplyingLevelHistory = true;
    try {
      this.applyLevelHistorySnapshot(next);
    } finally {
      this.isApplyingLevelHistory = false;
    }
    this.updateLevelHistoryControls?.();
  }

  private syncLevelTextEditors() {
    const scene = this.getCurrentLevelSceneEntry();
    if (!scene || !this.levelSceneObstaclesEl || !this.levelSceneJsonEl || !this.levelSceneStateRef)
      return;
    this.levelSceneObstaclesEl.value = JSON.stringify(scene.obstacles ?? [], null, 2);
    this.levelSceneJsonEl.value = JSON.stringify(this.levelSceneStateRef, null, 2);
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
    preset: 'cinematic' | 'alpine' | 'dunes' | 'islands';
    size: number;
    maxHeight: number;
    roughness: number;
    seed: number;
    sculptStamps?: Array<{
      x?: number;
      z?: number;
      radius?: number;
      strength?: number;
      mode?: 'raise' | 'lower' | 'smooth' | 'flatten';
      targetHeight?: number;
    }>;
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
    let height = Math.max(0, elevation * maxHeight);
    for (const stamp of options.sculptStamps ?? []) {
      const sx = Number(stamp.x ?? 0);
      const sz = Number(stamp.z ?? 0);
      const radius = Math.max(0.0001, Number(stamp.radius ?? 6));
      const strengthBase = Math.max(0.02, Math.min(2, Number(stamp.strength ?? 0.35)));
      const mode = String(stamp.mode ?? 'raise').toLowerCase();
      const dx = options.x - sx;
      const dz = options.z - sz;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance > radius) continue;
      const t = 1 - distance / radius;
      const falloff = t * t * (3 - 2 * t);
      const strength = strengthBase * falloff;
      if (mode === 'raise') {
        height += strength * maxHeight * 0.15;
      } else if (mode === 'lower') {
        height -= strength * maxHeight * 0.15;
      } else if (mode === 'flatten') {
        const target = Number(stamp.targetHeight ?? 0);
        height += (target - height) * Math.min(1, strength);
      } else {
        // smooth: blend toward base procedural value
        const base = Math.max(0, elevation * maxHeight);
        height += (base - height) * Math.min(1, strength);
      }
    }
    return Math.max(0, height);
  }

  private refreshLevelObjectSelect() {
    if (!this.levelObjectSelectEl) return;
    this.levelObjectSelectEl.innerHTML = '';
    const entries = Array.from(this.levelSceneObjects.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    const validIds = new Set(entries.map((entry) => entry.id));
    const nextSelectedIds = new Set<string>();
    for (const id of this.selectedLevelObjectIds) {
      if (validIds.has(id)) nextSelectedIds.add(id);
    }
    this.selectedLevelObjectIds = nextSelectedIds;
    if (this.selectedLevelObjectId && !validIds.has(this.selectedLevelObjectId)) {
      this.selectedLevelObjectId = null;
    }
    if (!this.selectedLevelObjectId && this.selectedLevelObjectIds.size > 0) {
      this.selectedLevelObjectId = this.selectedLevelObjectIds.values().next().value ?? null;
    }
    for (const item of entries) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label;
      this.levelObjectSelectEl.appendChild(option);
    }
    if (this.selectedLevelObjectId && this.levelSceneObjects.has(this.selectedLevelObjectId)) {
      this.levelObjectSelectEl.value = this.selectedLevelObjectId;
    } else if (entries.length > 0) {
      const firstEntry = entries[0];
      if (firstEntry) {
        this.levelObjectSelectEl.value = firstEntry.id;
        this.selectLevelObject(firstEntry.id);
      }
    } else {
      this.selectLevelObject(null);
    }
    if (this.levelHierarchyEl) {
      this.levelHierarchyEl.innerHTML = '';
      for (const entry of entries) {
        const button = document.createElement('button');
        button.className = `bone-list-item${entry.id === this.selectedLevelObjectId ? ' active' : ''}`;
        button.type = 'button';
        button.dataset.levelObjectId = entry.id;
        button.textContent = entry.label;
        button.addEventListener('click', (event) => {
          this.selectLevelObject(entry.id, { toggle: event.ctrlKey || event.metaKey });
        });
        this.levelHierarchyEl.appendChild(button);
      }
    }
    if (this.selectedLevelObjectId && this.levelSceneObjects.has(this.selectedLevelObjectId)) {
      this.selectLevelObject(this.selectedLevelObjectId);
    }
  }

  private getSelectedLevelObjectIds() {
    if (this.selectedLevelObjectIds.size === 0 && this.selectedLevelObjectId) {
      return [this.selectedLevelObjectId];
    }
    const selectedIds = Array.from(this.selectedLevelObjectIds).filter((id) =>
      this.levelSceneObjects.has(id),
    );
    if (
      selectedIds.length === 0 &&
      this.selectedLevelObjectId &&
      this.levelSceneObjects.has(this.selectedLevelObjectId)
    ) {
      return [this.selectedLevelObjectId];
    }
    return selectedIds;
  }

  private selectLevelObjects(objectIds: string[], primaryId: string | null = null) {
    const nextSelectedIds = new Set<string>();
    for (const id of objectIds) {
      if (this.levelSceneObjects.has(id)) nextSelectedIds.add(id);
    }
    const nextPrimary =
      primaryId && nextSelectedIds.has(primaryId)
        ? primaryId
        : (nextSelectedIds.values().next().value ?? null);
    this.selectedLevelObjectIds = nextSelectedIds;
    this.selectLevelObject(nextPrimary);
  }

  private syncLevelCameraTarget() {
    if (!this.controls) return;
    if (this.currentTab !== 'level') return;
    if (this.levelCameraMode !== 'locked') return;
    const entry = this.selectedLevelObjectId
      ? (this.levelSceneObjects.get(this.selectedLevelObjectId) ?? null)
      : null;
    if (!entry) return;
    entry.object.getWorldPosition(this.controls.target);
  }

  private getLevelPlacementPoint() {
    if (this.controls) return this.controls.target.clone();
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    return this.camera.position.clone().add(forward.multiplyScalar(8));
  }

  private getLevelBuildToolStatusText() {
    if (this.levelBuildTool === 'select') return 'Tool: select / transform';
    if (this.levelBuildTool === 'drop_box')
      return 'Tool: object dropper (box) - click surfaces to place';
    if (this.levelBuildTool === 'drop_zone')
      return 'Tool: object dropper (zone) - click surfaces to place';
    if (this.levelBuildTool === 'drop_ground')
      return 'Tool: object dropper (ground) - click surfaces to place';
    if (this.levelBuildTool === 'drop_player')
      return 'Tool: object dropper (player) - click surfaces to place';
    if (this.levelBuildTool === 'drop_crowd')
      return 'Tool: object dropper (crowd) - click surfaces to place';
    if (this.levelBuildTool === 'drop_road_point')
      return 'Tool: road spline point - click surfaces to append control points';
    if (this.levelBuildTool === 'sculpt_raise')
      return 'Tool: terrain sculpt raise - click terrain to lift';
    if (this.levelBuildTool === 'sculpt_lower')
      return 'Tool: terrain sculpt lower - click terrain to carve';
    if (this.levelBuildTool === 'sculpt_smooth')
      return 'Tool: terrain sculpt smooth - click terrain to soften';
    return 'Tool: terrain sculpt flatten - click terrain to level to clicked height';
  }

  private setLevelCameraMode(mode: 'free' | 'locked') {
    this.levelCameraMode = mode;
    if (mode !== 'free') {
      this.stopLevelFreeFly();
    }
    if (this.controls) {
      this.controls.enablePan = mode === 'free';
    }
    if (this.levelCameraModeButton) {
      const label = mode === 'free' ? 'Camera: Free Fly' : 'Camera: Object Locked';
      this.levelCameraModeButton.textContent = label;
      this.levelCameraModeButton.dataset.mode = mode;
      this.levelCameraModeButton.title =
        mode === 'free'
          ? 'Free-fly camera: Hold Right Mouse + WASD/QE, wheel to change speed'
          : 'Object-locked camera: orbits selected object';
    }
    this.applyBlenderCameraPreset();
    this.syncLevelCameraTarget();
  }

  private applyBlenderCameraPreset() {
    if (!this.controls) return;
    if (this.currentTab === 'level') {
      this.controls.mouseButtons = {
        LEFT: DISABLED_MOUSE_BUTTON,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: DISABLED_MOUSE_BUTTON,
      };
      this.controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      };
      return;
    }
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
  }

  private canUseLevelFreeFly() {
    return this.currentTab === 'level' && this.levelCameraMode === 'free';
  }

  private startLevelFreeFly(event: PointerEvent) {
    if (!this.canUseLevelFreeFly()) return;
    if (event.button !== 2) return;
    this.levelFreeFlyActive = true;
    this.levelFreeFlyPointerId = event.pointerId;
    this.levelFreeFlyLastMouse = { x: event.clientX, y: event.clientY };
    const lockTarget = this.renderer.domElement;
    if (document.pointerLockElement !== lockTarget) {
      lockTarget.requestPointerLock?.();
    }
    if (this.controls) this.controls.enabled = false;
    this.renderer.domElement.style.cursor = 'grabbing';
  }

  private stopLevelFreeFly() {
    if (!this.levelFreeFlyActive) return;
    this.levelFreeFlyActive = false;
    this.levelFreeFlyPointerId = null;
    this.levelFreeFlyKeys.clear();
    this.levelFreeFlyVelocity.set(0, 0, 0);
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock?.();
    }
    if (this.controls) this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
  }

  private handleLevelFreeFlyPointerLockChange = () => {
    if (document.pointerLockElement === this.renderer.domElement) {
      this.levelFreeFlyActive = true;
      if (this.controls) this.controls.enabled = false;
      this.renderer.domElement.style.cursor = 'grabbing';
      return;
    }
    if (!this.levelFreeFlyActive) return;
    this.levelFreeFlyActive = false;
    this.levelFreeFlyPointerId = null;
    this.levelFreeFlyKeys.clear();
    this.levelFreeFlyVelocity.set(0, 0, 0);
    if (this.controls) this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
  };

  private handleLevelFreeFlyPointerMove = (event: PointerEvent) => {
    if (!this.levelFreeFlyActive || !this.canUseLevelFreeFly()) return;
    const pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (!pointerLocked && this.levelFreeFlyPointerId !== null && event.pointerId !== this.levelFreeFlyPointerId)
      return;
    const dx = pointerLocked ? event.movementX : event.clientX - this.levelFreeFlyLastMouse.x;
    const dy = pointerLocked ? event.movementY : event.clientY - this.levelFreeFlyLastMouse.y;
    this.levelFreeFlyLastMouse = { x: event.clientX, y: event.clientY };
    const lookSpeed = 0.0022;
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    euler.y -= dx * lookSpeed;
    euler.x -= dy * lookSpeed;
    euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.x));
    this.camera.quaternion.setFromEuler(euler);
  };

  private handleLevelFreeFlyPointerUp = (event: PointerEvent) => {
    if (!this.levelFreeFlyActive) return;
    if (event.button !== 2 && document.pointerLockElement === this.renderer.domElement) return;
    if (this.levelFreeFlyPointerId === null || event.pointerId === this.levelFreeFlyPointerId) {
      this.stopLevelFreeFly();
    }
  };

  private handleLevelFreeFlyKeyDown = (event: KeyboardEvent) => {
    if (!this.levelFreeFlyActive || !this.canUseLevelFreeFly()) return;
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', ' ', 'shift', 'control'].includes(key)) {
      this.levelFreeFlyKeys.add(key);
      event.preventDefault();
    }
  };

  private handleLevelFreeFlyKeyUp = (event: KeyboardEvent) => {
    if (!this.levelFreeFlyActive) return;
    const key = event.key.toLowerCase();
    if (this.levelFreeFlyKeys.has(key)) {
      this.levelFreeFlyKeys.delete(key);
      event.preventDefault();
    }
  };

  private handleRagdollControlKeyDown = (event: KeyboardEvent) => {
    if (this.currentTab !== 'animation' || !this.ragdollEnabled) return;
    if (this.isKeyboardEventInEditableField(event)) return;
    const key = event.key.toLowerCase();
    if (!['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key))
      return;
    this.ragdollControlKeys.add(key);
    event.preventDefault();
  };

  private handleRagdollControlKeyUp = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (!this.ragdollControlKeys.has(key)) return;
    this.ragdollControlKeys.delete(key);
  };

  private handleLevelFreeFlyContextMenu = (event: MouseEvent) => {
    if (this.currentTab === 'level' && this.levelCameraMode === 'free') {
      event.preventDefault();
    }
  };

  private handleLevelFreeFlyWheel = (event: WheelEvent) => {
    if (!this.levelFreeFlyActive || !this.canUseLevelFreeFly()) return;
    const delta = event.deltaY > 0 ? -1 : 1;
    this.levelFreeFlyBaseSpeed = THREE.MathUtils.clamp(
      this.levelFreeFlyBaseSpeed + delta * 1.5,
      4,
      72,
    );
    event.preventDefault();
  };

  private rebuildLevelSceneObjects() {
    this.levelSceneObjects.clear();
    if (this.levelGroundMesh) {
      this.levelSceneObjects.set('ground', {
        id: 'ground',
        label: 'Ground',
        kind: 'ground',
        object: this.levelGroundMesh,
      });
    }
    if (this.levelPlayerMarker) {
      this.levelSceneObjects.set('player', {
        id: 'player',
        label: 'Player Spawn',
        kind: 'player',
        object: this.levelPlayerMarker,
      });
    }
    if (this.levelCrowdMarker) {
      this.levelSceneObjects.set('crowd', {
        id: 'crowd',
        label: 'Crowd Spawn',
        kind: 'crowd',
        object: this.levelCrowdMarker,
      });
    }
    for (const [obstacleId, mesh] of this.levelObstacleMeshes) {
      const modelRoot = this.levelModelInstanceRoots.get(obstacleId) ?? null;
      const id = `obstacle:${obstacleId}`;
      this.levelSceneObjects.set(id, {
        id,
        label: modelRoot ? `Model: ${obstacleId}` : `Obstacle: ${obstacleId}`,
        kind: 'obstacle',
        object: modelRoot ?? mesh,
        obstacleId,
      });
    }
    for (const [zoneId, mesh] of this.levelZoneMeshes) {
      const id = `zone:${zoneId}`;
      this.levelSceneObjects.set(id, {
        id,
        label: `Zone: ${zoneId}`,
        kind: 'zone',
        object: mesh,
        zoneId,
      });
    }
  }

  private updateLevelVisualizationFromState(obstacles: LevelObstacle[]) {
    const scene = this.getCurrentLevelSceneEntry();
    const environment = this.normalizeLevelEnvironment(scene?.environment);
    this.applyLevelEnvironmentPreset(environment);
    const ground = this.normalizeLevelGround(scene?.ground);
    if (this.levelGroundMesh) {
      this.levelScene.remove(this.levelGroundMesh);
      this.levelGroundMesh.geometry.dispose();
      if (this.levelGroundMesh.material instanceof THREE.Material)
        this.levelGroundMesh.material.dispose();
      this.levelGroundMesh = null;
    }
    if (this.levelWaterMesh) {
      this.levelScene.remove(this.levelWaterMesh);
      this.levelWaterMesh.geometry.dispose();
      this.levelWaterMesh = null;
    }
    if (this.levelWaterMaterial) {
      this.levelWaterMaterial.dispose();
      this.levelWaterMaterial = null;
    }
    if (ground) {
      const groundTexture = this.getLevelGroundTexture(ground.texturePreset);
      groundTexture.repeat.set(ground.textureRepeat, ground.textureRepeat);
      const terrain = ground.terrain?.enabled ? ground.terrain : null;
      const terrainSize = terrain ? Math.max(16, Number(terrain.size ?? ground.width)) : ground.width;
      const terrainDepth = terrain ? Math.max(16, Number(terrain.size ?? ground.depth)) : ground.depth;
      const terrainResolution = terrain
        ? Math.max(8, Math.min(128, Math.floor(Number(terrain.resolution ?? 48))))
        : 1;
      const groundGeometry = new THREE.PlaneGeometry(
        terrainSize,
        terrainDepth,
        terrainResolution,
        terrainResolution,
      );
      groundGeometry.rotateX(-Math.PI / 2);
      if (terrain) {
        const position = groundGeometry.getAttribute('position');
        if (position instanceof THREE.BufferAttribute) {
          for (let i = 0; i < position.count; i += 1) {
            const x = position.getX(i);
            const z = position.getZ(i);
            const h = this.sampleTerrainHeight({
              preset: terrain.preset ?? 'cinematic',
              size: terrain.size ?? Math.max(terrainSize, terrainDepth),
              maxHeight: terrain.maxHeight ?? 12,
              roughness: terrain.roughness ?? 0.56,
              seed: Math.floor(terrain.seed ?? 1337),
              sculptStamps: terrain.sculptStamps ?? [],
              x,
              z,
            });
            position.setY(i, h);
          }
          position.needsUpdate = true;
        }
        groundGeometry.computeVertexNormals();
      }
      this.levelGroundMesh = new THREE.Mesh(
        groundGeometry,
        new THREE.MeshStandardMaterial({
          map: groundTexture,
          flatShading: terrain !== null,
          roughness: 0.95,
          metalness: 0.05,
          color: 0xffffff,
        }),
      );
      this.levelGroundMesh.position.y = ground.y;
      this.levelGroundMesh.userData.levelObjectId = 'ground';
      this.levelScene.add(this.levelGroundMesh);
      this.levelWaterMesh = this.createEditorWaterMesh(ground);
      if (this.levelWaterMesh) {
        this.levelScene.add(this.levelWaterMesh);
      }
    }

    if (this.levelPlayerMarker) {
      this.levelScene.remove(this.levelPlayerMarker);
      this.levelPlayerMarker = null;
    }
    if (scene?.player) {
      const player = scene.player;
      const playerMarker = new THREE.Group();
      playerMarker.userData.levelObjectId = 'player';
      const playerBody = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 1.8, 16),
        new THREE.MeshStandardMaterial({
          color: 0x3b82f6,
          emissive: 0x0b2a5f,
          emissiveIntensity: 0.3,
        }),
      );
      playerBody.position.y = 0.9;
      playerBody.userData.levelObjectId = 'player';
      const playerArrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.35, 0.55, 12),
        new THREE.MeshStandardMaterial({
          color: 0x60a5fa,
          emissive: 0x1d4ed8,
          emissiveIntensity: 0.25,
        }),
      );
      playerArrow.position.set(0, 1.7, 0.85);
      playerArrow.rotation.x = Math.PI / 2;
      playerArrow.userData.levelObjectId = 'player';
      playerMarker.add(playerBody, playerArrow);
      playerMarker.position.set(
        Number(player.x ?? 0),
        Number(player.y ?? ground?.y ?? 0),
        Number(player.z ?? 0),
      );
      playerMarker.rotation.y = Number(player.yaw ?? 0);
      this.levelPlayerMarker = playerMarker;
      this.levelScene.add(playerMarker);
    }

    const crowdEnabled = scene?.crowd?.enabled === true;
    if (this.levelCrowdMarker) {
      this.levelScene.remove(this.levelCrowdMarker);
      this.levelCrowdMarker = null;
    }
    if (crowdEnabled) {
      const marker = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(12, 0.12, 8, 48),
        new THREE.MeshStandardMaterial({
          color: 0xf59e0b,
          emissive: 0x4a2a08,
          emissiveIntensity: 0.5,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.05;
      ring.userData.levelObjectId = 'crowd';
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.25, 0.25, 2.5, 12),
        new THREE.MeshStandardMaterial({
          color: 0xfbbf24,
          emissive: 0x4a2a08,
          emissiveIntensity: 0.35,
        }),
      );
      pillar.position.set(0, 1.25, 0);
      pillar.userData.levelObjectId = 'crowd';
      marker.add(ring, pillar);
      marker.userData.levelObjectId = 'crowd';
      const crowd = scene?.crowd ?? {};
      marker.position.set(
        Number(crowd.x ?? 0),
        Number(crowd.y ?? ground?.y ?? 0),
        Number(crowd.z ?? 0),
      );
      const crowdRadius = Math.max(1, Number(crowd.radius ?? 12));
      marker.scale.set(crowdRadius / 12, 1, crowdRadius / 12);
      this.levelCrowdMarker = marker;
      this.levelScene.add(marker);
    }

    this.levelObstacleMeshes.clear();
    this.levelModelInstanceRoots.clear();
    this.levelObstacleGroup.clear();
    this.levelZoneMeshes.clear();
    this.levelRoadMeshes.clear();
    this.levelRoadGroup.clear();

    for (let i = 0; i < obstacles.length; i += 1) {
      const obstacle = this.normalizeLevelObstacle(obstacles[i] ?? {}, i);
      if (!obstacles[i]?.id) obstacles[i] = obstacle;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.8 }),
      );
      mesh.position.set(obstacle.x, obstacle.y + obstacle.height / 2, obstacle.z);
      mesh.scale.set(obstacle.width, obstacle.height, obstacle.depth);
      mesh.userData.levelObjectId = `obstacle:${obstacle.id}`;
      this.levelObstacleGroup.add(mesh);
      this.levelObstacleMeshes.set(obstacle.id, mesh);
      const modelComponent = scene?.components?.[`obstacle:${obstacle.id}`];
      if (this.currentGameId) {
        void this.attachLevelModelInstance(this.currentGameId, obstacle, modelComponent);
      }
    }
    const zones = scene?.zones ?? [];
    const zoneGizmoDefinitions: ZoneGizmoDefinition[] = [];
    for (let i = 0; i < zones.length; i += 1) {
      const zone = this.normalizeLevelZone(zones[i] ?? {}, i);
      if (!zones[i]?.id) zones[i] = zone;
      const color =
        zone.type === 'damage'
          ? 0xff6b6b
          : zone.type === 'spawn'
            ? 0x22c55e
            : zone.type === 'safe'
              ? 0x60a5fa
              : 0xc084fc;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({
          color,
          transparent: true,
          opacity: 0.22,
          roughness: 0.75,
          metalness: 0.05,
        }),
      );
      mesh.position.set(zone.x, zone.y, zone.z);
      mesh.scale.set(zone.width, zone.height, zone.depth);
      mesh.userData.levelObjectId = `zone:${zone.id}`;
      this.levelObstacleGroup.add(mesh);
      this.levelZoneMeshes.set(zone.id, mesh);
      zoneGizmoDefinitions.push({
        id: zone.id,
        name: zone.name,
        type: zone.type,
        mesh,
      });
    }
    this.zoneGizmos?.sync(zoneGizmoDefinitions);
    const roads = scene?.roads ?? [];
    for (let i = 0; i < roads.length; i += 1) {
      const road = this.normalizeLevelRoad(roads[i] ?? {}, i);
      if (!roads[i]?.id) roads[i] = road;
      if (road.points.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(
        road.points.map((point) => new THREE.Vector3(point.x, point.y + road.yOffset, point.z)),
        false,
        'catmullrom',
        0.25,
      );
      const tubularSegments = Math.max(24, road.points.length * 14);
      const radialSegments = 10;
      const geometry = new THREE.TubeGeometry(
        curve,
        tubularSegments,
        Math.max(0.25, road.width * 0.5),
        radialSegments,
        false,
      );
      const material =
        road.material === 'dirt'
          ? new THREE.MeshStandardMaterial({
              color: 0x6f5338,
              roughness: 0.95,
              metalness: 0,
            })
          : road.material === 'neon'
            ? new THREE.MeshStandardMaterial({
                color: 0x5ee0ff,
                emissive: 0x0a4f66,
                emissiveIntensity: 0.7,
                roughness: 0.4,
                metalness: 0.25,
              })
            : new THREE.MeshStandardMaterial({
                color: 0x2b3038,
                roughness: 0.88,
                metalness: 0.05,
              });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `road:${road.id}`;
      this.levelRoadGroup.add(mesh);
      this.levelRoadMeshes.set(road.id, mesh);
    }
    this.rebuildLevelSceneObjects();
    this.refreshLevelObjectSelect();
  }

  private getModelFileUrl(gameId: string, modelId: string, file: string) {
    if (/^(https?:)?\/\//i.test(file) || file.startsWith('/')) return file;
    return getGameModelFileUrl(gameId, modelId, file);
  }

  private loadFbxObject(url: string) {
    return loadFbxObject(this.fbxLoader, url);
  }

  private loadTexture(url: string, colorSpace: THREE.ColorSpace) {
    return loadTexture(url, colorSpace);
  }

  private toModelTextureKey(slot: string): keyof EditorModelTextures | null {
    const normalized = slot.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'basecolor' || normalized === 'albedo' || normalized === 'diffuse')
      return 'baseColor';
    if (normalized === 'normal' || normalized === 'normalmap') return 'normal';
    if (
      normalized === 'roughness' ||
      normalized === 'metallicroughness' ||
      normalized === 'roughnessmetallic'
    )
      return 'roughness';
    if (normalized === 'metalness' || normalized === 'metallic') return 'metalness';
    if (normalized === 'emissive' || normalized === 'emissivemap') return 'emissive';
    return null;
  }

  private getTextureColorSpace(slot: keyof EditorModelTextures) {
    return slot === 'baseColor' || slot === 'emissive' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  }

  private ensureGeometryUv(mesh: THREE.Mesh) {
    const geometry = mesh.geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    const uv = geometry.getAttribute('uv');
    if (uv) return;
    const uvCandidates = ['uv1', 'uv2', 'uv3'];
    for (const candidate of uvCandidates) {
      const attr = geometry.getAttribute(candidate);
      if (attr) {
        geometry.setAttribute('uv', attr);
        return;
      }
    }
  }

  private normalizeModelRootPivot(root: THREE.Object3D) {
    return normalizeModelRootPivot(root);
  }

  private applyModelOriginOffset(
    root: THREE.Object3D,
    originOffset?: { x?: number; y?: number; z?: number },
  ) {
    applyModelOriginOffset(root, originOffset);
  }

  private toMeshStandardMaterial(material: THREE.Material) {
    if (material instanceof THREE.MeshStandardMaterial) return material;
    const source = material as THREE.Material & Record<string, unknown>;
    const next = new THREE.MeshStandardMaterial({
      color: source.color instanceof THREE.Color ? source.color.clone() : new THREE.Color(0xffffff),
      roughness: typeof source.roughness === 'number' ? source.roughness : 0.85,
      metalness: typeof source.metalness === 'number' ? source.metalness : 0.1,
    });
    if (source.map instanceof THREE.Texture) next.map = source.map;
    if (source.normalMap instanceof THREE.Texture) next.normalMap = source.normalMap;
    if (source.roughnessMap instanceof THREE.Texture) next.roughnessMap = source.roughnessMap;
    if (source.metalnessMap instanceof THREE.Texture) next.metalnessMap = source.metalnessMap;
    if (source.emissiveMap instanceof THREE.Texture) {
      next.emissiveMap = source.emissiveMap;
      next.emissive.set(0xffffff);
      next.emissiveIntensity = 0.6;
    }
    return next;
  }

  private applyTexturesToMaterial(
    material: THREE.MeshStandardMaterial,
    textures: Partial<Record<keyof EditorModelTextures, THREE.Texture | null>>,
  ) {
    if (textures.baseColor) material.map = textures.baseColor;
    if (textures.normal) material.normalMap = textures.normal;
    if (textures.roughness) material.roughnessMap = textures.roughness;
    if (textures.metalness) material.metalnessMap = textures.metalness;
    if (textures.emissive) {
      material.emissiveMap = textures.emissive;
      material.emissive.set(0xffffff);
      material.emissiveIntensity = 0.6;
    }
    material.needsUpdate = true;
  }

  private async resolveModelTextureSet(
    gameId: string,
    modelId: string,
    textures: Partial<Record<keyof EditorModelTextures, string>>,
  ) {
    const result: Partial<Record<keyof EditorModelTextures, THREE.Texture | null>> = {};
    const slots: Array<keyof EditorModelTextures> = [
      'baseColor',
      'normal',
      'roughness',
      'metalness',
      'emissive',
    ];
    await Promise.all(
      slots.map(async (slot) => {
        const file = typeof textures[slot] === 'string' ? String(textures[slot]).trim() : '';
        if (!file) {
          result[slot] = null;
          return;
        }
        result[slot] = await this.loadTexture(
          this.getModelFileUrl(gameId, modelId, file),
          this.getTextureColorSpace(slot),
        );
      }),
    );
    return result;
  }

  private async applyModelTexturesToObject(
    root: THREE.Object3D,
    gameId: string,
    model: Pick<EditorModelRecord, 'id' | 'textures' | 'materials'>,
  ) {
    const globalTextures = await this.resolveModelTextureSet(gameId, model.id, model.textures);
    const materialTextureSets = new Map<string, Partial<Record<keyof EditorModelTextures, THREE.Texture | null>>>();
    for (const entry of model.materials ?? []) {
      if (!entry || typeof entry !== 'object') continue;
      const rawTextures = entry.textures ?? {};
      const perMaterialPaths: Partial<Record<keyof EditorModelTextures, string>> = {};
      for (const [rawKey, value] of Object.entries(rawTextures)) {
        if (typeof value !== 'string') continue;
        const mappedKey = this.toModelTextureKey(rawKey);
        if (!mappedKey) continue;
        perMaterialPaths[mappedKey] = value;
      }
      const hasAny = Object.values(perMaterialPaths).some((value) => typeof value === 'string' && value.length > 0);
      if (!hasAny) continue;
      const textureSet = await this.resolveModelTextureSet(gameId, model.id, perMaterialPaths);
      const keys = [entry.id, entry.name]
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter((value) => value.length > 0);
      for (const key of keys) materialTextureSets.set(key, textureSet);
    }

    root.traverse((obj) => {
      obj.frustumCulled = false;
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      this.ensureGeometryUv(obj);
      const asArray = Array.isArray(obj.material) ? obj.material : [obj.material];
      const nextMaterials = asArray.map((base) => {
        const standard = this.toMeshStandardMaterial(base);
        const materialKey = standard.name.trim().toLowerCase();
        const perMaterial = materialTextureSets.get(materialKey);
        if (perMaterial) {
          this.applyTexturesToMaterial(standard, { ...globalTextures, ...perMaterial });
        } else {
          this.applyTexturesToMaterial(standard, globalTextures);
        }
        return standard;
      });
      obj.material = Array.isArray(obj.material) ? nextMaterials : (nextMaterials[0] ?? obj.material);
    });
  }

  private async loadModelAssetObject(gameId: string, model: EditorModelRecord) {
    const key = `${gameId}:${model.id}:${model.sourceFile}:${(model.files ?? []).join('|')}:${model.originOffset?.x ?? 0}:${model.originOffset?.y ?? 0}:${model.originOffset?.z ?? 0}`;
    let pending = this.modelLoadCache.get(key);
    if (!pending) {
      pending = (async () => {
        const sourceCandidates = new Set<string>();
        if (model.sourceFile) sourceCandidates.add(model.sourceFile);
        if (model.sourcePath) sourceCandidates.add(model.sourcePath);
        for (const file of model.files ?? []) {
          sourceCandidates.add(file);
        }
        const candidates = Array.from(sourceCandidates).filter((value) => value.trim().length > 0);
        if (candidates.length === 0) {
          throw new Error('No source FBX file is configured for this model.');
        }
        let root: THREE.Object3D | null = null;
        let lastError: unknown = null;
        for (const candidate of candidates) {
          try {
            const sourceUrl = this.getModelFileUrl(gameId, model.id, candidate);
            root = await this.loadFbxObject(sourceUrl);
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!root) {
          throw lastError instanceof Error
            ? lastError
            : new Error('Failed to load FBX from configured source files.');
        }
        const normalizedRoot = this.normalizeModelRootPivot(root);
        this.applyModelOriginOffset(normalizedRoot, model.originOffset);
        await this.applyModelTexturesToObject(normalizedRoot, gameId, model);
        return normalizedRoot;
      })();
      this.modelLoadCache.set(key, pending);
    }
    const loaded = await pending;
    return loaded.clone(true);
  }

  private async attachLevelModelInstance(
    gameId: string,
    obstacle: LevelObstacle,
    rawComponent: unknown,
  ) {
    if (!rawComponent || typeof rawComponent !== 'object') return;
    const component = rawComponent as Record<string, unknown>;
    if (component.type !== 'model_instance') return;
    const modelId = typeof component.modelId === 'string' ? component.modelId.trim() : '';
    const sourceFile = typeof component.sourceFile === 'string' ? component.sourceFile.trim() : '';
    if (!modelId || !sourceFile) return;
    const texturesRaw =
      component.textures && typeof component.textures === 'object'
        ? (component.textures as Record<string, unknown>)
        : {};
    const model: EditorModelRecord = {
      id: modelId,
      name: typeof component.name === 'string' ? component.name : modelId,
      sourceFile,
      originOffset: (() => {
        const raw =
          component.originOffset && typeof component.originOffset === 'object'
            ? (component.originOffset as Record<string, unknown>)
            : null;
        const x = Number(raw?.x ?? 0);
        const y = Number(raw?.y ?? 0);
        const z = Number(raw?.z ?? 0);
        return {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          z: Number.isFinite(z) ? z : 0,
        };
      })(),
      textures: {
        baseColor: typeof texturesRaw.baseColor === 'string' ? texturesRaw.baseColor : '',
        normal: typeof texturesRaw.normal === 'string' ? texturesRaw.normal : '',
        roughness: typeof texturesRaw.roughness === 'string' ? texturesRaw.roughness : '',
        metalness: typeof texturesRaw.metalness === 'string' ? texturesRaw.metalness : '',
        emissive: typeof texturesRaw.emissive === 'string' ? texturesRaw.emissive : '',
      },
    };
    try {
      const instance = await this.loadModelAssetObject(gameId, model);
      const obstacleId = String(obstacle.id ?? '').trim();
      if (!obstacleId) return;
      const placeholder = this.levelObstacleMeshes.get(obstacleId);
      if (!placeholder) return;
      const x = Number(obstacle.x ?? 0);
      const y = Number(obstacle.y ?? 0);
      const z = Number(obstacle.z ?? 0);
      const width = Math.max(0.1, Number(obstacle.width ?? 1));
      const height = Math.max(0.1, Number(obstacle.height ?? 1));
      const depth = Math.max(0.1, Number(obstacle.depth ?? 1));
      instance.userData.levelObjectId = `obstacle:${obstacleId}`;
      instance.position.set(x, y + height / 2, z);
      instance.scale.set(width, height, depth);
      this.levelObstacleGroup.add(instance);
      this.levelModelInstanceRoots.set(obstacleId, instance);
      placeholder.visible = false;
      this.rebuildLevelSceneObjects();
      this.refreshLevelObjectSelect();
    } catch (error) {
      console.warn('Failed to load model instance', error);
    }
  }

  private selectLevelObject(objectId: string | null, options: { toggle?: boolean } = {}) {
    let nextPrimary = objectId;
    const nextSelectedIds = new Set(this.selectedLevelObjectIds);
    if (!options.toggle) {
      nextSelectedIds.clear();
      if (objectId) nextSelectedIds.add(objectId);
    } else if (objectId) {
      if (nextSelectedIds.has(objectId)) {
        nextSelectedIds.delete(objectId);
        if (objectId === this.selectedLevelObjectId) {
          nextPrimary = nextSelectedIds.values().next().value ?? null;
        } else {
          nextPrimary = this.selectedLevelObjectId;
        }
      } else {
        nextSelectedIds.add(objectId);
      }
    }
    if (nextPrimary && !nextSelectedIds.has(nextPrimary)) {
      nextSelectedIds.add(nextPrimary);
    }
    if (!nextPrimary && nextSelectedIds.size > 0) {
      nextPrimary = nextSelectedIds.values().next().value ?? null;
    }
    this.selectedLevelObjectIds = nextSelectedIds;
    this.selectedLevelObjectId = nextPrimary;
    const selectedIds = this.getSelectedLevelObjectIds();

    for (const [id, mesh] of this.levelObstacleMeshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const selected = selectedIds.includes(`obstacle:${id}`);
      mat.color.set(selected ? 0xf59e0b : 0x666666);
      mat.emissive.set(selected ? 0x201008 : 0x000000);
      mat.emissiveIntensity = selected ? 0.5 : 0;
    }
    for (const [id, root] of this.levelModelInstanceRoots) {
      const selected = selectedIds.includes(`obstacle:${id}`);
      root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (!(obj.material instanceof THREE.MeshStandardMaterial)) return;
        obj.material.emissiveIntensity = selected ? 0.5 : 0;
      });
    }
    for (const [id, mesh] of this.levelZoneMeshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const selected = selectedIds.includes(`zone:${id}`);
      mat.opacity = selected ? 0.4 : 0.22;
      mat.emissive.set(selected ? 0x1f2937 : 0x000000);
      mat.emissiveIntensity = selected ? 0.35 : 0;
    }
    const selectedZoneId = nextPrimary?.startsWith('zone:') ? nextPrimary.replace('zone:', '') : null;
    this.zoneGizmos?.setSelectedZoneId(selectedZoneId);
    if (this.levelGroundMesh) {
      const mat = this.levelGroundMesh.material as THREE.MeshStandardMaterial;
      const selected = selectedIds.includes('ground');
      mat.emissive = new THREE.Color(selected ? 0x112233 : 0x000000);
      mat.emissiveIntensity = selected ? 0.25 : 0;
    }
    if (this.levelPlayerMarker) {
      this.levelPlayerMarker.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.material && mesh.material instanceof THREE.MeshStandardMaterial) {
          mesh.material.emissiveIntensity = selectedIds.includes('player') ? 0.75 : 0.3;
        }
      });
    }
    if (this.levelCrowdMarker) {
      this.levelCrowdMarker.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.material && mesh.material instanceof THREE.MeshStandardMaterial) {
          mesh.material.emissiveIntensity = selectedIds.includes('crowd') ? 0.85 : 0.35;
        }
      });
    }

    if (this.levelObjectSelectEl) {
      this.levelObjectSelectEl.value = nextPrimary ?? '';
    }
    if (this.levelHierarchyEl) {
      const items = this.levelHierarchyEl.querySelectorAll<HTMLButtonElement>('.bone-list-item');
      items.forEach((item) => {
        const id = item.dataset.levelObjectId;
        item.classList.toggle('active', Boolean(id && selectedIds.includes(id)));
      });
    }

    if (!this.levelTransform) return;
    const entry = nextPrimary ? (this.levelSceneObjects.get(nextPrimary) ?? null) : null;
    if (entry?.object && entry.object.parent) {
      this.levelTransform.attach(entry.object);
      setTransformControlsVisible(this.levelTransform, true);
    } else {
      this.levelTransform.detach();
      setTransformControlsVisible(this.levelTransform, false);
    }
    this.syncLevelCameraTarget();
    this.refreshLevelInspector();
  }

  private createUniqueLevelEntityId(prefix: string, existingIds: Set<string>) {
    let index = existingIds.size + 1;
    while (existingIds.has(`${prefix}${index}`)) index += 1;
    return `${prefix}${index}`;
  }

  private duplicateSelectedLevelObjects() {
    const scene = this.getCurrentLevelSceneEntry();
    if (!scene) return null;
    const selectedIds = this.getSelectedLevelObjectIds();
    if (selectedIds.length === 0) return null;
    const obstacles = scene.obstacles ?? [];
    const zones = scene.zones ?? [];
    const obstacleIdSet = new Set(
      obstacles.map((item, idx) => this.normalizeLevelObstacle(item ?? {}, idx).id),
    );
    const zoneIdSet = new Set(zones.map((item, idx) => this.normalizeLevelZone(item ?? {}, idx).id));
    const duplicatedIds: string[] = [];
    let duplicatedObstacles = 0;
    let duplicatedZones = 0;
    for (const selectedId of selectedIds) {
      if (selectedId.startsWith('obstacle:')) {
        const obstacleId = selectedId.replace('obstacle:', '');
        const index = obstacles.findIndex(
          (item, idx) => this.normalizeLevelObstacle(item ?? {}, idx).id === obstacleId,
        );
        if (index < 0) continue;
        const source = this.normalizeLevelObstacle(obstacles[index] ?? {}, index);
        const id = this.createUniqueLevelEntityId('obstacle_', obstacleIdSet);
        obstacleIdSet.add(id);
        obstacles.push({ ...source, id, x: source.x + 1 });
        duplicatedIds.push(`obstacle:${id}`);
        duplicatedObstacles += 1;
        continue;
      }
      if (selectedId.startsWith('zone:')) {
        const zoneId = selectedId.replace('zone:', '');
        const index = zones.findIndex(
          (item, idx) => this.normalizeLevelZone(item ?? {}, idx).id === zoneId,
        );
        if (index < 0) continue;
        const source = this.normalizeLevelZone(zones[index] ?? {}, index);
        const id = this.createUniqueLevelEntityId('zone_', zoneIdSet);
        zoneIdSet.add(id);
        zones.push({ ...source, id, x: source.x + 1, name: `${source.name} Copy` });
        duplicatedIds.push(`zone:${id}`);
        duplicatedZones += 1;
      }
    }
    if (duplicatedIds.length === 0) return null;
    scene.obstacles = obstacles;
    scene.zones = zones;
    this.updateLevelVisualization(scene.obstacles ?? []);
    this.selectLevelObjects(duplicatedIds, duplicatedIds[duplicatedIds.length - 1] ?? null);
    this.syncLevelTextEditors();
    return { duplicatedObstacles, duplicatedZones, total: duplicatedIds.length };
  }

  private deleteSelectedLevelObjects() {
    const scene = this.getCurrentLevelSceneEntry();
    if (!scene) return null;
    const selectedIds = this.getSelectedLevelObjectIds();
    if (selectedIds.length === 0) return null;
    const obstacleIds = new Set(
      selectedIds
        .filter((id) => id.startsWith('obstacle:'))
        .map((id) => id.replace('obstacle:', '')),
    );
    const zoneIds = new Set(
      selectedIds.filter((id) => id.startsWith('zone:')).map((id) => id.replace('zone:', '')),
    );
    const deleteGround = selectedIds.includes('ground');
    const deletePlayer = selectedIds.includes('player');
    const deleteCrowd = selectedIds.includes('crowd');

    if (obstacleIds.size > 0) {
      scene.obstacles = (scene.obstacles ?? []).filter(
        (item, idx) => !obstacleIds.has(this.normalizeLevelObstacle(item ?? {}, idx).id),
      );
    }
    if (zoneIds.size > 0) {
      scene.zones = (scene.zones ?? []).filter(
        (item, idx) => !zoneIds.has(this.normalizeLevelZone(item ?? {}, idx).id),
      );
    }
    if (deleteGround) delete scene.ground;
    if (deletePlayer) delete scene.player;
    if (deleteCrowd) delete scene.crowd;

    if (scene.components) {
      for (const id of selectedIds) {
        delete scene.components[id];
      }
    }

    const totalRemoved =
      obstacleIds.size +
      zoneIds.size +
      Number(deleteGround) +
      Number(deletePlayer) +
      Number(deleteCrowd);
    if (totalRemoved === 0) return null;

    this.updateLevelVisualization(scene.obstacles ?? []);
    this.syncLevelTextEditors();
    return {
      obstacles: obstacleIds.size,
      zones: zoneIds.size,
      ground: Number(deleteGround),
      player: Number(deletePlayer),
      crowd: Number(deleteCrowd),
      total: totalRemoved,
    };
  }

  private focusSelectedLevelObjects() {
    if (!this.controls) return false;
    const selectedIds = this.getSelectedLevelObjectIds();
    const selectedObjects = selectedIds
      .map((id) => this.levelSceneObjects.get(id)?.object ?? null)
      .filter((obj): obj is THREE.Object3D => Boolean(obj));
    if (selectedObjects.length === 0) return false;
    const centroid = new THREE.Vector3();
    const point = new THREE.Vector3();
    for (const object of selectedObjects) {
      object.getWorldPosition(point);
      centroid.add(point);
    }
    centroid.multiplyScalar(1 / selectedObjects.length);
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.lengthSq() < 0.0001) {
      offset.set(4, 4, 4);
    }
    this.controls.target.copy(centroid);
    this.camera.position.copy(centroid).add(offset);
    this.controls.update();
    return true;
  }

  private handleLevelTransformObjectChange = () => {
    const selectedId = this.selectedLevelObjectId;
    if (!selectedId) return;
    const scene = this.getCurrentLevelSceneEntry();
    const entry = this.levelSceneObjects.get(selectedId);
    if (!scene || !entry) return;
    if (entry.kind === 'obstacle' && entry.obstacleId) {
      const mesh = entry.object as THREE.Mesh;
      const obstacles = scene.obstacles ?? [];
      const index = obstacles.findIndex(
        (item, idx) => this.normalizeLevelObstacle(item ?? {}, idx).id === entry.obstacleId,
      );
      if (index >= 0) {
        obstacles[index] = {
          id: entry.obstacleId,
          x: mesh.position.x,
          y: mesh.position.y - mesh.scale.y / 2,
          z: mesh.position.z,
          width: Math.max(0.1, mesh.scale.x),
          height: Math.max(0.1, mesh.scale.y),
          depth: Math.max(0.1, mesh.scale.z),
        };
      }
      scene.obstacles = obstacles;
    } else if (entry.kind === 'ground') {
      const ground: NormalizedLevelGround = this.normalizeLevelGround(scene.ground ?? undefined) ?? {
        type: 'concrete',
        width: 120,
        depth: 120,
        y: 0,
        textureRepeat: 12,
        texturePreset: 'concrete',
        water: this.normalizeLevelWater(undefined),
      };
      const bounds = new THREE.Box3().setFromObject(entry.object);
      const size = new THREE.Vector3();
      bounds.getSize(size);
      ground.width = Math.max(1, size.x);
      ground.depth = Math.max(1, size.z);
      ground.y = entry.object.position.y;
      if (ground.terrain?.enabled) {
        ground.terrain.size = Math.max(ground.width, ground.depth);
      }
      scene.ground = ground;
    } else if (entry.kind === 'player') {
      const player = scene.player ?? {};
      player.x = entry.object.position.x;
      player.y = entry.object.position.y;
      player.z = entry.object.position.z;
      player.yaw = entry.object.rotation.y;
      player.controller = this.playerConfig.profile?.controller ?? 'third_person';
      scene.player = player;
    } else if (entry.kind === 'crowd') {
      const crowd = scene.crowd ?? { enabled: true };
      crowd.enabled = true;
      crowd.x = entry.object.position.x;
      crowd.y = entry.object.position.y;
      crowd.z = entry.object.position.z;
      crowd.radius = Math.max(1, 12 * entry.object.scale.x);
      scene.crowd = crowd;
    } else if (entry.kind === 'zone' && entry.zoneId) {
      const mesh = entry.object as THREE.Mesh;
      const zones = scene.zones ?? [];
      const index = zones.findIndex(
        (item, idx) => this.normalizeLevelZone(item ?? {}, idx).id === entry.zoneId,
      );
      if (index >= 0) {
        const source = this.normalizeLevelZone(zones[index] ?? {}, index);
        zones[index] = {
          ...source,
          id: entry.zoneId,
          x: mesh.position.x,
          y: mesh.position.y,
          z: mesh.position.z,
          width: Math.max(0.5, mesh.scale.x),
          height: Math.max(0.5, mesh.scale.y),
          depth: Math.max(0.5, mesh.scale.z),
        };
      }
      scene.zones = zones;
    }
    this.syncLevelTextEditors();
    this.refreshLevelContextDrawer();
  };

  private pickLevelObject = (event: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const selectable = Array.from(this.levelSceneObjects.values()).map((entry) => entry.object);
    const hits = this.raycaster.intersectObjects(selectable, true);
    const hitObject = hits[0]?.object;
    let hitId = hitObject?.userData.levelObjectId as string | undefined;
    if (!hitId && hitObject) {
      let cursor: THREE.Object3D | null = hitObject;
      while (cursor && !hitId) {
        hitId = cursor.userData.levelObjectId as string | undefined;
        cursor = cursor.parent;
      }
    }
    if (hitId) {
      this.selectLevelObject(hitId, { toggle: event.ctrlKey || event.metaKey });
      this.triggerHapticFeedback('light');
    }
  };

  private dropLevelObjectAtPointer = (event: PointerEvent) => {
    const scene = this.getCurrentLevelSceneEntry();
    if (!scene) return false;
    if (this.levelBuildTool === 'select') return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const candidates: THREE.Object3D[] = [];
    if (this.levelGroundMesh) candidates.push(this.levelGroundMesh);
    for (const mesh of this.levelObstacleMeshes.values()) candidates.push(mesh);
    for (const mesh of this.levelZoneMeshes.values()) candidates.push(mesh);
    let hitPoint: THREE.Vector3 | null = null;
    if (candidates.length > 0) {
      const hit = this.raycaster.intersectObjects(candidates, false)[0];
      if (hit) hitPoint = hit.point.clone();
    }
    if (!hitPoint) {
      const fallbackPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const point = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(fallbackPlane, point)) {
        hitPoint = point;
      }
    }
    if (!hitPoint) return false;

    if (this.levelBuildTool === 'drop_box') {
      this.recordLevelEdit(() => {
        const obstacles = scene.obstacles ?? [];
        const id = `obstacle_${obstacles.length + 1}`;
        const width = 1.25;
        const height = 1.25;
        const depth = 1.25;
        obstacles.push({
          id,
          x: hitPoint.x,
          y: hitPoint.y + height * 0.5,
          z: hitPoint.z,
          width,
          height,
          depth,
        });
        scene.obstacles = obstacles;
        this.updateLevelVisualization(obstacles);
        this.selectLevelObject(`obstacle:${id}`);
        this.syncLevelTextEditors();
      });
      return true;
    }

    if (this.levelBuildTool === 'drop_zone') {
      this.recordLevelEdit(() => {
        const zones = scene.zones ?? [];
        const id = `zone_${zones.length + 1}`;
        zones.push({
          id,
          name: `Zone ${zones.length + 1}`,
          tag: '',
          x: hitPoint.x,
          y: hitPoint.y + 1,
          z: hitPoint.z,
          width: 4,
          height: 2,
          depth: 4,
          type: 'trigger',
        });
        scene.zones = zones;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject(`zone:${id}`);
        this.syncLevelTextEditors();
      });
      return true;
    }

    if (this.levelBuildTool === 'drop_ground') {
      this.recordLevelEdit(() => {
        const current = this.normalizeLevelGround(scene.ground ?? undefined);
        scene.ground = {
          type: current?.type ?? 'concrete',
          width: current?.width ?? 120,
          depth: current?.depth ?? 120,
          y: hitPoint.y,
          textureRepeat: current?.textureRepeat ?? 12,
          texturePreset: current?.texturePreset ?? 'concrete',
          water: current?.water ? { ...current.water } : this.normalizeLevelWater(undefined),
          terrain: current?.terrain ? { ...current.terrain } : undefined,
        };
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject('ground');
        this.syncLevelTextEditors();
      });
      return true;
    }

    if (this.levelBuildTool === 'drop_player') {
      this.recordLevelEdit(() => {
        scene.player = {
          x: hitPoint.x,
          y: hitPoint.y,
          z: hitPoint.z,
          yaw: this.camera.rotation.y,
          controller: this.playerConfig.profile?.controller ?? 'third_person',
        };
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject('player');
        this.syncLevelTextEditors();
      });
      return true;
    }

    if (this.levelBuildTool === 'drop_crowd') {
      this.recordLevelEdit(() => {
        scene.crowd = {
          enabled: true,
          x: hitPoint.x,
          y: hitPoint.y,
          z: hitPoint.z,
          radius: scene.crowd?.radius ?? 12,
        };
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject('crowd');
        this.syncLevelTextEditors();
      });
      return true;
    }

    if (this.levelBuildTool === 'drop_road_point') {
      this.recordLevelEdit(() => {
        if (!scene.roads) scene.roads = [];
        const targetName = this.levelRoadEditName.trim() || `Road ${scene.roads.length + 1}`;
        let index = scene.roads.findIndex(
          (item, roadIndex) => this.normalizeLevelRoad(item ?? {}, roadIndex).name === targetName,
        );
        if (index < 0) {
          scene.roads.push({
            id: `road_${scene.roads.length + 1}`,
            name: targetName,
            width: this.levelRoadEditWidth,
            yOffset: 0.08,
            material: this.levelRoadEditMaterial,
            points: [],
          });
          index = scene.roads.length - 1;
        }
        const road = this.normalizeLevelRoad(scene.roads[index] ?? {}, index);
        road.width = this.levelRoadEditWidth;
        road.material = this.levelRoadEditMaterial;
        road.points.push({ x: hitPoint.x, y: hitPoint.y, z: hitPoint.z });
        scene.roads[index] = road;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
      });
      return true;
    }

    if (
      this.levelBuildTool === 'sculpt_raise' ||
      this.levelBuildTool === 'sculpt_lower' ||
      this.levelBuildTool === 'sculpt_smooth' ||
      this.levelBuildTool === 'sculpt_flatten'
    ) {
      this.recordLevelEdit(() => {
        const current = this.normalizeLevelGround(scene.ground ?? undefined) ?? {
          type: 'concrete',
          width: 120,
          depth: 120,
          y: 0,
          textureRepeat: 12,
          texturePreset: 'concrete',
          water: this.normalizeLevelWater(undefined),
        };
        const terrain = current.terrain ?? {
          enabled: true,
          preset: 'cinematic',
          size: 120,
          resolution: 32,
          maxHeight: 12,
          roughness: 0.56,
          seed: 1337,
          sculptStamps: [],
        };
        const mode =
          this.levelBuildTool === 'sculpt_lower'
            ? 'lower'
            : this.levelBuildTool === 'sculpt_smooth'
              ? 'smooth'
              : this.levelBuildTool === 'sculpt_flatten'
                ? 'flatten'
                : 'raise';
        const sculptStamps = Array.isArray(terrain.sculptStamps) ? [...terrain.sculptStamps] : [];
        sculptStamps.push({
          x: hitPoint.x,
          z: hitPoint.z,
          radius: this.levelSculptRadiusValue,
          strength: this.levelSculptStrengthValue,
          mode,
          targetHeight: Math.max(0, hitPoint.y - current.y),
        });
        terrain.sculptStamps = sculptStamps.slice(-512);
        current.terrain = terrain;
        scene.ground = current;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
      });
      return true;
    }

    return false;
  };

  private isTransformGizmoActive(control: TransformControls | null) {
    if (!control) return false;
    const axis = transformControlsInternal(control).axis ?? null;
    return axis != null;
  }

  // Get API path for animations (game-scoped only)
  private getAnimationsPath(): string | null {
    if (this.currentGameId) {
      return `/api/games/${this.currentGameId}/animations`;
    }
    return null; // No game selected
  }

  // Get API path for scenes (game-scoped only)
  private getScenesPath(): string | null {
    if (this.currentGameId) {
      return `/api/games/${this.currentGameId}/scenes`;
    }
    return null; // No game selected
  }

  // Load assets for current game (triggers refresh of animations and scenes)
  private async loadGameAssets(retryCount = 0) {
    console.log('Loading assets for game:', this.currentGameId, `(attempt ${retryCount + 1})`);
    console.log('refreshClipsFunction available:', !!this.refreshClipsFunction);
    console.log('refreshScenesFunction available:', !!this.refreshScenesFunction);
    if (this.currentGameId) {
      try {
        const res = await fetch(`/api/games/${this.currentGameId}/player`, { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as Partial<PlayerConfig>;
          this.playerConfig = this.normalizePlayerConfig({ ...this.playerConfig, ...data });
        } else {
          this.playerConfig = this.normalizePlayerConfig(this.playerConfig);
        }
      } catch {
        this.playerConfig = this.normalizePlayerConfig(this.playerConfig);
      }
    }
    this.loadVrm();
    if (this.refreshPlayerAvatarsFunction) await this.refreshPlayerAvatarsFunction();
    this.refreshPlayerInputsFunction?.();
    this.syncPlayerCapsulePreview();

    // If functions aren't ready yet, retry after a delay (max 5 retries)
    if ((!this.refreshClipsFunction || !this.refreshScenesFunction) && retryCount < 5) {
      console.log('Refresh functions not ready, retrying in 200ms...');
      setTimeout(() => {
        this.loadGameAssets(retryCount + 1);
      }, 200);
      return;
    }

    // Trigger refresh of animations list
    if (this.refreshClipsFunction) {
      console.log('Calling refreshClipsFunction...');
      try {
        await this.refreshClipsFunction();
        console.log('✓ Animations loaded successfully');
      } catch (err) {
        console.error('✗ Failed to load animations:', err);
      }
    } else {
      console.error('✗ refreshClipsFunction not available after retries');
    }

    // Trigger refresh of scenes
    if (this.refreshScenesFunction) {
      console.log('Calling refreshScenesFunction...');
      try {
        await this.refreshScenesFunction();
        console.log('✓ Scenes loaded successfully');
      } catch (err) {
        console.error('✗ Failed to load scenes:', err);
      }
    } else {
      console.error('✗ refreshScenesFunction not available after retries');
    }
    if (this.refreshModelsFunction) {
      console.log('Calling refreshModelsFunction...');
      try {
        await this.refreshModelsFunction();
        console.log('✓ Models loaded successfully');
      } catch (err) {
        console.error('✗ Failed to load models:', err);
      }
    }
  }

  private tick = () => {
    const delta = this.clock.getDelta();
    const now = performance.now();
    const isAnimationTab = this.currentTab === 'animation';
    const isCharacterTab = this.currentTab === 'animation' || this.currentTab === 'player';
    this.sanitizeTransformControls();
    this.syncRenderPixelRatio();

    if (isAnimationTab && this.ragdollEnabled && this.ragdollWorld) {
      this.stepRagdoll(delta);
    } else if (isAnimationTab && this.isPlaying) {
      this.time += delta;
      if (this.time > this.clip.duration) this.time = 0;
    }
    if (isAnimationTab && this.ragdollMode === 'reactive' && this.ragdollVisible && !this.ragdollEnabled) {
      if (this.ragdollWorld && this.ragdollBones.size > 0) {
        this.syncRagdollReactivePose(delta);
        this.updateRagdollDebugFromBodies();
      } else {
        this.updateRagdollDebugFromBones();
      }
    }
    const shouldUpdateHipsTarget =
      isCharacterTab &&
      this.vrm &&
      this.controls &&
      (!isAnimationTab || !this.isPlaying || now - this.lastHipsTargetUpdateMs >= 120);
    if (shouldUpdateHipsTarget) {
      const vrm = this.vrm;
      const controls = this.controls;
      if (vrm && controls) {
        const hips = vrm.humanoid.getRawBoneNode('hips');
        if (hips) {
          hips.getWorldPosition(controls.target);
          this.lastHipsTargetUpdateMs = now;
        }
      }
    }
    if (this.currentTab === 'level') {
      this.syncLevelCameraTarget();
      this.zoneGizmos?.update(this.camera);
      if (this.levelSkyDomeMesh?.visible) {
        this.levelSkyDomeMesh.position.copy(this.camera.position);
      }
      if (this.levelWaterMaterial) {
        const uTime = this.levelWaterMaterial.uniforms.uTime;
        if (uTime) uTime.value += delta;
      }
      if (this.levelFreeFlyActive && this.canUseLevelFreeFly()) {
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward).normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const desired = new THREE.Vector3();
        if (this.levelFreeFlyKeys.has('w')) desired.add(forward);
        if (this.levelFreeFlyKeys.has('s')) desired.sub(forward);
        if (this.levelFreeFlyKeys.has('d')) desired.add(right);
        if (this.levelFreeFlyKeys.has('a')) desired.sub(right);
        if (this.levelFreeFlyKeys.has('e') || this.levelFreeFlyKeys.has(' ')) desired.add(up);
        if (this.levelFreeFlyKeys.has('q')) desired.sub(up);
        if (desired.lengthSq() > 0) desired.normalize();
        const boost = this.levelFreeFlyKeys.has('shift') ? 2.5 : 1;
        const precision = this.levelFreeFlyKeys.has('control') ? 0.35 : 1;
        const maxSpeed = this.levelFreeFlyBaseSpeed * boost * precision;
        const accel = Math.max(0.01, Math.min(1, delta * 16));
        const damp = Math.max(0, 1 - delta * 9);
        this.levelFreeFlyVelocity.multiplyScalar(damp);
        this.levelFreeFlyVelocity.lerp(desired.multiplyScalar(maxSpeed), accel);
        if (this.levelFreeFlyVelocity.lengthSq() > 1e-6) {
          this.camera.position.addScaledVector(this.levelFreeFlyVelocity, delta);
        }
      }
    }
    this.controls?.update();
    if (isAnimationTab && this.mixer && this.currentMixamo) this.mixer.update(delta);
    if (isAnimationTab && this.isPlaying) {
      this.applyClipAtTime(this.time);
      this.updateTimeline(false);
    }
    if (isCharacterTab && this.vrm) {
      const vrmUpdateIntervalMs = isAnimationTab && this.isPlaying ? 33 : 0;
      if (vrmUpdateIntervalMs === 0 || now - this.lastVrmUpdateMs >= vrmUpdateIntervalMs) {
        this.vrm.update(delta);
        this.lastVrmUpdateMs = now;
      }
    }
    if (this.currentTab === 'player') {
      this.syncPlayerCapsulePreview();
    }
    const shouldUpdateBoneVisuals = !this.isPlaying || now - this.lastBoneVisualUpdateMs >= 66;
    if (shouldUpdateBoneVisuals) {
      if (isAnimationTab && this.boneVisualsVisible) {
        this.updateBoneMarkers();
        this.updateBoneGizmos();
      }
      this.lastBoneVisualUpdateMs = now;
    }
    const shouldDrawAxis = !this.isPlaying || now - this.lastAxisDrawMs >= 33;
    if (shouldDrawAxis) {
      this.drawAxisWidget();
      this.lastAxisDrawMs = now;
    }

    // Render with retro effects or standard
    if (retroRenderSettings.config.enabled && this.retroPostProcessor) {
      this.retroPostProcessor.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    this.animationId = requestAnimationFrame(this.tick);
  };

  private createHud() {
    const hud = document.createElement('div');
    hud.className = 'editor-ui aaa-editor';
    hud.innerHTML = [
      '<div class="editor-header">',
      '<div class="editor-title">Sleepy Engine Editor</div>',
      '<button class="mode-back-button" data-back-menu>Back to Menu</button>',
      '<div class="editor-game-selector">',
      '<label class="editor-game-field">',
      '<span>Game:</span>',
      '<select data-game-select>',
      '<option value="">-- Select Game --</option>',
      '</select>',
      '<button data-new-game>New Game</button>',
      '<button data-delete-game>Delete Game</button>',
      '</label>',
      '</div>',
      '<div class="editor-tabs">',
      '<button class="editor-tab active" data-tab="animation">Animation</button>',
      '<button class="editor-tab" data-tab="player">Player</button>',
      '<button class="editor-tab" data-tab="level">Level</button>',
      '<button class="editor-tab" data-tab="model">Model</button>',
      '<button class="editor-tab" data-tab="settings">Settings</button>',
      '</div>',
      '</div>',
      '<div class="editor-shell">',
      '<div class="editor-left" data-tab-panel="animation" style="display:none;">',
      '<div class="panel">',
      '<div class="panel-title">Bones</div>',
      '<div class="bone-list" data-bone-list></div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">History</div>',
      '<div class="undo-info" data-undo-info>Undo: 0 &middot; Redo: 0</div>',
      '<div class="panel-actions">',
      '<button data-undo-btn>Undo</button>',
      '<button data-redo-btn>Redo</button>',
      '</div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Clipboard</div>',
      '<div class="undo-info" data-clipboard-info>Empty</div>',
      '<div class="panel-actions">',
      '<button data-copy-btn>Copy Frame</button>',
      '<button data-paste-btn>Paste Frame</button>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="editor-left" data-tab-panel="player" style="display:none;">',
      '<div class="panel">',
      '<div class="panel-title">Player Controller</div>',
      '<label class="field"><span>Move Speed</span><input data-move-speed type="number" step="0.1" /></label>',
      '<label class="field"><span>Sprint Mult</span><input data-sprint-mult type="number" step="0.05" /></label>',
      '<label class="field"><span>Crouch Mult</span><input data-crouch-mult type="number" step="0.05" /></label>',
      '<label class="field"><span>Slide Accel</span><input data-slide-accel type="number" step="0.5" /></label>',
      '<label class="field"><span>Slide Friction</span><input data-slide-friction type="number" step="0.5" /></label>',
      '<label class="field"><span>Jump Speed</span><input data-jump-speed type="number" step="0.1" /></label>',
      '<label class="field"><span>Gravity</span><input data-gravity type="number" step="0.5" /></label>',
      '<label class="field"><span>Walk Threshold</span><input data-walk-threshold type="number" step="0.05" /></label>',
      '<label class="field"><span>Run Threshold</span><input data-run-threshold type="number" step="0.1" /></label>',
      '<label class="field"><span>IK Offset</span><input data-ik-offset type="number" step="0.01" /></label>',
      '<label class="field"><span>Capsule Radius Scale</span><input data-cap-radius type="number" step="0.05" /></label>',
      '<label class="field"><span>Capsule Height Scale</span><input data-cap-height type="number" step="0.05" /></label>',
      '<label class="field"><span>Capsule Y Offset</span><input data-cap-y type="number" step="0.01" /></label>',
      '<label class="field"><span>Camera Distance</span><input data-cam-distance type="number" step="0.1" /></label>',
      '<label class="field"><span>Camera Height</span><input data-cam-height type="number" step="0.1" /></label>',
      '<label class="field"><span>Shoulder Offset</span><input data-cam-shoulder type="number" step="0.1" /></label>',
      '<label class="field"><span>Shoulder Height</span><input data-cam-shoulder-y type="number" step="0.1" /></label>',
      '<label class="field"><span>Cam Sensitivity</span><input data-cam-sense type="number" step="0.05" /></label>',
      '<label class="field"><span>Cam Smoothing</span><input data-cam-smooth type="number" step="0.05" min="0" max="1" /></label>',
      '<label class="field"><span>Min Pitch</span><input data-cam-min-pitch type="number" step="0.05" /></label>',
      '<label class="field"><span>Max Pitch</span><input data-cam-max-pitch type="number" step="0.05" /></label>',
      '<label class="field"><span>Target Smooth</span><input data-cam-target-smooth type="number" step="1" /></label>',
      '<label class="field"><span>Name</span><input data-profile-name type="text" placeholder="Character Name" /></label>',
      '<label class="field"><span>Role</span><select data-profile-role><option value="player">Player</option><option value="npc">NPC</option><option value="boss">Boss</option><option value="neutral">Neutral</option></select></label>',
      '<label class="field"><span>Controller</span><select data-profile-controller><option value="third_person">Third Person</option><option value="first_person">First Person</option><option value="ragdoll">Ragdoll</option><option value="ai_only">AI Only</option><option value="hybrid">Hybrid</option></select></label>',
      '<label class="field"><span>Controller Modes JSON</span><textarea data-controller-modes-json rows="6" placeholder="{&quot;third_person&quot;:{},&quot;first_person&quot;:{},&quot;ragdoll&quot;:{}}"></textarea></label>',
      '<label class="field"><span>Faction</span><input data-profile-faction type="text" /></label>',
      '<label class="field"><span>Health</span><input data-profile-health type="number" min="1" step="1" /></label>',
      '<label class="field"><span>Stamina</span><input data-profile-stamina type="number" min="0" step="1" /></label>',
      '<label class="field"><span>Tags CSV</span><input data-profile-tags type="text" placeholder="humanoid,player" /></label>',
      '<label class="field"><span>Description</span><input data-profile-description type="text" placeholder="Short bio / intent" /></label>',
      '<label class="field"><span>Avatar</span><select data-player-avatar></select></label>',
      '<label class="field"><span>Upload VRM/GLB</span><input data-player-avatar-file type="file" accept=".vrm,.glb,.gltf" /></label>',
      '<div class="panel-actions">',
      '<button data-player-avatar-refresh>Refresh Avatars</button>',
      '<button data-player-avatar-load>Load Avatar</button>',
      '<button data-player-avatar-save>Save Avatar</button>',
      '</div>',
      '<div class="panel-actions">',
      '<button data-player-load>Load</button>',
      '<button data-player-save>Save</button>',
      '</div>',
      '<div class="clip-status" data-player-status></div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Capsule Collider</div>',
      '<label class="field"><span>Preview</span><input data-capsule-preview type="checkbox" /></label>',
      '<label class="field"><span>Base Radius</span><input data-capsule-base-radius type="number" step="0.01" min="0.05" /></label>',
      '<label class="field"><span>Base Height</span><input data-capsule-base-height type="number" step="0.01" min="0.2" /></label>',
      '<label class="field"><span>Skin Width</span><input data-capsule-skin-width type="number" step="0.005" min="0" /></label>',
      '<label class="field"><span>Step Height</span><input data-capsule-step-height type="number" step="0.01" min="0" /></label>',
      '<label class="field"><span>Slope Limit (deg)</span><input data-capsule-slope type="number" step="1" min="1" max="89" /></label>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Animation State Machine</div>',
      '<label class="field"><span>Initial</span><input data-sm-initial type="text" placeholder="idle" /></label>',
      '<label class="field"><span>States JSON</span><textarea data-sm-states rows="7"></textarea></label>',
      '<label class="field"><span>Transitions JSON</span><textarea data-sm-transitions rows="7"></textarea></label>',
      '<div class="panel-actions">',
      '<button data-sm-reset>Reset SM</button>',
      '<button data-sm-validate>Validate SM</button>',
      '</div>',
      '<div class="clip-status" data-sm-status></div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">NPC Brain</div>',
      '<label class="field"><span>NPC Enabled</span><input data-npc-enabled type="checkbox" /></label>',
      '<label class="field"><span>Archetype</span><input data-npc-archetype type="text" placeholder="grunt" /></label>',
      '<label class="field"><span>Aggression</span><input data-npc-aggression type="number" min="0" max="1" step="0.05" /></label>',
      '<label class="field"><span>Perception</span><input data-npc-perception type="number" min="0" step="0.5" /></label>',
      '<label class="field"><span>FOV</span><input data-npc-fov type="number" min="1" max="179" step="1" /></label>',
      '<label class="field"><span>Patrol Speed</span><input data-npc-patrol-speed type="number" min="0" step="0.1" /></label>',
      '<label class="field"><span>Chase Speed</span><input data-npc-chase-speed type="number" min="0" step="0.1" /></label>',
      '<label class="field"><span>Attack Range</span><input data-npc-attack-range type="number" min="0" step="0.1" /></label>',
      '<label class="field"><span>Reaction (ms)</span><input data-npc-reaction type="number" min="0" step="10" /></label>',
      '<label class="field"><span>Goals JSON</span><textarea data-npc-goals rows="4"></textarea></label>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Ragdoll Rig</div>',
      '<label class="field"><span>Show Ragdoll</span><input data-rig-show type="checkbox" /></label>',
      '<label class="field"><span>Bone</span><select data-rig-bone></select></label>',
      '<label class="field"><span>Source Bone</span><select data-rig-source-bone></select></label>',
      '<label class="field"><span>Child Bone</span><select data-rig-child-bone></select></label>',
      '<label class="field"><span>Gizmo Mode</span><select data-rig-mode><option value="translate">Move</option><option value="rotate">Rotate</option><option value="scale">Scale</option></select></label>',
      '<label class="field"><span>Radius Scale</span><input data-rig-radius type="range" min="0.3" max="2.0" step="0.05" value="1" /></label>',
      '<label class="field"><span>Length Scale</span><input data-rig-length type="range" min="0.3" max="2.0" step="0.05" value="1" /></label>',
      '<label class="field"><span>Offset X</span><input data-rig-offx type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Offset Y</span><input data-rig-offy type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Offset Z</span><input data-rig-offz type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Rot X</span><input data-rig-rotx type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Rot Y</span><input data-rig-roty type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Rot Z</span><input data-rig-rotz type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Swing Limit</span><input data-rig-swing type="number" step="1" value="45" /></label>',
      '<label class="field"><span>Twist Limit</span><input data-rig-twist type="number" step="1" value="35" /></label>',
      '<div class="panel-actions">',
      '<button data-rig-apply>Apply Rig</button>',
      '<button data-rig-reset>Reset Rig</button>',
      '</div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Ragdoll Simulation</div>',
      '<label class="field"><span>Active Muscles</span><input data-rsim-muscle-enabled type="checkbox" /></label>',
      '<label class="field"><span>Muscle Stiffness</span><input data-rsim-muscle-stiffness type="number" step="1" min="0" /></label>',
      '<label class="field"><span>Muscle Damping</span><input data-rsim-muscle-damping type="number" step="1" min="0" /></label>',
      '<label class="field"><span>Muscle Max Torque</span><input data-rsim-muscle-max-torque type="number" step="1" min="0" /></label>',
      '<label class="field"><span>Joint Stiffness Scale</span><input data-rsim-joint-stiffness-scale type="number" step="0.05" min="0" /></label>',
      '<label class="field"><span>Joint Damping Scale</span><input data-rsim-joint-damping-scale type="number" step="0.05" min="0" /></label>',
      '<label class="field"><span>Body Linear Damp Scale</span><input data-rsim-body-lin-scale type="number" step="0.05" min="0" /></label>',
      '<label class="field"><span>Body Angular Damp Scale</span><input data-rsim-body-ang-scale type="number" step="0.05" min="0" /></label>',
      '<label class="field"><span>Ground Friction</span><input data-rsim-ground-friction type="number" step="0.05" min="0" /></label>',
      '<label class="field"><span>Body Friction</span><input data-rsim-body-friction type="number" step="0.05" min="0" /></label>',
      '<label class="field"><span>Max Substeps</span><input data-rsim-max-substeps type="number" step="1" min="1" max="8" /></label>',
      '<label class="field"><span>Substep Hz</span><input data-rsim-substep-hz type="number" step="1" min="30" max="240" /></label>',
      '<label class="field"><span>Limit Blend</span><input data-rsim-limit-blend type="number" step="0.05" min="0" max="1" /></label>',
      '<label class="field"><span>Linear Bleed</span><input data-rsim-linear-bleed type="number" step="0.001" min="0.8" max="1" /></label>',
      '<label class="field"><span>Angular Bleed</span><input data-rsim-angular-bleed type="number" step="0.001" min="0.5" max="1" /></label>',
      '<label class="field"><span>Ground Slide Damping</span><input data-rsim-slide-damp type="number" step="0.01" min="0" max="1" /></label>',
      '<label class="field"><span>Ground Y Threshold</span><input data-rsim-ground-y type="number" step="0.05" min="0" /></label>',
      '<label class="field"><span>Ground Deadzone</span><input data-rsim-ground-deadzone type="number" step="0.01" min="0" /></label>',
      '<label class="field"><span>Max Linear Vel</span><input data-rsim-max-lin type="number" step="0.5" min="0" /></label>',
      '<label class="field"><span>Max Angular Vel</span><input data-rsim-max-ang type="number" step="0.5" min="0" /></label>',
      '<label class="field"><span>Start Impulse Y</span><input data-rsim-start-impulse type="number" step="0.05" /></label>',
      '</div>',
      '</div>',
      '<div class="editor-left" data-tab-panel="level" style="display:none;">',
      '<div class="panel">',
      '<div class="panel-title">Scene</div>',
      '<label class="field"><span>Scenes</span><select data-scene-list></select></label>',
      '<label class="field"><span>Name</span><input data-scene-name type="text" placeholder="main" /></label>',
      '<div class="panel-actions">',
      '<button data-scene-new>New</button>',
      '<button data-scene-load>Load</button>',
      '<button data-scene-save>Save</button>',
      '<button data-scene-delete>Delete</button>',
      '</div>',
      '<div class="clip-status" data-scene-status></div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Obstacles JSON</div>',
      '<textarea data-scene-obstacles rows="12"></textarea>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Level Tools</div>',
      '<label class="field"><span>Builder Tool</span><select data-level-build-tool><option value="select">Select / Transform</option><option value="drop_box">Dropper: Box</option><option value="drop_zone">Dropper: Zone</option><option value="drop_ground">Dropper: Ground</option><option value="drop_player">Dropper: Player</option><option value="drop_crowd">Dropper: Crowd</option><option value="drop_road_point">Road: Add Point</option><option value="sculpt_raise">Sculpt: Raise</option><option value="sculpt_lower">Sculpt: Lower</option><option value="sculpt_smooth">Sculpt: Smooth</option><option value="sculpt_flatten">Sculpt: Flatten</option></select></label>',
      '<label class="field"><span>Selected</span><select data-level-object></select></label>',
      '<div class="panel-title">Scene Hierarchy</div>',
      '<label class="field"><span>Search</span><input data-level-hierarchy-search type="text" placeholder="Filter objects..." /></label>',
      '<div class="bone-list" data-level-hierarchy></div>',
      '<div class="panel-actions">',
      '<button data-level-add>Add Box</button>',
      '<button data-level-add-zone>Add Zone</button>',
      '<button data-level-add-ground>Place Ground</button>',
      '<button data-level-add-player>Place Player</button>',
      '<button data-level-add-crowd>Place Crowd</button>',
      '<label class="field"><span>Model Asset</span><select data-level-model-spawn-select><option value="">Select model</option></select></label>',
      '<button data-level-add-model>Spawn Model</button>',
      '<button data-level-duplicate>Duplicate</button>',
      '<button data-level-delete>Delete</button>',
      '<button data-level-undo>Undo</button>',
      '<button data-level-redo>Redo</button>',
      '</div>',
      '<label class="field"><span>Transform Mode</span><select data-level-transform-mode><option value="translate">Move</option><option value="rotate">Rotate</option><option value="scale">Scale</option></select></label>',
      '<label class="field"><span>Snap Step</span><input data-level-snap type="number" min="0" step="0.1" value="0.5" /></label>',
      '<button data-level-focus>Focus Selected</button>',
      '<div class="panel-title">Inspector</div>',
      '<label class="field"><span>Object ID</span><input data-level-inspector-id type="text" readonly /></label>',
      '<label class="field"><span>Preset</span><select data-level-component-preset><option value="none">None</option><option value="door">Door</option><option value="pickup">Pickup</option><option value="checkpoint">Checkpoint</option><option value="spawner">Spawner</option></select></label>',
      '<button data-level-component-apply>Apply Preset</button>',
      '<label class="field"><span>Component JSON</span><textarea data-level-component-json rows="8" placeholder="{&quot;type&quot;:&quot;door&quot;}"></textarea></label>',
      '<button data-level-component-save>Save Component</button>',
      '<div class="panel-title">Zone Inspector</div>',
      '<label class="field"><span>Name</span><input data-level-zone-name type="text" placeholder="Zone Name" /></label>',
      '<label class="field"><span>Tag</span><input data-level-zone-tag type="text" placeholder="optional-tag" /></label>',
      '<label class="field"><span>Type</span><select data-level-zone-type><option value="trigger">Trigger</option><option value="spawn">Spawn</option><option value="damage">Damage</option><option value="safe">Safe</option></select></label>',
      '<button data-level-zone-apply>Apply Zone Meta</button>',
      '<div class="panel-title">Terrain Generator</div>',
      '<label class="field"><span>Preset</span><select data-level-terrain-preset><option value="cinematic">Cinematic</option><option value="alpine">Alpine</option><option value="dunes">Dunes</option><option value="islands">Islands</option></select></label>',
      '<label class="field"><span>Texture</span><select data-level-terrain-texture><option value="concrete">Concrete</option><option value="grass">Grass</option><option value="sand">Sand</option><option value="rock">Rock</option><option value="snow">Snow</option><option value="lava">Lava</option></select></label>',
      '<div class="panel-title">Object Asset Library</div>',
      '<div class="model-list level-model-library" data-level-model-library><div class="clip-status">No saved objects yet.</div></div>',
      '<div class="panel-title">Water Layer</div>',
      '<label class="field"><span>Enabled</span><input data-level-water-enabled type="checkbox" /></label>',
      '<label class="field"><span>Level Offset</span><input data-level-water-level type="number" step="0.02" value="0.08" /></label>',
      '<label class="field"><span>Opacity</span><input data-level-water-opacity type="number" min="0.1" max="1" step="0.01" value="0.78" /></label>',
      '<label class="field"><span>Wave Amp</span><input data-level-water-wave-amp type="number" min="0" max="3" step="0.01" value="0.22" /></label>',
      '<label class="field"><span>Wave Freq</span><input data-level-water-wave-freq type="number" min="0.01" max="2" step="0.01" value="0.16" /></label>',
      '<label class="field"><span>Wave Speed</span><input data-level-water-wave-speed type="number" min="0" max="8" step="0.05" value="1.1" /></label>',
      '<label class="field"><span>Shallow Color</span><input data-level-water-color-shallow type="color" value="#2f97d0" /></label>',
      '<label class="field"><span>Deep Color</span><input data-level-water-color-deep type="color" value="#081c47" /></label>',
      '<label class="field"><span>Specular</span><input data-level-water-specular type="number" min="0" max="4" step="0.05" value="1.35" /></label>',
      '<label class="field"><span>Size</span><input data-level-terrain-size type="number" min="16" max="320" step="4" value="96" /></label>',
      '<label class="field"><span>Resolution</span><input data-level-terrain-res type="number" min="8" max="56" step="1" value="28" /></label>',
      '<label class="field"><span>Max Height</span><input data-level-terrain-height type="number" min="1" max="64" step="0.5" value="10" /></label>',
      '<label class="field"><span>Roughness</span><input data-level-terrain-roughness type="number" min="0.2" max="0.95" step="0.01" value="0.56" /></label>',
      '<label class="field"><span>Seed</span><input data-level-terrain-seed type="number" step="1" value="1337" /></label>',
      '<div class="panel-actions">',
      '<button data-level-terrain-generate>Apply Mesh</button>',
      '<button data-level-terrain-append>Remix Seed</button>',
      '<button data-level-terrain-clear>Clear Terrain</button>',
      '</div>',
      '<div class="panel-actions">',
      '<label class="field"><span>Sculpt Radius</span><input data-level-sculpt-radius type="number" min="0.5" max="64" step="0.5" value="5" /></label>',
      '<label class="field"><span>Sculpt Strength</span><input data-level-sculpt-strength type="number" min="0.02" max="2" step="0.02" value="0.35" /></label>',
      '</div>',
      '<div class="clip-status" data-level-terrain-status>Procedural terrain deforms the ground mesh from a seeded heightfield.</div>',
      '<div class="panel-title">Road / Path Tool</div>',
      '<label class="field"><span>Road Name</span><input data-level-road-name type="text" placeholder="Road A" /></label>',
      '<div class="panel-actions">',
      '<button data-level-road-new>New Road</button>',
      '<button data-level-road-add-point>Add Point At Camera</button>',
      '<button data-level-road-pop-point>Undo Point</button>',
      '<button data-level-road-clear>Clear Roads</button>',
      '</div>',
      '<label class="field"><span>Road Width</span><input data-level-road-width type="number" min="1" max="30" step="0.25" value="3" /></label>',
      '<label class="field"><span>Material</span><select data-level-road-material><option value="asphalt">Asphalt</option><option value="dirt">Dirt</option><option value="neon">Neon</option></select></label>',
      '<div class="clip-status" data-level-road-status>Create a road, then use Road: Add Point tool and click in scene.</div>',
      '<div class="panel-title">Environment Preset Stack</div>',
      '<label class="field"><span>Preset</span><select data-level-environment-preset><option value="clear_day">Clear Day</option><option value="sunset">Sunset</option><option value="night">Night</option><option value="foggy">Foggy</option><option value="overcast">Overcast</option></select></label>',
      '<label class="field"><span>Fog Near</span><input data-level-environment-fog-near type="number" min="2" max="500" step="1" value="12" /></label>',
      '<label class="field"><span>Fog Far</span><input data-level-environment-fog-far type="number" min="8" max="1200" step="1" value="140" /></label>',
      '<label class="field"><span>Skybox</span><input data-level-environment-skybox-enabled type="checkbox" /></label>',
      '<label class="field"><span>Skybox Preset</span><select data-level-environment-skybox-preset><option value="clear_day">Clear Day</option><option value="sunset_clouds">Sunset Clouds</option><option value="midnight_stars">Midnight Stars</option><option value="nebula">Nebula</option></select></label>',
      '<label class="field"><span>Skybox Intensity</span><input data-level-environment-skybox-intensity type="number" min="0.2" max="2" step="0.05" value="1" /></label>',
      '<div class="panel-actions"><button data-level-environment-apply>Apply Environment</button></div>',
      '<div class="panel-title">No-Code Logic</div>',
      '<div class="panel-actions">',
      '<select data-level-logic-template><option value="custom">Template: Custom</option><option value="door_interact">Door Interaction</option><option value="zone_damage">Damage Zone</option><option value="checkpoint_touch">Checkpoint Touch</option><option value="portal_transition">Portal Transition</option></select>',
      '<button data-level-logic-template-apply>Apply Template</button>',
      '</div>',
      '<div class="panel-actions">',
      '<select data-level-logic-trigger><option value="onStart">On Start</option><option value="onInteract">On Interact</option><option value="onZoneEnter">On Zone Enter</option><option value="onTimer">On Timer</option></select>',
      '<select data-level-logic-action><option value="spawn">Spawn</option><option value="toggleDoor">Toggle Door</option><option value="showUi">Show UI</option><option value="setCheckpoint">Set Checkpoint</option><option value="sceneTransition">Scene Transition</option></select>',
      '</div>',
      '<label class="field"><span>Target</span><input data-level-logic-target type="text" placeholder="selected object id or scene" /></label>',
      '<label class="field"><span>Params JSON</span><input data-level-logic-params type="text" placeholder="{&quot;key&quot;:&quot;value&quot;}" /></label>',
      '<div class="panel-actions">',
      '<button data-level-logic-use-selected>Use Selected</button>',
      '<button data-level-logic-use-zone>Use Selected Zone</button>',
      '<button data-level-logic-add>Add Rule</button>',
      '<button data-level-logic-clear>Clear Logic</button>',
      '</div>',
      '<div class="bone-list" data-level-logic-list></div>',
      '<div class="panel-actions">',
      '<button data-level-logic-node-add-trigger>Add Trigger Node</button>',
      '<button data-level-logic-node-add-action>Add Action Node</button>',
      '<button data-level-logic-node-connect>Connect Selected</button>',
      '<button data-level-logic-node-delete>Delete Node(s)</button>',
      '<button data-level-logic-node-clear-selection>Clear Selection</button>',
      '<button data-level-logic-node-copy>Copy</button>',
      '<button data-level-logic-node-paste>Paste</button>',
      '</div>',
      '<div class="bone-list level-logic-graph-wrap" data-level-logic-graph></div>',
      '<div class="clip-status" data-level-logic-graph-status>Select nodes (Ctrl/Cmd for multi-select). Drag nodes to layout graph.</div>',
      '<canvas class="level-logic-minimap" data-level-logic-minimap width="260" height="120"></canvas>',
      '<div class="panel-title">Logic Preview</div>',
      '<div class="panel-actions">',
      '<select data-level-logic-preview-trigger><option value="onStart">On Start</option><option value="onInteract">On Interact</option><option value="onZoneEnter">On Zone Enter</option><option value="onTimer">On Timer</option></select>',
      '<input data-level-logic-preview-target type="text" placeholder="optional target filter" />',
      '</div>',
      '<div class="panel-actions">',
      '<button data-level-logic-preview-run>Run Preview</button>',
      '<button data-level-logic-preview-clear>Clear Log</button>',
      '</div>',
      '<div class="bone-list" data-level-logic-preview-log><div class="clip-status">No preview run yet.</div></div>',
      '<label class="field"><span>Scene Logic JSON</span><textarea data-scene-logic rows="8" placeholder="{&quot;nodes&quot;:[],&quot;links&quot;:[]}"></textarea></label>',
      '<div class="clip-status" data-level-status>Select an object in viewport or list to edit transform.</div>',
      '</div>',
      '</div>',
      '<div class="editor-right" data-tab-panel="level" style="display:none;">',
      '<div class="panel level-context-panel">',
      '<div class="panel-title">Context Inspector</div>',
      '<label class="field level-readout"><span>ID</span><code data-level-context-selection-id>none</code></label>',
      '<label class="field level-readout"><span>Kind</span><code data-level-context-selection-kind>none</code></label>',
      '<label class="field level-readout"><span>Count</span><code data-level-context-selection-count>0</code></label>',
      '<label class="field"><span>Transform Readout</span><textarea data-level-context-transform rows="5" readonly>Position: none\nRotation: none\nScale: none</textarea></label>',
      '<div class="clip-status" data-level-context-hints>Select an object in Scene Hierarchy or click one in the viewport to inspect it.</div>',
      '<div class="panel-title">Quick Actions</div>',
      '<div class="panel-actions" data-level-context-actions data-selection-id="none" data-selection-kind="none" data-selection-count="0">',
      '<button type="button" data-level-context-action="focus" data-level-focus-proxy>Focus</button>',
      '<button type="button" data-level-context-action="duplicate" data-level-duplicate-proxy>Duplicate</button>',
      '<button type="button" data-level-context-action="delete" data-level-delete-proxy>Delete</button>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="editor-view" data-viewport>',
      '<div class="viewport-overlay">',
      '<div class="level-command-bar" data-level-command-bar>',
      '<div class="level-command-group" role="group" aria-label="Transform tools">',
      '<button class="level-command-btn" data-level-tool-select>Select</button>',
      '<button class="level-command-btn" data-level-tool-move>Move</button>',
      '<button class="level-command-btn" data-level-tool-rotate>Rotate</button>',
      '<button class="level-command-btn" data-level-tool-scale>Scale</button>',
      '</div>',
      '<div class="level-command-group" role="group" aria-label="Snap controls">',
      '<button class="level-command-btn" data-level-snap-toggle>Snap</button>',
      '<label class="level-command-input"><span>Step</span><input data-level-snap-top type="number" min="0" step="0.1" value="0.5" /></label>',
      '</div>',
      '<div class="level-command-group" role="group" aria-label="Transform space">',
      '<button class="level-command-btn" data-level-space-toggle data-space="world">Space: World</button>',
      '</div>',
      '<div class="level-command-group" role="group" aria-label="Group operations">',
      '<button class="level-command-btn" data-level-group-duplicate>Group Duplicate</button>',
      '<button class="level-command-btn" data-level-group-delete>Group Delete</button>',
      '<button class="level-command-btn" data-level-focus-selection>Focus Selection</button>',
      '</div>',
      '</div>',
      '<div class="level-panel-toolbar" data-level-panel-toolbar></div>',
      '<div class="level-floating-root" data-level-floating-root></div>',
      '<div class="overlay-stack">',
      '<div class="overlay-group">',
      '<button class="icon-btn" data-bones-toggle title="Toggle Bones">B</button>',
      '<label class="overlay-slider" data-bone-scale-wrap style="display:none;">',
      '<span>Size</span>',
      '<input data-bone-scale type="range" min="0.25" max="1.75" step="0.05" />',
      '</label>',
      '<button class="icon-btn" data-reset title="Reset Pose">R</button>',
      '<button class="icon-btn" data-clear title="Clear Clip">C</button>',
      '</div>',
      '</div>',
      '<button class="level-camera-toggle" data-level-camera-mode title="Free-fly camera: pan/rotate/zoom anywhere">Camera: Free Fly</button>',
      '<div class="overlay-bottom-left">',
      '<div class="overlay-panel">',
      '<label class="field"><span>FBX</span><input data-mixamo-file type="file" accept=".fbx" multiple /></label>',
      '<label class="field"><span>Clip</span><select data-mixamo-clip></select></label>',
      '<div class="panel-actions">',
      '<button data-mixamo-preview>Preview</button>',
      '<button data-mixamo-bake>Bake</button>',
      '<button data-mixamo-stop>Stop</button>',
      '</div>',
      '<div class="clip-status" data-mixamo-status>FBX: none</div>',
      '<div class="overlay-clip-panel" data-clip-panel>',
      '<div class="panel-title">Clip Data</div>',
      '<label class="field"><span>Name</span><input data-clip-name type="text" placeholder="idle" /></label>',
      '<label class="field"><span>File</span><select data-clip-files></select></label>',
      '<div class="panel-actions">',
      '<button data-save>Save</button>',
      '<button data-load>Load</button>',
      '<button data-refresh>Refresh</button>',
      '</div>',
      '<div class="clip-status" data-clip-status></div>',
      '<button data-download>Download JSON</button>',
      '<textarea data-json rows="8"></textarea>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="axis-widget" aria-hidden="true">',
      '<canvas data-axis width="80" height="80"></canvas>',
      '</div>',
      '<div class="bone-overlay" data-bone-overlay>',
      '<div class="bone-overlay-title">Bone</div>',
      '<label class="field"><span>Rot X</span><input data-rot-x type="range" min="-3.14" max="3.14" step="0.01" /></label>',
      '<label class="field"><span>Rot Y</span><input data-rot-y type="range" min="-3.14" max="3.14" step="0.01" /></label>',
      '<label class="field"><span>Rot Z</span><input data-rot-z type="range" min="-3.14" max="3.14" step="0.01" /></label>',
      '<div class="bone-overlay-pos" data-pos-group>',
      '<label class="field"><span>Pos X</span><input data-pos-x type="range" min="-2" max="2" step="0.01" /></label>',
      '<label class="field"><span>Pos Y</span><input data-pos-y type="range" min="-2" max="2" step="0.01" /></label>',
      '<label class="field"><span>Pos Z</span><input data-pos-z type="range" min="-2" max="2" step="0.01" /></label>',
      '</div>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="editor-bottom" data-tab-panel="animation">',
      '<div class="timeline-labels">',
      '<div class="timeline-slider">',
      '<input data-time type="range" min="0" max="10" step="0.01" />',
      '</div>',
      '<div class="timeline-controls">',
      '<button data-step-back>&lt;</button>',
      '<button data-play>Play</button>',
      '<button data-stop>Stop</button>',
      '<button data-step-forward>&gt;</button>',
      '<button data-add>Keyframe</button>',
      '<span class="timeline-title">Timeline</span>',
      '<button data-override>Override Off</button>',
      '<button data-ragdoll>Ragdoll On/Off</button>',
      '<button data-ragdoll-visual>Ragdoll Visual</button>',
      '<button data-ragdoll-reset>Ragdoll Reset</button>',
      '<button data-ragdoll-record>Record</button>',
      '<button data-ragdoll-stop>Stop Rec</button>',
      `<label class="duration-field"><span>FPS</span><input data-fps type="number" min="5" max="60" step="1" value="${SAMPLE_RATE}" /></label>`,
      `<label class="duration-field"><span>Frames</span><input data-duration type="number" min="1" max="600" step="1" value="${DEFAULT_TIMELINE_FRAMES}" /></label>`,
      '</div>',
      '<span class="timeline-status" data-mixamo-status>FBX: none</span>',
      '<span class="timeline-status" data-ragdoll-status>Ragdoll: off</span>',
      '</div>',
      '<div class="timeline-grid timeline-midi">',
      '<div class="timeline-header" data-timeline-header></div>',
      '<div class="timeline-canvas-wrap" data-timeline-wrap>',
      '<div class="timeline-override-range" data-override-range hidden>',
      '<div class="timeline-override-frame" data-override-frame></div>',
      '<div class="timeline-override-handle start" data-override-start-handle></div>',
      '<div class="timeline-override-handle end" data-override-end-handle></div>',
      '</div>',
      '<canvas data-timeline height="64"></canvas>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="editor-bottom player-bottom" data-tab-panel="player" style="display:none;">',
      '<div class="player-bottom-grid">',
      '<div class="panel">',
      '<div class="panel-title">Config Preview</div>',
      '<textarea data-player-json rows="10"></textarea>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Notes</div>',
      '<div class="clip-status">Edit values above, then Save to write the game player.json.</div>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="editor-bottom player-bottom" data-tab-panel="level" style="display:none;">',
      '<div class="player-bottom-grid">',
      '<div class="panel">',
      '<div class="panel-title">Scene JSON (Read-only)</div>',
      '<textarea data-scene-json rows="10" readonly></textarea>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Tips</div>',
      '<div class="clip-status">Edit obstacles in the Obstacles JSON panel above. Changes are automatically synced to Scene JSON. Click Save to write to the selected game.</div>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="editor-left" data-tab-panel="model" style="display:none;">',
      '<div class="panel">',
      '<div class="panel-title">Model Library</div>',
      '<label class="field"><span>Model Name</span><input data-model-name type="text" placeholder="Crate A" /></label>',
      '<label class="field"><span>Model ID (optional)</span><input data-model-id type="text" placeholder="crate-a" /></label>',
      '<label class="field"><span>FBX Source File</span><input data-model-source-file type="text" placeholder="crate.fbx" /></label>',
      '<label class="field"><span>FBX Upload</span><input data-model-fbx-file type="file" accept=".fbx" /></label>',
      '<label class="field"><span>Origin Offset X</span><input data-model-origin-x type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Origin Offset Y</span><input data-model-origin-y type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Origin Offset Z</span><input data-model-origin-z type="number" step="0.01" value="0" /></label>',
      '<div class="panel-title">Collider</div>',
      '<label class="field"><span>Shape</span><select data-model-collider-shape><option value="box">Box</option><option value="sphere">Sphere</option><option value="capsule">Capsule</option><option value="mesh">Mesh</option></select></label>',
      '<label class="field"><span>Size X</span><input data-model-collider-size-x type="number" min="0.05" step="0.05" value="1" /></label>',
      '<label class="field"><span>Size Y</span><input data-model-collider-size-y type="number" min="0.05" step="0.05" value="1" /></label>',
      '<label class="field"><span>Size Z</span><input data-model-collider-size-z type="number" min="0.05" step="0.05" value="1" /></label>',
      '<label class="field"><span>Radius</span><input data-model-collider-radius type="number" min="0.05" step="0.05" value="0.5" /></label>',
      '<label class="field"><span>Height</span><input data-model-collider-height type="number" min="0.1" step="0.05" value="1.8" /></label>',
      '<label class="field"><span>Offset X</span><input data-model-collider-offset-x type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Offset Y</span><input data-model-collider-offset-y type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Offset Z</span><input data-model-collider-offset-z type="number" step="0.01" value="0" /></label>',
      '<label class="field"><span>Trigger</span><input data-model-collider-trigger type="checkbox" /></label>',
      '<div class="panel-title">Physics</div>',
      '<label class="field"><span>Enable Physics</span><input data-model-physics-enabled type="checkbox" checked /></label>',
      '<label class="field"><span>Body Type</span><select data-model-physics-body-type><option value="dynamic" selected>Dynamic</option><option value="static">Static</option><option value="kinematic">Kinematic</option></select></label>',
      '<label class="field"><span>Mass</span><input data-model-physics-mass type="number" min="0.01" step="0.1" value="1" /></label>',
      '<label class="field"><span>Friction</span><input data-model-physics-friction type="number" min="0" max="2" step="0.01" value="0.6" /></label>',
      '<label class="field"><span>Restitution</span><input data-model-physics-restitution type="number" min="0" max="1" step="0.01" value="0.1" /></label>',
      '<label class="field"><span>Linear Damping</span><input data-model-physics-linear-damping type="number" min="0" max="10" step="0.05" value="0.05" /></label>',
      '<label class="field"><span>Angular Damping</span><input data-model-physics-angular-damping type="number" min="0" max="10" step="0.05" value="0.1" /></label>',
      '<label class="field"><span>Gravity Scale</span><input data-model-physics-gravity-scale type="number" min="-2" max="2" step="0.05" value="1" /></label>',
      '<div class="panel-title">Physics Test</div>',
      '<label class="field"><span>Drop Height</span><input data-model-physics-spawn-height type="number" min="-10" max="50" step="0.1" value="1" /></label>',
      '<label class="field"><span>Velocity X</span><input data-model-physics-velocity-x type="number" min="-30" max="30" step="0.1" value="0" /></label>',
      '<label class="field"><span>Velocity Y</span><input data-model-physics-velocity-y type="number" min="-30" max="30" step="0.1" value="0" /></label>',
      '<label class="field"><span>Velocity Z</span><input data-model-physics-velocity-z type="number" min="-30" max="30" step="0.1" value="0" /></label>',
      '<div class="panel-actions">',
      '<button data-model-physics-test-drop type="button">Preset Drop Test</button>',
      '<button data-model-physics-test-push type="button">Preset Push Test</button>',
      '<button data-model-physics-test-clear type="button">Clear Test</button>',
      '</div>',
      '<label class="field"><span>Base Color Upload</span><input data-model-base-color-file type="file" accept=".png,.jpg,.jpeg,.webp,.ktx2" /></label>',
      '<label class="field"><span>Normal Upload</span><input data-model-normal-file type="file" accept=".png,.jpg,.jpeg,.webp,.ktx2" /></label>',
      '<label class="field"><span>Roughness Upload</span><input data-model-roughness-file type="file" accept=".png,.jpg,.jpeg,.webp,.ktx2" /></label>',
      '<label class="field"><span>Metalness Upload</span><input data-model-metalness-file type="file" accept=".png,.jpg,.jpeg,.webp,.ktx2" /></label>',
      '<label class="field"><span>Emissive Upload</span><input data-model-emissive-file type="file" accept=".png,.jpg,.jpeg,.webp,.ktx2" /></label>',
      '<div class="clip-status" data-model-base-color-path>Base Color: none</div>',
      '<div class="clip-status" data-model-normal-path>Normal: none</div>',
      '<div class="clip-status" data-model-roughness-path>Roughness: none</div>',
      '<div class="clip-status" data-model-metalness-path>Metalness: none</div>',
      '<div class="clip-status" data-model-emissive-path>Emissive: none</div>',
      '<div class="panel-actions">',
      '<button data-model-save>Save Model</button>',
      '<button data-model-preview>Preview Model</button>',
      '<button data-model-clear>Clear Form</button>',
      '<button data-model-refresh>Refresh</button>',
      '</div>',
      '<div class="clip-status" data-model-status>Select a game and save a model record.</div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Saved Models</div>',
      '<div class="model-list" data-model-list><div class="clip-status">No models yet.</div></div>',
      '</div>',
      '</div>',
      '<div class="editor-left" data-tab-panel="settings" style="display:none;">',
      '<div class="panel">',
      '<div class="panel-title">Retro Graphics</div>',
      '<label class="field">',
      '<span>Style Preset</span>',
      '<select data-style-preset>',
      '<option value="legacy">Legacy</option>',
      '<option value="soft">Soft Focus</option>',
      '<option value="arcade">Arcade Clean</option>',
      '<option value="cinematic">Cinematic</option>',
      '<option value="modern">Modern (No Effects)</option>',
      '</select>',
      '</label>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Color & Lighting</div>',
      '<label class="field">',
      '<span>Brightness: <strong data-brightness-val>1.00</strong></span>',
      '<input data-brightness type="range" min="0.5" max="2.0" step="0.05" value="1.0" />',
      '</label>',
      '<label class="field">',
      '<span>Contrast: <strong data-contrast-val>1.00</strong></span>',
      '<input data-contrast type="range" min="0.5" max="2.0" step="0.05" value="1.0" />',
      '</label>',
      '<label class="field">',
      '<span>Saturation: <strong data-saturation-val>1.00</strong></span>',
      '<input data-saturation type="range" min="0.0" max="2.0" step="0.05" value="1.0" />',
      '</label>',
      '<label class="field">',
      '<span>Gamma: <strong data-gamma-val>1.00</strong></span>',
      '<input data-gamma type="range" min="0.5" max="2.0" step="0.05" value="1.0" />',
      '</label>',
      '<label class="field">',
      '<span>Exposure: <strong data-exposure-val>1.00</strong></span>',
      '<input data-exposure type="range" min="0.5" max="2.0" step="0.05" value="1.0" />',
      '</label>',
      '</div>',
      '</div>',
    ].join('');

    // ============================================================================
    // GAME MANAGEMENT
    // ============================================================================

    const gameSelect = hud.querySelector('[data-game-select]') as HTMLSelectElement;
    const newGameBtn = hud.querySelector('[data-new-game]') as HTMLButtonElement;
    const deleteGameBtn = hud.querySelector('[data-delete-game]') as HTMLButtonElement;
    const backMenuBtn = hud.querySelector('[data-back-menu]') as HTMLButtonElement;
    backMenuBtn.addEventListener('click', () => {
      this.onBackToMenu?.();
    });
    const updateDeleteGameButtonState = () => {
      const selectedId = this.currentGameId;
      deleteGameBtn.disabled = !selectedId || selectedId === 'prototype';
      deleteGameBtn.title =
        selectedId === 'prototype' ? 'Prototype is protected and cannot be deleted' : '';
    };

    // Fetch and populate games list
    const loadGamesList = async (cacheBust = false) => {
      try {
        const games = await listGames(cacheBust);
        gameSelect.innerHTML = '<option value="">-- Select Game --</option>';
        for (const game of games) {
          const option = document.createElement('option');
          option.value = game.id;
          option.textContent = game.name;
          gameSelect.appendChild(option);
        }

        // Load saved game from localStorage, or default to prototype
        const savedGameId = localStorage.getItem('editorGameId');
        const prototypeGame = games.find((p) => p.id === 'prototype');
        const initialGameExists =
          this.initialGameId && games.find((p) => p.id === this.initialGameId);

        if (initialGameExists && this.initialGameId) {
          // Main menu launch selection takes precedence
          this.currentGameId = this.initialGameId;
          gameSelect.value = this.initialGameId;
          localStorage.setItem('editorGameId', this.initialGameId);
        } else if (savedGameId && games.find((p) => p.id === savedGameId)) {
          // Saved game exists, use it
          this.currentGameId = savedGameId;
          gameSelect.value = savedGameId;
        } else if (prototypeGame) {
          // No saved game, fall back to prototype if it exists
          this.currentGameId = 'prototype';
          gameSelect.value = 'prototype';
          localStorage.setItem('editorGameId', 'prototype');
        } else if (games[0]) {
          this.currentGameId = games[0].id;
          gameSelect.value = games[0].id;
          localStorage.setItem('editorGameId', games[0].id);
        }

        // Schedule asset loading (will retry if functions not ready yet)
        if (this.currentGameId) {
          // First verify API endpoints are working
          setTimeout(async () => {
            console.log('=== Editor Initialization Debug ===');
            console.log('Selected game:', this.currentGameId);

            // Test animations endpoint
            try {
              const animPath = `/api/games/${this.currentGameId}/animations`;
              console.log('Testing:', animPath);
              const res = await fetch(animPath);
              if (res.ok) {
                const data = await res.json();
                console.log('✓ Animations API response:', data);
              } else {
                console.error('✗ Animations API failed:', res.status);
              }
            } catch (err) {
              console.error('✗ Animations API error:', err);
            }

            // Test scenes endpoint
            try {
              const scenesPath = `/api/games/${this.currentGameId}/scenes`;
              console.log('Testing:', scenesPath);
              const res = await fetch(scenesPath);
              if (res.ok) {
                const data = await res.json();
                console.log('✓ Scenes API response:', data);
              } else {
                console.error('✗ Scenes API failed:', res.status);
              }
            } catch (err) {
              console.error('✗ Scenes API error:', err);
            }

            console.log('Starting asset loading...');
            this.loadGameAssets(0);
          }, 100);
        }
        updateDeleteGameButtonState();
      } catch (err) {
        console.error('Error loading games list:', err);
      }
    };

    const selectGame = async (gameId: string) => {
      if (!gameId) {
        this.currentGameId = null;
        localStorage.removeItem('editorGameId');
        updateDeleteGameButtonState();
        return;
      }
      this.currentGameId = gameId;
      localStorage.setItem('editorGameId', gameId);
      updateDeleteGameButtonState();
      // Reload assets for this game
      await this.loadGameAssets();
    };

    // Game selection handler
    gameSelect.addEventListener('change', async () => {
      await selectGame(gameSelect.value);
    });

    // New game handler
    newGameBtn.addEventListener('click', async () => {
      const name = prompt('Enter game name:');
      if (!name) return;

      const description = prompt('Enter game description (optional):') || '';

      try {
        const data = await createGame({ name, description });
        this.currentGameId = data.id;
        localStorage.setItem('editorGameId', data.id);

        // Refresh games list
        await loadGamesList(true);
        gameSelect.value = data.id;

        // Load empty assets for new game
        await this.loadGameAssets();

        alert(`Game "${data.name}" created successfully!`);
      } catch (err) {
        console.error('Error creating game:', err);
        alert(`Error creating game: ${String(err)}`);
      }
    });

    deleteGameBtn.addEventListener('click', async () => {
      const gameId = this.currentGameId;
      if (!gameId) {
        alert('Select a game first.');
        return;
      }
      if (gameId === 'prototype') {
        alert('Prototype is protected and cannot be deleted.');
        return;
      }
      const label = gameSelect.options[gameSelect.selectedIndex]?.textContent?.trim() || gameId;
      const confirmed = confirm(
        `Delete game "${label}" (${gameId})?\n\nThis removes all scenes, animations, avatars, assets, and logic for this game.`,
      );
      if (!confirmed) return;

      try {
        await deleteGame(gameId);
        if (localStorage.getItem('editorGameId') === gameId) {
          localStorage.removeItem('editorGameId');
        }
        this.currentGameId = null;
        gameSelect.value = '';
        const optionToRemove = Array.from(gameSelect.options).find(
          (option) => option.value === gameId,
        );
        optionToRemove?.remove();
        updateDeleteGameButtonState();
        await loadGamesList(true);
        alert(`Game "${label}" deleted.`);
      } catch (err) {
        console.error('Error deleting game:', err);
        alert(`Error deleting game: ${String(err)}`);
      }
    });

    this.loadGamesListFunction = loadGamesList;
    this.selectGameFunction = async (gameId: string) => {
      gameSelect.value = gameId;
      await selectGame(gameId);
    };

    // Load games list on startup
    loadGamesList();

    const tabButtons = Array.from(hud.querySelectorAll('[data-tab]')) as HTMLButtonElement[];
    const tabPanels = Array.from(hud.querySelectorAll('[data-tab-panel]')) as HTMLDivElement[];
    this.externalPanelNodes.clear();
    for (const panel of tabPanels) {
      const tab = panel.dataset.tabPanel as
        | 'animation'
        | 'player'
        | 'level'
        | 'model'
        | 'settings'
        | undefined;
      if (!tab) continue;
      if (panel.classList.contains('editor-left')) {
        this.externalPanelNodes.set(`left:${tab}`, panel);
      } else if (panel.classList.contains('editor-right')) {
        this.externalPanelNodes.set(`right:${tab}`, panel);
      } else if (panel.classList.contains('editor-bottom')) {
        this.externalPanelNodes.set(`bottom:${tab}`, panel);
      }
    }
    const panels = Array.from(hud.querySelectorAll('.panel')) as HTMLDivElement[];
    for (const panel of panels) {
      const title = panel.querySelector('.panel-title') as HTMLDivElement | null;
      if (!title) continue;
      const body = document.createElement('div');
      body.className = 'panel-body';
      const nodes = Array.from(panel.childNodes);
      const startIndex = nodes.indexOf(title);
      for (let i = startIndex + 1; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!node) continue;
        body.appendChild(node);
      }
      panel.appendChild(body);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'panel-toggle';
      toggle.textContent = '–';
      title.appendChild(toggle);
      title.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).classList.contains('panel-toggle')) {
          // allow button to trigger too
        }
        const collapsed = panel.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '+' : '–';
      });
    }

    const levelPanelToolbar = hud.querySelector('[data-level-panel-toolbar]') as HTMLDivElement | null;
    const levelFloatingRoot = hud.querySelector('[data-level-floating-root]') as HTMLDivElement | null;
    const levelViewport = hud.querySelector('.editor-view[data-viewport]') as HTMLDivElement | null;
    const levelPanelSources = Array.from(
      hud.querySelectorAll(
        '.editor-left[data-tab-panel="level"] .panel, .editor-right[data-tab-panel="level"] .panel, .editor-bottom[data-tab-panel="level"] .panel',
      ),
    ) as HTMLDivElement[];
    const floatingPanelsById = new Map<string, HTMLDivElement>();
    const floatingButtonsById = new Map<string, HTMLButtonElement>();
    let floatingPanelZ = 40;
    const defaultOpenPanels = new Set<string>();
    const defaultPositionByTitle = new Map<string, { x: number; y: number }>([
      ['Scene', { x: 16, y: 74 }],
      ['Obstacles JSON', { x: 16, y: 288 }],
      ['Level Tools', { x: 324, y: 74 }],
      ['Inspector', { x: 324, y: 288 }],
      ['Zone Inspector', { x: 632, y: 74 }],
      ['Terrain Generator', { x: 632, y: 288 }],
      ['Road / Path Tool', { x: 940, y: 74 }],
      ['Environment Preset Stack', { x: 940, y: 288 }],
      ['No-Code Logic', { x: 1248, y: 74 }],
      ['Logic Preview', { x: 1248, y: 342 }],
      ['Context Inspector', { x: 16, y: 520 }],
      ['Quick Actions', { x: 324, y: 520 }],
      ['Scene JSON (Read-only)', { x: 632, y: 520 }],
      ['Tips', { x: 940, y: 520 }],
    ]);
    const floatingGridGap = 12;
    const floatingGridStartX = 12;
    const floatingGridStartY = 108;
    const floatingGridColumnWidth = 332;
    let floatingGridColumnHeights: number[] = [];

    const resetFloatingGridLayout = () => {
      if (!levelViewport) {
        floatingGridColumnHeights = [floatingGridStartY];
        return;
      }
      const usableWidth = Math.max(280, levelViewport.clientWidth - floatingGridStartX * 2);
      const columns = Math.max(
        1,
        Math.floor((usableWidth + floatingGridGap) / (floatingGridColumnWidth + floatingGridGap)),
      );
      floatingGridColumnHeights = Array(columns).fill(floatingGridStartY);
    };

    const placeFloatingPanelInGrid = (panel: HTMLDivElement, preferred?: { x: number; y: number }) => {
      if (!levelViewport) return;
      if (floatingGridColumnHeights.length === 0) resetFloatingGridLayout();
      const viewportWidth = Math.max(280, levelViewport.clientWidth);
      const usePreferred =
        preferred &&
        viewportWidth >= 1540 &&
        preferred.x >= 8 &&
        preferred.x <= viewportWidth - 260 &&
        preferred.y >= 8;
      if (usePreferred) {
        panel.style.left = `${preferred.x}px`;
        panel.style.top = `${preferred.y}px`;
        clampFloatingPanel(panel);
        return;
      }
      let targetColumn = 0;
      let targetHeight = floatingGridColumnHeights[0] ?? floatingGridStartY;
      for (let i = 1; i < floatingGridColumnHeights.length; i += 1) {
        const nextHeight = floatingGridColumnHeights[i] ?? Number.POSITIVE_INFINITY;
        if (nextHeight < targetHeight) {
          targetColumn = i;
          targetHeight = nextHeight;
        }
      }
      const x = floatingGridStartX + targetColumn * (floatingGridColumnWidth + floatingGridGap);
      const y = targetHeight;
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      clampFloatingPanel(panel);
      const panelHeight = Math.max(180, panel.offsetHeight);
      floatingGridColumnHeights[targetColumn] = y + panelHeight + floatingGridGap;
    };

    const cleanPanelTitle = (titleEl: HTMLElement | null) => {
      if (!titleEl) return 'Panel';
      const text = Array.from(titleEl.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join(' ')
        .trim();
      const value = (text || titleEl.textContent || 'Panel').replace(/[+-]\s*$/, '').trim();
      return value || 'Panel';
    };

    const splitPanelSections = (panel: HTMLDivElement) => {
      const titleEl = Array.from(panel.children).find((child) =>
        child.classList.contains('panel-title'),
      ) as HTMLElement | undefined;
      const bodyEl = Array.from(panel.children).find((child) =>
        child.classList.contains('panel-body'),
      ) as HTMLElement | undefined;
      if (!titleEl || !bodyEl) return [] as Array<{ title: string; nodes: Node[] }>;
      const sections: Array<{ title: string; nodes: Node[] }> = [];
      let currentTitle = cleanPanelTitle(titleEl);
      let currentNodes: Node[] = [];
      const flush = () => {
        if (currentNodes.length === 0) return;
        sections.push({ title: currentTitle, nodes: currentNodes });
        currentNodes = [];
      };
      for (const node of Array.from(bodyEl.childNodes)) {
        if (node instanceof HTMLElement && node.classList.contains('panel-title')) {
          flush();
          currentTitle = cleanPanelTitle(node);
          continue;
        }
        currentNodes.push(node);
      }
      flush();
      return sections;
    };

    const syncFloatingButtonState = (panelId: string) => {
      const panel = floatingPanelsById.get(panelId);
      const button = floatingButtonsById.get(panelId);
      if (!panel || !button) return;
      const hidden = panel.classList.contains('is-hidden');
      button.classList.toggle('active', !hidden);
      button.setAttribute('aria-pressed', hidden ? 'false' : 'true');
    };

    const clampFloatingPanel = (panel: HTMLDivElement) => {
      if (!levelViewport) return;
      const viewportRect = levelViewport.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const currentLeft = Number(panel.style.left.replace('px', '')) || 0;
      const currentTop = Number(panel.style.top.replace('px', '')) || 0;
      const maxLeft = Math.max(8, viewportRect.width - panelRect.width - 8);
      const maxTop = Math.max(8, viewportRect.height - panelRect.height - 8);
      panel.style.left = `${Math.min(maxLeft, Math.max(8, currentLeft))}px`;
      panel.style.top = `${Math.min(maxTop, Math.max(8, currentTop))}px`;
    };

    const makeFloatingPanelDraggable = (panel: HTMLDivElement, handle: HTMLDivElement) => {
      let dragging = false;
      let pointerId = -1;
      let offsetX = 0;
      let offsetY = 0;
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest('button')) return;
        dragging = true;
        pointerId = event.pointerId;
        floatingPanelZ += 1;
        panel.style.zIndex = String(floatingPanelZ);
        const rect = panel.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener('pointermove', (event) => {
        if (!dragging || event.pointerId !== pointerId || !levelViewport) return;
        const viewportRect = levelViewport.getBoundingClientRect();
        const left = event.clientX - viewportRect.left - offsetX;
        const top = event.clientY - viewportRect.top - offsetY;
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        clampFloatingPanel(panel);
      });
      const stopDrag = (event: PointerEvent) => {
        if (!dragging || event.pointerId !== pointerId) return;
        dragging = false;
        pointerId = -1;
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      };
      handle.addEventListener('pointerup', stopDrag);
      handle.addEventListener('pointercancel', stopDrag);
    };

    if (levelPanelToolbar && levelFloatingRoot && levelPanelSources.length > 0) {
      resetFloatingGridLayout();
      let createdFloatingPanels = 0;
      let panelIndex = 0;
      for (const sourcePanel of levelPanelSources) {
        const sections = splitPanelSections(sourcePanel);
        for (const section of sections) {
          panelIndex += 1;
          createdFloatingPanels += 1;
          const title = section.title;
          const panelId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'panel'}-${panelIndex}`;
          const floatingPanel = document.createElement('div');
          floatingPanel.className = 'panel level-floating-panel';
          floatingPanel.dataset.levelFloatingId = panelId;
          const defaultPos = defaultPositionByTitle.get(title) ?? {
            x: 16 + ((panelIndex - 1) % 4) * 300,
            y: 74 + Math.floor((panelIndex - 1) / 4) * 220,
          };
          floatingPanel.style.left = `${defaultPos.x}px`;
          floatingPanel.style.top = `${defaultPos.y}px`;
          if (!defaultOpenPanels.has(title)) {
            floatingPanel.classList.add('is-hidden');
          }
          floatingPanelZ += 1;
          floatingPanel.style.zIndex = String(floatingPanelZ);

          const header = document.createElement('div');
          header.className = 'panel-title level-floating-header';
          const headerLabel = document.createElement('span');
          headerLabel.className = 'level-floating-header-label';
          headerLabel.textContent = title;
          const closeButton = document.createElement('button');
          closeButton.type = 'button';
          closeButton.className = 'level-floating-close';
          closeButton.textContent = 'Hide';
          closeButton.addEventListener('click', () => {
            floatingPanel.classList.add('is-hidden');
            syncFloatingButtonState(panelId);
          });
          header.appendChild(headerLabel);
          header.appendChild(closeButton);

          const body = document.createElement('div');
          body.className = 'panel-body level-floating-body';
          for (const node of section.nodes) {
            body.appendChild(node);
          }

          floatingPanel.appendChild(header);
          floatingPanel.appendChild(body);
          levelFloatingRoot.appendChild(floatingPanel);
          placeFloatingPanelInGrid(floatingPanel, defaultPos);
          makeFloatingPanelDraggable(floatingPanel, header);
          floatingPanelsById.set(panelId, floatingPanel);

          const toggleButton = document.createElement('button');
          toggleButton.type = 'button';
          toggleButton.className = 'level-panel-toggle-btn';
          toggleButton.textContent = title;
          toggleButton.addEventListener('click', () => {
            const hidden = floatingPanel.classList.toggle('is-hidden');
            if (!hidden) {
              floatingPanelZ += 1;
              floatingPanel.style.zIndex = String(floatingPanelZ);
              clampFloatingPanel(floatingPanel);
            }
            syncFloatingButtonState(panelId);
          });
          levelPanelToolbar.appendChild(toggleButton);
          floatingButtonsById.set(panelId, toggleButton);
          syncFloatingButtonState(panelId);
        }
      }

      if (createdFloatingPanels > 0) {
        for (const sourcePanel of levelPanelSources) {
          const sourceContainer = sourcePanel.parentElement as HTMLDivElement | null;
          if (sourceContainer) {
            sourceContainer.classList.add('level-source-hidden');
          }
        }
      }

    }

    const applyTab = (tab: 'animation' | 'player' | 'level' | 'model' | 'settings') => {
      this.switchToTab(tab);
      hud.classList.toggle('mode-animation', tab === 'animation');
      hud.classList.toggle('mode-player', tab === 'player');
      hud.classList.toggle('mode-level', tab === 'level');
      hud.classList.toggle('mode-model', tab === 'model');
      hud.classList.toggle('mode-settings', tab === 'settings');
      for (const btn of tabButtons) {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      }
      const isExternalShell = hud.classList.contains('external-shell');
      for (const panel of tabPanels) {
        if (isExternalShell) {
          // In React external-shell mode, panels are mounted into external hosts.
          // Avoid forcing inline display state here, or the mounted panel can get stuck hidden.
          continue;
        }
        const show = panel.dataset.tabPanel === tab;
        panel.style.display = show ? '' : 'none';
      }
      if (tab === 'level') {
        resetFloatingGridLayout();
        for (const panel of floatingPanelsById.values()) {
          clampFloatingPanel(panel);
        }
      }
      this.resizeRenderer();
      this.resizeTimeline();
      this.drawTimeline();
      this.fitCameraToVrm();
    };
    this.applyTabFunction = applyTab;

    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab as 'animation' | 'player' | 'level' | 'model' | 'settings';
        applyTab(tab);
      });
    });

    applyTab('animation');

    const timeInput = hud.querySelector('[data-time]') as HTMLInputElement;
    const durationInput = hud.querySelector('[data-duration]') as HTMLInputElement;
    const fpsInput = hud.querySelector('[data-fps]') as HTMLInputElement;
    const addBtn = hud.querySelector('[data-add]') as HTMLButtonElement;
    const playButtons = Array.from(hud.querySelectorAll('[data-play]')) as HTMLButtonElement[];
    const stopButtons = Array.from(hud.querySelectorAll('[data-stop]')) as HTMLButtonElement[];
    const bonesToggleBtn = hud.querySelector('[data-bones-toggle]') as HTMLButtonElement;
    const boneScaleWrap = hud.querySelector('[data-bone-scale-wrap]') as HTMLLabelElement;
    const boneScaleInput = hud.querySelector('[data-bone-scale]') as HTMLInputElement;
    const resetBtn = hud.querySelector('[data-reset]') as HTMLButtonElement;
    const clearBtn = hud.querySelector('[data-clear]') as HTMLButtonElement;
    const clipPanel = hud.querySelector('[data-clip-panel]') as HTMLDivElement;
    const saveBtn = hud.querySelector('[data-save]') as HTMLButtonElement;
    const loadBtn = hud.querySelector('[data-load]') as HTMLButtonElement;
    const refreshBtn = hud.querySelector('[data-refresh]') as HTMLButtonElement;
    const clipNameInput = hud.querySelector('[data-clip-name]') as HTMLInputElement;
    const clipSelect = hud.querySelector('[data-clip-files]') as HTMLSelectElement;
    const clipStatus = hud.querySelector('[data-clip-status]') as HTMLDivElement;
    const downloadBtn = hud.querySelector('[data-download]') as HTMLButtonElement;
    const exportBtn = hud.querySelector('[data-export]') as HTMLButtonElement | null;
    const jsonBox = hud.querySelector('[data-json]') as HTMLTextAreaElement;
    const mixamoFile = hud.querySelector('[data-mixamo-file]') as HTMLInputElement;
    const mixamoSelect = hud.querySelector('[data-mixamo-clip]') as HTMLSelectElement;
    const mixamoPreview = hud.querySelector('[data-mixamo-preview]') as HTMLButtonElement;
    const mixamoBake = hud.querySelector('[data-mixamo-bake]') as HTMLButtonElement;
    const mixamoStop = hud.querySelector('[data-mixamo-stop]') as HTMLButtonElement;
    const mixamoStatus = hud.querySelector('[data-mixamo-status]') as HTMLSpanElement;
    const ragdollBtn = hud.querySelector('[data-ragdoll]') as HTMLButtonElement | null;
    const ragdollVisualBtn = hud.querySelector('[data-ragdoll-visual]') as HTMLButtonElement | null;
    const ragdollResetBtn = hud.querySelector('[data-ragdoll-reset]') as HTMLButtonElement | null;
    const ragdollRecordBtn = hud.querySelector('[data-ragdoll-record]') as HTMLButtonElement | null;
    const ragdollStopBtn = hud.querySelector('[data-ragdoll-stop]') as HTMLButtonElement | null;
    const ragdollStatus = hud.querySelector('[data-ragdoll-status]') as HTMLSpanElement | null;
    const timeline = hud.querySelector('[data-timeline]') as HTMLCanvasElement;
    const timelineHeader = hud.querySelector('[data-timeline-header]') as HTMLDivElement;
    const timelineWrap = hud.querySelector('[data-timeline-wrap]') as HTMLDivElement;
    const stepBack = hud.querySelector('[data-step-back]') as HTMLButtonElement;
    const stepForward = hud.querySelector('[data-step-forward]') as HTMLButtonElement;
    const overrideBtn = hud.querySelector('[data-override]') as HTMLButtonElement;
    const overrideRangeWrap = hud.querySelector('[data-override-range]') as HTMLDivElement;
    const overrideStartHandle = hud.querySelector('[data-override-start-handle]') as HTMLDivElement;
    const overrideEndHandle = hud.querySelector('[data-override-end-handle]') as HTMLDivElement;
    const playerStatus = hud.querySelector('[data-player-status]') as HTMLDivElement;
    const playerJson = hud.querySelector('[data-player-json]') as HTMLTextAreaElement;
    const playerAvatarSelect = hud.querySelector('[data-player-avatar]') as HTMLSelectElement;
    const playerAvatarFileInput = hud.querySelector(
      '[data-player-avatar-file]',
    ) as HTMLInputElement;
    const playerAvatarRefreshButton = hud.querySelector(
      '[data-player-avatar-refresh]',
    ) as HTMLButtonElement;
    const playerAvatarLoadButton = hud.querySelector(
      '[data-player-avatar-load]',
    ) as HTMLButtonElement;
    const playerAvatarSaveButton = hud.querySelector(
      '[data-player-avatar-save]',
    ) as HTMLButtonElement;
    const moveSpeedInput = hud.querySelector('[data-move-speed]') as HTMLInputElement;
    const sprintMultInput = hud.querySelector('[data-sprint-mult]') as HTMLInputElement;
    const crouchMultInput = hud.querySelector('[data-crouch-mult]') as HTMLInputElement;
    const slideAccelInput = hud.querySelector('[data-slide-accel]') as HTMLInputElement;
    const slideFrictionInput = hud.querySelector('[data-slide-friction]') as HTMLInputElement;
    const jumpSpeedInput = hud.querySelector('[data-jump-speed]') as HTMLInputElement;
    const gravityInput = hud.querySelector('[data-gravity]') as HTMLInputElement;
    const walkThresholdInput = hud.querySelector('[data-walk-threshold]') as HTMLInputElement;
    const runThresholdInput = hud.querySelector('[data-run-threshold]') as HTMLInputElement;
    const ikOffsetInput = hud.querySelector('[data-ik-offset]') as HTMLInputElement;
    const capRadiusInput = hud.querySelector('[data-cap-radius]') as HTMLInputElement;
    const capHeightInput = hud.querySelector('[data-cap-height]') as HTMLInputElement;
    const capYOffsetInput = hud.querySelector('[data-cap-y]') as HTMLInputElement;
    const camDistanceInput = hud.querySelector('[data-cam-distance]') as HTMLInputElement;
    const camHeightInput = hud.querySelector('[data-cam-height]') as HTMLInputElement;
    const camShoulderInput = hud.querySelector('[data-cam-shoulder]') as HTMLInputElement;
    const camShoulderYInput = hud.querySelector('[data-cam-shoulder-y]') as HTMLInputElement;
    const camSenseInput = hud.querySelector('[data-cam-sense]') as HTMLInputElement;
    const camSmoothInput = hud.querySelector('[data-cam-smooth]') as HTMLInputElement;
    const camMinPitchInput = hud.querySelector('[data-cam-min-pitch]') as HTMLInputElement;
    const camMaxPitchInput = hud.querySelector('[data-cam-max-pitch]') as HTMLInputElement;
    const camTargetSmoothInput = hud.querySelector('[data-cam-target-smooth]') as HTMLInputElement;
    const profileNameInput = hud.querySelector('[data-profile-name]') as HTMLInputElement;
    const profileRoleInput = hud.querySelector('[data-profile-role]') as HTMLSelectElement;
    const profileControllerInput = hud.querySelector(
      '[data-profile-controller]',
    ) as HTMLSelectElement;
    const controllerModesJsonInput = hud.querySelector(
      '[data-controller-modes-json]',
    ) as HTMLTextAreaElement;
    const profileFactionInput = hud.querySelector('[data-profile-faction]') as HTMLInputElement;
    const profileHealthInput = hud.querySelector('[data-profile-health]') as HTMLInputElement;
    const profileStaminaInput = hud.querySelector('[data-profile-stamina]') as HTMLInputElement;
    const profileTagsInput = hud.querySelector('[data-profile-tags]') as HTMLInputElement;
    const profileDescriptionInput = hud.querySelector(
      '[data-profile-description]',
    ) as HTMLInputElement;
    const rigShowInput = hud.querySelector('[data-rig-show]') as HTMLInputElement;
    const rigBoneSelect = hud.querySelector('[data-rig-bone]') as HTMLSelectElement;
    const rigSourceBoneSelect = hud.querySelector('[data-rig-source-bone]') as HTMLSelectElement;
    const rigChildBoneSelect = hud.querySelector('[data-rig-child-bone]') as HTMLSelectElement;
    const rigModeSelect = hud.querySelector('[data-rig-mode]') as HTMLSelectElement;
    const rigRadiusInput = hud.querySelector('[data-rig-radius]') as HTMLInputElement;
    const rigLengthInput = hud.querySelector('[data-rig-length]') as HTMLInputElement;
    const rigOffX = hud.querySelector('[data-rig-offx]') as HTMLInputElement;
    const rigOffY = hud.querySelector('[data-rig-offy]') as HTMLInputElement;
    const rigOffZ = hud.querySelector('[data-rig-offz]') as HTMLInputElement;
    const rigRotX = hud.querySelector('[data-rig-rotx]') as HTMLInputElement;
    const rigRotY = hud.querySelector('[data-rig-roty]') as HTMLInputElement;
    const rigRotZ = hud.querySelector('[data-rig-rotz]') as HTMLInputElement;
    const rigSwing = hud.querySelector('[data-rig-swing]') as HTMLInputElement;
    const rigTwist = hud.querySelector('[data-rig-twist]') as HTMLInputElement;
    const rigApplyButton = hud.querySelector('[data-rig-apply]') as HTMLButtonElement;
    const rigResetButton = hud.querySelector('[data-rig-reset]') as HTMLButtonElement;
    const rsimMuscleEnabled = hud.querySelector('[data-rsim-muscle-enabled]') as HTMLInputElement;
    const rsimMuscleStiffness = hud.querySelector(
      '[data-rsim-muscle-stiffness]',
    ) as HTMLInputElement;
    const rsimMuscleDamping = hud.querySelector('[data-rsim-muscle-damping]') as HTMLInputElement;
    const rsimMuscleMaxTorque = hud.querySelector(
      '[data-rsim-muscle-max-torque]',
    ) as HTMLInputElement;
    const rsimJointStiffnessScale = hud.querySelector(
      '[data-rsim-joint-stiffness-scale]',
    ) as HTMLInputElement;
    const rsimJointDampingScale = hud.querySelector(
      '[data-rsim-joint-damping-scale]',
    ) as HTMLInputElement;
    const rsimBodyLinScale = hud.querySelector('[data-rsim-body-lin-scale]') as HTMLInputElement;
    const rsimBodyAngScale = hud.querySelector('[data-rsim-body-ang-scale]') as HTMLInputElement;
    const rsimGroundFriction = hud.querySelector('[data-rsim-ground-friction]') as HTMLInputElement;
    const rsimBodyFriction = hud.querySelector('[data-rsim-body-friction]') as HTMLInputElement;
    const rsimMaxSubsteps = hud.querySelector('[data-rsim-max-substeps]') as HTMLInputElement;
    const rsimSubstepHz = hud.querySelector('[data-rsim-substep-hz]') as HTMLInputElement;
    const rsimLimitBlend = hud.querySelector('[data-rsim-limit-blend]') as HTMLInputElement;
    const rsimLinearBleed = hud.querySelector('[data-rsim-linear-bleed]') as HTMLInputElement;
    const rsimAngularBleed = hud.querySelector('[data-rsim-angular-bleed]') as HTMLInputElement;
    const rsimSlideDamp = hud.querySelector('[data-rsim-slide-damp]') as HTMLInputElement;
    const rsimGroundY = hud.querySelector('[data-rsim-ground-y]') as HTMLInputElement;
    const rsimGroundDeadzone = hud.querySelector('[data-rsim-ground-deadzone]') as HTMLInputElement;
    const rsimMaxLin = hud.querySelector('[data-rsim-max-lin]') as HTMLInputElement;
    const rsimMaxAng = hud.querySelector('[data-rsim-max-ang]') as HTMLInputElement;
    const rsimStartImpulse = hud.querySelector('[data-rsim-start-impulse]') as HTMLInputElement;
    const capsulePreviewInput = hud.querySelector('[data-capsule-preview]') as HTMLInputElement;
    const capsuleBaseRadiusInput = hud.querySelector(
      '[data-capsule-base-radius]',
    ) as HTMLInputElement;
    const capsuleBaseHeightInput = hud.querySelector(
      '[data-capsule-base-height]',
    ) as HTMLInputElement;
    const capsuleSkinWidthInput = hud.querySelector(
      '[data-capsule-skin-width]',
    ) as HTMLInputElement;
    const capsuleStepHeightInput = hud.querySelector(
      '[data-capsule-step-height]',
    ) as HTMLInputElement;
    const capsuleSlopeInput = hud.querySelector('[data-capsule-slope]') as HTMLInputElement;
    const stateMachineInitialInput = hud.querySelector('[data-sm-initial]') as HTMLInputElement;
    const stateMachineStatesInput = hud.querySelector('[data-sm-states]') as HTMLTextAreaElement;
    const stateMachineTransitionsInput = hud.querySelector(
      '[data-sm-transitions]',
    ) as HTMLTextAreaElement;
    const stateMachineResetButton = hud.querySelector('[data-sm-reset]') as HTMLButtonElement;
    const stateMachineValidateButton = hud.querySelector('[data-sm-validate]') as HTMLButtonElement;
    const stateMachineStatus = hud.querySelector('[data-sm-status]') as HTMLDivElement;
    const npcEnabledInput = hud.querySelector('[data-npc-enabled]') as HTMLInputElement;
    const npcArchetypeInput = hud.querySelector('[data-npc-archetype]') as HTMLInputElement;
    const npcAggressionInput = hud.querySelector('[data-npc-aggression]') as HTMLInputElement;
    const npcPerceptionInput = hud.querySelector('[data-npc-perception]') as HTMLInputElement;
    const npcFovInput = hud.querySelector('[data-npc-fov]') as HTMLInputElement;
    const npcPatrolSpeedInput = hud.querySelector('[data-npc-patrol-speed]') as HTMLInputElement;
    const npcChaseSpeedInput = hud.querySelector('[data-npc-chase-speed]') as HTMLInputElement;
    const npcAttackRangeInput = hud.querySelector('[data-npc-attack-range]') as HTMLInputElement;
    const npcReactionInput = hud.querySelector('[data-npc-reaction]') as HTMLInputElement;
    const npcGoalsInput = hud.querySelector('[data-npc-goals]') as HTMLTextAreaElement;
    const playerLoadButton = hud.querySelector('[data-player-load]') as HTMLButtonElement;
    const playerSaveButton = hud.querySelector('[data-player-save]') as HTMLButtonElement;
    const sceneList = hud.querySelector('[data-scene-list]') as HTMLSelectElement;
    const sceneNameInput = hud.querySelector('[data-scene-name]') as HTMLInputElement;
    const sceneNewBtn = hud.querySelector('[data-scene-new]') as HTMLButtonElement;
    const sceneLoadBtn = hud.querySelector('[data-scene-load]') as HTMLButtonElement;
    const sceneSaveBtn = hud.querySelector('[data-scene-save]') as HTMLButtonElement;
    const sceneDeleteBtn = hud.querySelector('[data-scene-delete]') as HTMLButtonElement;
    const sceneStatus = hud.querySelector('[data-scene-status]') as HTMLDivElement;
    const modelNameInput = hud.querySelector('[data-model-name]') as HTMLInputElement;
    const modelIdInput = hud.querySelector('[data-model-id]') as HTMLInputElement;
    const modelSourceFileInput = hud.querySelector('[data-model-source-file]') as HTMLInputElement;
    const modelFbxFileInput = hud.querySelector('[data-model-fbx-file]') as HTMLInputElement;
    const modelOriginXInput = hud.querySelector('[data-model-origin-x]') as HTMLInputElement;
    const modelOriginYInput = hud.querySelector('[data-model-origin-y]') as HTMLInputElement;
    const modelOriginZInput = hud.querySelector('[data-model-origin-z]') as HTMLInputElement;
    const modelColliderShapeInput = hud.querySelector(
      '[data-model-collider-shape]',
    ) as HTMLSelectElement;
    const modelColliderSizeXInput = hud.querySelector(
      '[data-model-collider-size-x]',
    ) as HTMLInputElement;
    const modelColliderSizeYInput = hud.querySelector(
      '[data-model-collider-size-y]',
    ) as HTMLInputElement;
    const modelColliderSizeZInput = hud.querySelector(
      '[data-model-collider-size-z]',
    ) as HTMLInputElement;
    const modelColliderRadiusInput = hud.querySelector(
      '[data-model-collider-radius]',
    ) as HTMLInputElement;
    const modelColliderHeightInput = hud.querySelector(
      '[data-model-collider-height]',
    ) as HTMLInputElement;
    const modelColliderOffsetXInput = hud.querySelector(
      '[data-model-collider-offset-x]',
    ) as HTMLInputElement;
    const modelColliderOffsetYInput = hud.querySelector(
      '[data-model-collider-offset-y]',
    ) as HTMLInputElement;
    const modelColliderOffsetZInput = hud.querySelector(
      '[data-model-collider-offset-z]',
    ) as HTMLInputElement;
    const modelColliderTriggerInput = hud.querySelector(
      '[data-model-collider-trigger]',
    ) as HTMLInputElement;
    const modelPhysicsEnabledInput = hud.querySelector(
      '[data-model-physics-enabled]',
    ) as HTMLInputElement;
    const modelPhysicsBodyTypeInput = hud.querySelector(
      '[data-model-physics-body-type]',
    ) as HTMLSelectElement;
    const modelPhysicsMassInput = hud.querySelector('[data-model-physics-mass]') as HTMLInputElement;
    const modelPhysicsFrictionInput = hud.querySelector(
      '[data-model-physics-friction]',
    ) as HTMLInputElement;
    const modelPhysicsRestitutionInput = hud.querySelector(
      '[data-model-physics-restitution]',
    ) as HTMLInputElement;
    const modelPhysicsLinearDampingInput = hud.querySelector(
      '[data-model-physics-linear-damping]',
    ) as HTMLInputElement;
    const modelPhysicsAngularDampingInput = hud.querySelector(
      '[data-model-physics-angular-damping]',
    ) as HTMLInputElement;
    const modelPhysicsGravityScaleInput = hud.querySelector(
      '[data-model-physics-gravity-scale]',
    ) as HTMLInputElement;
    const modelPhysicsSpawnHeightInput = hud.querySelector(
      '[data-model-physics-spawn-height]',
    ) as HTMLInputElement;
    const modelPhysicsVelocityXInput = hud.querySelector(
      '[data-model-physics-velocity-x]',
    ) as HTMLInputElement;
    const modelPhysicsVelocityYInput = hud.querySelector(
      '[data-model-physics-velocity-y]',
    ) as HTMLInputElement;
    const modelPhysicsVelocityZInput = hud.querySelector(
      '[data-model-physics-velocity-z]',
    ) as HTMLInputElement;
    const modelPhysicsDropPresetBtn = hud.querySelector(
      '[data-model-physics-test-drop]',
    ) as HTMLButtonElement;
    const modelPhysicsPushPresetBtn = hud.querySelector(
      '[data-model-physics-test-push]',
    ) as HTMLButtonElement;
    const modelPhysicsClearPresetBtn = hud.querySelector(
      '[data-model-physics-test-clear]',
    ) as HTMLButtonElement;
    const modelBaseColorFileInput = hud.querySelector(
      '[data-model-base-color-file]',
    ) as HTMLInputElement;
    const modelNormalFileInput = hud.querySelector('[data-model-normal-file]') as HTMLInputElement;
    const modelRoughnessFileInput = hud.querySelector(
      '[data-model-roughness-file]',
    ) as HTMLInputElement;
    const modelMetalnessFileInput = hud.querySelector(
      '[data-model-metalness-file]',
    ) as HTMLInputElement;
    const modelEmissiveFileInput = hud.querySelector(
      '[data-model-emissive-file]',
    ) as HTMLInputElement;
    const modelBaseColorPath = hud.querySelector('[data-model-base-color-path]') as HTMLDivElement;
    const modelNormalPath = hud.querySelector('[data-model-normal-path]') as HTMLDivElement;
    const modelRoughnessPath = hud.querySelector('[data-model-roughness-path]') as HTMLDivElement;
    const modelMetalnessPath = hud.querySelector('[data-model-metalness-path]') as HTMLDivElement;
    const modelEmissivePath = hud.querySelector('[data-model-emissive-path]') as HTMLDivElement;
    const modelSaveBtn = hud.querySelector('[data-model-save]') as HTMLButtonElement;
    const modelPreviewBtn = hud.querySelector('[data-model-preview]') as HTMLButtonElement;
    const modelClearBtn = hud.querySelector('[data-model-clear]') as HTMLButtonElement;
    const modelRefreshBtn = hud.querySelector('[data-model-refresh]') as HTMLButtonElement;
    const modelStatus = hud.querySelector('[data-model-status]') as HTMLDivElement;
    const modelList = hud.querySelector('[data-model-list]') as HTMLDivElement;
    const sceneObstacles = hud.querySelector('[data-scene-obstacles]') as HTMLTextAreaElement;
    const sceneJson = hud.querySelector('[data-scene-json]') as HTMLTextAreaElement;
    const levelObjectSelect = hud.querySelector('[data-level-object]') as HTMLSelectElement;
    const levelBuildTool = hud.querySelector('[data-level-build-tool]') as HTMLSelectElement;
    const levelHierarchySearch = hud.querySelector(
      '[data-level-hierarchy-search]',
    ) as HTMLInputElement;
    const levelHierarchy = hud.querySelector('[data-level-hierarchy]') as HTMLDivElement;
    const levelAddBtn = hud.querySelector('[data-level-add]') as HTMLButtonElement;
    const levelAddZoneBtn = hud.querySelector('[data-level-add-zone]') as HTMLButtonElement;
    const levelAddGroundBtn = hud.querySelector('[data-level-add-ground]') as HTMLButtonElement;
    const levelAddPlayerBtn = hud.querySelector('[data-level-add-player]') as HTMLButtonElement;
    const levelAddCrowdBtn = hud.querySelector('[data-level-add-crowd]') as HTMLButtonElement;
    const levelModelSpawnSelect = hud.querySelector(
      '[data-level-model-spawn-select]',
    ) as HTMLSelectElement;
    const levelModelLibrary = hud.querySelector('[data-level-model-library]') as HTMLDivElement;
    const levelAddModelBtn = hud.querySelector('[data-level-add-model]') as HTMLButtonElement;
    const levelDuplicateBtn = hud.querySelector('[data-level-duplicate]') as HTMLButtonElement;
    const levelDeleteBtn = hud.querySelector('[data-level-delete]') as HTMLButtonElement;
    const levelUndoBtn = hud.querySelector('[data-level-undo]') as HTMLButtonElement;
    const levelRedoBtn = hud.querySelector('[data-level-redo]') as HTMLButtonElement;
    const levelTransformMode = hud.querySelector(
      '[data-level-transform-mode]',
    ) as HTMLSelectElement;
    const levelSnapInput = hud.querySelector('[data-level-snap]') as HTMLInputElement;
    const levelFocusBtn = hud.querySelector('[data-level-focus]') as HTMLButtonElement;
    const levelToolSelectBtn = hud.querySelector('[data-level-tool-select]') as HTMLButtonElement;
    const levelToolMoveBtn = hud.querySelector('[data-level-tool-move]') as HTMLButtonElement;
    const levelToolRotateBtn = hud.querySelector('[data-level-tool-rotate]') as HTMLButtonElement;
    const levelToolScaleBtn = hud.querySelector('[data-level-tool-scale]') as HTMLButtonElement;
    const levelSnapToggleBtn = hud.querySelector('[data-level-snap-toggle]') as HTMLButtonElement;
    const levelSnapTopInput = hud.querySelector('[data-level-snap-top]') as HTMLInputElement;
    const levelSpaceToggleBtn = hud.querySelector('[data-level-space-toggle]') as HTMLButtonElement;
    const levelGroupDuplicateBtn = hud.querySelector(
      '[data-level-group-duplicate]',
    ) as HTMLButtonElement;
    const levelGroupDeleteBtn = hud.querySelector('[data-level-group-delete]') as HTMLButtonElement;
    const levelGroupFocusBtn =
      (hud.querySelector('[data-level-group-focus]') as HTMLButtonElement | null) ??
      (hud.querySelector('[data-level-focus-selection]') as HTMLButtonElement | null);
    const levelInspectorId = hud.querySelector('[data-level-inspector-id]') as HTMLInputElement;
    const levelComponentPreset = hud.querySelector(
      '[data-level-component-preset]',
    ) as HTMLSelectElement;
    const levelComponentApply = hud.querySelector(
      '[data-level-component-apply]',
    ) as HTMLButtonElement;
    const levelComponentJson = hud.querySelector(
      '[data-level-component-json]',
    ) as HTMLTextAreaElement;
    const levelComponentSave = hud.querySelector(
      '[data-level-component-save]',
    ) as HTMLButtonElement;
    const levelZoneName = hud.querySelector('[data-level-zone-name]') as HTMLInputElement;
    const levelZoneTag = hud.querySelector('[data-level-zone-tag]') as HTMLInputElement;
    const levelZoneType = hud.querySelector('[data-level-zone-type]') as HTMLSelectElement;
    const levelZoneApply = hud.querySelector('[data-level-zone-apply]') as HTMLButtonElement;
    const levelTerrainPreset = hud.querySelector('[data-level-terrain-preset]') as HTMLSelectElement;
    const levelTerrainTexture = hud.querySelector(
      '[data-level-terrain-texture]',
    ) as HTMLSelectElement;
    const levelWaterEnabled = hud.querySelector('[data-level-water-enabled]') as HTMLInputElement;
    const levelWaterLevel = hud.querySelector('[data-level-water-level]') as HTMLInputElement;
    const levelWaterOpacity = hud.querySelector('[data-level-water-opacity]') as HTMLInputElement;
    const levelWaterWaveAmp = hud.querySelector('[data-level-water-wave-amp]') as HTMLInputElement;
    const levelWaterWaveFreq = hud.querySelector(
      '[data-level-water-wave-freq]',
    ) as HTMLInputElement;
    const levelWaterWaveSpeed = hud.querySelector(
      '[data-level-water-wave-speed]',
    ) as HTMLInputElement;
    const levelWaterColorShallow = hud.querySelector(
      '[data-level-water-color-shallow]',
    ) as HTMLInputElement;
    const levelWaterColorDeep = hud.querySelector(
      '[data-level-water-color-deep]',
    ) as HTMLInputElement;
    const levelWaterSpecular = hud.querySelector('[data-level-water-specular]') as HTMLInputElement;
    const levelTerrainSize = hud.querySelector('[data-level-terrain-size]') as HTMLInputElement;
    const levelTerrainRes = hud.querySelector('[data-level-terrain-res]') as HTMLInputElement;
    const levelTerrainHeight = hud.querySelector('[data-level-terrain-height]') as HTMLInputElement;
    const levelTerrainRoughness = hud.querySelector(
      '[data-level-terrain-roughness]',
    ) as HTMLInputElement;
    const levelTerrainSeed = hud.querySelector('[data-level-terrain-seed]') as HTMLInputElement;
    const levelSculptRadius = hud.querySelector('[data-level-sculpt-radius]') as HTMLInputElement;
    const levelSculptStrength = hud.querySelector(
      '[data-level-sculpt-strength]',
    ) as HTMLInputElement;
    const levelTerrainGenerateBtn = hud.querySelector(
      '[data-level-terrain-generate]',
    ) as HTMLButtonElement;
    const levelTerrainAppendBtn = hud.querySelector(
      '[data-level-terrain-append]',
    ) as HTMLButtonElement;
    const levelTerrainClearBtn = hud.querySelector(
      '[data-level-terrain-clear]',
    ) as HTMLButtonElement;
    const levelTerrainStatus = hud.querySelector('[data-level-terrain-status]') as HTMLDivElement;
    const levelRoadName = hud.querySelector('[data-level-road-name]') as HTMLInputElement;
    const levelRoadWidth = hud.querySelector('[data-level-road-width]') as HTMLInputElement;
    const levelRoadMaterial = hud.querySelector('[data-level-road-material]') as HTMLSelectElement;
    const levelRoadNew = hud.querySelector('[data-level-road-new]') as HTMLButtonElement;
    const levelRoadAddPoint = hud.querySelector('[data-level-road-add-point]') as HTMLButtonElement;
    const levelRoadPopPoint = hud.querySelector('[data-level-road-pop-point]') as HTMLButtonElement;
    const levelRoadClear = hud.querySelector('[data-level-road-clear]') as HTMLButtonElement;
    const levelRoadStatus = hud.querySelector('[data-level-road-status]') as HTMLDivElement;
    const levelEnvironmentPreset = hud.querySelector(
      '[data-level-environment-preset]',
    ) as HTMLSelectElement;
    const levelEnvironmentFogNear = hud.querySelector(
      '[data-level-environment-fog-near]',
    ) as HTMLInputElement;
    const levelEnvironmentFogFar = hud.querySelector(
      '[data-level-environment-fog-far]',
    ) as HTMLInputElement;
    const levelEnvironmentSkyboxEnabled = hud.querySelector(
      '[data-level-environment-skybox-enabled]',
    ) as HTMLInputElement;
    const levelEnvironmentSkyboxPreset = hud.querySelector(
      '[data-level-environment-skybox-preset]',
    ) as HTMLSelectElement;
    const levelEnvironmentSkyboxIntensity = hud.querySelector(
      '[data-level-environment-skybox-intensity]',
    ) as HTMLInputElement;
    const levelEnvironmentApply = hud.querySelector(
      '[data-level-environment-apply]',
    ) as HTMLButtonElement;
    const sceneLogicInput = hud.querySelector('[data-scene-logic]') as HTMLTextAreaElement;
    const levelLogicTemplate = hud.querySelector('[data-level-logic-template]') as HTMLSelectElement;
    const levelLogicTemplateApply = hud.querySelector(
      '[data-level-logic-template-apply]',
    ) as HTMLButtonElement;
    const levelLogicTrigger = hud.querySelector('[data-level-logic-trigger]') as HTMLSelectElement;
    const levelLogicAction = hud.querySelector('[data-level-logic-action]') as HTMLSelectElement;
    const levelLogicTarget = hud.querySelector('[data-level-logic-target]') as HTMLInputElement;
    const levelLogicParams = hud.querySelector('[data-level-logic-params]') as HTMLInputElement;
    const levelLogicUseSelected = hud.querySelector(
      '[data-level-logic-use-selected]',
    ) as HTMLButtonElement;
    const levelLogicUseZone = hud.querySelector('[data-level-logic-use-zone]') as HTMLButtonElement;
    const levelLogicAdd = hud.querySelector('[data-level-logic-add]') as HTMLButtonElement;
    const levelLogicClear = hud.querySelector('[data-level-logic-clear]') as HTMLButtonElement;
    const levelLogicList = hud.querySelector('[data-level-logic-list]') as HTMLDivElement;
    const levelLogicGraph = hud.querySelector('[data-level-logic-graph]') as HTMLDivElement;
    const levelLogicGraphStatus = hud.querySelector(
      '[data-level-logic-graph-status]',
    ) as HTMLDivElement;
    const levelLogicMinimap = hud.querySelector('[data-level-logic-minimap]') as HTMLCanvasElement;
    const levelLogicNodeAddTrigger = hud.querySelector(
      '[data-level-logic-node-add-trigger]',
    ) as HTMLButtonElement;
    const levelLogicNodeAddAction = hud.querySelector(
      '[data-level-logic-node-add-action]',
    ) as HTMLButtonElement;
    const levelLogicNodeConnect = hud.querySelector(
      '[data-level-logic-node-connect]',
    ) as HTMLButtonElement;
    const levelLogicNodeDelete = hud.querySelector(
      '[data-level-logic-node-delete]',
    ) as HTMLButtonElement;
    const levelLogicNodeClearSelection = hud.querySelector(
      '[data-level-logic-node-clear-selection]',
    ) as HTMLButtonElement;
    const levelLogicNodeCopy = hud.querySelector(
      '[data-level-logic-node-copy]',
    ) as HTMLButtonElement;
    const levelLogicNodePaste = hud.querySelector(
      '[data-level-logic-node-paste]',
    ) as HTMLButtonElement;
    const levelLogicPreviewTrigger = hud.querySelector(
      '[data-level-logic-preview-trigger]',
    ) as HTMLSelectElement;
    const levelLogicPreviewTarget = hud.querySelector(
      '[data-level-logic-preview-target]',
    ) as HTMLInputElement;
    const levelLogicPreviewRun = hud.querySelector(
      '[data-level-logic-preview-run]',
    ) as HTMLButtonElement;
    const levelLogicPreviewClear = hud.querySelector(
      '[data-level-logic-preview-clear]',
    ) as HTMLButtonElement;
    const levelLogicPreviewLog = hud.querySelector(
      '[data-level-logic-preview-log]',
    ) as HTMLDivElement;
    const levelContextSelectionId = hud.querySelector(
      '[data-level-context-selection-id]',
    ) as HTMLElement;
    const levelContextSelectionKind = hud.querySelector(
      '[data-level-context-selection-kind]',
    ) as HTMLElement;
    const levelContextSelectionCount = hud.querySelector(
      '[data-level-context-selection-count]',
    ) as HTMLElement;
    const levelContextTransform = hud.querySelector(
      '[data-level-context-transform]',
    ) as HTMLTextAreaElement;
    const levelContextHints = hud.querySelector('[data-level-context-hints]') as HTMLElement;
    const levelContextActions = hud.querySelector('[data-level-context-actions]') as HTMLElement;
    const levelFocusProxyBtn = hud.querySelector('[data-level-focus-proxy]') as HTMLButtonElement;
    const levelDuplicateProxyBtn = hud.querySelector(
      '[data-level-duplicate-proxy]',
    ) as HTMLButtonElement;
    const levelDeleteProxyBtn = hud.querySelector('[data-level-delete-proxy]') as HTMLButtonElement;
    const levelStatus = hud.querySelector('[data-level-status]') as HTMLDivElement;
    const editorHeader = hud.querySelector('.editor-header') as HTMLDivElement | null;
    const levelCameraModeBtn = hud.querySelector(
      '[data-level-camera-mode]',
    ) as HTMLButtonElement | null;
    if (editorHeader && levelCameraModeBtn) {
      editorHeader.appendChild(levelCameraModeBtn);
    }
    this.levelCameraModeButton = levelCameraModeBtn;
    this.setLevelCameraMode('free');
    levelBuildTool.value = this.levelBuildTool;
    levelBuildTool.addEventListener('change', () => {
      this.levelBuildTool = (levelBuildTool.value as typeof this.levelBuildTool) ?? 'select';
      updateLevelCommandBarState();
      if (levelStatus) {
        levelStatus.textContent = this.getLevelBuildToolStatusText();
      }
    });
    levelCameraModeBtn?.addEventListener('click', () => {
      this.setLevelCameraMode(this.levelCameraMode === 'free' ? 'locked' : 'free');
      if (levelStatus) {
        levelStatus.textContent =
          this.levelCameraMode === 'free'
            ? 'Camera mode: free fly'
            : 'Camera mode: object locked';
      }
    });
    levelUndoBtn?.addEventListener('click', () => this.levelUndo());
    levelRedoBtn?.addEventListener('click', () => this.levelRedo());
    levelFocusProxyBtn?.addEventListener('click', () => levelFocusBtn?.click());
    levelDuplicateProxyBtn?.addEventListener('click', () => levelDuplicateBtn?.click());
    levelDeleteProxyBtn?.addEventListener('click', () => levelDeleteBtn?.click());

    // Settings tab controls
    const stylePresetSelect = hud.querySelector('[data-style-preset]') as HTMLSelectElement;
    const brightnessInput = hud.querySelector('[data-brightness]') as HTMLInputElement;
    const brightnessVal = hud.querySelector('[data-brightness-val]') as HTMLElement;
    const contrastInput = hud.querySelector('[data-contrast]') as HTMLInputElement;
    const contrastVal = hud.querySelector('[data-contrast-val]') as HTMLElement;
    const saturationInput = hud.querySelector('[data-saturation]') as HTMLInputElement;
    const saturationVal = hud.querySelector('[data-saturation-val]') as HTMLElement;
    const gammaInput = hud.querySelector('[data-gamma]') as HTMLInputElement;
    const gammaVal = hud.querySelector('[data-gamma-val]') as HTMLElement;
    const exposureInput = hud.querySelector('[data-exposure]') as HTMLInputElement;
    const exposureVal = hud.querySelector('[data-exposure-val]') as HTMLElement;

    const sceneState = { scenes: [] as LevelScene[] };
    this.levelSceneStateRef = sceneState;
    this.levelSceneListEl = sceneList;
    this.levelSceneObstaclesEl = sceneObstacles;
    this.levelSceneJsonEl = sceneJson;
    this.levelObjectSelectEl = levelObjectSelect;
    this.levelHierarchyEl = levelHierarchy;
    this.levelInspectorIdEl = levelInspectorId;
    this.levelComponentPresetEl = levelComponentPreset;
    this.levelComponentJsonEl = levelComponentJson;
    this.levelZoneNameEl = levelZoneName;
    this.levelZoneTagEl = levelZoneTag;
    this.levelZoneTypeEl = levelZoneType;
    this.levelLogicListEl = levelLogicList;
    this.levelLogicGraphEl = levelLogicGraph;
    this.levelLogicGraphStatusEl = levelLogicGraphStatus;
    this.levelLogicMinimapEl = levelLogicMinimap;
    this.levelContextSelectionIdEl = levelContextSelectionId;
    this.levelContextSelectionKindEl = levelContextSelectionKind;
    this.levelContextSelectionCountEl = levelContextSelectionCount;
    this.levelContextTransformEl = levelContextTransform;
    this.levelContextHintsEl = levelContextHints;
    this.levelContextActionsEl = levelContextActions;

    let modelRecords: EditorModelRecord[] = [];
    let modelUploadedFiles: string[] = [];
    const defaultModelOriginOffset = (): EditorModelOriginOffset => ({ x: 0, y: 0, z: 0 });
    const defaultModelCollider = (): EditorModelCollider => ({
      shape: 'box',
      size: { x: 1, y: 1, z: 1 },
      radius: 0.5,
      height: 1.8,
      offset: { x: 0, y: 0, z: 0 },
      isTrigger: false,
    });
    const defaultModelPhysics = (): EditorModelPhysics => ({
      enabled: true,
      bodyType: 'dynamic',
      mass: 1,
      friction: 0.6,
      restitution: 0.1,
      linearDamping: 0.05,
      angularDamping: 0.1,
      gravityScale: 1,
      spawnHeightOffset: 1,
      initialVelocity: { x: 0, y: 0, z: 0 },
    });
    const asFiniteNumber = (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const clampFiniteNumber = (value: unknown, min: number, max: number, fallback: number) =>
      THREE.MathUtils.clamp(asFiniteNumber(value, fallback), min, max);
    const readNumberInput = (input: HTMLInputElement, fallback: number) => {
      const value = Number(input.value);
      return Number.isFinite(value) ? value : fallback;
    };
    const readModelOriginOffsetInput = () => {
      return {
        x: readNumberInput(modelOriginXInput, 0),
        y: readNumberInput(modelOriginYInput, 0),
        z: readNumberInput(modelOriginZInput, 0),
      } satisfies EditorModelOriginOffset;
    };
    const readModelColliderInput = (): EditorModelCollider => ({
      shape:
        modelColliderShapeInput.value === 'sphere' ||
        modelColliderShapeInput.value === 'capsule' ||
        modelColliderShapeInput.value === 'mesh'
          ? modelColliderShapeInput.value
          : 'box',
      size: {
        x: Math.max(0.05, readNumberInput(modelColliderSizeXInput, 1)),
        y: Math.max(0.05, readNumberInput(modelColliderSizeYInput, 1)),
        z: Math.max(0.05, readNumberInput(modelColliderSizeZInput, 1)),
      },
      radius: Math.max(0.05, readNumberInput(modelColliderRadiusInput, 0.5)),
      height: Math.max(0.1, readNumberInput(modelColliderHeightInput, 1.8)),
      offset: {
        x: readNumberInput(modelColliderOffsetXInput, 0),
        y: readNumberInput(modelColliderOffsetYInput, 0),
        z: readNumberInput(modelColliderOffsetZInput, 0),
      },
      isTrigger: modelColliderTriggerInput.checked,
    });
    const readModelPhysicsInput = (): EditorModelPhysics => ({
      enabled: modelPhysicsEnabledInput.checked,
      bodyType:
        modelPhysicsBodyTypeInput.value === 'dynamic' || modelPhysicsBodyTypeInput.value === 'kinematic'
          ? modelPhysicsBodyTypeInput.value
          : 'dynamic',
      mass: Math.max(0.01, readNumberInput(modelPhysicsMassInput, 1)),
      friction: Math.max(0, readNumberInput(modelPhysicsFrictionInput, 0.6)),
      restitution: THREE.MathUtils.clamp(readNumberInput(modelPhysicsRestitutionInput, 0.1), 0, 1),
      linearDamping: Math.max(0, readNumberInput(modelPhysicsLinearDampingInput, 0.05)),
      angularDamping: Math.max(0, readNumberInput(modelPhysicsAngularDampingInput, 0.1)),
      gravityScale: readNumberInput(modelPhysicsGravityScaleInput, 1),
      spawnHeightOffset: THREE.MathUtils.clamp(
        readNumberInput(modelPhysicsSpawnHeightInput, 1),
        -10,
        50,
      ),
      initialVelocity: {
        x: THREE.MathUtils.clamp(readNumberInput(modelPhysicsVelocityXInput, 0), -30, 30),
        y: THREE.MathUtils.clamp(readNumberInput(modelPhysicsVelocityYInput, 0), -30, 30),
        z: THREE.MathUtils.clamp(readNumberInput(modelPhysicsVelocityZInput, 0), -30, 30),
      },
    });
    const emptyTextures = (): EditorModelTextures => ({
      baseColor: '',
      normal: '',
      roughness: '',
      metalness: '',
      emissive: '',
    });
    let modelTexturePaths: EditorModelTextures = emptyTextures();
    const syncModelTexturePathBadges = () => {
      modelBaseColorPath.textContent = `Base Color: ${modelTexturePaths.baseColor || 'none'}`;
      modelNormalPath.textContent = `Normal: ${modelTexturePaths.normal || 'none'}`;
      modelRoughnessPath.textContent = `Roughness: ${modelTexturePaths.roughness || 'none'}`;
      modelMetalnessPath.textContent = `Metalness: ${modelTexturePaths.metalness || 'none'}`;
      modelEmissivePath.textContent = `Emissive: ${modelTexturePaths.emissive || 'none'}`;
    };
    const slugifyModelId = (value: string) =>
      value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const normalizeModelRecord = (record: GameModelRecord): EditorModelRecord => {
      const unknownRecord = record as unknown as Record<string, unknown>;
      const sourceFileRaw =
        typeof unknownRecord.sourceFile === 'string'
          ? unknownRecord.sourceFile
          : typeof unknownRecord.sourcePath === 'string'
            ? unknownRecord.sourcePath
            : '';
      const texturesValue = unknownRecord.textures;
      const textures = (texturesValue && typeof texturesValue === 'object'
        ? texturesValue
        : {}) as Record<string, unknown>;
      const toTexture = (key: keyof EditorModelTextures) =>
        typeof textures[key] === 'string' ? String(textures[key]) : '';
      return {
        id: String(record.id ?? '').trim(),
        name: String(record.name ?? '').trim(),
        sourceFile: String(sourceFileRaw ?? '').trim(),
        sourcePath:
          typeof unknownRecord.sourcePath === 'string' ? String(unknownRecord.sourcePath) : undefined,
        originOffset: (() => {
          const value =
            unknownRecord.originOffset && typeof unknownRecord.originOffset === 'object'
              ? (unknownRecord.originOffset as Record<string, unknown>)
              : null;
          if (!value) return defaultModelOriginOffset();
          const x = Number(value.x ?? 0);
          const y = Number(value.y ?? 0);
          const z = Number(value.z ?? 0);
          return {
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
            z: Number.isFinite(z) ? z : 0,
          };
        })(),
        collider: (() => {
          const value =
            unknownRecord.collider && typeof unknownRecord.collider === 'object'
              ? (unknownRecord.collider as Record<string, unknown>)
              : null;
          if (!value) return defaultModelCollider();
          const sizeRaw =
            value.size && typeof value.size === 'object'
              ? (value.size as Record<string, unknown>)
              : {};
          const offsetRaw =
            value.offset && typeof value.offset === 'object'
              ? (value.offset as Record<string, unknown>)
              : {};
          const shapeRaw = String(value.shape ?? 'box').toLowerCase();
          return {
            shape:
              shapeRaw === 'sphere' || shapeRaw === 'capsule' || shapeRaw === 'mesh'
                ? shapeRaw
                : 'box',
            size: {
              x: Math.max(0.05, Number(sizeRaw.x ?? 1)),
              y: Math.max(0.05, Number(sizeRaw.y ?? 1)),
              z: Math.max(0.05, Number(sizeRaw.z ?? 1)),
            },
            radius: Math.max(0.05, Number(value.radius ?? 0.5)),
            height: Math.max(0.1, Number(value.height ?? 1.8)),
            offset: {
              x: Number(offsetRaw.x ?? 0),
              y: Number(offsetRaw.y ?? 0),
              z: Number(offsetRaw.z ?? 0),
            },
            isTrigger: value.isTrigger === true,
          };
        })(),
        physics: (() => {
          const value =
            unknownRecord.physics && typeof unknownRecord.physics === 'object'
              ? (unknownRecord.physics as Record<string, unknown>)
              : null;
          if (!value) return defaultModelPhysics();
          const bodyTypeRaw = String(value.bodyType ?? defaultModelPhysics().bodyType).toLowerCase();
          const dampingRaw =
            value.damping && typeof value.damping === 'object'
              ? (value.damping as Record<string, unknown>)
              : {};
          const spawnRawObject =
            value.spawn && typeof value.spawn === 'object'
              ? (value.spawn as Record<string, unknown>)
              : null;
          const initialVelocityRaw =
            value.initialVelocity && typeof value.initialVelocity === 'object'
              ? (value.initialVelocity as Record<string, unknown>)
              : value.velocity && typeof value.velocity === 'object'
                ? (value.velocity as Record<string, unknown>)
              : {};
          const defaultPhysics = defaultModelPhysics();
          const normalizedBodyType =
            bodyTypeRaw === 'dynamic' || bodyTypeRaw === 'kinematic' || bodyTypeRaw === 'static'
              ? bodyTypeRaw
              : defaultPhysics.bodyType;
          return {
            enabled:
              typeof value.enabled === 'boolean' ? value.enabled : defaultPhysics.enabled,
            bodyType: normalizedBodyType,
            mass: Math.max(
              normalizedBodyType === 'dynamic' ? 0.01 : 0,
              asFiniteNumber(value.mass, defaultPhysics.mass),
            ),
            friction: Math.max(0, asFiniteNumber(value.friction, defaultPhysics.friction)),
            restitution: clampFiniteNumber(value.restitution, 0, 1, defaultPhysics.restitution),
            linearDamping: Math.max(
              0,
              asFiniteNumber(value.linearDamping ?? dampingRaw.linear, defaultPhysics.linearDamping),
            ),
            angularDamping: Math.max(
              0,
              asFiniteNumber(value.angularDamping ?? dampingRaw.angular, defaultPhysics.angularDamping),
            ),
            gravityScale: asFiniteNumber(value.gravityScale, defaultPhysics.gravityScale),
            spawnHeightOffset: clampFiniteNumber(
              value.spawnHeightOffset ??
                (typeof value.spawn === 'number' ? value.spawn : spawnRawObject?.heightOffset),
              -10,
              50,
              defaultPhysics.spawnHeightOffset,
            ),
            initialVelocity: {
              x: clampFiniteNumber(initialVelocityRaw.x, -30, 30, defaultPhysics.initialVelocity.x),
              y: clampFiniteNumber(initialVelocityRaw.y, -30, 30, defaultPhysics.initialVelocity.y),
              z: clampFiniteNumber(initialVelocityRaw.z, -30, 30, defaultPhysics.initialVelocity.z),
            },
          };
        })(),
        textures: {
          baseColor: toTexture('baseColor'),
          normal: toTexture('normal'),
          roughness: toTexture('roughness'),
          metalness: toTexture('metalness'),
          emissive: toTexture('emissive'),
        },
        files: Array.isArray(unknownRecord.files)
          ? unknownRecord.files.filter((item): item is string => typeof item === 'string')
          : undefined,
        materials: Array.isArray(unknownRecord.materials)
          ? unknownRecord.materials
              .map((entry) => {
                if (!entry || typeof entry !== 'object') return null;
                const raw = entry as Record<string, unknown>;
                const texturesRaw =
                  raw.textures && typeof raw.textures === 'object'
                    ? (raw.textures as Record<string, unknown>)
                    : {};
                const textures: Record<string, string> = {};
                for (const [key, value] of Object.entries(texturesRaw)) {
                  if (typeof value === 'string' && value.trim().length > 0) {
                    textures[key] = value.trim();
                  }
                }
                return {
                  id: typeof raw.id === 'string' ? raw.id : '',
                  name: typeof raw.name === 'string' ? raw.name : '',
                  textures,
                };
              })
              .filter((entry): entry is NonNullable<EditorModelRecord['materials']>[number] => !!entry)
          : undefined,
        createdAt: typeof unknownRecord.createdAt === 'string' ? unknownRecord.createdAt : undefined,
        updatedAt: typeof unknownRecord.updatedAt === 'string' ? unknownRecord.updatedAt : undefined,
      };
    };
    const readModelForm = () => ({
      id: modelIdInput.value.trim(),
      name: modelNameInput.value.trim(),
      sourceFile: modelSourceFileInput.value.trim(),
      originOffset: readModelOriginOffsetInput(),
      collider: readModelColliderInput(),
      physics: readModelPhysicsInput(),
      textures: { ...modelTexturePaths } as EditorModelTextures,
    });
    const writeModelForm = (record: EditorModelRecord | null) => {
      const next = record ?? {
        id: '',
        name: '',
        sourceFile: '',
        originOffset: defaultModelOriginOffset(),
        collider: defaultModelCollider(),
        physics: defaultModelPhysics(),
        textures: emptyTextures(),
      };
      modelIdInput.value = next.id;
      modelNameInput.value = next.name;
      modelSourceFileInput.value = next.sourceFile;
      modelOriginXInput.value = String(next.originOffset?.x ?? 0);
      modelOriginYInput.value = String(next.originOffset?.y ?? 0);
      modelOriginZInput.value = String(next.originOffset?.z ?? 0);
      const collider = next.collider ?? defaultModelCollider();
      modelColliderShapeInput.value = collider.shape;
      modelColliderSizeXInput.value = String(collider.size.x);
      modelColliderSizeYInput.value = String(collider.size.y);
      modelColliderSizeZInput.value = String(collider.size.z);
      modelColliderRadiusInput.value = String(collider.radius);
      modelColliderHeightInput.value = String(collider.height);
      modelColliderOffsetXInput.value = String(collider.offset.x);
      modelColliderOffsetYInput.value = String(collider.offset.y);
      modelColliderOffsetZInput.value = String(collider.offset.z);
      modelColliderTriggerInput.checked = collider.isTrigger;
      const physics = next.physics ?? defaultModelPhysics();
      modelPhysicsEnabledInput.checked = physics.enabled;
      modelPhysicsBodyTypeInput.value = physics.bodyType;
      modelPhysicsMassInput.value = String(physics.mass);
      modelPhysicsFrictionInput.value = String(physics.friction);
      modelPhysicsRestitutionInput.value = String(physics.restitution);
      modelPhysicsLinearDampingInput.value = String(physics.linearDamping);
      modelPhysicsAngularDampingInput.value = String(physics.angularDamping);
      modelPhysicsGravityScaleInput.value = String(physics.gravityScale);
      modelPhysicsSpawnHeightInput.value = String(physics.spawnHeightOffset);
      modelPhysicsVelocityXInput.value = String(physics.initialVelocity.x);
      modelPhysicsVelocityYInput.value = String(physics.initialVelocity.y);
      modelPhysicsVelocityZInput.value = String(physics.initialVelocity.z);
      modelTexturePaths = {
        baseColor: next.textures.baseColor ?? '',
        normal: next.textures.normal ?? '',
        roughness: next.textures.roughness ?? '',
        metalness: next.textures.metalness ?? '',
        emissive: next.textures.emissive ?? '',
      };
      syncModelTexturePathBadges();
      modelUploadedFiles = Array.isArray(next.files) ? [...next.files] : [];
    };
    syncModelTexturePathBadges();
    const getTextureFileSelection = () => ({
      baseColor: modelBaseColorFileInput?.files?.[0] ?? null,
      normal: modelNormalFileInput?.files?.[0] ?? null,
      roughness: modelRoughnessFileInput?.files?.[0] ?? null,
      metalness: modelMetalnessFileInput?.files?.[0] ?? null,
      emissive: modelEmissiveFileInput?.files?.[0] ?? null,
    });
    const syncLevelModelSpawnOptions = () => {
      const previous = levelModelSpawnSelect.value || this.levelModelSpawnId || '';
      levelModelSpawnSelect.innerHTML = '<option value="">Select model</option>';
      const sorted = modelRecords.slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const model of sorted) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.name} (${model.id})`;
        levelModelSpawnSelect.appendChild(option);
      }
      const hasPrevious = sorted.some((item) => item.id === previous);
      this.levelModelSpawnId = hasPrevious ? previous : '';
      levelModelSpawnSelect.value = this.levelModelSpawnId;
    };
    const renderLevelModelLibrary = () => {
      if (!levelModelLibrary) return;
      if (modelRecords.length === 0) {
        levelModelLibrary.innerHTML = '<div class="clip-status">No saved objects yet.</div>';
        return;
      }
      levelModelLibrary.innerHTML = '';
      const sorted = modelRecords.slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const model of sorted) {
        const row = document.createElement('div');
        row.className = 'model-list-row';
        const meta = document.createElement('div');
        meta.className = 'model-list-meta';
        meta.textContent = `${model.name} (${model.id})`;
        const place = document.createElement('button');
        place.type = 'button';
        place.textContent = 'Place';
        place.dataset.levelLibraryPlace = model.id;
        row.append(meta, place);
        levelModelLibrary.appendChild(row);
      }
    };
    const renderModelList = () => {
      if (modelRecords.length === 0) {
        modelList.innerHTML = '<div class="clip-status">No models saved for this game.</div>';
        syncLevelModelSpawnOptions();
        renderLevelModelLibrary();
        return;
      }
      modelList.innerHTML = '';
      const sorted = modelRecords.slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const model of sorted) {
        const row = document.createElement('div');
        row.className = 'model-list-row';
        const meta = document.createElement('button');
        meta.type = 'button';
        meta.className = 'model-list-meta';
        meta.textContent = `${model.name} (${model.id}) • ${model.sourceFile}`;
        meta.addEventListener('click', async () => {
          if (!this.currentGameId) {
            writeModelForm(model);
            return;
          }
          try {
            const fullRecord = await getGameModel(this.currentGameId, model.id);
            writeModelForm(normalizeModelRecord(fullRecord));
            if (modelStatus) modelStatus.textContent = `Loaded ${model.id} into form`;
          } catch {
            writeModelForm(model);
            if (modelStatus) modelStatus.textContent = `Loaded cached ${model.id}`;
          }
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.dataset.modelDelete = model.id;
        row.append(meta, remove);
        modelList.appendChild(row);
      }
      syncLevelModelSpawnOptions();
      renderLevelModelLibrary();
    };
    const setSceneStatus = (text: string, tone: 'ok' | 'warn' = 'ok') => {
      sceneStatus.textContent = text;
      sceneStatus.dataset.tone = tone;
    };
    const syncSceneSelect = () => {
      sceneList.innerHTML = '';
      for (const entry of sceneState.scenes) {
        const opt = document.createElement('option');
        opt.value = entry.name;
        opt.textContent = entry.name;
        sceneList.appendChild(opt);
      }
    };
    const syncSceneJson = () => {
      sceneJson.value = JSON.stringify(sceneState, null, 2);
    };
    const refreshModels = async () => {
      if (!this.currentGameId) {
        modelRecords = [];
        renderModelList();
        if (modelStatus) modelStatus.textContent = 'Select a game to manage models.';
        return;
      }
      try {
        const items = await listGameModels(this.currentGameId);
        modelRecords = items
          .map((item: GameModelRecord) => normalizeModelRecord(item))
          .filter((item: EditorModelRecord) => item.id.length > 0 && item.name.length > 0);
        renderModelList();
        if (modelStatus) modelStatus.textContent = `Loaded ${modelRecords.length} model(s).`;
      } catch (error) {
        modelRecords = [];
        renderModelList();
        if (modelStatus) modelStatus.textContent = `Model load failed: ${String(error)}`;
      }
    };
    this.refreshModelsFunction = refreshModels;
    const renderLogicPreviewLog = (lines: string[]) => {
      if (!levelLogicPreviewLog) return;
      levelLogicPreviewLog.innerHTML = '';
      const output = lines.length > 0 ? lines : ['No preview output.'];
      for (const line of output) {
        const row = document.createElement('div');
        row.className = 'clip-status';
        row.textContent = line;
        levelLogicPreviewLog.appendChild(row);
      }
    };
    const clearLogicPreviewLog = () => {
      renderLogicPreviewLog(['No preview run yet.']);
    };
    const parseLogicPreviewTrigger = (value: string): LogicPreviewTrigger => {
      if (value === 'onInteract' || value === 'onZoneEnter' || value === 'onTimer') return value;
      return 'onStart';
    };
    const loadSceneFromState = (name: string) => {
      const entry = sceneState.scenes.find((s) => s.name === name);
      if (!entry) return;
      sceneList.value = entry.name;
      sceneNameInput.value = entry.name;
      sceneObstacles.value = JSON.stringify(entry.obstacles ?? [], null, 2);
      const normalizedGround = this.normalizeLevelGround(entry.ground);
      const terrain = normalizedGround?.terrain;
      levelTerrainTexture.value = normalizedGround?.texturePreset ?? 'concrete';
      const water = normalizedGround?.water ?? this.normalizeLevelWater(undefined);
      levelWaterEnabled.checked = water.enabled;
      levelWaterLevel.value = String(water.level);
      levelWaterOpacity.value = String(water.opacity);
      levelWaterWaveAmp.value = String(water.waveAmplitude);
      levelWaterWaveFreq.value = String(water.waveFrequency);
      levelWaterWaveSpeed.value = String(water.waveSpeed);
      levelWaterColorShallow.value = water.colorShallow;
      levelWaterColorDeep.value = water.colorDeep;
      levelWaterSpecular.value = String(water.specularStrength);
      if (terrain) {
        levelTerrainPreset.value = terrain.preset ?? 'cinematic';
        levelTerrainSize.value = String(Math.max(16, Number(terrain.size ?? 96)));
        levelTerrainRes.value = String(Math.max(8, Number(terrain.resolution ?? 28)));
        levelTerrainHeight.value = String(Math.max(1, Number(terrain.maxHeight ?? 10)));
        levelTerrainRoughness.value = String(
          Math.max(0.2, Math.min(0.95, Number(terrain.roughness ?? 0.56))),
        );
        levelTerrainSeed.value = String(Math.floor(Number(terrain.seed ?? 1337)));
        levelSculptRadius.value = String(Math.max(0.5, Number(levelSculptRadius.value || 5)));
        levelSculptStrength.value = String(
          Math.max(0.02, Math.min(2, Number(levelSculptStrength.value || 0.35))),
        );
      }
      this.levelSculptRadiusValue = Math.max(0.5, Number(levelSculptRadius.value || 5));
      this.levelSculptStrengthValue = Math.max(
        0.02,
        Math.min(2, Number(levelSculptStrength.value || 0.35)),
      );
      const environment = this.normalizeLevelEnvironment(entry.environment);
      levelEnvironmentPreset.value = environment.preset;
      levelEnvironmentFogNear.value = String(environment.fogNear);
      levelEnvironmentFogFar.value = String(environment.fogFar);
      levelEnvironmentSkyboxEnabled.checked = environment.skybox.enabled;
      levelEnvironmentSkyboxPreset.value = environment.skybox.preset;
      levelEnvironmentSkyboxIntensity.value = String(environment.skybox.intensity);
      if (entry.roads && entry.roads.length > 0) {
        const road = this.normalizeLevelRoad(entry.roads[entry.roads.length - 1] ?? {}, entry.roads.length - 1);
        levelRoadName.value = road.name;
        levelRoadWidth.value = String(road.width);
        levelRoadMaterial.value = road.material;
        this.levelRoadEditName = road.name;
        this.levelRoadEditWidth = road.width;
        this.levelRoadEditMaterial = road.material;
        if (levelRoadStatus) levelRoadStatus.textContent = `Roads loaded: ${entry.roads.length}`;
      } else {
        this.levelRoadEditName = levelRoadName.value.trim() || 'Road 1';
        this.levelRoadEditWidth = Math.max(1, Number(levelRoadWidth.value || 3));
        this.levelRoadEditMaterial =
          (levelRoadMaterial.value as 'asphalt' | 'dirt' | 'neon') || 'asphalt';
        if (levelRoadStatus) levelRoadStatus.textContent = 'No roads in scene yet.';
      }
      sceneLogicInput.value = JSON.stringify(entry.logic ?? { nodes: [], links: [] }, null, 2);
      syncSceneJson();
      // Update level scene visualization
      this.updateLevelVisualization(entry.obstacles ?? []);
      this.refreshLevelInspector();
      this.renderLevelLogicList();
      clearLogicPreviewLog();
    };
    this.captureLevelHistorySnapshot = () => ({
      scenes: JSON.parse(JSON.stringify(sceneState.scenes)) as LevelScene[],
      activeSceneName: sceneList.value || null,
      selectedObjectId: this.selectedLevelObjectId,
    });
    this.applyLevelHistorySnapshot = (snapshot) => {
      sceneState.scenes = JSON.parse(JSON.stringify(snapshot.scenes)) as LevelScene[];
      syncSceneSelect();
      const targetName =
        snapshot.activeSceneName &&
        sceneState.scenes.some((entry) => entry.name === snapshot.activeSceneName)
          ? snapshot.activeSceneName
          : (sceneState.scenes[0]?.name ?? null);
      if (targetName) {
        loadSceneFromState(targetName);
      } else {
        this.selectLevelObject(null);
        this.syncLevelTextEditors();
        this.refreshLevelInspector();
        this.renderLevelLogicList();
      }
      if (snapshot.selectedObjectId && this.levelSceneObjects.has(snapshot.selectedObjectId)) {
        this.selectLevelObject(snapshot.selectedObjectId);
      } else {
        this.selectLevelObject(null);
      }
      syncSceneJson();
    };
    this.updateLevelHistoryControls = () => {
      if (levelUndoBtn) levelUndoBtn.disabled = !this.levelHistory.canUndo();
      if (levelRedoBtn) levelRedoBtn.disabled = !this.levelHistory.canRedo();
    };
    this.updateLevelHistoryControls?.();

    // Method to update level scene with obstacles
    this.updateLevelVisualization = (obstacles: LevelObstacle[]) => {
      this.updateLevelVisualizationFromState(obstacles);
      this.syncLevelTextEditors();
    };
    const loadScenes = async () => {
      const scenesPath = this.getScenesPath();
      if (!scenesPath) {
        setSceneStatus('No game selected', 'warn');
        sceneState.scenes = [];
        syncSceneSelect();
        return;
      }
      try {
        if (!this.currentGameId) throw new Error('No game selected');
        const data = await getGameScenes(this.currentGameId);
        sceneState.scenes = (data.scenes ?? [
          {
            name: 'main',
            obstacles: [],
            zones: [],
            components: {},
            roads: [],
            environment: this.normalizeLevelEnvironment(undefined),
            logic: { nodes: [], links: [] },
          },
        ]).map(
          (scene, sceneIndex) => {
            const rawObstacles = Array.isArray(scene.obstacles) ? scene.obstacles : [];
            const obstacles = rawObstacles.map((item, obstacleIndex) =>
              this.normalizeLevelObstacle((item ?? {}) as LevelObstacle, obstacleIndex),
            );
            const ground = this.normalizeLevelGround(
              (scene.ground ?? undefined) as LevelGround | undefined,
            );
            return {
              name: scene.name || `scene_${sceneIndex + 1}`,
              obstacles,
              zones: Array.isArray((scene as LevelScene).zones)
                ? ((scene as LevelScene).zones ?? []).map((item, zoneIndex) =>
                    this.normalizeLevelZone((item ?? {}) as LevelZone, zoneIndex),
                  )
                : [],
              logic:
                (scene as LevelScene).logic && typeof (scene as LevelScene).logic === 'object'
                  ? {
                      nodes: Array.isArray((scene as LevelScene).logic?.nodes)
                        ? (scene as LevelScene).logic?.nodes
                        : [],
                      links: Array.isArray((scene as LevelScene).logic?.links)
                        ? (scene as LevelScene).logic?.links
                        : [],
                    }
                  : { nodes: [], links: [] },
              components:
                (scene as LevelScene).components &&
                typeof (scene as LevelScene).components === 'object'
                  ? { ...(scene as LevelScene).components }
                  : {},
              roads: Array.isArray((scene as LevelScene).roads)
                ? ((scene as LevelScene).roads ?? []).map((item, roadIndex) =>
                    this.normalizeLevelRoad((item ?? {}) as LevelRoad, roadIndex),
                  )
                : [],
              environment: this.normalizeLevelEnvironment(
                (scene as LevelScene).environment ?? undefined,
              ),
              ground: ground ?? undefined,
              player: scene.player ? { ...scene.player } : undefined,
              crowd: scene.crowd ? { ...scene.crowd } : undefined,
            };
          },
        );
        syncSceneSelect();
        loadSceneFromState(sceneState.scenes[0]?.name ?? 'main');
        this.levelHistory.clear();
        this.levelTransformDragSnapshot = null;
        this.updateLevelHistoryControls?.();
        setSceneStatus(`Scenes: ${sceneState.scenes.length}`, 'ok');
      } catch (err) {
        sceneState.scenes = [
          {
            name: 'main',
            obstacles: [],
            zones: [],
            components: {},
            roads: [],
            environment: this.normalizeLevelEnvironment(undefined),
            logic: { nodes: [], links: [] },
          },
        ];
        syncSceneSelect();
        loadSceneFromState('main');
        this.levelHistory.clear();
        this.levelTransformDragSnapshot = null;
        this.updateLevelHistoryControls?.();
        setSceneStatus('Initialized default scene', 'ok');
      }
    };
    const saveScenes = async () => {
      const scenesPath = this.getScenesPath();
      if (!scenesPath) {
        setSceneStatus('Please select a game first', 'warn');
        return;
      }
      try {
        if (!this.currentGameId) throw new Error('No game selected');
        await saveGameScenes(this.currentGameId, sceneState);
        setSceneStatus(`Saved to game "${this.currentGameId}"`, 'ok');
      } catch (err) {
        setSceneStatus(`Save failed: ${String(err)}`, 'warn');
      }
    };

    // Store reference for external access
    this.refreshScenesFunction = loadScenes;

    // Add custom event listener to trigger refresh from outside
    sceneList.addEventListener('refreshScenes', () => {
      loadScenes();
    });

    sceneLoadBtn?.addEventListener('click', () => loadSceneFromState(sceneList.value));
    sceneList?.addEventListener('change', () => loadSceneFromState(sceneList.value));
    sceneNewBtn?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const name = (sceneNameInput.value || '').trim() || `scene_${sceneState.scenes.length + 1}`;
        if (sceneState.scenes.find((s) => s.name === name)) {
          setSceneStatus('Scene already exists', 'warn');
          return;
        }
        sceneState.scenes.push({
          name,
          obstacles: [],
          zones: [],
          components: {},
          roads: [],
          environment: this.normalizeLevelEnvironment(undefined),
          logic: { nodes: [], links: [] },
        });
        syncSceneSelect();
        sceneList.value = name;
        loadSceneFromState(name);
      });
    });
    sceneSaveBtn?.addEventListener('click', async () => {
      let shouldSave = false;
      this.recordLevelEdit(() => {
        const name = (sceneNameInput.value || '').trim() || sceneList.value || 'main';
        let obstacles: LevelObstacle[] = [];
        let logicPayload: LevelScene['logic'] = { nodes: [], links: [] };
        try {
          obstacles = JSON.parse(sceneObstacles.value || '[]') as LevelObstacle[];
        } catch (err) {
          setSceneStatus(`Invalid JSON: ${String(err)}`, 'warn');
          return;
        }
        try {
          const parsed = JSON.parse(sceneLogicInput.value || '{}') as LevelScene['logic'];
          logicPayload = {
            nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [],
            links: Array.isArray(parsed?.links) ? parsed.links : [],
          };
        } catch (err) {
          setSceneStatus(`Invalid logic JSON: ${String(err)}`, 'warn');
          return;
        }
        const entry = sceneState.scenes.find((s) => s.name === name);
        if (entry) {
          entry.obstacles = obstacles;
          entry.logic = logicPayload;
        } else {
          sceneState.scenes.push({
            name,
            obstacles,
            logic: logicPayload,
            zones: [],
            components: {},
            roads: [],
            environment: this.normalizeLevelEnvironment(undefined),
          });
        }
        syncSceneSelect();
        sceneList.value = name;
        syncSceneJson();
        this.updateLevelVisualization(obstacles);
        shouldSave = true;
      });
      if (shouldSave) {
        await saveScenes();
      }
    });
    sceneDeleteBtn?.addEventListener('click', async () => {
      this.recordLevelEdit(() => {
        const name = sceneList.value;
        sceneState.scenes = sceneState.scenes.filter((s) => s.name !== name);
        if (sceneState.scenes.length === 0) {
          sceneState.scenes.push({
            name: 'main',
            obstacles: [],
            zones: [],
            components: {},
            roads: [],
            environment: this.normalizeLevelEnvironment(undefined),
            logic: { nodes: [], links: [] },
          });
        }
        syncSceneSelect();
        loadSceneFromState(sceneState.scenes[0]?.name ?? 'main');
        syncSceneJson();
      });
      await saveScenes();
    });

    modelClearBtn?.addEventListener('click', () => {
      writeModelForm(null);
      if (modelFbxFileInput) modelFbxFileInput.value = '';
      if (modelBaseColorFileInput) modelBaseColorFileInput.value = '';
      if (modelNormalFileInput) modelNormalFileInput.value = '';
      if (modelRoughnessFileInput) modelRoughnessFileInput.value = '';
      if (modelMetalnessFileInput) modelMetalnessFileInput.value = '';
      if (modelEmissiveFileInput) modelEmissiveFileInput.value = '';
      if (modelStatus) modelStatus.textContent = 'Cleared model form.';
    });

    modelRefreshBtn?.addEventListener('click', async () => {
      await refreshModels();
    });
    modelPhysicsDropPresetBtn?.addEventListener('click', () => {
      modelPhysicsEnabledInput.checked = true;
      modelPhysicsBodyTypeInput.value = 'dynamic';
      modelPhysicsSpawnHeightInput.value = '3';
      modelPhysicsVelocityXInput.value = '0';
      modelPhysicsVelocityYInput.value = '0';
      modelPhysicsVelocityZInput.value = '0';
      if (modelStatus) modelStatus.textContent = 'Applied drop test preset.';
    });
    modelPhysicsPushPresetBtn?.addEventListener('click', () => {
      modelPhysicsEnabledInput.checked = true;
      modelPhysicsBodyTypeInput.value = 'dynamic';
      modelPhysicsSpawnHeightInput.value = '1';
      modelPhysicsVelocityXInput.value = '5';
      modelPhysicsVelocityYInput.value = '1.5';
      modelPhysicsVelocityZInput.value = '0';
      if (modelStatus) modelStatus.textContent = 'Applied push test preset.';
    });
    modelPhysicsClearPresetBtn?.addEventListener('click', () => {
      modelPhysicsSpawnHeightInput.value = '0';
      modelPhysicsVelocityXInput.value = '0';
      modelPhysicsVelocityYInput.value = '0';
      modelPhysicsVelocityZInput.value = '0';
      if (modelStatus) modelStatus.textContent = 'Cleared physics test values.';
    });

    modelFbxFileInput?.addEventListener('change', () => {
      const file = modelFbxFileInput.files?.[0];
      if (!file) return;
      if (!modelSourceFileInput.value.trim()) {
        modelSourceFileInput.value = file.name;
      }
      if (!modelNameInput.value.trim()) {
        modelNameInput.value = file.name.replace(/\.[^/.]+$/, '');
      }
    });

    modelBaseColorFileInput?.addEventListener('change', () => {
      const file = modelBaseColorFileInput.files?.[0];
      if (!file) return;
      modelTexturePaths.baseColor = file.name;
      syncModelTexturePathBadges();
    });
    modelNormalFileInput?.addEventListener('change', () => {
      const file = modelNormalFileInput.files?.[0];
      if (!file) return;
      modelTexturePaths.normal = file.name;
      syncModelTexturePathBadges();
    });
    modelRoughnessFileInput?.addEventListener('change', () => {
      const file = modelRoughnessFileInput.files?.[0];
      if (!file) return;
      modelTexturePaths.roughness = file.name;
      syncModelTexturePathBadges();
    });
    modelMetalnessFileInput?.addEventListener('change', () => {
      const file = modelMetalnessFileInput.files?.[0];
      if (!file) return;
      modelTexturePaths.metalness = file.name;
      syncModelTexturePathBadges();
    });
    modelEmissiveFileInput?.addEventListener('change', () => {
      const file = modelEmissiveFileInput.files?.[0];
      if (!file) return;
      modelTexturePaths.emissive = file.name;
      syncModelTexturePathBadges();
    });

    const previewModelFromForm = async () => {
      const form = readModelForm();
      const modelId = slugifyModelId(form.id || form.name);
      if (!modelId) {
        if (modelStatus) modelStatus.textContent = 'Model id or name is required for preview.';
        return;
      }
      let previewRecord: EditorModelRecord = {
        id: modelId,
        name: form.name || modelId,
        sourceFile: form.sourceFile,
        originOffset: form.originOffset,
        collider: form.collider,
        physics: form.physics,
        textures: form.textures,
      };
      if (this.currentGameId) {
        try {
          const saved = await getGameModel(this.currentGameId, modelId);
          const normalized = normalizeModelRecord(saved);
          previewRecord = {
            ...normalized,
            name: previewRecord.name || normalized.name,
            textures: {
              ...normalized.textures,
              ...form.textures,
            },
            originOffset: form.originOffset ?? normalized.originOffset ?? defaultModelOriginOffset(),
            collider: form.collider ?? normalized.collider ?? defaultModelCollider(),
            physics: form.physics ?? normalized.physics ?? defaultModelPhysics(),
          };
        } catch {
          // Form-based preview fallback is intentional for unsaved models.
        }
      }
      try {
        if (this.modelPreviewObject) {
          this.modelPreviewRoot.remove(this.modelPreviewObject);
          this.modelPreviewObject = null;
        }
        const localFbx = modelFbxFileInput?.files?.[0] ?? null;
        let preview: THREE.Object3D;
        if (localFbx) {
          const localFbxUrl = URL.createObjectURL(localFbx);
          try {
            preview = await this.loadFbxObject(localFbxUrl);
          } finally {
            URL.revokeObjectURL(localFbxUrl);
          }
          preview = this.normalizeModelRootPivot(preview);
          this.applyModelOriginOffset(preview, form.originOffset);
          const localTextures = getTextureFileSelection();
          const loadLocalTexture = async (file: File | null, colorSpace: THREE.ColorSpace) => {
            if (!file) return null;
            const url = URL.createObjectURL(file);
            try {
              return await this.loadTexture(url, colorSpace);
            } finally {
              URL.revokeObjectURL(url);
            }
          };
          const textureLoads = await Promise.all([
            loadLocalTexture(localTextures.baseColor, THREE.SRGBColorSpace),
            loadLocalTexture(localTextures.normal, THREE.NoColorSpace),
            loadLocalTexture(localTextures.roughness, THREE.NoColorSpace),
            loadLocalTexture(localTextures.metalness, THREE.NoColorSpace),
            loadLocalTexture(localTextures.emissive, THREE.SRGBColorSpace),
          ]);
          const [baseColor, normal, roughness, metalness, emissive] = textureLoads;
          preview.traverse((obj) => {
            if (!(obj instanceof THREE.Mesh)) return;
            this.ensureGeometryUv(obj);
            const asArray = Array.isArray(obj.material) ? obj.material : [obj.material];
            const nextMaterials = asArray.map((base) => {
              const material = this.toMeshStandardMaterial(base);
              this.applyTexturesToMaterial(material, {
                baseColor,
                normal,
                roughness,
                metalness,
                emissive,
              });
              return material;
            });
            obj.material = Array.isArray(obj.material) ? nextMaterials : (nextMaterials[0] ?? obj.material);
          });
        } else {
          if (!this.currentGameId || !previewRecord.sourceFile) {
            if (modelStatus) {
              modelStatus.textContent = 'Select an FBX upload or saved source file for preview.';
            }
            return;
          }
          preview = await this.loadModelAssetObject(this.currentGameId, previewRecord);
        }
        preview.position.set(0, 0, 0);
        preview.scale.multiplyScalar(1.6);
        this.modelPreviewObject = preview;
        this.modelPreviewRoot.add(preview);
        this.switchToTab('model');
        if (this.controls) {
          this.controls.target.set(0, 0.8, 0);
          this.controls.update();
        }
        if (modelStatus) modelStatus.textContent = `Preview loaded: ${previewRecord.name}`;
      } catch (error) {
        if (modelStatus) modelStatus.textContent = `Preview failed: ${String(error)}`;
      }
    };

    modelPreviewBtn?.addEventListener('click', async () => {
      await previewModelFromForm();
    });

    modelSaveBtn?.addEventListener('click', async () => {
      if (!this.currentGameId) {
        if (modelStatus) modelStatus.textContent = 'Select a game before saving models.';
        return;
      }
      const form = readModelForm();
      const nextId = slugifyModelId(form.id || form.name);
      if (!form.name) {
        if (modelStatus) modelStatus.textContent = 'Model name is required.';
        return;
      }
      if (!nextId) {
        if (modelStatus) modelStatus.textContent = 'Model id could not be generated from name.';
        return;
      }
      if (!form.sourceFile && !modelFbxFileInput?.files?.[0]) {
        if (modelStatus) modelStatus.textContent = 'FBX source file name is required.';
        return;
      }
      try {
        const uploadedFiles = new Set<string>(modelUploadedFiles);
        const fbxUpload = modelFbxFileInput?.files?.[0];
        if (fbxUpload) {
          const saved = await uploadGameModelFile(this.currentGameId, nextId, fbxUpload.name, fbxUpload);
          modelSourceFileInput.value = saved.file;
          uploadedFiles.add(saved.file);
        }
        const textureFiles = getTextureFileSelection();
        if (textureFiles.baseColor) {
          const saved = await uploadGameModelFile(
            this.currentGameId,
            nextId,
            textureFiles.baseColor.name,
            textureFiles.baseColor,
          );
          uploadedFiles.add(saved.file);
          modelTexturePaths.baseColor = saved.file;
        }
        if (textureFiles.normal) {
          const saved = await uploadGameModelFile(
            this.currentGameId,
            nextId,
            textureFiles.normal.name,
            textureFiles.normal,
          );
          uploadedFiles.add(saved.file);
          modelTexturePaths.normal = saved.file;
        }
        if (textureFiles.roughness) {
          const saved = await uploadGameModelFile(
            this.currentGameId,
            nextId,
            textureFiles.roughness.name,
            textureFiles.roughness,
          );
          uploadedFiles.add(saved.file);
          modelTexturePaths.roughness = saved.file;
        }
        if (textureFiles.metalness) {
          const saved = await uploadGameModelFile(
            this.currentGameId,
            nextId,
            textureFiles.metalness.name,
            textureFiles.metalness,
          );
          uploadedFiles.add(saved.file);
          modelTexturePaths.metalness = saved.file;
        }
        if (textureFiles.emissive) {
          const saved = await uploadGameModelFile(
            this.currentGameId,
            nextId,
            textureFiles.emissive.name,
            textureFiles.emissive,
          );
          uploadedFiles.add(saved.file);
          modelTexturePaths.emissive = saved.file;
        }
        syncModelTexturePathBadges();
        const freshForm = readModelForm();
        await saveGameModel(this.currentGameId, {
          id: nextId,
          name: freshForm.name,
          sourceFile: freshForm.sourceFile,
          sourcePath: freshForm.sourceFile,
          originOffset: freshForm.originOffset,
          collider: freshForm.collider,
          physics: freshForm.physics,
          textures: freshForm.textures,
          files: Array.from(uploadedFiles),
          materials: [
            {
              id: 'default',
              name: 'Default',
              textures: {
                ...(freshForm.textures.baseColor ? { baseColor: freshForm.textures.baseColor } : {}),
                ...(freshForm.textures.normal ? { normal: freshForm.textures.normal } : {}),
                ...(freshForm.textures.roughness ? { roughness: freshForm.textures.roughness } : {}),
                ...(freshForm.textures.metalness ? { metalness: freshForm.textures.metalness } : {}),
                ...(freshForm.textures.emissive ? { emissive: freshForm.textures.emissive } : {}),
              },
            },
          ],
        });
        modelUploadedFiles = Array.from(uploadedFiles);
        modelIdInput.value = nextId;
        if (modelStatus) modelStatus.textContent = `Saved model ${nextId}.`;
        await refreshModels();
        await previewModelFromForm();
      } catch (error) {
        if (modelStatus) modelStatus.textContent = `Model save failed: ${String(error)}`;
      }
    });

    modelList?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      const deleteButton = target?.closest<HTMLButtonElement>('[data-model-delete]');
      const modelId = deleteButton?.dataset.modelDelete ?? '';
      if (!modelId) return;
      if (!this.currentGameId) {
        if (modelStatus) modelStatus.textContent = 'Select a game before deleting models.';
        return;
      }
      try {
        await deleteGameModel(this.currentGameId, modelId);
        if (modelStatus) modelStatus.textContent = `Deleted model ${modelId}.`;
        if (modelIdInput.value.trim() === modelId) writeModelForm(null);
        await refreshModels();
      } catch (error) {
        if (modelStatus) modelStatus.textContent = `Delete failed: ${String(error)}`;
      }
    });

    sceneLogicInput?.addEventListener('change', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        try {
          const parsed = JSON.parse(sceneLogicInput.value || '{}') as LevelScene['logic'];
          scene.logic = {
            nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [],
            links: Array.isArray(parsed?.links) ? parsed.links : [],
          };
          syncSceneJson();
          this.renderLevelLogicList();
        } catch {
          // keep editor responsive; validation occurs on save.
        }
      });
    });

    levelLogicAdd?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const trigger = levelLogicTrigger.value || 'onStart';
        const action = levelLogicAction.value || 'spawn';
        const target = (levelLogicTarget.value || this.selectedLevelObjectId || 'scene').trim();
        let params: Record<string, unknown> = {};
        const rawParams = levelLogicParams.value.trim();
        if (rawParams.length > 0) {
          try {
            params = JSON.parse(rawParams) as Record<string, unknown>;
          } catch {
            params = { raw: rawParams };
          }
        }
        const logic = scene.logic ?? { nodes: [], links: [] };
        const nodes = Array.isArray(logic.nodes) ? logic.nodes : [];
        const links = Array.isArray(logic.links) ? logic.links : [];
        const tId = `trg_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        const aId = `act_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        nodes.push({ id: tId, kind: 'trigger', trigger, target, params });
        nodes.push({ id: aId, kind: 'action', action, target, params });
        links.push({ from: tId, to: aId });
        scene.logic = { nodes, links };
        sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
        syncSceneJson();
        this.renderLevelLogicList();
        if (levelStatus) levelStatus.textContent = `Added logic rule: ${trigger} -> ${action}`;
      });
    });

    levelLogicClear?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        scene.logic = { nodes: [], links: [] };
        sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
        syncSceneJson();
        this.levelLogicSelectedNodeIds.clear();
        this.renderLevelLogicList();
        if (levelStatus) levelStatus.textContent = 'Cleared scene logic';
      });
    });
    levelLogicNodeAddTrigger?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const logic = scene.logic ?? { nodes: [], links: [] };
        const nodes = Array.isArray(logic.nodes) ? logic.nodes : [];
        const id = `trg_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        nodes.push({
          id,
          kind: 'trigger',
          trigger: levelLogicTrigger.value || 'onStart',
          target: (levelLogicTarget.value || 'scene').trim() || 'scene',
          params: {},
        });
        scene.logic = { nodes, links: Array.isArray(logic.links) ? logic.links : [] };
        sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
        this.levelLogicSelectedNodeIds.clear();
        this.levelLogicSelectedNodeIds.add(id);
        this.renderLevelLogicList();
      });
    });
    levelLogicNodeAddAction?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const logic = scene.logic ?? { nodes: [], links: [] };
        const nodes = Array.isArray(logic.nodes) ? logic.nodes : [];
        const id = `act_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        nodes.push({
          id,
          kind: 'action',
          action: levelLogicAction.value || 'spawn',
          target: (levelLogicTarget.value || 'scene').trim() || 'scene',
          params: {},
        });
        scene.logic = { nodes, links: Array.isArray(logic.links) ? logic.links : [] };
        sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
        this.levelLogicSelectedNodeIds.clear();
        this.levelLogicSelectedNodeIds.add(id);
        this.renderLevelLogicList();
      });
    });
    levelLogicNodeConnect?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const selected = Array.from(this.levelLogicSelectedNodeIds);
        if (selected.length < 2) return;
        const from = selected[0];
        const to = selected[1];
        const logic = scene.logic ?? { nodes: [], links: [] };
        const links = Array.isArray(logic.links) ? logic.links : [];
        if (!links.some((item) => item && item.from === from && item.to === to)) {
          links.push({ from, to });
        }
        scene.logic = {
          nodes: Array.isArray(logic.nodes) ? logic.nodes : [],
          links,
        };
        sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
        this.renderLevelLogicList();
      });
    });
    levelLogicNodeDelete?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const selected = new Set(this.levelLogicSelectedNodeIds);
        if (selected.size === 0) return;
        const logic = scene.logic ?? { nodes: [], links: [] };
        const nodes = (Array.isArray(logic.nodes) ? logic.nodes : []).filter((node) => {
          if (!node || typeof node !== 'object') return false;
          const id = (node as { id?: unknown }).id;
          return typeof id === 'string' && !selected.has(id);
        });
        const links = (Array.isArray(logic.links) ? logic.links : []).filter((link) => {
          const from = typeof link?.from === 'string' ? link.from : '';
          const to = typeof link?.to === 'string' ? link.to : '';
          return !selected.has(from) && !selected.has(to);
        });
        this.levelLogicSelectedNodeIds.clear();
        scene.logic = { nodes, links };
        sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
        this.renderLevelLogicList();
      });
    });
    levelLogicNodeClearSelection?.addEventListener('click', () => {
      this.levelLogicSelectedNodeIds.clear();
      this.renderLevelLogicList();
    });
    const copyLogicSelection = () => {
      const scene = this.getCurrentLevelSceneEntry();
      if (!scene) return false;
      const logic = scene.logic ?? { nodes: [], links: [] };
      const nodes = (Array.isArray(logic.nodes) ? logic.nodes : []).filter(
        (node): node is Record<string, unknown> =>
          Boolean(node) &&
          typeof node === 'object' &&
          typeof (node as { id?: unknown }).id === 'string' &&
          this.levelLogicSelectedNodeIds.has((node as { id: string }).id),
      );
      if (nodes.length === 0) return false;
      const ids = new Set(nodes.map((node) => String(node.id)));
      const links = (Array.isArray(logic.links) ? logic.links : [])
        .map((link) => ({
          from: typeof link?.from === 'string' ? link.from : '',
          to: typeof link?.to === 'string' ? link.to : '',
        }))
        .filter((link) => ids.has(link.from) && ids.has(link.to));
      this.levelLogicClipboard = {
        nodes: JSON.parse(JSON.stringify(nodes)) as Array<Record<string, unknown>>,
        links: JSON.parse(JSON.stringify(links)) as Array<{ from: string; to: string }>,
      };
      return true;
    };
    const pasteLogicSelection = () => {
      if (!this.levelLogicClipboard) return false;
      const scene = this.getCurrentLevelSceneEntry();
      if (!scene) return false;
      const logic = scene.logic ?? { nodes: [], links: [] };
      const nodes = Array.isArray(logic.nodes) ? logic.nodes : [];
      const links = Array.isArray(logic.links) ? logic.links : [];
      const idMap = new Map<string, string>();
      const nextSelected = new Set<string>();
      for (const sourceNode of this.levelLogicClipboard.nodes) {
        const sourceId = String(sourceNode.id ?? '');
        if (!sourceId) continue;
        const nextId = `${String(sourceNode.kind ?? 'node')}_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        idMap.set(sourceId, nextId);
        nodes.push({
          ...sourceNode,
          id: nextId,
          x: Number(sourceNode.x ?? 40) + 44,
          y: Number(sourceNode.y ?? 40) + 44,
        });
        nextSelected.add(nextId);
      }
      for (const sourceLink of this.levelLogicClipboard.links) {
        const from = idMap.get(sourceLink.from);
        const to = idMap.get(sourceLink.to);
        if (!from || !to) continue;
        links.push({ from, to });
      }
      scene.logic = { nodes, links };
      sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
      this.levelLogicSelectedNodeIds = nextSelected;
      this.renderLevelLogicList();
      return nextSelected.size > 0;
    };
    levelLogicNodeCopy?.addEventListener('click', () => {
      const ok = copyLogicSelection();
      if (levelStatus) levelStatus.textContent = ok ? 'Copied logic selection' : 'No nodes selected';
    });
    levelLogicNodePaste?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const ok = pasteLogicSelection();
        if (levelStatus) levelStatus.textContent = ok ? 'Pasted logic selection' : 'Clipboard empty';
      });
    });
    levelLogicGraph?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const card = target?.closest<HTMLButtonElement>('[data-level-logic-node-id]');
      if (!card) return;
      const nodeId = card.dataset.levelLogicNodeId;
      if (!nodeId) return;
      if (event.metaKey || event.ctrlKey) {
        if (this.levelLogicSelectedNodeIds.has(nodeId)) this.levelLogicSelectedNodeIds.delete(nodeId);
        else this.levelLogicSelectedNodeIds.add(nodeId);
      } else {
        this.levelLogicSelectedNodeIds.clear();
        this.levelLogicSelectedNodeIds.add(nodeId);
      }
      this.renderLevelLogicList();
    });
    levelLogicGraph?.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement | null;
      const outPort = target?.closest<HTMLElement>('.level-logic-port.out');
      if (outPort) {
        const card = outPort.closest<HTMLButtonElement>('[data-level-logic-node-id]');
        const nodeId = card?.dataset.levelLogicNodeId;
        const board = target?.closest<HTMLElement>('.level-logic-graph-board');
        if (!nodeId || !board) return;
        const rect = board.getBoundingClientRect();
        this.levelLogicLinkDrag = {
          pointerId: event.pointerId,
          fromId: nodeId,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
        this.renderLevelLogicGraph();
        return;
      }
      const card = target?.closest<HTMLButtonElement>('[data-level-logic-node-id]');
      if (!card) {
        const board = target?.closest<HTMLElement>('.level-logic-graph-board');
        if (!board) return;
        const rect = board.getBoundingClientRect();
        this.levelLogicBoxSelect = {
          pointerId: event.pointerId,
          startX: event.clientX - rect.left,
          startY: event.clientY - rect.top,
          additive: Boolean(event.ctrlKey || event.metaKey),
        };
        if (!this.levelLogicBoxSelect.additive) this.levelLogicSelectedNodeIds.clear();
        let box = board.querySelector<HTMLElement>('.level-logic-select-box');
        if (!box) {
          box = document.createElement('div');
          box.className = 'level-logic-select-box';
          board.appendChild(box);
        }
        box.style.left = `${this.levelLogicBoxSelect.startX}px`;
        box.style.top = `${this.levelLogicBoxSelect.startY}px`;
        box.style.width = '1px';
        box.style.height = '1px';
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      const nodeId = card.dataset.levelLogicNodeId;
      if (!nodeId) return;
      const bounds = card.getBoundingClientRect();
      const scene = this.getCurrentLevelSceneEntry();
      const logic = scene?.logic ?? { nodes: [], links: [] };
      const logicNodes = Array.isArray(logic.nodes)
        ? logic.nodes.filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string',
          )
        : [];
      const selectionStart = new Map<string, { x: number; y: number }>();
      const selected =
        this.levelLogicSelectedNodeIds.size > 1 && this.levelLogicSelectedNodeIds.has(nodeId)
          ? Array.from(this.levelLogicSelectedNodeIds)
          : [nodeId];
      for (const id of selected) {
        const node = logicNodes.find((item) => String(item.id) === id);
        if (!node) continue;
        const x = Number(node.x ?? 0);
        const y = Number(node.y ?? 0);
        selectionStart.set(id, { x, y });
      }
      this.levelLogicDrag = {
        id: nodeId,
        pointerId: event.pointerId,
        offsetX: event.clientX - bounds.left,
        offsetY: event.clientY - bounds.top,
        startMouseX: event.clientX,
        startMouseY: event.clientY,
        selectionStart,
      };
      card.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    levelLogicGraph?.addEventListener('pointermove', (event) => {
      if (this.levelLogicLinkDrag && event.pointerId === this.levelLogicLinkDrag.pointerId) {
        const board = levelLogicGraph.querySelector<HTMLElement>('.level-logic-graph-board');
        if (!board) return;
        const rect = board.getBoundingClientRect();
        this.levelLogicLinkDrag.x = event.clientX - rect.left;
        this.levelLogicLinkDrag.y = event.clientY - rect.top;
        const target = event.target as HTMLElement | null;
        const inPort = target?.closest<HTMLElement>('.level-logic-port.in');
        const card = inPort?.closest<HTMLButtonElement>('[data-level-logic-node-id]');
        const nextHover = card?.dataset.levelLogicNodeId ?? null;
        if (nextHover !== this.levelLogicLinkHoverTargetId) {
          this.levelLogicLinkHoverTargetId = nextHover;
        }
        const scene = this.getCurrentLevelSceneEntry();
        if (scene && this.levelLogicGraphStatusEl) {
          const logic = scene.logic ?? { nodes: [], links: [] };
          const nodes = (Array.isArray(logic.nodes) ? logic.nodes : []).filter(
            (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
          );
          const links = (Array.isArray(logic.links) ? logic.links : []) as Array<Record<string, unknown>>;
          if (nextHover) {
            const check = this.canConnectLevelLogicNodes(
              nodes,
              links,
              this.levelLogicLinkDrag.fromId,
              nextHover,
            );
            this.levelLogicGraphStatusEl.textContent = check.ok
              ? `Release to link ${this.levelLogicLinkDrag.fromId} -> ${nextHover}`
              : check.reason;
          } else {
            this.levelLogicGraphStatusEl.textContent = 'Drag to an input port to create a link.';
          }
        }
        this.renderLevelLogicGraph();
        return;
      }
      if (this.levelLogicBoxSelect && event.pointerId === this.levelLogicBoxSelect.pointerId) {
        const board = levelLogicGraph.querySelector<HTMLElement>('.level-logic-graph-board');
        if (!board) return;
        const box = board.querySelector<HTMLElement>('.level-logic-select-box');
        if (!box) return;
        const rect = board.getBoundingClientRect();
        const currentX = event.clientX - rect.left;
        const currentY = event.clientY - rect.top;
        const left = Math.min(this.levelLogicBoxSelect.startX, currentX);
        const top = Math.min(this.levelLogicBoxSelect.startY, currentY);
        const width = Math.abs(currentX - this.levelLogicBoxSelect.startX);
        const height = Math.abs(currentY - this.levelLogicBoxSelect.startY);
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;
        const cards = board.querySelectorAll<HTMLButtonElement>('[data-level-logic-node-id]');
        cards.forEach((item) => {
          const itemLeft = Number.parseFloat(item.style.left || '0');
          const itemTop = Number.parseFloat(item.style.top || '0');
          const itemRight = itemLeft + 160;
          const itemBottom = itemTop + 58;
          const overlaps = itemRight >= left && itemLeft <= left + width && itemBottom >= top && itemTop <= top + height;
          const nodeId = item.dataset.levelLogicNodeId;
          if (!nodeId) return;
          if (overlaps) this.levelLogicSelectedNodeIds.add(nodeId);
          else if (!this.levelLogicBoxSelect?.additive) this.levelLogicSelectedNodeIds.delete(nodeId);
          item.classList.toggle('active', this.levelLogicSelectedNodeIds.has(nodeId));
        });
        if (this.levelLogicGraphStatusEl) {
          this.levelLogicGraphStatusEl.textContent =
            this.levelLogicSelectedNodeIds.size > 0
              ? `Selected nodes: ${this.levelLogicSelectedNodeIds.size}`
              : 'Select nodes (Ctrl/Cmd for multi-select). Drag nodes to layout the graph.';
        }
        return;
      }
      if (!this.levelLogicDrag) return;
      if (event.pointerId !== this.levelLogicDrag.pointerId) return;
      const scene = this.getCurrentLevelSceneEntry();
      if (!scene) return;
      const logic = scene.logic ?? { nodes: [], links: [] };
      const nodes = Array.isArray(logic.nodes) ? logic.nodes : [];
      const node = nodes.find(
        (item) => item && typeof item === 'object' && (item as { id?: unknown }).id === this.levelLogicDrag?.id,
      ) as Record<string, unknown> | undefined;
      if (!node) return;
      const graphBounds = levelLogicGraph.getBoundingClientRect();
      const x = event.clientX - graphBounds.left - this.levelLogicDrag.offsetX;
      const y = event.clientY - graphBounds.top - this.levelLogicDrag.offsetY;
      const nextX = Math.max(8, Math.min(820, x));
      const nextY = Math.max(8, Math.min(480, y));
      node.x = nextX;
      node.y = nextY;
      if (this.levelLogicDrag.selectionStart.size > 1) {
        const dx = event.clientX - this.levelLogicDrag.startMouseX;
        const dy = event.clientY - this.levelLogicDrag.startMouseY;
        for (const [id, start] of this.levelLogicDrag.selectionStart) {
          if (id === this.levelLogicDrag.id) continue;
          const groupNode = nodes.find(
            (item) => item && typeof item === 'object' && (item as { id?: unknown }).id === id,
          ) as Record<string, unknown> | undefined;
          if (!groupNode) continue;
          groupNode.x = Math.max(8, Math.min(820, start.x + dx));
          groupNode.y = Math.max(8, Math.min(480, start.y + dy));
        }
      }
      scene.logic = { nodes, links: Array.isArray(logic.links) ? logic.links : [] };
      this.renderLevelLogicGraph();
    });
    levelLogicGraph?.addEventListener('pointerup', (event) => {
      if (this.levelLogicLinkDrag && event.pointerId === this.levelLogicLinkDrag.pointerId) {
        const sourceId = this.levelLogicLinkDrag.fromId;
        const target = event.target as HTMLElement | null;
        const inPort = target?.closest<HTMLElement>('.level-logic-port.in');
        const targetCard = inPort?.closest<HTMLButtonElement>('[data-level-logic-node-id]');
        const targetId = targetCard?.dataset.levelLogicNodeId;
        this.levelLogicLinkHoverTargetId = null;
        this.levelLogicLinkDrag = null;
        if (targetId && targetId !== sourceId) {
          this.recordLevelEdit(() => {
            const scene = this.getCurrentLevelSceneEntry();
            if (!scene) return;
            const logic = scene.logic ?? { nodes: [], links: [] };
            const links = (Array.isArray(logic.links) ? logic.links : []) as Array<Record<string, unknown>>;
            const nodes = (Array.isArray(logic.nodes) ? logic.nodes : []) as Array<Record<string, unknown>>;
            const check = this.canConnectLevelLogicNodes(nodes, links, sourceId, targetId);
            if (!check.ok) {
              if (this.levelLogicGraphStatusEl) this.levelLogicGraphStatusEl.textContent = check.reason;
              return;
            }
            if (!links.some((item) => item && item.from === sourceId && item.to === targetId)) {
              links.push({ from: sourceId, to: targetId });
            }
            scene.logic = {
              nodes,
              links,
            };
            sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
            this.renderLevelLogicList();
            if (this.levelLogicGraphStatusEl) {
              this.levelLogicGraphStatusEl.textContent = `Linked ${sourceId} -> ${targetId}`;
            }
          });
        } else {
          this.renderLevelLogicGraph();
        }
        return;
      }
      if (this.levelLogicBoxSelect && event.pointerId === this.levelLogicBoxSelect.pointerId) {
        this.levelLogicBoxSelect = null;
        const board = levelLogicGraph.querySelector<HTMLElement>('.level-logic-graph-board');
        board?.querySelector<HTMLElement>('.level-logic-select-box')?.remove();
        this.renderLevelLogicList();
        return;
      }
      if (!this.levelLogicDrag || event.pointerId !== this.levelLogicDrag.pointerId) return;
      this.levelLogicDrag = null;
      const scene = this.getCurrentLevelSceneEntry();
      if (scene) {
        sceneLogicInput.value = JSON.stringify(scene.logic ?? { nodes: [], links: [] }, null, 2);
      }
    });
    levelLogicGraph?.addEventListener('pointercancel', () => {
      this.levelLogicDrag = null;
      this.levelLogicBoxSelect = null;
      this.levelLogicLinkDrag = null;
      this.levelLogicLinkHoverTargetId = null;
      this.renderLevelLogicGraph();
    });
    levelLogicGraph?.addEventListener('pointerleave', () => {
      if (!this.levelLogicLinkDrag) return;
      this.levelLogicLinkHoverTargetId = null;
      this.renderLevelLogicGraph();
    });
    levelLogicPreviewRun?.addEventListener('click', () => {
      const scene = this.getCurrentLevelSceneEntry();
      if (!scene) {
        renderLogicPreviewLog(['No scene selected.']);
        return;
      }
      const trigger = parseLogicPreviewTrigger(levelLogicPreviewTrigger.value || 'onStart');
      const target = levelLogicPreviewTarget.value.trim();
      const result = runLevelLogicPreview(scene.logic, { trigger, target });
      const header = `Preview ${trigger}${target ? ` @ ${target}` : ''}: ${result.firedActions} action(s) fired from ${result.matchedTriggers} trigger node(s).`;
      renderLogicPreviewLog([header, ...result.lines]);
      if (levelStatus) levelStatus.textContent = `Logic preview complete for ${trigger}`;
    });
    levelLogicPreviewClear?.addEventListener('click', () => {
      clearLogicPreviewLog();
      if (levelStatus) levelStatus.textContent = 'Cleared logic preview log';
    });

    levelObjectSelect.addEventListener('change', () => {
      this.selectLevelObject(levelObjectSelect.value || null);
      if (levelStatus)
        levelStatus.textContent = levelObjectSelect.value
          ? `Selected ${levelObjectSelect.value}`
          : 'No object selected';
    });
    levelHierarchySearch.addEventListener('input', () => {
      const query = levelHierarchySearch.value.trim().toLowerCase();
      const buttons = levelHierarchy.querySelectorAll<HTMLButtonElement>('.bone-list-item');
      buttons.forEach((btn) => {
        const label = btn.textContent?.toLowerCase() ?? '';
        btn.style.display = !query || label.includes(query) ? '' : 'none';
      });
    });

    levelComponentApply.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        const objectId = this.selectedLevelObjectId;
        if (!scene || !objectId) return;
        if (!scene.components) scene.components = {};
        const preset =
          (levelComponentPreset.value as 'none' | 'door' | 'pickup' | 'checkpoint' | 'spawner') ||
          'none';
        const next = this.getLevelComponentTemplate(preset, objectId);
        if (Object.keys(next).length === 0) {
          delete scene.components[objectId];
        } else {
          scene.components[objectId] = next;
        }
        this.refreshLevelInspector();
        this.syncLevelTextEditors();
        if (levelStatus) levelStatus.textContent = `Applied component preset: ${preset}`;
      });
    });

    levelComponentSave.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        const objectId = this.selectedLevelObjectId;
        if (!scene || !objectId) return;
        try {
          const parsed = JSON.parse(levelComponentJson.value || '{}') as Record<string, unknown>;
          if (!scene.components) scene.components = {};
          if (Object.keys(parsed).length === 0) delete scene.components[objectId];
          else scene.components[objectId] = parsed;
          this.syncLevelTextEditors();
          if (levelStatus) levelStatus.textContent = `Saved component for ${objectId}`;
        } catch (error) {
          if (levelStatus) levelStatus.textContent = `Component JSON invalid: ${String(error)}`;
        }
      });
    });

    const applySelectedZoneInspector = () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        const selectedId = this.selectedLevelObjectId;
        if (!scene || !selectedId || !selectedId.startsWith('zone:')) return;
        const zoneId = selectedId.replace('zone:', '');
        const zones = scene.zones ?? [];
        const index = zones.findIndex(
          (item, idx) => this.normalizeLevelZone(item ?? {}, idx).id === zoneId,
        );
        if (index < 0) return;
        const source = this.normalizeLevelZone(zones[index] ?? {}, index);
        const rawType = String(levelZoneType.value || source.type).toLowerCase();
        const zoneType: Required<LevelZone>['type'] =
          rawType === 'spawn' || rawType === 'damage' || rawType === 'safe' ? rawType : 'trigger';
        zones[index] = {
          ...source,
          name: (levelZoneName.value || source.name).trim() || source.id,
          tag: (levelZoneTag.value || '').trim(),
          type: zoneType,
        };
        scene.zones = zones;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject(`zone:${zoneId}`);
        this.syncLevelTextEditors();
        if (levelStatus) levelStatus.textContent = `Updated zone ${zoneId}`;
      });
    };

    levelZoneApply.addEventListener('click', () => {
      applySelectedZoneInspector();
    });
    levelZoneName.addEventListener('blur', () => applySelectedZoneInspector());
    levelZoneTag.addEventListener('blur', () => applySelectedZoneInspector());
    levelZoneType.addEventListener('change', () => applySelectedZoneInspector());

    levelLogicUseSelected?.addEventListener('click', () => {
      const selected = this.selectedLevelObjectId;
      levelLogicTarget.value = selected ?? 'scene';
      if (levelStatus) {
        levelStatus.textContent = selected
          ? `Logic target set to ${selected}`
          : 'Logic target set to scene';
      }
    });

    levelLogicTemplateApply?.addEventListener('click', () => {
      const selected = this.selectedLevelObjectId ?? 'scene';
      const selectedZoneId = selected.startsWith('zone:') ? selected.replace('zone:', '') : '';
      const template = levelLogicTemplate.value || 'custom';
      if (template === 'door_interact') {
        levelLogicTrigger.value = 'onInteract';
        levelLogicAction.value = 'toggleDoor';
        levelLogicTarget.value = selected;
        levelLogicParams.value = JSON.stringify({ openSeconds: 0.35 });
      } else if (template === 'zone_damage') {
        levelLogicTrigger.value = 'onZoneEnter';
        levelLogicAction.value = 'showUi';
        levelLogicTarget.value = selected;
        levelLogicParams.value = JSON.stringify({
          zoneId: selectedZoneId || 'zone_1',
          damage: 25,
          message: 'Damage Zone',
        });
      } else if (template === 'checkpoint_touch') {
        levelLogicTrigger.value = 'onInteract';
        levelLogicAction.value = 'setCheckpoint';
        levelLogicTarget.value = selected;
        levelLogicParams.value = JSON.stringify({ saveHealth: true });
      } else if (template === 'portal_transition') {
        levelLogicTrigger.value = 'onZoneEnter';
        levelLogicAction.value = 'sceneTransition';
        levelLogicTarget.value = selected;
        levelLogicParams.value = JSON.stringify({
          zoneId: selectedZoneId || 'zone_1',
          scene: 'main',
          spawn: 'player',
        });
      }
      if (levelStatus) {
        levelStatus.textContent =
          template === 'custom'
            ? 'Select a gameplay template'
            : `Applied logic template: ${template.replace('_', ' ')}`;
      }
    });

    levelLogicUseZone?.addEventListener('click', () => {
      const selected = this.selectedLevelObjectId;
      if (!selected || !selected.startsWith('zone:')) {
        if (levelStatus) levelStatus.textContent = 'Select a zone first';
        return;
      }
      const zoneId = selected.replace('zone:', '');
      levelLogicTrigger.value = 'onZoneEnter';
      levelLogicTarget.value = selected;
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(levelLogicParams.value || '{}') as Record<string, unknown>;
      } catch {
        params = {};
      }
      params.zoneId = zoneId;
      levelLogicParams.value = JSON.stringify(params);
      if (levelStatus) levelStatus.textContent = `Logic trigger set for zone ${zoneId}`;
    });

    levelLogicList?.addEventListener('click', (event) => {
      this.recordLevelEdit(() => {
        const target = event.target as HTMLElement | null;
        const removeBtn = target?.closest<HTMLButtonElement>('[data-level-logic-remove]');
        if (!removeBtn) return;
        const removeIndex = Number(removeBtn.dataset.levelLogicRemove ?? '-1');
        if (!Number.isInteger(removeIndex) || removeIndex < 0) return;
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const logic = scene.logic ?? { nodes: [], links: [] };
        const links = Array.isArray(logic.links) ? [...logic.links] : [];
        if (removeIndex >= links.length) return;
        links.splice(removeIndex, 1);
        const usedNodeIds = new Set<string>();
        for (const link of links) {
          if (typeof link?.from === 'string') usedNodeIds.add(link.from);
          if (typeof link?.to === 'string') usedNodeIds.add(link.to);
        }
        const nodes = (Array.isArray(logic.nodes) ? logic.nodes : []).filter((node) => {
          if (!node || typeof node !== 'object') return false;
          const id = (node as { id?: unknown }).id;
          if (typeof id !== 'string') return false;
          return usedNodeIds.has(id);
        });
        scene.logic = { nodes, links };
        sceneLogicInput.value = JSON.stringify(scene.logic, null, 2);
        this.syncLevelTextEditors();
        this.renderLevelLogicList();
        if (levelStatus) levelStatus.textContent = 'Removed logic rule';
      });
    });

    let levelTransformSpace: 'local' | 'world' = 'world';
    const updateLevelCommandBarState = () => {
      const mode = levelTransformMode.value as 'translate' | 'rotate' | 'scale';
      const isSelectTool = this.levelBuildTool === 'select';
      levelToolSelectBtn?.classList.toggle('active', isSelectTool);
      levelToolMoveBtn?.classList.toggle('active', mode === 'translate');
      levelToolRotateBtn?.classList.toggle('active', mode === 'rotate');
      levelToolScaleBtn?.classList.toggle('active', mode === 'scale');
      if (levelSpaceToggleBtn) {
        const label = levelTransformSpace === 'local' ? 'Local' : 'World';
        levelSpaceToggleBtn.dataset.space = levelTransformSpace;
        levelSpaceToggleBtn.textContent = `Space: ${label}`;
        levelSpaceToggleBtn.classList.toggle('active', levelTransformSpace === 'local');
      }
      const snap = Math.max(0, Number(levelSnapInput.value) || 0);
      levelSnapToggleBtn?.classList.toggle('active', snap > 0);
      levelSnapTopInput.value = String(snap);
    };
    const applyLevelTransformMode = (mode: 'translate' | 'rotate' | 'scale', fromTopBar = false) => {
      levelTransformMode.value = mode;
      this.levelTransform?.setMode(mode);
      if (fromTopBar) {
        levelBuildTool.value = 'select';
        levelBuildTool.dispatchEvent(new Event('change'));
      }
      updateLevelCommandBarState();
      if (levelStatus) levelStatus.textContent = `Transform mode: ${mode}`;
    };
    this.setLevelTransformModeHotkey = (mode) => applyLevelTransformMode(mode, true);
    const applyLevelSnap = (announce = true) => {
      const snap = Math.max(0, Number(levelSnapInput.value) || 0);
      this.levelTransform?.setTranslationSnap(snap > 0 ? snap : null);
      this.levelTransform?.setRotationSnap(
        snap > 0 ? THREE.MathUtils.degToRad(Math.max(1, snap * 10)) : null,
      );
      this.levelTransform?.setScaleSnap(snap > 0 ? snap : null);
      updateLevelCommandBarState();
      if (announce && levelStatus) {
        levelStatus.textContent = snap > 0 ? `Snap: ${snap}` : 'Snap: off';
      }
    };
    const applyLevelTransformSpace = (space: 'local' | 'world', announce = true) => {
      levelTransformSpace = space;
      this.levelTransform?.setSpace(space);
      updateLevelCommandBarState();
      if (announce && levelStatus) {
        levelStatus.textContent = `Transform space: ${space}`;
      }
    };

    levelTransformMode.addEventListener('change', () => {
      applyLevelTransformMode(levelTransformMode.value as 'translate' | 'rotate' | 'scale');
    });
    levelSnapInput.addEventListener('change', () => applyLevelSnap());
    levelToolSelectBtn?.addEventListener('click', () => {
      levelBuildTool.value = 'select';
      levelBuildTool.dispatchEvent(new Event('change'));
      updateLevelCommandBarState();
      if (levelStatus) levelStatus.textContent = 'Builder tool: select / transform';
    });
    levelToolMoveBtn?.addEventListener('click', () => applyLevelTransformMode('translate', true));
    levelToolRotateBtn?.addEventListener('click', () => applyLevelTransformMode('rotate', true));
    levelToolScaleBtn?.addEventListener('click', () => applyLevelTransformMode('scale', true));
    levelSnapToggleBtn?.addEventListener('click', () => {
      const current = Math.max(0, Number(levelSnapInput.value) || 0);
      const fallback = Math.max(0, Number(levelSnapTopInput.value) || 0.5);
      levelSnapInput.value = current > 0 ? '0' : String(fallback);
      applyLevelSnap();
    });
    levelSnapTopInput?.addEventListener('change', () => {
      const value = Math.max(0, Number(levelSnapTopInput.value) || 0);
      levelSnapInput.value = String(value);
      applyLevelSnap();
    });
    levelSpaceToggleBtn?.addEventListener('click', () => {
      applyLevelTransformSpace(levelTransformSpace === 'world' ? 'local' : 'world');
    });
    levelGroupDuplicateBtn?.addEventListener('click', () => levelDuplicateBtn.click());
    levelGroupDeleteBtn?.addEventListener('click', () => levelDeleteBtn.click());
    levelGroupFocusBtn?.addEventListener('click', () => levelFocusBtn.click());

    levelTransformMode.value = 'translate';
    applyLevelSnap(false);
    applyLevelTransformSpace('world', false);
    updateLevelCommandBarState();

    levelAddBtn.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const obstacles = scene.obstacles ?? [];
        const id = `obstacle_${obstacles.length + 1}`;
        obstacles.push({ id, x: 0, y: 0, z: 0, width: 1, height: 1, depth: 1 });
        scene.obstacles = obstacles;
        this.updateLevelVisualization(obstacles);
        this.selectLevelObject(`obstacle:${id}`);
        this.syncLevelTextEditors();
        if (levelStatus) levelStatus.textContent = `Added ${id}`;
      });
    });

    levelAddZoneBtn.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const zones = scene.zones ?? [];
        const id = `zone_${zones.length + 1}`;
        zones.push({
          id,
          name: `Zone ${zones.length + 1}`,
          tag: '',
          x: 0,
          y: 1,
          z: 0,
          width: 4,
          height: 2,
          depth: 4,
          type: 'trigger',
        });
        scene.zones = zones;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject(`zone:${id}`);
        this.syncLevelTextEditors();
        if (levelStatus) levelStatus.textContent = `Added ${id}`;
      });
    });

    levelAddGroundBtn.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const point = this.getLevelPlacementPoint();
        const current = this.normalizeLevelGround(scene.ground ?? undefined);
        scene.ground = {
          type: current?.type ?? 'concrete',
          width: current?.width ?? 120,
          depth: current?.depth ?? 120,
          y: Number.isFinite(point.y) ? point.y : 0,
          textureRepeat: current?.textureRepeat ?? 12,
          texturePreset: current?.texturePreset ?? this.parseGroundTexturePreset(levelTerrainTexture.value),
          water: current?.water ? { ...current.water } : this.normalizeLevelWater(undefined),
          terrain: current?.terrain ? { ...current.terrain } : undefined,
        };
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject('ground');
        this.syncLevelTextEditors();
        if (levelStatus) levelStatus.textContent = 'Placed ground';
      });
    });

    levelAddPlayerBtn.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const point = this.getLevelPlacementPoint();
        scene.player = {
          x: point.x,
          y: point.y,
          z: point.z,
          yaw: this.camera.rotation.y,
          controller: this.playerConfig.profile?.controller ?? 'third_person',
        };
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject('player');
        this.syncLevelTextEditors();
        if (levelStatus) levelStatus.textContent = 'Placed player spawn';
      });
    });

    levelAddCrowdBtn.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const point = this.getLevelPlacementPoint();
        scene.crowd = {
          enabled: true,
          x: point.x,
          y: point.y,
          z: point.z,
          radius: scene.crowd?.radius ?? 12,
        };
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.selectLevelObject('crowd');
        this.syncLevelTextEditors();
        if (levelStatus) levelStatus.textContent = 'Placed crowd zone';
      });
    });

    const spawnLevelModelAsset = (model: EditorModelRecord) => {
      const scene = this.getCurrentLevelSceneEntry();
      if (!scene) return;
      const point = this.getLevelPlacementPoint();
      const collider = model.collider ?? defaultModelCollider();
      const colliderSize =
        collider.shape === 'sphere'
          ? { x: collider.radius * 2, y: collider.radius * 2, z: collider.radius * 2 }
          : collider.shape === 'capsule'
            ? { x: collider.radius * 2, y: collider.height, z: collider.radius * 2 }
            : { ...collider.size };
      const obstacles = scene.obstacles ?? [];
      const obstacleIds = new Set(
        obstacles.map((item, index) => this.normalizeLevelObstacle(item ?? {}, index).id),
      );
      const id = this.createUniqueLevelEntityId('model_', obstacleIds);
      obstacles.push({
        id,
        x: point.x,
        y: point.y + Math.max(0.05, colliderSize.y) / 2,
        z: point.z,
        width: Math.max(0.05, colliderSize.x),
        height: Math.max(0.05, colliderSize.y),
        depth: Math.max(0.05, colliderSize.z),
      });
      scene.obstacles = obstacles;
      if (!scene.components) scene.components = {};
      scene.components[`obstacle:${id}`] = {
        type: 'model_instance',
        name: model.name,
        modelId: model.id,
        sourceFile: model.sourceFile,
        originOffset: model.originOffset,
        collider: model.collider,
        physics: model.physics,
        textures: model.textures,
      };
      this.updateLevelVisualization(obstacles);
      this.selectLevelObject(`obstacle:${id}`);
      this.syncLevelTextEditors();
      if (levelStatus) levelStatus.textContent = `Spawned model ${model.name} as obstacle ${id}`;
    };

    levelModelSpawnSelect?.addEventListener('change', () => {
      this.levelModelSpawnId = levelModelSpawnSelect.value || '';
      if (levelStatus) {
        levelStatus.textContent = this.levelModelSpawnId
          ? `Model spawn set: ${this.levelModelSpawnId}`
          : 'Model spawn cleared';
      }
    });

    levelAddModelBtn?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const modelId = this.levelModelSpawnId || levelModelSpawnSelect.value;
        if (!modelId) {
          if (levelStatus) levelStatus.textContent = 'Select a model to spawn.';
          return;
        }
        const model = modelRecords.find((item) => item.id === modelId);
        if (!model) {
          if (levelStatus) levelStatus.textContent = `Model ${modelId} is not loaded.`;
          return;
        }
        spawnLevelModelAsset(model);
      });
    });

    levelModelLibrary?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const placeButton = target?.closest<HTMLButtonElement>('[data-level-library-place]');
      const modelId = placeButton?.dataset.levelLibraryPlace ?? '';
      if (!modelId) return;
      this.recordLevelEdit(() => {
        const model = modelRecords.find((item) => item.id === modelId);
        if (!model) {
          if (levelStatus) levelStatus.textContent = `Model ${modelId} is not loaded.`;
          return;
        }
        this.levelModelSpawnId = model.id;
        levelModelSpawnSelect.value = model.id;
        spawnLevelModelAsset(model);
      });
    });

    levelDuplicateBtn.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const result = this.duplicateSelectedLevelObjects();
        if (!result || !levelStatus) return;
        levelStatus.textContent = `Duplicated ${result.total} object(s): ${result.duplicatedObstacles} obstacle(s), ${result.duplicatedZones} zone(s)`;
      });
    });

    levelDeleteBtn.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const result = this.deleteSelectedLevelObjects();
        if (!result || !levelStatus) return;
        levelStatus.textContent = `Deleted ${result.total} object(s): ${result.obstacles} obstacle(s), ${result.zones} zone(s), ${result.ground} ground, ${result.player} player, ${result.crowd} crowd`;
      });
    });

    levelFocusBtn.addEventListener('click', () => {
      const focused = this.focusSelectedLevelObjects();
      if (focused && levelStatus) {
        const count = this.getSelectedLevelObjectIds().length;
        levelStatus.textContent = `Focused selection (${Math.max(1, count)} object(s))`;
      }
    });

    const setTerrainStatus = (text: string, tone: 'ok' | 'warn' = 'ok') => {
      if (!levelTerrainStatus) return;
      levelTerrainStatus.textContent = text;
      levelTerrainStatus.dataset.tone = tone;
    };

    const applyWaterFromControls = () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const nextGround: NormalizedLevelGround = this.normalizeLevelGround(scene.ground) ?? {
          type: 'concrete',
          width: 120,
          depth: 120,
          y: 0,
          textureRepeat: 12,
          texturePreset: this.parseGroundTexturePreset(levelTerrainTexture.value),
          water: this.normalizeLevelWater(undefined),
        };
        nextGround.water = this.normalizeLevelWater({
          enabled: levelWaterEnabled.checked,
          level: Number(levelWaterLevel.value),
          opacity: Number(levelWaterOpacity.value),
          waveAmplitude: Number(levelWaterWaveAmp.value),
          waveFrequency: Number(levelWaterWaveFreq.value),
          waveSpeed: Number(levelWaterWaveSpeed.value),
          colorShallow: levelWaterColorShallow.value,
          colorDeep: levelWaterColorDeep.value,
          specularStrength: Number(levelWaterSpecular.value),
        });
        scene.ground = nextGround;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
        setTerrainStatus(
          nextGround.water.enabled
            ? `Water updated (${nextGround.water.colorShallow} -> ${nextGround.water.colorDeep})`
            : 'Water disabled',
          'ok',
        );
      });
    };

    const runTerrainGeneration = (mode: 'apply' | 'remix' | 'clear') => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) {
          setTerrainStatus('No level scene loaded', 'warn');
          return;
        }
        const currentObstacles = scene.obstacles ?? [];
        if (mode === 'clear') {
          const nextGround = this.normalizeLevelGround(scene.ground ?? undefined);
          if (nextGround?.terrain) {
            nextGround.terrain.enabled = false;
            scene.ground = nextGround;
          }
          scene.obstacles = currentObstacles.filter((item, idx) => {
            const id = this.normalizeLevelObstacle(item ?? {}, idx).id;
            return !id.startsWith('terrain_');
          });
          this.updateLevelVisualization(scene.obstacles);
          this.syncLevelTextEditors();
          setTerrainStatus('Cleared terrain mesh and legacy terrain blocks', 'ok');
          if (levelStatus) levelStatus.textContent = 'Terrain mesh cleared';
          return;
        }

        const size = Number(levelTerrainSize.value) || 96;
        const resolution = Number(levelTerrainRes.value) || 28;
        const maxHeight = Number(levelTerrainHeight.value) || 10;
        const roughness = Number(levelTerrainRoughness.value) || 0.56;
        const currentSeed = Math.floor(Number(levelTerrainSeed.value) || 1337);
        const seed =
          mode === 'remix' ? Math.floor(1000 + Math.random() * 999999) : Math.floor(currentSeed);
        if (mode === 'remix') {
          levelTerrainSeed.value = String(seed);
        }
        const nextGround: NormalizedLevelGround = this.normalizeLevelGround(scene.ground) ?? {
          type: 'concrete',
          width: size + 12,
          depth: size + 12,
          y: 0,
          textureRepeat: 12,
          texturePreset: 'concrete',
          water: this.normalizeLevelWater(undefined),
        };
        nextGround.width = Math.max(nextGround.width, size + 12);
        nextGround.depth = Math.max(nextGround.depth, size + 12);
        nextGround.texturePreset = this.parseGroundTexturePreset(levelTerrainTexture.value);
        nextGround.terrain = {
          enabled: true,
          preset:
            (levelTerrainPreset.value as 'cinematic' | 'alpine' | 'dunes' | 'islands') ||
            'cinematic',
          size,
          resolution,
          maxHeight,
          roughness,
          seed,
          sculptStamps: nextGround.terrain?.sculptStamps ?? [],
        };
        scene.ground = nextGround;
        scene.obstacles = currentObstacles.filter((item, idx) => {
          const id = this.normalizeLevelObstacle(item ?? {}, idx).id;
          return !id.startsWith('terrain_');
        });

        this.updateLevelVisualization(scene.obstacles);
        this.syncLevelTextEditors();
        setTerrainStatus(
          `${mode === 'remix' ? 'Remixed' : 'Applied'} ${levelTerrainPreset.value} mesh (seed ${seed}) with ${nextGround.texturePreset} texture`,
          'ok',
        );
        if (levelStatus) levelStatus.textContent = `Terrain mesh ready (${levelTerrainPreset.value})`;
      });
    };

    levelTerrainGenerateBtn?.addEventListener('click', () => runTerrainGeneration('apply'));
    levelTerrainAppendBtn?.addEventListener('click', () => runTerrainGeneration('remix'));
    levelTerrainClearBtn?.addEventListener('click', () => runTerrainGeneration('clear'));
    levelTerrainTexture?.addEventListener('change', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const nextGround: NormalizedLevelGround = this.normalizeLevelGround(scene.ground) ?? {
          type: 'concrete',
          width: 120,
          depth: 120,
          y: 0,
          textureRepeat: 12,
          texturePreset: 'concrete',
          water: this.normalizeLevelWater(undefined),
        };
        nextGround.texturePreset = this.parseGroundTexturePreset(levelTerrainTexture.value);
        scene.ground = nextGround;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
        setTerrainStatus(`Ground texture set to ${nextGround.texturePreset}`, 'ok');
      });
    });
    levelWaterEnabled?.addEventListener('change', applyWaterFromControls);
    levelWaterLevel?.addEventListener('change', applyWaterFromControls);
    levelWaterOpacity?.addEventListener('change', applyWaterFromControls);
    levelWaterWaveAmp?.addEventListener('change', applyWaterFromControls);
    levelWaterWaveFreq?.addEventListener('change', applyWaterFromControls);
    levelWaterWaveSpeed?.addEventListener('change', applyWaterFromControls);
    levelWaterColorShallow?.addEventListener('change', applyWaterFromControls);
    levelWaterColorDeep?.addEventListener('change', applyWaterFromControls);
    levelWaterSpecular?.addEventListener('change', applyWaterFromControls);
    levelSculptRadius?.addEventListener('change', () => {
      this.levelSculptRadiusValue = Math.max(0.5, Number(levelSculptRadius.value || 5));
      if (levelStatus) levelStatus.textContent = `Sculpt radius: ${this.levelSculptRadiusValue}`;
    });
    levelSculptStrength?.addEventListener('change', () => {
      this.levelSculptStrengthValue = Math.max(
        0.02,
        Math.min(2, Number(levelSculptStrength.value || 0.35)),
      );
      if (levelStatus) levelStatus.textContent = `Sculpt strength: ${this.levelSculptStrengthValue}`;
    });
    levelRoadName?.addEventListener('change', () => {
      this.levelRoadEditName = (levelRoadName.value || '').trim() || 'Road 1';
    });
    levelRoadWidth?.addEventListener('change', () => {
      this.levelRoadEditWidth = Math.max(1, Number(levelRoadWidth.value || 3));
      levelRoadWidth.value = String(this.levelRoadEditWidth);
    });
    levelRoadMaterial?.addEventListener('change', () => {
      this.levelRoadEditMaterial =
        (levelRoadMaterial.value as 'asphalt' | 'dirt' | 'neon') || 'asphalt';
    });

    const getActiveRoad = (scene: LevelScene) => {
      if (!scene.roads) scene.roads = [];
      const targetName = this.levelRoadEditName || `Road ${scene.roads.length + 1}`;
      const index = scene.roads.findIndex(
        (item, roadIndex) => this.normalizeLevelRoad(item ?? {}, roadIndex).name === targetName,
      );
      if (index >= 0) {
        const existing = this.normalizeLevelRoad(scene.roads[index] ?? {}, index);
        scene.roads[index] = existing;
        return { road: scene.roads[index] as LevelRoad, index, name: targetName };
      }
      const next: LevelRoad = {
        id: `road_${scene.roads.length + 1}`,
        name: targetName,
        width: this.levelRoadEditWidth,
        yOffset: 0.08,
        material: this.levelRoadEditMaterial,
        points: [],
      };
      scene.roads.push(next);
      return { road: next, index: scene.roads.length - 1, name: targetName };
    };

    levelRoadNew?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        if (!scene.roads) scene.roads = [];
        const roadIndex = scene.roads.length + 1;
        const name = this.levelRoadEditName || `Road ${roadIndex}`;
        scene.roads.push({
          id: `road_${roadIndex}`,
          name,
          width: this.levelRoadEditWidth,
          yOffset: 0.08,
          material: this.levelRoadEditMaterial,
          points: [],
        });
        levelRoadName.value = name;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
        if (levelRoadStatus) levelRoadStatus.textContent = `Created ${name}`;
      });
    });

    levelRoadAddPoint?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        const active = getActiveRoad(scene);
        const point = this.getLevelPlacementPoint();
        if (!active.road.points) active.road.points = [];
        active.road.width = this.levelRoadEditWidth;
        active.road.material = this.levelRoadEditMaterial;
        active.road.points.push({ x: point.x, y: point.y, z: point.z });
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
        if (levelRoadStatus) {
          levelRoadStatus.textContent = `${active.name}: ${active.road.points.length} point(s)`;
        }
      });
    });

    levelRoadPopPoint?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene || !scene.roads || scene.roads.length === 0) return;
        const active = getActiveRoad(scene);
        const points = active.road.points ?? [];
        if (points.length > 0) points.pop();
        active.road.points = points;
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
        if (levelRoadStatus) levelRoadStatus.textContent = `${active.name}: ${points.length} point(s)`;
      });
    });

    levelRoadClear?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        scene.roads = [];
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
        if (levelRoadStatus) levelRoadStatus.textContent = 'Cleared roads';
      });
    });

    levelEnvironmentApply?.addEventListener('click', () => {
      this.recordLevelEdit(() => {
        const scene = this.getCurrentLevelSceneEntry();
        if (!scene) return;
        scene.environment = {
          preset:
            (levelEnvironmentPreset.value as 'clear_day' | 'sunset' | 'night' | 'foggy' | 'overcast') ||
            'clear_day',
          fogNear: Math.max(2, Number(levelEnvironmentFogNear.value || 12)),
          fogFar: Math.max(8, Number(levelEnvironmentFogFar.value || 140)),
          skybox: {
            enabled: levelEnvironmentSkyboxEnabled.checked,
            preset:
              (levelEnvironmentSkyboxPreset.value as
                | 'clear_day'
                | 'sunset_clouds'
                | 'midnight_stars'
                | 'nebula') || 'clear_day',
            intensity: THREE.MathUtils.clamp(Number(levelEnvironmentSkyboxIntensity.value || 1), 0.2, 2),
          },
        };
        this.updateLevelVisualization(scene.obstacles ?? []);
        this.syncLevelTextEditors();
        if (levelStatus) levelStatus.textContent = `Environment preset: ${scene.environment.preset}`;
      });
    });

    writeModelForm(null);
    renderModelList();

    void loadScenes();

    // Settings tab initialization and handlers
    if (stylePresetSelect) {
      stylePresetSelect.value = retroRenderSettings.config.stylePreset;
      stylePresetSelect.addEventListener('change', () => {
        retroRenderSettings.applyStylePreset(
          stylePresetSelect.value as 'legacy' | 'soft' | 'arcade' | 'cinematic' | 'modern',
        );
        // Update sliders and displays to reflect preset values
        if (brightnessInput) {
          brightnessInput.value = retroRenderSettings.config.brightness.toString();
          if (brightnessVal) brightnessVal.textContent = retroRenderSettings.config.brightness.toFixed(2);
        }
        if (contrastInput) {
          contrastInput.value = retroRenderSettings.config.contrast.toString();
          if (contrastVal) contrastVal.textContent = retroRenderSettings.config.contrast.toFixed(2);
        }
        if (saturationInput) {
          saturationInput.value = retroRenderSettings.config.saturation.toString();
          if (saturationVal) saturationVal.textContent = retroRenderSettings.config.saturation.toFixed(2);
        }
        if (gammaInput) {
          gammaInput.value = retroRenderSettings.config.gamma.toString();
          if (gammaVal) gammaVal.textContent = retroRenderSettings.config.gamma.toFixed(2);
        }
        if (exposureInput) {
          exposureInput.value = retroRenderSettings.config.exposure.toString();
          if (exposureVal) exposureVal.textContent = retroRenderSettings.config.exposure.toFixed(2);
        }
        window.dispatchEvent(new CustomEvent('retro-settings-changed'));
      });
    }

    if (brightnessInput) {
      brightnessInput.value = retroRenderSettings.config.brightness.toString();
      if (brightnessVal) brightnessVal.textContent = retroRenderSettings.config.brightness.toFixed(2);
      brightnessInput.addEventListener('input', () => {
        const value = parseFloat(brightnessInput.value);
        if (brightnessVal) brightnessVal.textContent = value.toFixed(2);
        retroRenderSettings.update({ brightness: value });
        if (this.retroPostProcessor) this.retroPostProcessor.setBrightness(value);
      });
    }

    if (contrastInput) {
      contrastInput.value = retroRenderSettings.config.contrast.toString();
      if (contrastVal) contrastVal.textContent = retroRenderSettings.config.contrast.toFixed(2);
      contrastInput.addEventListener('input', () => {
        const value = parseFloat(contrastInput.value);
        if (contrastVal) contrastVal.textContent = value.toFixed(2);
        retroRenderSettings.update({ contrast: value });
        if (this.retroPostProcessor) this.retroPostProcessor.setContrast(value);
      });
    }

    if (saturationInput) {
      saturationInput.value = retroRenderSettings.config.saturation.toString();
      if (saturationVal) saturationVal.textContent = retroRenderSettings.config.saturation.toFixed(2);
      saturationInput.addEventListener('input', () => {
        const value = parseFloat(saturationInput.value);
        if (saturationVal) saturationVal.textContent = value.toFixed(2);
        retroRenderSettings.update({ saturation: value });
        if (this.retroPostProcessor) this.retroPostProcessor.setSaturation(value);
      });
    }

    if (gammaInput) {
      gammaInput.value = retroRenderSettings.config.gamma.toString();
      if (gammaVal) gammaVal.textContent = retroRenderSettings.config.gamma.toFixed(2);
      gammaInput.addEventListener('input', () => {
        const value = parseFloat(gammaInput.value);
        if (gammaVal) gammaVal.textContent = value.toFixed(2);
        retroRenderSettings.update({ gamma: value });
        if (this.retroPostProcessor) this.retroPostProcessor.setGamma(value);
      });
    }

    if (exposureInput) {
      exposureInput.value = retroRenderSettings.config.exposure.toString();
      if (exposureVal) exposureVal.textContent = retroRenderSettings.config.exposure.toFixed(2);
      exposureInput.addEventListener('input', () => {
        const value = parseFloat(exposureInput.value);
        if (exposureVal) exposureVal.textContent = value.toFixed(2);
        retroRenderSettings.update({ exposure: value });
        if (this.retroPostProcessor) this.retroPostProcessor.setExposure(value);
      });
    }

    this.timelineHeader = timelineHeader;
    this.timelineWrap = timelineWrap;
    const viewport = hud.querySelector('[data-viewport]') as HTMLDivElement;
    this.viewport = viewport;
    this.timeline = timeline;
    this.axisCanvas = hud.querySelector('[data-axis]') as HTMLCanvasElement;
    this.boneOverlay = hud.querySelector('[data-bone-overlay]') as HTMLDivElement;
    const rotX = hud.querySelector('[data-rot-x]') as HTMLInputElement;
    const rotY = hud.querySelector('[data-rot-y]') as HTMLInputElement;
    const rotZ = hud.querySelector('[data-rot-z]') as HTMLInputElement;
    const posGroup = hud.querySelector('[data-pos-group]') as HTMLDivElement;
    const posX = hud.querySelector('[data-pos-x]') as HTMLInputElement;
    const posY = hud.querySelector('[data-pos-y]') as HTMLInputElement;
    const posZ = hud.querySelector('[data-pos-z]') as HTMLInputElement;
    this.time = 0;
    this.setTotalFrames(this.getTotalFrames());
    timeInput.value = '0.0000';
    durationInput.value = String(this.getTotalFrames());
    this.overrideRangeStartFrame = 0;
    this.overrideRangeEndFrame = Math.max(0, this.getTotalFrames() - 1);
    this.syncOverrideRangeUi(overrideRangeWrap, overrideStartHandle, overrideEndHandle, false);
    this.resizeTimeline();
    this.drawTimeline();
    if (boneScaleInput) {
      const base = this.computeBoneScale() * 0.5;
      this.boneScale = base;
      boneScaleInput.value = '1';
    }
    if (boneScaleWrap) {
      boneScaleWrap.style.display = this.boneVisualsVisible ? 'flex' : 'none';
    }

    const syncPlayerJson = () => {
      if (!playerJson) return;
      playerJson.value = JSON.stringify(this.playerConfig, null, 2);
    };

    const refreshPlayerAvatars = async () => {
      if (!this.currentGameId) {
        playerAvatarSelect.innerHTML = '<option value="">(No Avatar)</option>';
        return;
      }
      try {
        const data = await listGameAvatars(this.currentGameId);
        const files = (data.files ?? []).slice().sort((a, b) => a.localeCompare(b));
        playerAvatarSelect.innerHTML = '';
        const noneOption = document.createElement('option');
        noneOption.value = '';
        noneOption.textContent = '(No Avatar)';
        playerAvatarSelect.appendChild(noneOption);
        for (const file of files) {
          const option = document.createElement('option');
          option.value = file;
          option.textContent = file;
          playerAvatarSelect.appendChild(option);
        }
        const currentAvatar = String(this.playerConfig.avatar ?? '');
        if (currentAvatar && files.includes(currentAvatar)) {
          playerAvatarSelect.value = currentAvatar;
        } else {
          playerAvatarSelect.value = '';
        }
      } catch (error) {
        playerAvatarSelect.innerHTML = '<option value="">(No Avatar)</option>';
        if (playerStatus) playerStatus.textContent = `Avatar list failed: ${String(error)}`;
      }
    };
    this.refreshPlayerAvatarsFunction = refreshPlayerAvatars;

    const setPlayerInputs = () => {
      if (!ikOffsetInput) return;
      moveSpeedInput.value = this.playerConfig.moveSpeed.toFixed(2);
      sprintMultInput.value = this.playerConfig.sprintMultiplier.toFixed(2);
      crouchMultInput.value = this.playerConfig.crouchMultiplier.toFixed(2);
      slideAccelInput.value = this.playerConfig.slideAccel.toFixed(2);
      slideFrictionInput.value = this.playerConfig.slideFriction.toFixed(2);
      jumpSpeedInput.value = this.playerConfig.jumpSpeed.toFixed(2);
      gravityInput.value = this.playerConfig.gravity.toFixed(2);
      walkThresholdInput.value = this.playerConfig.walkThreshold.toFixed(2);
      runThresholdInput.value = this.playerConfig.runThreshold.toFixed(2);
      ikOffsetInput.value = this.playerConfig.ikOffset.toFixed(2);
      capRadiusInput.value = this.playerConfig.capsuleRadiusScale.toFixed(2);
      capHeightInput.value = this.playerConfig.capsuleHeightScale.toFixed(2);
      capYOffsetInput.value = this.playerConfig.capsuleYOffset.toFixed(2);
      camDistanceInput.value = this.playerConfig.cameraDistance.toFixed(2);
      camHeightInput.value = this.playerConfig.cameraHeight.toFixed(2);
      camShoulderInput.value = this.playerConfig.cameraShoulder.toFixed(2);
      camShoulderYInput.value = this.playerConfig.cameraShoulderHeight.toFixed(2);
      camSenseInput.value = this.playerConfig.cameraSensitivity.toFixed(2);
      camSmoothInput.value = this.playerConfig.cameraSmoothing.toFixed(2);
      camMinPitchInput.value = this.playerConfig.cameraMinPitch.toFixed(2);
      camMaxPitchInput.value = this.playerConfig.cameraMaxPitch.toFixed(2);
      camTargetSmoothInput.value = this.playerConfig.targetSmoothSpeed.toFixed(0);
      profileNameInput.value = String(this.playerConfig.profile?.name ?? '');
      profileRoleInput.value = String(this.playerConfig.profile?.role ?? 'player');
      profileControllerInput.value = String(
        this.playerConfig.profile?.controller ?? 'third_person',
      );
      controllerModesJsonInput.value = JSON.stringify(this.playerConfig.controllerModes, null, 2);
      profileFactionInput.value = String(this.playerConfig.profile?.faction ?? '');
      profileHealthInput.value = String(this.playerConfig.profile?.health ?? 100);
      profileStaminaInput.value = String(this.playerConfig.profile?.stamina ?? 100);
      profileTagsInput.value = (this.playerConfig.profile?.tags ?? []).join(',');
      profileDescriptionInput.value = String(this.playerConfig.profile?.description ?? '');
      playerAvatarSelect.value = String(this.playerConfig.avatar ?? '');
      capsulePreviewInput.checked = Boolean(this.playerConfig.capsule?.preview);
      capsuleBaseRadiusInput.value = String(this.playerConfig.capsule?.baseRadius ?? 0.35);
      capsuleBaseHeightInput.value = String(this.playerConfig.capsule?.baseHeight ?? 1.72);
      capsuleSkinWidthInput.value = String(this.playerConfig.capsule?.skinWidth ?? 0.03);
      capsuleStepHeightInput.value = String(this.playerConfig.capsule?.stepHeight ?? 0.35);
      capsuleSlopeInput.value = String(this.playerConfig.capsule?.slopeLimitDeg ?? 50);
      stateMachineInitialInput.value = String(this.playerConfig.stateMachine?.initial ?? 'idle');
      stateMachineStatesInput.value = JSON.stringify(
        this.playerConfig.stateMachine?.states ?? [],
        null,
        2,
      );
      stateMachineTransitionsInput.value = JSON.stringify(
        this.playerConfig.stateMachine?.transitions ?? [],
        null,
        2,
      );
      npcEnabledInput.checked = Boolean(this.playerConfig.npc?.enabled);
      npcArchetypeInput.value = String(this.playerConfig.npc?.archetype ?? 'grunt');
      npcAggressionInput.value = String(this.playerConfig.npc?.aggression ?? 0.5);
      npcPerceptionInput.value = String(this.playerConfig.npc?.perceptionRange ?? 20);
      npcFovInput.value = String(this.playerConfig.npc?.fovDeg ?? 120);
      npcPatrolSpeedInput.value = String(this.playerConfig.npc?.patrolSpeed ?? 2);
      npcChaseSpeedInput.value = String(this.playerConfig.npc?.chaseSpeed ?? 4);
      npcAttackRangeInput.value = String(this.playerConfig.npc?.attackRange ?? 1.8);
      npcReactionInput.value = String(this.playerConfig.npc?.reactionMs ?? 220);
      npcGoalsInput.value = JSON.stringify(this.playerConfig.npc?.goals ?? [], null, 2);
      if (rigBoneSelect && rigBoneSelect.options.length === 0) {
        for (const def of this.ragdollDefs) {
          const opt = document.createElement('option');
          opt.value = def.name;
          opt.textContent = def.name;
          rigBoneSelect.appendChild(opt);
        }
      }
      const rigBoneKeys = this.bones.map((bone) => this.getBoneKey(bone));
      const ensureRigBoneMappingOptions = (select: HTMLSelectElement | null) => {
        if (!select) return;
        const prev = select.value;
        select.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = 'Auto';
        select.appendChild(auto);
        for (const key of rigBoneKeys) {
          const opt = document.createElement('option');
          opt.value = key;
          opt.textContent = key;
          select.appendChild(opt);
        }
        if (prev && rigBoneKeys.includes(prev)) {
          select.value = prev;
        } else {
          select.value = '';
        }
      };
      ensureRigBoneMappingOptions(rigSourceBoneSelect);
      ensureRigBoneMappingOptions(rigChildBoneSelect);
      if (rigShowInput) rigShowInput.checked = this.ragdollVisible || this.ragdollEnabled;
      if (rigBoneSelect) {
        const name = rigBoneSelect.value || this.ragdollDefs[0]?.name || '';
        if (name) {
          rigBoneSelect.value = name;
          const cfg = this.playerConfig.ragdollRig[name] ?? {
            radiusScale: 1,
            lengthScale: 1,
            offset: { x: 0, y: 0, z: 0 },
            rot: { x: 0, y: 0, z: 0 },
            swingLimit: 45,
            twistLimit: 35,
          };
          if (rigSourceBoneSelect) {
            rigSourceBoneSelect.value =
              typeof cfg.sourceBone === 'string' && rigBoneKeys.includes(cfg.sourceBone)
                ? cfg.sourceBone
                : '';
          }
          if (rigChildBoneSelect) {
            rigChildBoneSelect.value =
              typeof cfg.childBone === 'string' && rigBoneKeys.includes(cfg.childBone)
                ? cfg.childBone
                : '';
          }
          rigRadiusInput.value = String(cfg.radiusScale ?? 1);
          rigLengthInput.value = String(cfg.lengthScale ?? 1);
          rigOffX.value = String(cfg.offset?.x ?? 0);
          rigOffY.value = String(cfg.offset?.y ?? 0);
          rigOffZ.value = String(cfg.offset?.z ?? 0);
          rigRotX.value = String(cfg.rot?.x ?? 0);
          rigRotY.value = String(cfg.rot?.y ?? 0);
          rigRotZ.value = String(cfg.rot?.z ?? 0);
          rigSwing.value = String(cfg.swingLimit ?? 45);
          rigTwist.value = String(cfg.twistLimit ?? 35);
        }
      }
      const muscle = this.getRagdollMuscleConfig();
      const sim = this.getRagdollSimConfig();
      rsimMuscleEnabled.checked = muscle.enabled;
      rsimMuscleStiffness.value = String(muscle.stiffness);
      rsimMuscleDamping.value = String(muscle.damping);
      rsimMuscleMaxTorque.value = String(muscle.maxTorque);
      rsimJointStiffnessScale.value = String(sim.jointStiffnessScale);
      rsimJointDampingScale.value = String(sim.jointDampingScale);
      rsimBodyLinScale.value = String(sim.bodyLinearDampingScale);
      rsimBodyAngScale.value = String(sim.bodyAngularDampingScale);
      rsimGroundFriction.value = String(sim.groundFriction);
      rsimBodyFriction.value = String(sim.bodyFriction);
      rsimMaxSubsteps.value = String(sim.maxSubsteps);
      rsimSubstepHz.value = String(sim.substepHz);
      rsimLimitBlend.value = String(sim.limitBlend);
      rsimLinearBleed.value = String(sim.linearBleed);
      rsimAngularBleed.value = String(sim.angularBleed);
      rsimSlideDamp.value = String(sim.groundSlideDamping);
      rsimGroundY.value = String(sim.groundSlideYThreshold);
      rsimGroundDeadzone.value = String(sim.groundSlideDeadzone);
      rsimMaxLin.value = String(sim.maxLinearVelocity);
      rsimMaxAng.value = String(sim.maxAngularVelocity);
      rsimStartImpulse.value = String(sim.startImpulseY);
      this.syncPlayerCapsulePreview();
      syncPlayerJson();
    };
    this.refreshPlayerInputsFunction = setPlayerInputs;

    const readPlayerInputs = () => {
      if (stateMachineStatus) stateMachineStatus.textContent = '';
      this.playerConfig.moveSpeed = Number(moveSpeedInput.value) || 0;
      this.playerConfig.sprintMultiplier = Number(sprintMultInput.value) || 0;
      this.playerConfig.crouchMultiplier = Number(crouchMultInput.value) || 0;
      this.playerConfig.slideAccel = Number(slideAccelInput.value) || 0;
      this.playerConfig.slideFriction = Number(slideFrictionInput.value) || 0;
      this.playerConfig.jumpSpeed = Number(jumpSpeedInput.value) || 0;
      this.playerConfig.gravity = Number(gravityInput.value) || 0;
      this.playerConfig.walkThreshold = Number(walkThresholdInput.value) || 0;
      this.playerConfig.runThreshold = Number(runThresholdInput.value) || 0;
      this.playerConfig.ikOffset = Number(ikOffsetInput.value) || 0;
      this.playerConfig.capsuleRadiusScale = Number(capRadiusInput.value) || 1;
      this.playerConfig.capsuleHeightScale = Number(capHeightInput.value) || 1;
      this.playerConfig.capsuleYOffset = Number(capYOffsetInput.value) || 0;
      this.playerConfig.cameraDistance = Number(camDistanceInput.value) || 0;
      this.playerConfig.cameraHeight = Number(camHeightInput.value) || 0;
      this.playerConfig.cameraShoulder = Number(camShoulderInput.value) || 0;
      this.playerConfig.cameraShoulderHeight = Number(camShoulderYInput.value) || 0;
      this.playerConfig.cameraSensitivity = Number(camSenseInput.value) || 0;
      this.playerConfig.cameraSmoothing = Number(camSmoothInput.value) || 0;
      this.playerConfig.cameraMinPitch = Number(camMinPitchInput.value) || 0;
      this.playerConfig.cameraMaxPitch = Number(camMaxPitchInput.value) || 0;
      this.playerConfig.targetSmoothSpeed = Number(camTargetSmoothInput.value) || 0;
      this.playerConfig.profile = {
        name: profileNameInput.value.trim() || 'Unnamed Character',
        role: (profileRoleInput.value as CharacterRole) || 'player',
        controller: (profileControllerInput.value as ControllerMode) || 'third_person',
        faction: profileFactionInput.value.trim() || 'neutral',
        health: Math.max(1, Number(profileHealthInput.value) || 100),
        stamina: Math.max(0, Number(profileStaminaInput.value) || 100),
        description: profileDescriptionInput.value.trim(),
        tags: profileTagsInput.value
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      };
      try {
        const parsedModes = JSON.parse(controllerModesJsonInput.value || '{}') as ControllerModeConfigs;
        this.playerConfig.controllerModes = {
          third_person: { ...(parsedModes?.third_person ?? {}) },
          first_person: { ...(parsedModes?.first_person ?? {}) },
          ragdoll: { ...(parsedModes?.ragdoll ?? {}) },
        };
      } catch {
        this.playerConfig.controllerModes = { ...this.playerConfig.controllerModes };
      }
      this.playerConfig.avatar = playerAvatarSelect.value || '';
      this.playerConfig.capsule = {
        preview: capsulePreviewInput.checked,
        baseRadius: Math.max(0.05, Number(capsuleBaseRadiusInput.value) || 0.35),
        baseHeight: Math.max(0.2, Number(capsuleBaseHeightInput.value) || 1.72),
        skinWidth: Math.max(0, Number(capsuleSkinWidthInput.value) || 0.03),
        stepHeight: Math.max(0, Number(capsuleStepHeightInput.value) || 0.35),
        slopeLimitDeg: THREE.MathUtils.clamp(Number(capsuleSlopeInput.value) || 50, 1, 89),
      };
      let parsedStates = this.playerConfig.stateMachine?.states ?? [];
      let parsedTransitions = this.playerConfig.stateMachine?.transitions ?? [];
      try {
        const statesRaw = JSON.parse(stateMachineStatesInput.value || '[]');
        parsedStates = Array.isArray(statesRaw)
          ? statesRaw
              .map((state) => parseStateMachineState(state))
              .filter((state) => state.id.length > 0)
          : parsedStates;
      } catch {
        if (stateMachineStatus) stateMachineStatus.textContent = 'States JSON parse error.';
      }
      try {
        const transitionsRaw = JSON.parse(stateMachineTransitionsInput.value || '[]');
        parsedTransitions = Array.isArray(transitionsRaw)
          ? transitionsRaw
              .map((transition) => parseStateMachineTransition(transition))
              .filter((transition) => transition.to.length > 0)
          : parsedTransitions;
      } catch {
        if (stateMachineStatus) stateMachineStatus.textContent = 'Transitions JSON parse error.';
      }
      this.playerConfig.stateMachine = {
        initial: stateMachineInitialInput.value.trim() || 'idle',
        states: parsedStates,
        transitions: parsedTransitions,
      };
      let npcGoals = this.playerConfig.npc?.goals ?? [];
      try {
        const parsed = JSON.parse(npcGoalsInput.value || '[]');
        if (Array.isArray(parsed)) npcGoals = parsed.map((goal) => String(goal));
      } catch {
        // Keep last valid goals if parse fails.
      }
      this.playerConfig.npc = {
        enabled: npcEnabledInput.checked,
        archetype: npcArchetypeInput.value.trim() || 'grunt',
        aggression: THREE.MathUtils.clamp(Number(npcAggressionInput.value) || 0.5, 0, 1),
        perceptionRange: Math.max(0, Number(npcPerceptionInput.value) || 20),
        fovDeg: THREE.MathUtils.clamp(Number(npcFovInput.value) || 120, 1, 179),
        patrolSpeed: Math.max(0, Number(npcPatrolSpeedInput.value) || 2),
        chaseSpeed: Math.max(0, Number(npcChaseSpeedInput.value) || 4),
        attackRange: Math.max(0, Number(npcAttackRangeInput.value) || 1.8),
        reactionMs: Math.max(0, Number(npcReactionInput.value) || 220),
        goals: npcGoals,
      };
      this.playerConfig.ragdollMuscle = {
        enabled: rsimMuscleEnabled.checked,
        stiffness: Number(rsimMuscleStiffness.value) || 0,
        damping: Number(rsimMuscleDamping.value) || 0,
        maxTorque: Number(rsimMuscleMaxTorque.value) || 0,
      };
      this.playerConfig.ragdollSim = {
        jointStiffnessScale: Number(rsimJointStiffnessScale.value) || 0,
        jointDampingScale: Number(rsimJointDampingScale.value) || 0,
        bodyLinearDampingScale: Number(rsimBodyLinScale.value) || 0,
        bodyAngularDampingScale: Number(rsimBodyAngScale.value) || 0,
        groundFriction: Number(rsimGroundFriction.value) || 0,
        bodyFriction: Number(rsimBodyFriction.value) || 0,
        maxSubsteps: Number(rsimMaxSubsteps.value) || 1,
        substepHz: Number(rsimSubstepHz.value) || 60,
        limitBlend: Number(rsimLimitBlend.value) || 0,
        linearBleed: Number(rsimLinearBleed.value) || 0,
        angularBleed: Number(rsimAngularBleed.value) || 0,
        groundSlideDamping: Number(rsimSlideDamp.value) || 0,
        groundSlideYThreshold: Number(rsimGroundY.value) || 0,
        groundSlideDeadzone: Number(rsimGroundDeadzone.value) || 0,
        maxLinearVelocity: Number(rsimMaxLin.value) || 0,
        maxAngularVelocity: Number(rsimMaxAng.value) || 0,
        startImpulseY: Number(rsimStartImpulse.value) || 0,
      };
      if (rigBoneSelect) {
        const name = rigBoneSelect.value;
        if (name) {
          this.playerConfig.ragdollRig[name] = {
            radiusScale: Number(rigRadiusInput.value) || 1,
            lengthScale: Number(rigLengthInput.value) || 1,
            sourceBone: rigSourceBoneSelect?.value?.trim() || undefined,
            childBone: rigChildBoneSelect?.value?.trim() || undefined,
            offset: {
              x: Number(rigOffX.value) || 0,
              y: Number(rigOffY.value) || 0,
              z: Number(rigOffZ.value) || 0,
            },
            rot: {
              x: Number(rigRotX.value) || 0,
              y: Number(rigRotY.value) || 0,
              z: Number(rigRotZ.value) || 0,
            },
            swingLimit: Number(rigSwing.value) || 0,
            twistLimit: Number(rigTwist.value) || 0,
          };
        }
      }
      this.syncPlayerCapsulePreview();
      syncPlayerJson();
    };

    stateMachineResetButton?.addEventListener('click', () => {
      this.playerConfig.stateMachine = {
        initial: 'idle',
        states: DEFAULT_STATE_MACHINE_STATES.map((state) => ({
          ...state,
          tags: [...(state.tags ?? [])],
        })),
        transitions: DEFAULT_STATE_MACHINE_TRANSITIONS.map((transition) => ({ ...transition })),
      };
      setPlayerInputs();
      if (stateMachineStatus) stateMachineStatus.textContent = 'Reset state machine defaults.';
    });

    stateMachineValidateButton?.addEventListener('click', () => {
      readPlayerInputs();
      const errors: string[] = [];
      const sm = this.playerConfig.stateMachine;
      const stateNames = new Set(sm.states.map((state) => state.id));
      if (!stateNames.has(sm.initial))
        errors.push(`Initial "${sm.initial}" is missing from states.`);
      for (const transition of sm.transitions) {
        if (transition.from !== 'any' && !stateNames.has(transition.from)) {
          errors.push(`Transition from "${transition.from}" is invalid.`);
        }
        if (!stateNames.has(transition.to)) {
          errors.push(`Transition to "${transition.to}" is invalid.`);
        }
      }
      if (stateMachineStatus) {
        stateMachineStatus.textContent =
          errors.length > 0 ? `Invalid: ${errors[0]}` : 'State machine valid.';
      }
    });

    playerLoadButton?.addEventListener('click', async () => {
      try {
        if (!this.currentGameId) throw new Error('No game selected');
        const res = await fetch(`/api/games/${this.currentGameId}/player`, { cache: 'no-store' });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as Partial<PlayerConfig>;
        this.playerConfig = this.normalizePlayerConfig({ ...this.playerConfig, ...data });
        setPlayerInputs();
        await refreshPlayerAvatars();
        this.loadVrm();
        if (playerStatus) playerStatus.textContent = 'Loaded player config.';
      } catch (error) {
        if (playerStatus) playerStatus.textContent = `Load failed: ${String(error)}`;
      }
    });

    playerSaveButton?.addEventListener('click', async () => {
      try {
        readPlayerInputs();
        if (!this.currentGameId) throw new Error('No game selected');
        const res = await fetch(`/api/games/${this.currentGameId}/player`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.playerConfig),
        });
        if (!res.ok) throw new Error(await res.text());
        if (playerStatus) playerStatus.textContent = 'Saved player config.';
      } catch (error) {
        if (playerStatus) playerStatus.textContent = `Save failed: ${String(error)}`;
      }
    });

    playerAvatarRefreshButton?.addEventListener('click', async () => {
      await refreshPlayerAvatars();
      if (playerStatus) playerStatus.textContent = 'Avatar list refreshed.';
    });

    playerAvatarLoadButton?.addEventListener('click', () => {
      this.playerConfig.avatar = playerAvatarSelect.value || '';
      syncPlayerJson();
      this.loadVrm();
      if (playerStatus) {
        playerStatus.textContent = this.playerConfig.avatar
          ? `Loaded avatar ${this.playerConfig.avatar}`
          : 'Avatar cleared (no model)';
      }
    });

    playerAvatarSaveButton?.addEventListener('click', async () => {
      try {
        if (!this.currentGameId) throw new Error('No game selected');
        const file = playerAvatarFileInput.files?.[0];
        if (!file) throw new Error('No VRM/GLB file selected');
        await uploadGameAvatar(this.currentGameId, file.name, file);
        this.playerConfig.avatar = file.name;
        syncPlayerJson();
        await refreshPlayerAvatars();
        playerAvatarSelect.value = file.name;
        this.loadVrm();
        if (playerStatus) playerStatus.textContent = `Uploaded and selected ${file.name}`;
      } catch (error) {
        if (playerStatus) playerStatus.textContent = `Avatar upload failed: ${String(error)}`;
      }
    });

    setPlayerInputs();
    void refreshPlayerAvatars();
    [
      moveSpeedInput,
      sprintMultInput,
      crouchMultInput,
      slideAccelInput,
      slideFrictionInput,
      jumpSpeedInput,
      gravityInput,
      walkThresholdInput,
      runThresholdInput,
      ikOffsetInput,
      capRadiusInput,
      capHeightInput,
      capYOffsetInput,
      camDistanceInput,
      camHeightInput,
      camShoulderInput,
      camShoulderYInput,
      camSenseInput,
      camSmoothInput,
      camMinPitchInput,
      camMaxPitchInput,
      camTargetSmoothInput,
      profileNameInput,
      profileRoleInput,
      profileControllerInput,
      profileFactionInput,
      profileHealthInput,
      profileStaminaInput,
      profileTagsInput,
      profileDescriptionInput,
      capsulePreviewInput,
      capsuleBaseRadiusInput,
      capsuleBaseHeightInput,
      capsuleSkinWidthInput,
      capsuleStepHeightInput,
      capsuleSlopeInput,
      stateMachineInitialInput,
      stateMachineStatesInput,
      stateMachineTransitionsInput,
      npcEnabledInput,
      npcArchetypeInput,
      npcAggressionInput,
      npcPerceptionInput,
      npcFovInput,
      npcPatrolSpeedInput,
      npcChaseSpeedInput,
      npcAttackRangeInput,
      npcReactionInput,
      npcGoalsInput,
      playerAvatarSelect,
      rsimMuscleEnabled,
      rsimMuscleStiffness,
      rsimMuscleDamping,
      rsimMuscleMaxTorque,
      rsimJointStiffnessScale,
      rsimJointDampingScale,
      rsimBodyLinScale,
      rsimBodyAngScale,
      rsimGroundFriction,
      rsimBodyFriction,
      rsimMaxSubsteps,
      rsimSubstepHz,
      rsimLimitBlend,
      rsimLinearBleed,
      rsimAngularBleed,
      rsimSlideDamp,
      rsimGroundY,
      rsimGroundDeadzone,
      rsimMaxLin,
      rsimMaxAng,
      rsimStartImpulse,
    ].forEach((input) => {
      input?.addEventListener('change', readPlayerInputs);
    });
    rigBoneSelect?.addEventListener('change', () => {
      const name = rigBoneSelect.value;
      const cfg = this.playerConfig.ragdollRig[name] ?? {
        radiusScale: 1,
        lengthScale: 1,
        sourceBone: undefined,
        childBone: undefined,
        offset: { x: 0, y: 0, z: 0 },
        rot: { x: 0, y: 0, z: 0 },
        swingLimit: 45,
        twistLimit: 35,
      };
      if (rigSourceBoneSelect) {
        rigSourceBoneSelect.value = cfg.sourceBone ?? '';
      }
      if (rigChildBoneSelect) {
        rigChildBoneSelect.value = cfg.childBone ?? '';
      }
      rigRadiusInput.value = String(cfg.radiusScale ?? 1);
      rigLengthInput.value = String(cfg.lengthScale ?? 1);
      rigOffX.value = String(cfg.offset?.x ?? 0);
      rigOffY.value = String(cfg.offset?.y ?? 0);
      rigOffZ.value = String(cfg.offset?.z ?? 0);
      rigRotX.value = String(cfg.rot?.x ?? 0);
      rigRotY.value = String(cfg.rot?.y ?? 0);
      rigRotZ.value = String(cfg.rot?.z ?? 0);
      rigSwing.value = String(cfg.swingLimit ?? 45);
      rigTwist.value = String(cfg.twistLimit ?? 35);
      this.selectRagdoll(name);
    });
    const rebuildRagdoll = () => {
      if (this.ragdollEnabled || this.ragdollVisible) {
        this.buildRagdoll();
        for (const mesh of this.ragdollDebugMeshes) {
          mesh.visible = this.ragdollEnabled || this.ragdollVisible;
        }
        if (this.selectedRagdoll) this.selectRagdoll(this.selectedRagdoll);
      }
    };
    const applyRagdollSimField = () => {
      readPlayerInputs();
      rebuildRagdoll();
    };
    [
      rsimMuscleEnabled,
      rsimMuscleStiffness,
      rsimMuscleDamping,
      rsimMuscleMaxTorque,
      rsimJointStiffnessScale,
      rsimJointDampingScale,
      rsimBodyLinScale,
      rsimBodyAngScale,
      rsimGroundFriction,
      rsimBodyFriction,
      rsimMaxSubsteps,
      rsimSubstepHz,
      rsimLimitBlend,
      rsimLinearBleed,
      rsimAngularBleed,
      rsimSlideDamp,
      rsimGroundY,
      rsimGroundDeadzone,
      rsimMaxLin,
      rsimMaxAng,
      rsimStartImpulse,
    ].forEach((input) => input?.addEventListener('input', applyRagdollSimField));
    rigRadiusInput?.addEventListener('input', () => {
      const name = rigBoneSelect.value;
      if (!name) return;
      this.playerConfig.ragdollRig[name] = {
        radiusScale: Number(rigRadiusInput.value) || 1,
        lengthScale: Number(rigLengthInput.value) || 1,
        sourceBone: rigSourceBoneSelect?.value?.trim() || undefined,
        childBone: rigChildBoneSelect?.value?.trim() || undefined,
        offset: {
          x: Number(rigOffX.value) || 0,
          y: Number(rigOffY.value) || 0,
          z: Number(rigOffZ.value) || 0,
        },
        rot: {
          x: Number(rigRotX.value) || 0,
          y: Number(rigRotY.value) || 0,
          z: Number(rigRotZ.value) || 0,
        },
        swingLimit: Number(rigSwing.value) || 0,
        twistLimit: Number(rigTwist.value) || 0,
      };
      rebuildRagdoll();
    });
    rigLengthInput?.addEventListener('input', () => {
      const name = rigBoneSelect.value;
      if (!name) return;
      this.playerConfig.ragdollRig[name] = {
        radiusScale: Number(rigRadiusInput.value) || 1,
        lengthScale: Number(rigLengthInput.value) || 1,
        sourceBone: rigSourceBoneSelect?.value?.trim() || undefined,
        childBone: rigChildBoneSelect?.value?.trim() || undefined,
        offset: {
          x: Number(rigOffX.value) || 0,
          y: Number(rigOffY.value) || 0,
          z: Number(rigOffZ.value) || 0,
        },
        rot: {
          x: Number(rigRotX.value) || 0,
          y: Number(rigRotY.value) || 0,
          z: Number(rigRotZ.value) || 0,
        },
        swingLimit: Number(rigSwing.value) || 0,
        twistLimit: Number(rigTwist.value) || 0,
      };
      rebuildRagdoll();
    });
    const applyRigField = () => {
      const name = rigBoneSelect.value;
      if (!name) return;
      this.playerConfig.ragdollRig[name] = {
        radiusScale: Number(rigRadiusInput.value) || 1,
        lengthScale: Number(rigLengthInput.value) || 1,
        sourceBone: rigSourceBoneSelect?.value?.trim() || undefined,
        childBone: rigChildBoneSelect?.value?.trim() || undefined,
        offset: {
          x: Number(rigOffX.value) || 0,
          y: Number(rigOffY.value) || 0,
          z: Number(rigOffZ.value) || 0,
        },
        rot: {
          x: Number(rigRotX.value) || 0,
          y: Number(rigRotY.value) || 0,
          z: Number(rigRotZ.value) || 0,
        },
        swingLimit: Number(rigSwing.value) || 0,
        twistLimit: Number(rigTwist.value) || 0,
      };
      rebuildRagdoll();
    };
    rigOffX?.addEventListener('input', applyRigField);
    rigOffY?.addEventListener('input', applyRigField);
    rigOffZ?.addEventListener('input', applyRigField);
    rigRotX?.addEventListener('input', applyRigField);
    rigRotY?.addEventListener('input', applyRigField);
    rigRotZ?.addEventListener('input', applyRigField);
    rigSwing?.addEventListener('input', applyRigField);
    rigTwist?.addEventListener('input', applyRigField);
    rigSourceBoneSelect?.addEventListener('change', applyRigField);
    rigChildBoneSelect?.addEventListener('change', applyRigField);
    rigModeSelect?.addEventListener('change', () => {
      if (this.ragdollTransform) {
        this.ragdollTransform.setMode(rigModeSelect.value as 'translate' | 'rotate' | 'scale');
      }
    });
    rigShowInput?.addEventListener('change', () => {
      if (rigShowInput.checked && !this.ragdollVisible) {
        void this.toggleRagdollVisual(ragdollStatus ?? undefined);
      } else if (!rigShowInput.checked && this.ragdollVisible) {
        void this.toggleRagdollVisual(ragdollStatus ?? undefined);
      }
    });
    rigApplyButton?.addEventListener('click', () => {
      readPlayerInputs();
      rebuildRagdoll();
    });
    rigResetButton?.addEventListener('click', () => {
      this.playerConfig.ragdollRig = {};
      setPlayerInputs();
      rebuildRagdoll();
    });

    this.ragdollTransform?.addEventListener('objectChange', () => {
      if (!this.selectedRagdoll || !this.ragdollTransform) return;
      const rag = this.ragdollBones.get(this.selectedRagdoll);
      if (!rag || !rag.basePos || !rag.baseRot || !rag.boneWorldQuat) return;
      const mesh = this.ragdollTransform.object;
      if (!mesh) return;
      const offsetWorld = mesh.position.clone().sub(rag.basePos);
      const invBone = rag.boneWorldQuat.clone().invert();
      const offsetLocal = offsetWorld.applyQuaternion(invBone);
      const rotOffset = rag.baseRot.clone().invert().multiply(mesh.quaternion);
      const euler = new THREE.Euler().setFromQuaternion(rotOffset, 'XYZ');
      const cfg = this.playerConfig.ragdollRig[this.selectedRagdoll] ?? {
        radiusScale: 1,
        lengthScale: 1,
      };
      cfg.offset = { x: offsetLocal.x, y: offsetLocal.y, z: offsetLocal.z };
      cfg.rot = { x: euler.x, y: euler.y, z: euler.z };
      this.playerConfig.ragdollRig[this.selectedRagdoll] = cfg;
      setPlayerInputs();
    });
    void (async () => {
      try {
        if (!this.currentGameId) throw new Error('No game selected');
        const res = await fetch(`/api/games/${this.currentGameId}/player`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as Partial<PlayerConfig>;
        this.playerConfig = this.normalizePlayerConfig({ ...this.playerConfig, ...data });
        setPlayerInputs();
        await refreshPlayerAvatars();
        this.loadVrm();
      } catch {
        // ignore
      }
    })();

    const applyRot = () => {
      if (!this.selectedBone) return;
      this.selectedBone.rotation.x = parseFloat(rotX.value);
      this.selectedBone.rotation.y = parseFloat(rotY.value);
      this.selectedBone.rotation.z = parseFloat(rotZ.value);
    };
    const applyPos = () => {
      if (!this.selectedBone) return;
      if (this.getBoneKey(this.selectedBone) !== ROOT_BONE_KEY) return;
      this.selectedBone.position.set(
        parseFloat(posX.value),
        parseFloat(posY.value),
        parseFloat(posZ.value),
      );
    };
    rotX.addEventListener('input', applyRot);
    rotY.addEventListener('input', applyRot);
    rotZ.addEventListener('input', applyRot);
    posX.addEventListener('input', applyPos);
    posY.addEventListener('input', applyPos);
    posZ.addEventListener('input', applyPos);
    timeline.addEventListener('pointerdown', (event) => {
      if (!this.timeline) return;

      // Update pointer state
      this.pointerPressure = event.pressure ?? 0.5;
      this.pointerType = event.pointerType as 'mouse' | 'pen' | 'touch';

      const rect = this.timeline.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width - 1e-4, event.clientX - rect.left));
      const totalFrames = this.getTotalFrames();
      const frameIndex = Math.min(totalFrames - 1, Math.floor((x / rect.width) * totalFrames));

      // Start scrubbing
      this.timelineScrubbing = true;
      this.timelineScrubLastX = event.clientX;
      this.timelineScrubLastTime = performance.now();
      this.timelineScrubVelocity = 0;
      this.timelineLastFrame = frameIndex;
      this.timelineDownFrame = frameIndex;
      this.timelinePaintMode = this.overrideMode
        ? null
        : this.hasFrameAtIndex(frameIndex)
          ? 'disable'
          : 'enable';
      this.timelinePaintChanged = false;

      // Set time and scrub to frame
      this.time = frameIndex / this.fps;
      this.applyClipAtTime(this.time);
      if (this.timelinePaintMode) {
        this.pushUndo();
        this.timelinePaintChanged =
          this.setFrameEnabled(frameIndex, this.timelinePaintMode === 'enable') ||
          this.timelinePaintChanged;
        this.rebuildClipKeyMap();
        this.drawTimeline();
      }

      // Haptic feedback on frame snap
      if (this.pointerType === 'pen' || this.pointerType === 'touch') {
        this.triggerHapticFeedback('light');
      }
    });

    // Timeline scrubbing (drag to scrub)
    timeline.addEventListener('pointermove', (event) => {
      if (!this.timeline || !this.timelineScrubbing) return;

      // Cancel long-press if moved
      if (this.timelineLongPressTimer !== null) {
        clearTimeout(this.timelineLongPressTimer);
        this.timelineLongPressTimer = null;
      }

      // Update pointer state
      this.pointerPressure = event.pressure ?? 0.5;

      const rect = this.timeline.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width - 1e-4, event.clientX - rect.left));
      const totalFrames = this.getTotalFrames();
      const frameIndex = Math.min(totalFrames - 1, Math.floor((x / rect.width) * totalFrames));

      // Calculate velocity for momentum
      const now = performance.now();
      const dt = now - this.timelineScrubLastTime;
      if (dt > 0) {
        const dx = event.clientX - this.timelineScrubLastX;
        this.timelineScrubVelocity = dx / dt; // pixels per ms
        this.timelineScrubLastX = event.clientX;
        this.timelineScrubLastTime = now;
      }

      // Apply pressure-based sensitivity for stylus
      let actualFrameIndex = frameIndex;
      if (this.pointerType === 'pen' && this.pointerPressure > 0) {
        // Light pressure = slower scrubbing (finer control)
        const pressureFactor = 0.3 + this.pointerPressure * 0.7;
        const frameDelta = frameIndex - this.timelineLastFrame;
        actualFrameIndex = Math.floor(this.timelineLastFrame + frameDelta * pressureFactor);
        actualFrameIndex = Math.max(0, Math.min(totalFrames - 1, actualFrameIndex));
      }

      // Only update if frame changed
      if (actualFrameIndex !== this.timelineLastFrame) {
        const previousFrame = this.timelineLastFrame;
        this.timelineLastFrame = actualFrameIndex;
        this.time = actualFrameIndex / this.fps;
        this.applyClipAtTime(this.time);
        if (this.timelinePaintMode) {
          const start = Math.min(previousFrame, actualFrameIndex);
          const end = Math.max(previousFrame, actualFrameIndex);
          for (let i = start; i <= end; i += 1) {
            this.timelinePaintChanged =
              this.setFrameEnabled(i, this.timelinePaintMode === 'enable') ||
              this.timelinePaintChanged;
          }
          this.rebuildClipKeyMap();
          this.applyClipAtTime(this.time);
          this.drawTimeline();
        }

        // Haptic feedback on frame snap
        if (this.pointerType === 'pen' || this.pointerType === 'touch') {
          this.triggerHapticFeedback('light');
        }
      }
    });

    // Timeline scrubbing end
    timeline.addEventListener('pointerup', (_event) => {
      this.timelineScrubbing = false;
      this.timelinePaintMode = null;

      // Cancel long-press
      if (this.timelineLongPressTimer !== null) {
        clearTimeout(this.timelineLongPressTimer);
        this.timelineLongPressTimer = null;
      }
      this.timelineScrubVelocity = 0;
      if (this.timelinePaintChanged) {
        this.updateTimeline();
      }
      if (this.overrideMode && this.timelineDownFrame === this.timelineLastFrame) {
        const overrideBone = this.selectedBone ?? this.bones[0] ?? null;
        if (overrideBone) {
          const { startTime, endTime } = this.getOverrideRangeTimes();
          const overrideTime = THREE.MathUtils.clamp(this.time, startTime, endTime);
          this.pushUndo();
          this.applyOverrideOffset(overrideBone, overrideTime);
          this.refreshJson(jsonBox);
          this.updateTimeline();
          this.triggerHapticFeedback('medium');
        }
      }
      this.timelinePaintChanged = false;
      this.timelineDownFrame = -1;
    });

    // Cancel scrubbing if pointer leaves timeline
    timeline.addEventListener('pointerleave', () => {
      this.timelineScrubbing = false;
      this.timelinePaintMode = null;
      if (this.timelineLongPressTimer !== null) {
        clearTimeout(this.timelineLongPressTimer);
        this.timelineLongPressTimer = null;
      }
      this.timelinePaintChanged = false;
      this.timelineDownFrame = -1;
    });

    timeInput.addEventListener('input', () => {
      const snappedFrame = this.getFrameIndex(parseFloat(timeInput.value));
      this.time = this.getFrameTime(snappedFrame);
      timeInput.value = this.time.toFixed(4);
      this.applyClipAtTime(this.time);
    });

    durationInput.addEventListener('change', () => {
      const maxFrames = Math.max(1, Math.floor(MAX_DURATION * this.fps));
      const value = Math.max(1, Math.min(maxFrames, Math.round(parseFloat(durationInput.value))));
      this.setTotalFrames(value);
      durationInput.value = String(this.getTotalFrames());
      this.syncOverrideRangeUi(overrideRangeWrap, overrideStartHandle, overrideEndHandle);
      this.drawTimeline();
    });

    fpsInput.addEventListener('change', () => {
      const oldFps = this.fps;
      const oldTotalFrames = this.getTotalFrames();
      const value = Math.max(5, Math.min(60, parseFloat(fpsInput.value)));
      this.fps = value;
      fpsInput.value = value.toFixed(0);
      for (const frame of this.clip.frames) {
        const frameIndex = Math.round(frame.time * oldFps);
        frame.time = this.getFrameTime(frameIndex);
      }
      this.setTotalFrames(oldTotalFrames);
      durationInput.value = String(this.getTotalFrames());
      this.normalizeClipToFrameGrid();
      this.syncOverrideRangeUi(overrideRangeWrap, overrideStartHandle, overrideEndHandle);
      this.drawTimeline();
    });

    addBtn.addEventListener('click', () => {
      this.pushUndo();
      if (this.overrideMode) {
        const overrideBone = this.selectedBone ?? this.bones[0] ?? null;
        if (overrideBone) {
          const { startTime, endTime } = this.getOverrideRangeTimes();
          const overrideTime = THREE.MathUtils.clamp(this.time, startTime, endTime);
          this.applyOverrideOffset(overrideBone, overrideTime);
        }
      } else {
        this.addKeyframe(this.time);
      }
      this.refreshJson(jsonBox);
      this.drawTimeline();
    });

    bonesToggleBtn.addEventListener('click', () => {
      this.boneVisualsVisible = !this.boneVisualsVisible;
      bonesToggleBtn.textContent = this.boneVisualsVisible ? 'Hide Bones' : 'Show Bones';
      if (!this.boneGizmoGroup) this.buildBoneGizmos();
      if (this.boneMarkers.size === 0) this.ensureBoneMarkers();
      if (this.boneGizmoGroup) this.boneGizmoGroup.visible = this.boneVisualsVisible;
      for (const marker of this.boneMarkers.values()) {
        marker.visible = this.boneVisualsVisible;
      }
      if (boneScaleWrap) {
        boneScaleWrap.style.display = this.boneVisualsVisible ? 'flex' : 'none';
      }
    });

    boneScaleInput?.addEventListener('input', () => {
      const value = parseFloat(boneScaleInput.value);
      if (!Number.isFinite(value)) return;
      const base = this.computeBoneScale() * 0.5;
      this.boneScale = base * value;
      this.ensureBoneMarkers();
      this.buildBoneGizmos();
      if (this.boneGizmoGroup) this.boneGizmoGroup.visible = this.boneVisualsVisible;
      for (const marker of this.boneMarkers.values()) {
        marker.visible = this.boneVisualsVisible;
      }
    });

    for (const playBtn of playButtons) {
      playBtn.addEventListener('click', () => {
        this.stopMixamoPreview();
        if (this.mixer) this.mixer.stopAllAction();
        this.disableRagdoll();
        this.isPlaying = true;
        this.ragdollRecording = false;
      });
    }

    for (const stopBtn of stopButtons) {
      stopBtn.addEventListener('click', () => {
        this.isPlaying = false;
      });
    }

    stepBack.addEventListener('click', () => {
      this.stepFrame(-1);
    });

    stepForward.addEventListener('click', () => {
      this.stepFrame(1);
    });

    overrideBtn.addEventListener('click', () => {
      this.overrideMode = !this.overrideMode;
      overrideBtn.textContent = this.overrideMode ? 'Override On' : 'Override Off';
      this.syncOverrideRangeUi(
        overrideRangeWrap,
        overrideStartHandle,
        overrideEndHandle,
        this.overrideMode,
      );
    });

    const updateOverrideFrameFromClientX = (clientX: number, edge: 'start' | 'end') => {
      if (!timelineWrap) return;
      const rect = timelineWrap.getBoundingClientRect();
      const totalFrames = this.getTotalFrames();
      const ratio = THREE.MathUtils.clamp(
        (clientX - rect.left) / Math.max(1, rect.width),
        0,
        0.999999,
      );
      const frame = THREE.MathUtils.clamp(Math.floor(ratio * totalFrames), 0, totalFrames - 1);
      if (edge === 'start') {
        this.overrideRangeStartFrame = Math.min(frame, this.overrideRangeEndFrame);
      } else {
        this.overrideRangeEndFrame = Math.max(frame, this.overrideRangeStartFrame);
      }
      this.syncOverrideRangeUi(
        overrideRangeWrap,
        overrideStartHandle,
        overrideEndHandle,
        this.overrideMode,
      );
    };

    const bindOverrideHandleDrag = (handle: HTMLDivElement | null, edge: 'start' | 'end') => {
      if (!handle) return;
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        updateOverrideFrameFromClientX(event.clientX, edge);
      });
      handle.addEventListener('pointermove', (event) => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        updateOverrideFrameFromClientX(event.clientX, edge);
      });
      const stop = (event: PointerEvent) => {
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    };
    bindOverrideHandleDrag(overrideStartHandle, 'start');
    bindOverrideHandleDrag(overrideEndHandle, 'end');

    resetBtn.addEventListener('click', () => {
      this.resetPose();
      this.isPlaying = false;
    });

    clearBtn.addEventListener('click', () => {
      this.pushUndo();
      this.clip.frames = [];
      this.setTotalFrames(Math.max(1, Math.round(parseFloat(durationInput.value))));
      durationInput.value = String(this.getTotalFrames());
      this.overrideRangeStartFrame = 0;
      this.overrideRangeEndFrame = Math.max(0, this.getTotalFrames() - 1);
      this.syncOverrideRangeUi(
        overrideRangeWrap,
        overrideStartHandle,
        overrideEndHandle,
        this.overrideMode,
      );
      this.rebuildClipKeyMap();
      this.refreshJson(jsonBox);
      this.drawTimeline();
    });

    const setClipStatus = (text: string, tone: 'ok' | 'warn' = 'ok') => {
      clipStatus.textContent = text;
      clipStatus.dataset.tone = tone;
    };

    const refreshEngineClips = async () => {
      try {
        const animPath = this.getAnimationsPath();
        if (!animPath) {
          setClipStatus('No game selected', 'warn');
          clipSelect.innerHTML = '<option value="">-- select a game first --</option>';
          return;
        }
        console.log('Fetching animations from', animPath, '...');
        const res = await fetch(animPath, { cache: 'no-store' });
        console.log(
          'Response status:',
          res.status,
          'Content-Type:',
          res.headers.get('content-type'),
        );

        if (!res.ok) {
          console.warn('Failed to fetch animations:', res.status, res.statusText);
          setClipStatus(`API error: ${res.status}`, 'warn');
          clipSelect.innerHTML = '<option value="">-- No clips --</option>';
          return;
        }

        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          console.warn('Non-JSON response from /api/animations');
          const text = await res.text();
          console.log('Response preview:', text.substring(0, 200));
          setClipStatus('API returned non-JSON', 'warn');
          clipSelect.innerHTML = '<option value="">-- No clips --</option>';
          return;
        }

        const data = (await res.json()) as { files?: string[] };
        console.log('Received animation files:', data);
        const files = (data.files ?? []).filter((name) => name.toLowerCase().endsWith('.json'));
        clipSelect.innerHTML = '';
        if (files.length === 0) {
          clipSelect.innerHTML = '<option value="">-- No clips --</option>';
          setClipStatus('No clips found', 'warn');
        } else {
          for (const file of files) {
            const opt = document.createElement('option');
            opt.value = file;
            opt.textContent = file;
            clipSelect.appendChild(opt);
          }
          setClipStatus(`Files: ${files.length}`, 'ok');
        }
      } catch (err) {
        console.error('Error loading clips:', err);
        setClipStatus(`Error: ${String(err)}`, 'warn');
        clipSelect.innerHTML = '<option value="">-- No clips --</option>';
      }
    };

    // Store reference for external access
    this.refreshClipsFunction = refreshEngineClips;

    // Add custom event listener to trigger refresh from outside
    clipSelect.addEventListener('refreshClips', () => {
      refreshEngineClips();
    });

    saveBtn.addEventListener('click', async () => {
      const name = clipNameInput.value.trim() || this.retargetedName || 'clip';
      const animPath = this.getAnimationsPath();
      if (!animPath) {
        setClipStatus('Please select a game first', 'warn');
        return;
      }
      try {
        if (!this.currentGameId) throw new Error('No game selected');
        await saveGameAnimation(this.currentGameId, name, { name, clip: this.clip });
        setClipStatus(`Saved ${name}.json`, 'ok');
        await refreshEngineClips();
      } catch (err) {
        setClipStatus(`Save failed: ${String(err)}`, 'warn');
      }
    });

    const loadClip = async (name: string) => {
      if (!name) {
        setClipStatus('Load failed: no file selected', 'warn');
        return;
      }
      this.pushUndo();
      const animPath = this.getAnimationsPath();
      if (!animPath) {
        setClipStatus('Please select a game first', 'warn');
        return;
      }
      try {
        if (!this.currentGameId) throw new Error('No game selected');
        const payload = await getGameAnimation(this.currentGameId, name);
        const data = parseClipPayload(payload);
        if (!data) return;
        this.clip = data;
        this.setTotalFrames(this.getTotalFrames());
        this.normalizeClipToFrameGrid();
        this.fillEmptyFramesFromPose();
        this.time = 0;
        this.rebuildClipKeyMap();
        durationInput.value = String(this.getTotalFrames());
        this.overrideRangeStartFrame = 0;
        this.overrideRangeEndFrame = Math.max(0, this.getTotalFrames() - 1);
        this.syncOverrideRangeUi(
          overrideRangeWrap,
          overrideStartHandle,
          overrideEndHandle,
          this.overrideMode,
        );
        timeInput.value = '0.0000';
        this.applyClipAtTime(0);
        this.refreshJson(jsonBox);
        this.updateTimeline();
        setClipStatus(`Loaded ${name}`, 'ok');
      } catch (err) {
        setClipStatus(`Load failed: ${String(err)}`, 'warn');
      }
    };

    loadBtn.addEventListener('click', async () => {
      const name = clipSelect.value || clipNameInput.value.trim();
      await loadClip(name);
    });

    clipSelect.addEventListener('change', async () => {
      const name = clipSelect.value;
      if (!name) return;
      await loadClip(name);
    });

    refreshBtn.addEventListener('click', refreshEngineClips);

    downloadBtn.addEventListener('click', () => {
      const name = this.retargetedName || 'sleepy_clip';
      const blob = new Blob([JSON.stringify(this.clip, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });

    refreshEngineClips();

    exportBtn?.addEventListener('click', () => {
      if (!this.vrm) return;
      const clip = this.buildAnimationClip();
      const exporter = new GLTFExporter();
      exporter.parse(
        this.vrm.scene,
        (result) => {
          const blob =
            result instanceof ArrayBuffer
              ? new Blob([result], { type: 'model/gltf-binary' })
              : new Blob([JSON.stringify(result)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = 'sleepy-animation.glb';
          link.click();
          URL.revokeObjectURL(url);
        },
        (err) => console.warn('GLTF export failed', err),
        { binary: true, animations: [clip] },
      );
    });

    mixamoFile.addEventListener('change', async () => {
      const files = Array.from(mixamoFile.files ?? []);
      if (files.length === 0) return;
      for (const file of files) {
        await this.loadMixamoFile(file, mixamoSelect, mixamoStatus, mixamoStatus);
      }
      mixamoFile.value = '';
    });

    mixamoPreview.addEventListener('click', () => {
      this.previewMixamo(mixamoSelect.value, mixamoStatus);
    });

    mixamoSelect.addEventListener('change', () => {
      if (!mixamoSelect.value) return;
      this.previewMixamo(mixamoSelect.value, mixamoStatus);
    });

    mixamoStop.addEventListener('click', () => {
      this.stopMixamoPreview();
      mixamoStatus.textContent = 'FBX: stopped';
    });

    mixamoBake.addEventListener('click', () => {
      this.bakeMixamoToClip(mixamoSelect.value, jsonBox, mixamoStatus);
    });

    ragdollBtn?.addEventListener('click', () => {
      void this.toggleRagdoll(ragdollStatus ?? undefined);
    });

    ragdollVisualBtn?.addEventListener('click', () => {
      void this.toggleRagdollVisual(ragdollStatus ?? undefined);
    });

    ragdollResetBtn?.addEventListener('click', () => {
      this.resetRagdollPose();
      if (ragdollStatus) {
        ragdollStatus.textContent = this.ragdollEnabled
          ? 'Ragdoll: on'
          : this.ragdollVisible
            ? 'Ragdoll: visual'
            : 'Ragdoll: off';
      }
    });

    ragdollRecordBtn?.addEventListener('click', () => {
      if (!this.ragdollEnabled) return;
      this.startRagdollRecording();
      if (ragdollStatus) ragdollStatus.textContent = 'Ragdoll: recording';
    });

    ragdollStopBtn?.addEventListener('click', () => {
      this.ragdollRecording = false;
      if (ragdollStatus)
        ragdollStatus.textContent = this.ragdollEnabled ? 'Ragdoll: on' : 'Ragdoll: off';
    });

    // --- Animation left panel: bone list, history, clipboard ---
    const boneListEl = hud.querySelector('[data-bone-list]') as HTMLDivElement;
    const undoInfo = hud.querySelector('[data-undo-info]') as HTMLDivElement;
    const clipboardInfo = hud.querySelector('[data-clipboard-info]') as HTMLDivElement;
    const undoBtn = hud.querySelector('[data-undo-btn]') as HTMLButtonElement;
    const redoBtn = hud.querySelector('[data-redo-btn]') as HTMLButtonElement;
    const copyBtn = hud.querySelector('[data-copy-btn]') as HTMLButtonElement;
    const pasteBtn = hud.querySelector('[data-paste-btn]') as HTMLButtonElement;

    undoBtn?.addEventListener('click', () => this.undo());
    redoBtn?.addEventListener('click', () => this.redo());
    copyBtn?.addEventListener('click', () => {
      if (this.copyKeyframeAtTime(this.time) && clipboardInfo) {
        const snap = 1 / this.fps;
        const t = Math.round(this.time / snap) * snap;
        clipboardInfo.textContent = `Copied frame at ${t.toFixed(2)}s`;
      }
    });
    pasteBtn?.addEventListener('click', () => {
      if (this.pasteKeyframeAtTime(this.time) && clipboardInfo) {
        clipboardInfo.textContent = `Pasted at ${this.time.toFixed(2)}s`;
      }
    });

    this.updateUndoInfo = () => {
      if (undoInfo)
        undoInfo.textContent = `Undo: ${this.undoStack.length} \u00b7 Redo: ${this.redoStack.length}`;
    };
    this.updateBoneList = () => {
      if (!boneListEl) return;
      boneListEl.innerHTML = '';
      for (const bone of this.bones) {
        const key = this.getBoneKey(bone);
        const btn = document.createElement('button');
        btn.className = 'bone-list-item' + (bone === this.selectedBone ? ' active' : '');
        btn.textContent = key;
        btn.addEventListener('click', () => {
          this.setSelectedBone(bone);
          this.updateBoneList?.();
        });
        boneListEl.appendChild(btn);
      }
    };

    return hud;
  }

  private cloneClip(): ClipData {
    return JSON.parse(JSON.stringify(this.clip)) as ClipData;
  }

  private pushUndo() {
    this.undoStack.push({ clip: this.cloneClip(), time: this.time });
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack.length = 0;
    this.updateUndoInfo?.();
  }

  private undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ clip: this.cloneClip(), time: this.time });
    this.clip = entry.clip;
    this.disabledFrameCache.clear();
    this.time = entry.time;
    this.rebuildClipKeyMap();
    this.applyClipAtTime(this.time);
    this.updateTimeline();
    this.updateUndoInfo?.();
  }

  private redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ clip: this.cloneClip(), time: this.time });
    this.clip = entry.clip;
    this.disabledFrameCache.clear();
    this.time = entry.time;
    this.rebuildClipKeyMap();
    this.applyClipAtTime(this.time);
    this.updateTimeline();
    this.updateUndoInfo?.();
  }

  private copyKeyframeAtTime(time: number) {
    const frame = this.findFrameByIndex(this.getFrameIndex(time));
    if (!frame) return false;
    this.keyframeClipboard = {
      bones: JSON.parse(JSON.stringify(frame.bones)),
      rootPos: frame.rootPos ? { ...frame.rootPos } : undefined,
    };
    return true;
  }

  private pasteKeyframeAtTime(time: number) {
    if (!this.keyframeClipboard) return false;
    this.pushUndo();
    const frameIndex = this.getFrameIndex(time);
    const t = this.getFrameTime(frameIndex);
    const existing = this.findFrameByIndex(frameIndex);
    const pasted = {
      bones: JSON.parse(JSON.stringify(this.keyframeClipboard.bones)) as Record<
        string,
        { x: number; y: number; z: number; w: number }
      >,
      rootPos: this.keyframeClipboard.rootPos ? { ...this.keyframeClipboard.rootPos } : undefined,
    };
    if (existing) {
      existing.time = t;
      Object.assign(existing.bones, pasted.bones);
      if (pasted.rootPos) existing.rootPos = pasted.rootPos;
    } else {
      this.clip.frames.push({ time: t, ...pasted });
      this.clip.frames.sort((a, b) => a.time - b.time);
    }
    this.disabledFrameCache.delete(frameIndex);
    this.rebuildClipKeyMap();
    this.applyClipAtTime(t);
    this.updateTimeline();
    return true;
  }

  private refreshJson(textarea: HTMLTextAreaElement) {
    textarea.value = JSON.stringify(this.clip, null, 2);
  }

  private updateTimeline(force = true) {
    const timeInput = this.hud.querySelector('[data-time]') as HTMLInputElement;
    const frameIndex = THREE.MathUtils.clamp(
      Math.round(this.time * this.fps),
      0,
      this.getTotalFrames() - 1,
    );
    const now = performance.now();
    if (timeInput && (force || now - this.timelineLastUiUpdateMs >= 66)) {
      timeInput.value = this.time.toFixed(4);
      this.timelineLastUiUpdateMs = now;
    }
    if (!force && frameIndex === this.timelineLastDrawnFrame) return;
    this.timelineLastDrawnFrame = frameIndex;
    this.drawTimeline();
  }

  /**
   * Animate timeline scrubbing to target frame with easing (momentum effect).
   */
  private animateTimelineToFrame(targetFrame: number) {
    const startFrame = this.timelineLastFrame;
    const startTime = performance.now();
    const duration = 300; // ms

    const animate = () => {
      const now = performance.now();
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);

      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentFrame = Math.floor(startFrame + (targetFrame - startFrame) * eased);

      this.timelineLastFrame = currentFrame;
      this.time = currentFrame / this.fps;
      this.applyClipAtTime(this.time);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    animate();
  }

  private dismissContextMenu() {
    const old = this.container.querySelector('.context-menu');
    if (old) old.remove();
  }

  private showTimelineContextMenu(frameIndex: number) {
    this.dismissContextMenu();
    const t = this.getFrameTime(frameIndex);
    const bone = this.selectedBone ?? this.bones[0];
    if (!bone) return;

    const existing = this.findFrameByIndex(frameIndex);
    const hasKeyframe = !!existing;

    const menu = document.createElement('div');
    menu.className = 'context-menu';

    type Action = { label: string; disabled?: boolean; action: () => void };
    const items: Action[] = [];

    if (hasKeyframe) {
      items.push({
        label: 'Delete Keyframe',
        action: () => {
          this.toggleKeyframe(bone, t);
          this.updateTimeline();
          this.triggerHapticFeedback('medium');
        },
      });
      items.push({
        label: 'Copy Keyframe',
        action: () => {
          this.copyKeyframeAtTime(t);
        },
      });
    } else {
      items.push({
        label: 'Insert Keyframe',
        action: () => {
          this.toggleKeyframe(bone, t);
          this.updateTimeline();
          this.triggerHapticFeedback('medium');
        },
      });
      items.push({
        label: 'Paste Keyframe',
        disabled: !this.keyframeClipboard,
        action: () => {
          this.pasteKeyframeAtTime(t);
          this.triggerHapticFeedback('medium');
        },
      });
    }

    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'context-menu-item' + (item.disabled ? ' disabled' : '');
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        this.dismissContextMenu();
        item.action();
      });
      menu.appendChild(btn);
    }

    // Separator + cancel
    const sep = document.createElement('div');
    sep.className = 'context-menu-sep';
    menu.appendChild(sep);
    const cancel = document.createElement('button');
    cancel.className = 'context-menu-item';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.dismissContextMenu());
    menu.appendChild(cancel);

    // Position near the timeline scrub point
    if (!this.timeline) return;
    const rect = this.timeline.getBoundingClientRect();
    const totalFrames = this.getTotalFrames();
    const cellWidth = rect.width / totalFrames;
    const px = rect.left + (frameIndex + 0.5) * cellWidth;
    const py = rect.top;
    menu.style.left = `${Math.min(px, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.max(0, py - 8)}px`;
    menu.style.transform = 'translateY(-100%)';

    this.container.appendChild(menu);

    // Close on outside click
    const dismiss = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.dismissContextMenu();
        window.removeEventListener('pointerdown', dismiss, true);
      }
    };
    window.addEventListener('pointerdown', dismiss, true);
  }

  private addKeyframe(time: number) {
    if (!this.vrm) return;
    const frameIndex = this.getFrameIndex(time);
    const frameTime = this.getFrameTime(frameIndex);
    const bones: Record<string, { x: number; y: number; z: number; w: number }> = {};
    for (const bone of this.bones) {
      const q = bone.quaternion;
      bones[this.getBoneKey(bone)] = { x: q.x, y: q.y, z: q.z, w: q.w };
    }
    const root = this.boneByKey.get(ROOT_BONE_KEY);
    const rootPos = root
      ? { x: root.position.x, y: root.position.y, z: root.position.z }
      : undefined;
    const existing = this.findFrameByIndex(frameIndex);
    if (existing) {
      existing.time = frameTime;
      existing.bones = bones;
      existing.rootPos = rootPos;
      this.disabledFrameCache.delete(frameIndex);
    } else {
      this.clip.frames.push({ time: frameTime, bones, rootPos });
      this.disabledFrameCache.delete(frameIndex);
    }
    this.clip.frames.sort((a, b) => a.time - b.time);
    this.rebuildClipKeyMap();
    this.drawTimeline();
  }

  private toggleKeyframe(bone: THREE.Object3D, time: number) {
    this.pushUndo();
    const frameIndex = this.getFrameIndex(time);
    const t = this.getFrameTime(frameIndex);
    if (this.overrideMode) {
      this.applyOverrideOffset(bone, t);
      this.drawTimeline();
      return;
    }
    this.setFrameEnabled(frameIndex, !this.hasFrameAtIndex(frameIndex));
    this.rebuildClipKeyMap();
    this.applyClipAtTime(t);
    this.drawTimeline();
  }

  private getFrameIndex(time: number) {
    const totalFrames = this.getTotalFrames();
    return THREE.MathUtils.clamp(Math.round(time * this.fps), 0, totalFrames - 1);
  }

  private getFrameTime(frameIndex: number) {
    return frameIndex / this.fps;
  }

  private getOverrideRangeTimes() {
    const startFrame = Math.min(this.overrideRangeStartFrame, this.overrideRangeEndFrame);
    const endFrame = Math.max(this.overrideRangeStartFrame, this.overrideRangeEndFrame);
    return {
      startTime: this.getFrameTime(startFrame),
      endTime: this.getFrameTime(endFrame),
    };
  }

  private getTotalFrames() {
    return Math.max(1, Math.round(this.clip.duration * this.fps));
  }

  private setTotalFrames(totalFrames: number) {
    const clamped = Math.max(1, totalFrames);
    this.clip.duration = clamped / this.fps;
    this.time = THREE.MathUtils.clamp(this.time, 0, this.clip.duration);
    const durationInput = this.hud?.querySelector('[data-duration]') as HTMLInputElement | null;
    const timeInput = this.hud?.querySelector('[data-time]') as HTMLInputElement | null;
    if (durationInput) {
      durationInput.max = String(Math.max(1, Math.floor(MAX_DURATION * this.fps)));
      durationInput.value = String(clamped);
    }
    if (timeInput) {
      timeInput.max = this.clip.duration.toFixed(4);
      timeInput.step = (1 / this.fps).toFixed(4);
      timeInput.value = this.time.toFixed(4);
    }
  }

  private computeTimelineLaneMetrics(
    totalFrames: number,
    width: number,
    height: number,
    scale = 1,
  ) {
    const lanePadX = Math.max(6, Math.floor(8 * scale));
    const lanePadY = Math.max(2, Math.floor(4 * scale));
    const usableWidth = Math.max(1, width - lanePadX * 2);
    const stepPitch = usableWidth / Math.max(1, totalFrames);
    const gap = stepPitch > 3 ? Math.min(stepPitch * 0.22, 3 * scale) : 0;
    const cellSize = Math.max(1, Math.min(stepPitch - gap, height - lanePadY * 2));
    const laneY = lanePadY;
    return { lanePadX, usableWidth, stepPitch, gap, cellSize, laneY };
  }

  private normalizeClipToFrameGrid() {
    const totalFrames = this.getTotalFrames();
    const dedup = new Map<number, BoneFrame>();
    for (const frame of this.clip.frames) {
      const idx = THREE.MathUtils.clamp(Math.round(frame.time * this.fps), 0, totalFrames - 1);
      dedup.set(idx, {
        time: this.getFrameTime(idx),
        bones: JSON.parse(JSON.stringify(frame.bones)) as Record<
          string,
          { x: number; y: number; z: number; w: number }
        >,
        rootPos: frame.rootPos ? { ...frame.rootPos } : undefined,
      });
    }
    this.clip.frames = Array.from(dedup.values()).sort((a, b) => a.time - b.time);
  }

  private syncOverrideRangeUi(
    wrap: HTMLDivElement | null,
    startHandle: HTMLDivElement | null,
    endHandle: HTMLDivElement | null,
    enabled = this.overrideMode,
  ) {
    const totalFrames = this.getTotalFrames();
    const maxFrame = Math.max(0, totalFrames - 1);
    this.overrideRangeStartFrame = THREE.MathUtils.clamp(this.overrideRangeStartFrame, 0, maxFrame);
    this.overrideRangeEndFrame = THREE.MathUtils.clamp(this.overrideRangeEndFrame, 0, maxFrame);
    if (this.overrideRangeStartFrame > this.overrideRangeEndFrame) {
      const temp = this.overrideRangeStartFrame;
      this.overrideRangeStartFrame = this.overrideRangeEndFrame;
      this.overrideRangeEndFrame = temp;
    }
    if (wrap) wrap.style.display = enabled ? 'block' : 'none';
    const frameEl = wrap?.querySelector('[data-override-frame]') as HTMLDivElement | null;
    if (frameEl) {
      const start = Math.min(this.overrideRangeStartFrame, this.overrideRangeEndFrame);
      const end = Math.max(this.overrideRangeStartFrame, this.overrideRangeEndFrame);
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const metrics = this.computeTimelineLaneMetrics(totalFrames, rect.width, rect.height, 1);
      const frameLeft = metrics.lanePadX + start * metrics.stepPitch + metrics.gap * 0.5;
      const frameWidth = Math.max(
        metrics.stepPitch - metrics.gap,
        (end - start + 1) * metrics.stepPitch - metrics.gap,
      );
      frameEl.style.left = `${frameLeft}px`;
      frameEl.style.width = `${frameWidth}px`;
      frameEl.style.top = `${metrics.laneY}px`;
      frameEl.style.height = `${metrics.cellSize}px`;
      if (startHandle) {
        startHandle.style.left = `${frameLeft}px`;
        startHandle.style.top = `${metrics.laneY}px`;
        startHandle.style.height = `${metrics.cellSize}px`;
      }
      if (endHandle) {
        endHandle.style.left = `${frameLeft + frameWidth}px`;
        endHandle.style.top = `${metrics.laneY}px`;
        endHandle.style.height = `${metrics.cellSize}px`;
      }
    }
  }

  private hasFrameAtIndex(frameIndex: number) {
    return !!this.findFrameByIndex(frameIndex);
  }

  private findFrameByIndex(frameIndex: number) {
    return this.clip.frames.find((frame) => Math.round(frame.time * this.fps) === frameIndex);
  }

  private cloneFrame(frame: BoneFrame, frameTime: number): BoneFrame {
    return {
      time: frameTime,
      bones: JSON.parse(JSON.stringify(frame.bones)) as Record<
        string,
        { x: number; y: number; z: number; w: number }
      >,
      rootPos: frame.rootPos ? { ...frame.rootPos } : undefined,
    };
  }

  private setFrameEnabled(frameIndex: number, enabled: boolean) {
    const frameTime = this.getFrameTime(frameIndex);
    const existing = this.findFrameByIndex(frameIndex);
    if (enabled) {
      if (existing) return false;
      const cached = this.disabledFrameCache.get(frameIndex);
      if (cached) {
        this.clip.frames.push(this.cloneFrame(cached, frameTime));
        this.clip.frames.sort((a, b) => a.time - b.time);
        this.disabledFrameCache.delete(frameIndex);
        return true;
      }
      // Sample current evaluated pose at the target frame so re-enabled keys blend naturally.
      this.applyClipAtTime(frameTime);
      const bones: Record<string, { x: number; y: number; z: number; w: number }> = {};
      for (const b of this.bones) {
        const q = b.quaternion;
        bones[this.getBoneKey(b)] = { x: q.x, y: q.y, z: q.z, w: q.w };
      }
      const root = this.boneByKey.get(ROOT_BONE_KEY);
      const rootPos = root
        ? { x: root.position.x, y: root.position.y, z: root.position.z }
        : undefined;
      this.clip.frames.push({ time: frameTime, bones, rootPos });
      this.clip.frames.sort((a, b) => a.time - b.time);
      this.disabledFrameCache.delete(frameIndex);
      return true;
    }
    if (!existing) return false;
    this.disabledFrameCache.set(frameIndex, this.cloneFrame(existing, frameTime));
    this.clip.frames = this.clip.frames.filter((frame) => frame !== existing);
    return true;
  }

  private applyOverrideOffset(bone: THREE.Object3D, time: number) {
    if (this.clip.frames.length === 0) return;
    const { startTime: rangeStart, endTime: rangeEnd } = this.getOverrideRangeTimes();
    if (time < rangeStart || time > rangeEnd) return;
    const key = this.getBoneKey(bone);
    let prev: BoneFrame | null = null;
    let next: BoneFrame | null = null;
    for (let i = 0; i < this.clip.frames.length; i += 1) {
      const frame = this.clip.frames[i];
      if (!frame) continue;
      if (frame.time < rangeStart || frame.time > rangeEnd) continue;
      if (!frame.bones[key]) continue;
      if (frame.time <= time) prev = frame;
      if (frame.time >= time) {
        next = frame;
        break;
      }
    }
    if (!prev && !next) return;
    if (!next) next = prev;
    if (!prev) prev = next;
    if (!prev || !next) return;
    const qa = prev.bones[key];
    const qb = next.bones[key];
    if (!qa || !qb) return;
    const span = Math.max(0.0001, next.time - prev.time);
    const t = THREE.MathUtils.clamp((time - prev.time) / span, 0, 1);
    const base = new THREE.Quaternion(qa.x, qa.y, qa.z, qa.w).slerp(
      new THREE.Quaternion(qb.x, qb.y, qb.z, qb.w),
      t,
    );
    const current = bone.quaternion.clone();
    const offset = current.multiply(base.clone().invert());

    for (const frame of this.clip.frames) {
      if (frame.time < rangeStart || frame.time > rangeEnd) continue;
      const entry = frame.bones[key];
      if (!entry) continue;
      const q = new THREE.Quaternion(entry.x, entry.y, entry.z, entry.w);
      q.premultiply(offset);
      entry.x = q.x;
      entry.y = q.y;
      entry.z = q.z;
      entry.w = q.w;
    }

    if (key === ROOT_BONE_KEY) {
      let prevRoot: BoneFrame | null = null;
      let nextRoot: BoneFrame | null = null;
      for (let i = 0; i < this.clip.frames.length; i += 1) {
        const frame = this.clip.frames[i];
        if (!frame) continue;
        if (frame.time < rangeStart || frame.time > rangeEnd) continue;
        if (!frame.rootPos) continue;
        if (frame.time <= time) prevRoot = frame;
        if (frame.time >= time) {
          nextRoot = frame;
          break;
        }
      }
      if (prevRoot || nextRoot) {
        if (!nextRoot) nextRoot = prevRoot;
        if (!prevRoot) prevRoot = nextRoot;
        if (prevRoot?.rootPos && nextRoot?.rootPos) {
          const span = Math.max(0.0001, nextRoot.time - prevRoot.time);
          const t = THREE.MathUtils.clamp((time - prevRoot.time) / span, 0, 1);
          const basePos = new THREE.Vector3(
            THREE.MathUtils.lerp(prevRoot.rootPos.x, nextRoot.rootPos.x, t),
            THREE.MathUtils.lerp(prevRoot.rootPos.y, nextRoot.rootPos.y, t),
            THREE.MathUtils.lerp(prevRoot.rootPos.z, nextRoot.rootPos.z, t),
          );
          const currentPos = bone.position.clone();
          const offsetPos = currentPos.sub(basePos);
          for (const frame of this.clip.frames) {
            if (frame.time < rangeStart || frame.time > rangeEnd) continue;
            if (!frame.rootPos) continue;
            frame.rootPos = {
              x: frame.rootPos.x + offsetPos.x,
              y: frame.rootPos.y + offsetPos.y,
              z: frame.rootPos.z + offsetPos.z,
            };
          }
        }
      }
    }
  }

  private applyClipAtTime(time: number) {
    if (!this.vrm || this.clip.frames.length === 0) return;
    const frames = this.clip.frames;
    if (this.clipKeyMap.size === 0) {
      this.rebuildClipKeyMap();
    }
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (!first || !last) return;
    let prev = first;
    let next = last;
    if (time <= first.time) {
      prev = first;
      next = first;
    } else if (time >= last.time) {
      prev = last;
      next = last;
    } else {
      let lo = 0;
      let hi = frames.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const frame = frames[mid];
        if (!frame) break;
        if (frame.time < time) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const nextIndex = THREE.MathUtils.clamp(lo, 0, frames.length - 1);
      const prevIndex = THREE.MathUtils.clamp(nextIndex - 1, 0, frames.length - 1);
      prev = frames[prevIndex] ?? prev;
      next = frames[nextIndex] ?? next;
    }
    const span = Math.max(0.0001, next.time - prev.time);
    const t = THREE.MathUtils.clamp((time - prev.time) / span, 0, 1);

    const root = this.boneByKey.get(ROOT_BONE_KEY);
    if (root) {
      const rootA = prev.rootPos ?? next.rootPos;
      const rootB = next.rootPos ?? prev.rootPos;
      if (rootA && rootB) {
        root.position.set(
          THREE.MathUtils.lerp(rootA.x, rootB.x, t),
          THREE.MathUtils.lerp(rootA.y, rootB.y, t),
          THREE.MathUtils.lerp(rootA.z, rootB.z, t),
        );
      }
    }
    for (const [key, bone] of this.clipKeyMap.entries()) {
      const qa = prev.bones[key] ?? next.bones[key];
      const qb = next.bones[key] ?? prev.bones[key];
      if (!qa || !qb) continue;
      this.clipInterpQuatA.set(qa.x, qa.y, qa.z, qa.w);
      this.clipInterpQuatB.set(qb.x, qb.y, qb.z, qb.w);
      this.clipInterpQuatOut.slerpQuaternions(this.clipInterpQuatA, this.clipInterpQuatB, t);
      bone.quaternion.copy(this.clipInterpQuatOut);
    }
  }

  private rebuildClipKeyMap() {
    this.clipKeyMap.clear();
    if (!this.vrm) return;
    const keys = new Set<string>();
    for (const frame of this.clip.frames) {
      for (const key of Object.keys(frame.bones)) {
        keys.add(key);
      }
    }
    for (const key of keys) {
      let bone = this.boneByKey.get(key) ?? this.boneByName.get(key);
      if (!bone) {
        const lower = key.toLowerCase();
        bone = this.boneByKey.get(lower) ?? this.boneByName.get(lower);
      }
      if (bone) {
        this.clipKeyMap.set(key, bone);
      }
    }
  }

  private fillEmptyFramesFromPose() {
    if (!this.vrm) return;
    const hasAny = this.clip.frames.some((frame) => Object.keys(frame.bones).length > 0);
    if (hasAny) return;
    const bonesSnapshot: Record<string, { x: number; y: number; z: number; w: number }> = {};
    for (const bone of this.bones) {
      const q = bone.quaternion;
      bonesSnapshot[this.getBoneKey(bone)] = { x: q.x, y: q.y, z: q.z, w: q.w };
    }
    const root = this.boneByKey.get(ROOT_BONE_KEY);
    const rootPos = root
      ? { x: root.position.x, y: root.position.y, z: root.position.z }
      : undefined;
    for (const frame of this.clip.frames) {
      frame.bones = { ...bonesSnapshot };
      if (rootPos) {
        frame.rootPos = { ...rootPos };
      }
    }
  }

  private normalizePlayerConfig(payload: Partial<PlayerConfig> | null | undefined): PlayerConfig {
    const defaults = createDefaultPlayerConfig();
    const data = (payload ?? {}) as Partial<PlayerConfig>;
    const profileTags = Array.isArray(data.profile?.tags)
      ? data.profile.tags.map((tag) => String(tag))
      : [...defaults.profile.tags];
    const machineStates = Array.isArray(data.stateMachine?.states)
      ? data.stateMachine.states
      : null;
    const machineTransitions = Array.isArray(data.stateMachine?.transitions)
      ? data.stateMachine.transitions
      : null;
    const npcGoals = Array.isArray(data.npc?.goals)
      ? data.npc.goals.map((goal) => String(goal))
      : [...defaults.npc.goals];
    return {
      ...defaults,
      ...data,
      controllerModes: {
        third_person: {
          ...(defaults.controllerModes?.third_person ?? {}),
          ...((data.controllerModes as ControllerModeConfigs | undefined)?.third_person ?? {}),
        },
        first_person: {
          ...(defaults.controllerModes?.first_person ?? {}),
          ...((data.controllerModes as ControllerModeConfigs | undefined)?.first_person ?? {}),
        },
        ragdoll: {
          ...(defaults.controllerModes?.ragdoll ?? {}),
          ...((data.controllerModes as ControllerModeConfigs | undefined)?.ragdoll ?? {}),
        },
      },
      ragdollMuscle: { ...defaults.ragdollMuscle, ...(data.ragdollMuscle ?? {}) },
      ragdollSim: { ...defaults.ragdollSim, ...(data.ragdollSim ?? {}) },
      ragdollRig:
        typeof data.ragdollRig === 'object' && data.ragdollRig ? { ...data.ragdollRig } : {},
      profile: {
        ...defaults.profile,
        ...(data.profile ?? {}),
        tags: profileTags,
      },
      capsule: { ...defaults.capsule, ...(data.capsule ?? {}) },
      stateMachine: {
        initial: String(data.stateMachine?.initial ?? defaults.stateMachine.initial),
        states: machineStates
          ? machineStates
              .map((state) => ({
                ...parseStateMachineState(state),
              }))
              .filter((state) => state.id.length > 0)
          : defaults.stateMachine.states.map((state) => ({
              ...state,
              tags: [...(state.tags ?? [])],
            })),
        transitions: machineTransitions
          ? machineTransitions
              .map((transition) => ({
                ...parseStateMachineTransition(transition),
              }))
              .filter((transition) => transition.to.length > 0)
          : defaults.stateMachine.transitions.map((transition) => ({ ...transition })),
      },
      npc: {
        ...defaults.npc,
        ...(data.npc ?? {}),
        goals: npcGoals,
      },
    };
  }

  private syncPlayerCapsulePreview() {
    const enabled = this.currentTab === 'player' && Boolean(this.playerConfig.capsule?.preview);
    if (!enabled) {
      if (this.playerCapsulePreview) this.playerCapsulePreview.visible = false;
      return;
    }
    const capsule = this.playerConfig.capsule ?? createDefaultPlayerConfig().capsule;
    const radius = Math.max(0.08, capsule.baseRadius * (this.playerConfig.capsuleRadiusScale || 1));
    const height = Math.max(
      radius * 2.2,
      capsule.baseHeight * (this.playerConfig.capsuleHeightScale || 1),
    );
    const cylinderLength = Math.max(0.05, height - radius * 2);
    if (!this.playerCapsulePreview) {
      const solid = new THREE.Mesh(
        new THREE.CapsuleGeometry(radius, cylinderLength, 8, 16),
        this.playerCapsulePreviewMaterial,
      );
      const wire = new THREE.Mesh(
        new THREE.CapsuleGeometry(radius, cylinderLength, 8, 16),
        this.playerCapsuleWireframe,
      );
      const group = new THREE.Group();
      group.add(solid, wire);
      group.renderOrder = 20;
      this.characterScene.add(group);
      this.playerCapsulePreview = group;
    } else {
      const solid = this.playerCapsulePreview.children[0] as THREE.Mesh | undefined;
      const wire = this.playerCapsulePreview.children[1] as THREE.Mesh | undefined;
      if (solid) {
        solid.geometry.dispose();
        solid.geometry = new THREE.CapsuleGeometry(radius, cylinderLength, 8, 16);
      }
      if (wire) {
        wire.geometry.dispose();
        wire.geometry = new THREE.CapsuleGeometry(radius, cylinderLength, 8, 16);
      }
    }
    const anchor = this.playerCapsuleTemp.set(0, 0, 0);
    if (this.vrm) {
      const hips = this.vrm.humanoid.getRawBoneNode('hips');
      if (hips) {
        hips.getWorldPosition(anchor);
      } else {
        anchor.copy(this.vrm.scene.position);
      }
    }
    this.playerCapsulePreview.position.set(
      anchor.x,
      Math.max(radius, height * 0.5 + (this.playerConfig.capsuleYOffset || 0)),
      anchor.z,
    );
    this.playerCapsulePreview.visible = enabled;
  }

  private loadVrm() {
    if (!this.currentGameId) return;
    const avatarName = String(this.playerConfig.avatar ?? '').trim();
    if (!avatarName) {
      if (this.vrm) {
        this.characterScene.remove(this.vrm.scene);
        this.vrm = null;
      }
      this.syncPlayerCapsulePreview();
      return;
    }
    const url = getGameAvatarUrl(this.currentGameId, avatarName);
    this.gltfLoader.load(
      url,
      (gltf) => {
        this.applyVrm(gltf);
      },
      undefined,
      (err) => console.warn('VRM load failed', err),
    );
  }

  private createCharacterScene() {
    // Minimal animation-preview scene: clean lighting + floor/grid only.
    this.characterScene.background = new THREE.Color(0x090d16);
    this.characterScene.fog = null;

    const hemi = new THREE.HemisphereLight(0xb6c8ff, 0x10141d, 0.5);
    this.characterScene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(4, 7, 3);
    this.characterScene.add(key);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.25);
    fill.position.set(-4, 3.5, -2);
    this.characterScene.add(fill);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 50),
      new THREE.MeshStandardMaterial({
        color: 0x1f2530,
        roughness: 0.94,
        metalness: 0.02,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.001;
    this.characterScene.add(floor);

    const gridHelper = new THREE.GridHelper(40, 40, 0x4d5b78, 0x232c3b);
    gridHelper.position.y = 0.002;
    const gridMat = gridHelper.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.32;
    this.characterScene.add(gridHelper);
  }

  private createLevelScene() {
    // Add basic lighting for level viewing
    this.levelAmbientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.levelScene.add(this.levelAmbientLight);

    this.levelDirectionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    this.levelDirectionalLight.position.set(5, 10, 5);
    this.levelScene.add(this.levelDirectionalLight);

    // Add a grid for reference
    const gridHelper = new THREE.GridHelper(100, 100, 0x444444, 0x222222);
    gridHelper.position.y = 0.01; // Slightly above ground to prevent z-fighting
    this.levelScene.add(gridHelper);

    this.levelObstacleGroup.name = 'level-obstacles';
    this.levelScene.add(this.levelObstacleGroup);
    this.levelRoadGroup.name = 'level-roads';
    this.levelScene.add(this.levelRoadGroup);
    this.zoneGizmos = new ZoneGizmos(this.levelScene);

    // Obstacles are loaded from the selected scene in the level editor UI.
  }

  private createSettingsScene() {
    // Minimal scene for settings preview
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    this.settingsScene.add(ambient);

    // Add floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshStandardMaterial({ color: 0x333333 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.settingsScene.add(floor);

    this.modelPreviewRoot.name = 'model-preview-root';
    this.modelPreviewRoot.position.set(0, 0, 0);
    this.modelPreviewRoot.visible = false;
    this.settingsScene.add(this.modelPreviewRoot);
  }

  private async loadLevelGeometry() {
    const scenesPath = this.getScenesPath();
    if (!scenesPath) {
      console.log('No game selected, skipping level geometry load');
      return;
    }
    try {
      const res = await fetch(scenesPath, { cache: 'no-store' });
      if (!res.ok) {
        console.log('Level geometry API not available (404 expected in dev)');
        return;
      }

      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.log('Level geometry API returned non-JSON response');
        return;
      }

      const data = await res.json();
      if (!data.scenes || !Array.isArray(data.scenes)) return;

      // Load the first scene's obstacles
      const scene = data.scenes[0];
      if (!scene || !scene.obstacles) return;

      // Create meshes for obstacles
      for (const obstacle of scene.obstacles) {
        const geometry = new THREE.BoxGeometry(
          obstacle.width || 1,
          obstacle.height || 1,
          obstacle.depth || 1,
        );
        const material = new THREE.MeshStandardMaterial({
          color: 0x666666,
          roughness: 0.8,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(obstacle.x || 0, obstacle.y || 0, obstacle.z || 0);
        this.levelScene.add(mesh);
      }
    } catch (err) {
      // Silently fail - level geometry is optional during development
      console.log('Level geometry not loaded (optional)');
    }
  }

  private createStudioTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#1b202a';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 16; i += 1) {
      const p = (i / 16) * 512;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, 512);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(512, p);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let i = 0; i < 1800; i += 1) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      ctx.fillRect(x, y, 1, 1);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2.5, 2.5);
    tex.anisotropy = 4;
    return tex;
  }

  private applyVrm(gltf: GLTF) {
    const scene = gltf.scene;
    if (typeof VRMUtils.removeUnnecessaryVertices === 'function') {
      VRMUtils.removeUnnecessaryVertices(scene);
    }
    if (typeof VRMUtils.removeUnnecessaryJoints === 'function') {
      VRMUtils.removeUnnecessaryJoints(scene);
    }
    const vrm = gltf.userData?.vrm as VRM | undefined;
    if (!vrm) return;

    // Remove old VRM from character scene
    if (this.vrm) {
      this.characterScene.remove(this.vrm.scene);
      this.vrm = null;
    }
    if (this.skeletonHelper) {
      this.characterScene.remove(this.skeletonHelper);
      this.skeletonHelper = null;
    }
    if (this.boneGizmoGroup) {
      this.characterScene.remove(this.boneGizmoGroup);
      this.boneGizmoGroup = null;
      this.boneGizmos.clear();
    }

    this.vrm = vrm;
    vrm.humanoid.autoUpdateHumanBones = false;
    vrm.scene.position.set(0, 0, 0);

    // Add VRM to character scene
    this.characterScene.add(vrm.scene);

    requestAnimationFrame(() => {
      this.resizeRenderer();
      this.fitCameraToVrm(true);
    });
    this.boneScale = this.computeBoneScale() * 0.5;
    this.collectBones();
    this.buildBoneGizmos();
    this.populateBoneList();
    this.syncPlayerCapsulePreview();
  }

  private fitCameraToVrm(forceAxis = false) {
    if (!this.vrm || !this.controls) return;
    const box = new THREE.Box3().setFromObject(this.vrm.scene);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const extent = Math.max(size.x, size.y, size.z, 1);
    const target = forceAxis ? new THREE.Vector3(0, center.y, 0) : center;
    this.controls.target.copy(target);
    const dist = extent * 1.9;
    this.camera.position.set(0, target.y + size.y * 0.2, -dist);
    this.camera.lookAt(target);
    this.controls.minDistance = Math.max(0.6, extent * 0.6);
    this.controls.maxDistance = Math.max(6, extent * 6);
    this.controls.update();
  }

  private computeBoneScale() {
    if (!this.vrm) return 0.08;
    const box = new THREE.Box3().setFromObject(this.vrm.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const height = Math.max(size.y, 0.5);
    return Math.max(0.02, Math.min(0.16, height * 0.04));
  }

  /**
   * Compute adaptive bone gizmo scale with camera distance and pointer type.
   * Adjusts size based on camera zoom and input method for optimal precision.
   */
  private computeAdaptiveBoneScale(): number {
    const baseScale = this.computeBoneScale();

    // Scale based on camera distance
    const cameraDistance = this.controls ? this.controls.getDistance() : 5;
    const distanceMultiplier = Math.max(0.8, Math.min(1.5, cameraDistance / 5));

    // Input-specific multipliers
    let inputMultiplier = 1.0;
    if (this.pointerType === 'touch') {
      inputMultiplier = 1.5; // 50% larger for finger touch
    } else if (this.pointerType === 'pen') {
      inputMultiplier = 1.3; // 30% larger for stylus precision
    }

    return baseScale * distanceMultiplier * inputMultiplier;
  }

  private handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (!this.viewport) return;
    if (!this.dragActive) {
      this.dragActive = true;
      this.viewport.classList.add('drag-active');
    }
  };

  private handleDragLeave = () => {
    if (!this.viewport) return;
    this.dragActive = false;
    this.viewport.classList.remove('drag-active');
  };

  private handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    this.handleDragLeave();
    const file = event.dataTransfer?.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.vrm')) return;
    const buffer = await file.arrayBuffer();
    this.gltfLoader.parse(
      buffer,
      '',
      (gltf) => this.applyVrm(gltf),
      (err) => console.warn('VRM parse failed', err),
    );
  };

  private drawAxisWidget() {
    if (!this.axisCanvas) return;
    const ctx = this.axisCanvas.getContext('2d');
    if (!ctx) return;
    const size = this.axisCanvas.width;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(8,10,14,0.8)';
    ctx.fillRect(0, 0, size, size);
    const center = size / 2;
    const scale = size * 0.34;

    this.axisDrawInvQuat.copy(this.camera.quaternion).invert();
    const axes = [
      { name: 'X', dir: this.axisBasisX, color: '#ef4444', neg: '#7f1d1d' },
      { name: 'Y', dir: this.axisBasisY, color: '#22c55e', neg: '#14532d' },
      { name: 'Z', dir: this.axisBasisZ, color: '#3b82f6', neg: '#1e3a8a' },
    ];

    const drawAxis = (dir: THREE.Vector3, color: string, label: string) => {
      this.axisDrawVec.copy(dir).applyQuaternion(this.axisDrawInvQuat);
      const x = center + this.axisDrawVec.x * scale;
      const y = center - this.axisDrawVec.y * scale;
      const depth = this.axisDrawVec.z;
      ctx.strokeStyle = color;
      ctx.lineWidth = depth > 0 ? 2.4 : 1.4;
      ctx.beginPath();
      ctx.moveTo(center, center);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, depth > 0 ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '11px Space Grotesk, sans-serif';
      ctx.fillText(label, x + 4, y - 4);
    };

    for (const axis of axes) {
      drawAxis(axis.dir, axis.color, `+${axis.name}`);
      this.axisDrawNegVec.copy(axis.dir).multiplyScalar(-1);
      drawAxis(this.axisDrawNegVec, axis.neg, `-${axis.name}`);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(center, center, size * 0.42, 0, Math.PI * 2);
    ctx.stroke();
  }

  private collectBones() {
    if (!this.vrm) return;
    const bones: THREE.Object3D[] = [];
    const rawRoot = this.vrm.humanoid?.getRawBoneNode('hips');
    const root = rawRoot ?? this.vrm.scene;
    root.traverse((obj) => {
      if ((obj as THREE.Object3D).type === 'Bone') {
        bones.push(obj as THREE.Object3D);
      }
    });
    const humanoidNames = [
      'hips',
      'spine',
      'chest',
      'upperChest',
      'neck',
      'head',
      'leftShoulder',
      'leftUpperArm',
      'leftLowerArm',
      'leftHand',
      'rightShoulder',
      'rightUpperArm',
      'rightLowerArm',
      'rightHand',
      'leftUpperLeg',
      'leftLowerLeg',
      'leftFoot',
      'leftToes',
      'rightUpperLeg',
      'rightLowerLeg',
      'rightFoot',
      'rightToes',
      'leftThumbProximal',
      'leftThumbIntermediate',
      'leftThumbDistal',
      'leftIndexProximal',
      'leftIndexIntermediate',
      'leftIndexDistal',
      'leftMiddleProximal',
      'leftMiddleIntermediate',
      'leftMiddleDistal',
      'leftRingProximal',
      'leftRingIntermediate',
      'leftRingDistal',
      'leftLittleProximal',
      'leftLittleIntermediate',
      'leftLittleDistal',
      'rightThumbProximal',
      'rightThumbIntermediate',
      'rightThumbDistal',
      'rightIndexProximal',
      'rightIndexIntermediate',
      'rightIndexDistal',
      'rightMiddleProximal',
      'rightMiddleIntermediate',
      'rightMiddleDistal',
      'rightRingProximal',
      'rightRingIntermediate',
      'rightRingDistal',
      'rightLittleProximal',
      'rightLittleIntermediate',
      'rightLittleDistal',
    ];
    for (const name of humanoidNames) {
      const bone = this.vrm.humanoid?.getRawBoneNode(name as HumanBoneName);
      if (bone) {
        bone.userData.humanoidKey = name;
      }
    }
    bones.sort((a, b) => this.getBoneKey(a).localeCompare(this.getBoneKey(b)));
    this.bones = bones;
    this.boneByName.clear();
    this.boneByKey.clear();
    this.restPose.clear();
    for (let i = 0; i < bones.length; i += 1) {
      const bone = bones[i];
      if (!bone) continue;
      const key = this.getBoneKey(bone);
      const name = bone.name || key;
      if (!bone.name) bone.name = name;
      this.boneByName.set(name, bone);
      this.boneByKey.set(key, bone);
      this.restPose.set(bone.name, {
        pos: bone.position.clone(),
        quat: bone.quaternion.clone(),
      });
    }
    this.ensureBoneMarkers();
    this.refreshTimelineLabels();
  }

  private populateBoneList() {
    if (this.bones[0]) {
      this.setSelectedBone(this.bones[0]);
    }
    this.updateBoneList?.();
  }

  private getBoneKey(bone: THREE.Object3D) {
    const humanoid = bone.userData.humanoidKey as string | undefined;
    if (humanoid) return humanoid;
    if (bone.name) return bone.name;
    return this.buildBonePath(bone);
  }

  private buildBonePath(bone: THREE.Object3D) {
    const parts: string[] = [];
    let current: THREE.Object3D | null = bone;
    while (current && current.parent) {
      const parentObj = current.parent as THREE.Object3D;
      const index = parentObj.children.indexOf(current);
      const label = current.name ? current.name : `child${index}`;
      parts.unshift(label);
      if (parentObj.type === 'Scene') break;
      current = parentObj;
    }
    return parts.join('/');
  }

  private resetPose() {
    for (const bone of this.bones) {
      const rest = this.restPose.get(bone.name);
      if (!rest) continue;
      bone.position.copy(rest.pos);
      bone.quaternion.copy(rest.quat);
    }
  }

  private setSelectedBone(bone: THREE.Object3D | null) {
    this.selectedBone = bone;

    // Haptic feedback for bone selection (stylus/touch devices)
    if (bone && (this.pointerType === 'pen' || this.pointerType === 'touch')) {
      this.triggerHapticFeedback('light');
    }

    if (this.boneOverlay) {
      if (bone) {
        this.boneOverlay.classList.add('visible');
        const title = this.boneOverlay.querySelector('.bone-overlay-title');
        if (title) title.textContent = this.getBoneKey(bone);
        const rotX = this.boneOverlay.querySelector('[data-rot-x]') as HTMLInputElement;
        const rotY = this.boneOverlay.querySelector('[data-rot-y]') as HTMLInputElement;
        const rotZ = this.boneOverlay.querySelector('[data-rot-z]') as HTMLInputElement;
        rotX.value = bone.rotation.x.toFixed(2);
        rotY.value = bone.rotation.y.toFixed(2);
        rotZ.value = bone.rotation.z.toFixed(2);
        const posGroup = this.boneOverlay.querySelector('[data-pos-group]') as HTMLDivElement;
        const posX = this.boneOverlay.querySelector('[data-pos-x]') as HTMLInputElement;
        const posY = this.boneOverlay.querySelector('[data-pos-y]') as HTMLInputElement;
        const posZ = this.boneOverlay.querySelector('[data-pos-z]') as HTMLInputElement;
        const isRoot = this.getBoneKey(bone) === ROOT_BONE_KEY;
        posGroup.style.display = isRoot ? 'flex' : 'none';
        if (isRoot) {
          posX.value = bone.position.x.toFixed(2);
          posY.value = bone.position.y.toFixed(2);
          posZ.value = bone.position.z.toFixed(2);
        }
      } else {
        this.boneOverlay.classList.remove('visible');
      }
    }
    this.updateBoneMarkers();
    this.updateBoneList?.();
    this.refreshTimelineLabels();
    this.drawTimeline();
  }

  private stepFrame(direction: 1 | -1) {
    const frame = 1 / this.fps;
    this.isPlaying = false;
    this.time = THREE.MathUtils.clamp(this.time + direction * frame, 0, this.clip.duration);
    this.applyClipAtTime(this.time);
    this.updateTimeline();
  }

  private ensureBoneMarkers() {
    for (const marker of this.boneMarkers.values()) {
      this.scene.remove(marker);
    }
    this.boneMarkers.clear();
    this.boneMarkerObjects = [];

    // Keep marker meshes as invisible hit-targets for selection/snap behavior.
    // Visual joints are rendered by bone gizmos only to avoid duplicate spheres.
    const adaptiveScale = this.computeAdaptiveBoneScale();
    const geom = new THREE.SphereGeometry(adaptiveScale * 0.6, 16, 12);

    for (const bone of this.bones) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0,
      });
      const marker = new THREE.Mesh(geom, mat);
      marker.renderOrder = 0;
      marker.visible = this.boneVisualsVisible;
      marker.userData.boneName = bone.name;
      marker.userData.baseScale = adaptiveScale;
      this.scene.add(marker);
      this.boneMarkers.set(bone.name, marker);
      this.boneMarkerObjects.push(marker);
    }
  }

  private updateBoneMarkers() {
    if (!this.vrm) return;

    // Check for hover (snap to bone behavior for stylus)
    let hoveredBone: THREE.Object3D | null = null;
    if ((this.pointerType === 'pen' || this.pointerType === 'touch') && !this.dragActive) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObjects(this.boneMarkerObjects, false);
      if (hits[0]) {
        const boneName = hits[0].object.userData.boneName as string | undefined;
        if (boneName) {
          hoveredBone = this.boneByName.get(boneName) ?? null;
        }
      }
    }

    for (const bone of this.bones) {
      const marker = this.boneMarkers.get(bone.name);
      if (!marker) continue;

      bone.getWorldPosition(this.boneMarkerWorldPos);
      marker.position.copy(this.boneMarkerWorldPos);
      marker.scale.setScalar(bone === hoveredBone ? 1.4 : 1.0);
    }
  }

  private buildBoneGizmos() {
    if (!this.vrm) return;
    if (this.boneGizmoGroup) {
      this.scene.remove(this.boneGizmoGroup);
    }
    this.boneGizmoGroup = new THREE.Group();
    this.scene.add(this.boneGizmoGroup);
    this.boneGizmoGroup.visible = this.boneVisualsVisible;
    this.boneGizmos.clear();

    const jointGeom = new THREE.SphereGeometry(this.boneScale * 0.8, 16, 12);
    const stickGeom = new THREE.CylinderGeometry(this.boneScale * 0.2, this.boneScale * 0.2, 1, 10);
    for (const bone of this.bones) {
      const jointMat = new THREE.MeshBasicMaterial({ color: 0x93c5fd, depthTest: false });
      const stickMat = new THREE.MeshBasicMaterial({ color: 0x1d4ed8, depthTest: false });
      const joint = new THREE.Mesh(jointGeom, jointMat);
      const stick = new THREE.Mesh(stickGeom, stickMat);
      joint.renderOrder = 9;
      stick.renderOrder = 8;
      stick.visible = false;
      this.boneGizmoGroup.add(stick, joint);
      this.boneGizmos.set(bone.name, { joint, stick, parent: bone.parent as THREE.Object3D });
    }
  }

  private updateBoneGizmos() {
    if (!this.vrm || !this.boneGizmoGroup) return;
    const up = new THREE.Vector3(0, 1, 0);
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const stickQuat = new THREE.Quaternion();

    // Calculate pressure-based scale multiplier for gizmos
    const pressureScale =
      this.pointerType === 'pen' && this.pointerPressure > 0
        ? 1.0 + this.pointerPressure * 0.5 // Scale up to 1.5x with heavy pressure
        : 1.0;

    for (const bone of this.bones) {
      const gizmo = this.boneGizmos.get(bone.name);
      if (!gizmo) continue;
      bone.getWorldPosition(v0);
      gizmo.joint.position.copy(v0);

      const jointMat = gizmo.joint.material as THREE.MeshBasicMaterial;
      const isSelected = bone === this.selectedBone;

      // Enhanced color feedback for stylus interaction
      if (isSelected) {
        // Selected bone: orange/amber with pressure-based intensity
        if (this.pointerType === 'pen' && this.pointerPressure > 0) {
          const intensity = 0.6 + this.pointerPressure * 0.4;
          jointMat.color.setRGB(0.96 * intensity, 0.62 * intensity, 0.04 * intensity);
        } else {
          jointMat.color.set(0xf59e0b);
        }
        // Scale selected joint by pressure
        gizmo.joint.scale.setScalar(pressureScale);
      } else {
        // Unselected bones: light blue
        jointMat.color.set(0x93c5fd);
        gizmo.joint.scale.setScalar(1.0);
      }

      const parent = gizmo.parent;
      if (parent && parent.type === 'Bone') {
        parent.getWorldPosition(v1);
        dir.copy(v0).sub(v1);
        const len = dir.length();
        if (len > 0.001) {
          gizmo.stick.visible = true;
          gizmo.stick.position.copy(v1).addScaledVector(dir, 0.5);
          gizmo.stick.scale.set(1, len, 1);
          stickQuat.setFromUnitVectors(up, dir.normalize());
          gizmo.stick.quaternion.copy(stickQuat);
        } else {
          gizmo.stick.visible = false;
        }
      } else {
        gizmo.stick.visible = false;
      }
    }
  }

  private handleViewportPick = (event: PointerEvent) => {
    if (!this.viewport) return;
    this.sanitizeTransformControls();
    if (this.currentTab === 'level') {
      if (event.button === 2 && this.levelCameraMode === 'free') {
        event.preventDefault();
        this.startLevelFreeFly(event);
        return;
      }
      if (event.button !== 0) return;
      if (this.levelTransform?.dragging || this.isTransformGizmoActive(this.levelTransform)) {
        return;
      }
      if (this.dropLevelObjectAtPointer(event)) {
        return;
      }
      this.pickLevelObject(event);
      return;
    }

    // Capture stylus/pointer state
    this.pointerPressure = event.pressure ?? 0.5;
    this.pointerTiltX = event.tiltX ?? 0;
    this.pointerTiltY = event.tiltY ?? 0;
    this.pointerType = event.pointerType as 'mouse' | 'pen' | 'touch';
    this.isBarrelButtonPressed = event.button === 1 || event.buttons === 4; // Middle/barrel button

    // Palm rejection: reject touches with large contact area (likely palm)
    if (this.pointerType === 'touch') {
      const contactWidth = event.width ?? 0;
      const contactHeight = event.height ?? 0;
      const contactArea = contactWidth * contactHeight;
      // Reject if contact area is larger than typical finger (> 400 sq pixels)
      if (contactArea > 400) {
        return;
      }
    }

    // Barrel button shortcut: reset pose
    if (this.isBarrelButtonPressed && this.pointerType === 'pen') {
      this.resetPose();
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Adjust raycaster precision based on pointer type and pressure
    if (this.pointerType === 'pen' && this.pointerPressure > 0) {
      // Lighter pressure = more forgiving hit detection for stylus
      const pressureFactor = Math.max(0.5, 1 - this.pointerPressure * 0.3);
      this.raycaster.params.Points = { threshold: 0.1 * pressureFactor };
    } else if (this.pointerType === 'touch') {
      // Larger threshold for finger touch
      this.raycaster.params.Points = { threshold: 0.15 };
    } else {
      this.raycaster.params.Points = { threshold: 0.1 };
    }

    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Snap to bone behavior: if stylus/touch is near a bone, expand hit area
    if (this.pointerType === 'pen' || this.pointerType === 'touch') {
      const boneMarkerArray = Array.from(this.boneMarkers.values());
      const expandedHits = this.raycaster.intersectObjects(boneMarkerArray, false);

      // Check if any bone is within snap distance (in screen space)
      for (const hit of expandedHits) {
        const boneName = hit.object.userData.boneName as string | undefined;
        if (boneName && hit.distance < 100) {
          // 100 units in world space
          const bone = this.boneByName.get(boneName);
          if (bone) {
            // Visual feedback for snap
            this.triggerHapticFeedback('light');
            // Highlight logic is handled in updateBoneMarkers
          }
          break;
        }
      }
    }
    if (this.handleRagdollHandlePick(event)) {
      return;
    }
    if (this.ragdollDebugMeshes.length > 0) {
      const ragHits = this.raycaster.intersectObjects(this.ragdollDebugMeshes, false);
      if (ragHits[0]) {
        const name = ragHits[0].object.userData.ragdollName as string | undefined;
        if (name) {
          this.selectRagdoll(name);
          return;
        }
      }
    }
    const hits = this.raycaster.intersectObjects(Array.from(this.boneMarkers.values()), false);
    if (!hits[0]) return;
    const name = hits[0].object.userData.boneName as string | undefined;
    if (!name) return;
    const bone = this.boneByName.get(name) ?? null;
    this.setSelectedBone(bone);
  };

  private handleRagdollHandlePick(event: PointerEvent) {
    if (!this.viewport || !this.ragdollHandles) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.ragdollHandles.children, false);
    if (!hits[0]) return false;
    const handle = hits[0].object.userData.handle as 'start' | 'end' | undefined;
    if (!handle) return false;
    this.ragdollHandleActive = handle;
    return true;
  }

  private selectRagdoll(name: string) {
    this.selectedRagdoll = name;
    const mesh = this.ragdollDebugMeshes.find((item) => item.userData.ragdollName === name) ?? null;
    if (this.ragdollTransform) {
      if (mesh && mesh.parent) {
        this.ragdollTransform.attach(mesh);
        setTransformControlsVisible(this.ragdollTransform, true);
      } else {
        this.ragdollTransform.detach();
        setTransformControlsVisible(this.ragdollTransform, false);
      }
    }
    if (mesh && mesh.parent) {
      this.ensureRagdollHandles();
    }
  }

  private ensureRagdollHandles() {
    if (!this.selectedRagdoll) return;
    const rag = this.ragdollBones.get(this.selectedRagdoll);
    if (!rag || !rag.axis || !rag.baseLength || !rag.basePos) return;
    if (!this.ragdollHandles) {
      this.ragdollHandles = new THREE.Group();
      this.scene.add(this.ragdollHandles);
    }
    this.ragdollHandles.clear();
    const handleGeom = new THREE.SphereGeometry(0.05, 12, 8);
    const handleMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false });
    const start = new THREE.Mesh(handleGeom, handleMat);
    const end = new THREE.Mesh(handleGeom, handleMat);
    start.renderOrder = 12;
    end.renderOrder = 12;
    start.userData.handle = 'start';
    end.userData.handle = 'end';
    this.ragdollHandles.add(start, end);
    this.updateRagdollHandles();
  }

  private updateRagdollHandles() {
    if (!this.ragdollHandles || !this.selectedRagdoll) return;
    const rag = this.ragdollBones.get(this.selectedRagdoll);
    if (!rag || !rag.body || !rag.axis || !rag.baseLength) return;
    const center = rag.body.translation();
    const rot = rag.body.rotation();
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(
      new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w),
    );
    const half = rag.baseLength * 0.5 * (this.playerConfig.ragdollRig[rag.name]?.lengthScale ?? 1);
    const startPos = new THREE.Vector3(center.x, center.y, center.z).addScaledVector(axis, -half);
    const endPos = new THREE.Vector3(center.x, center.y, center.z).addScaledVector(axis, half);
    const start = this.ragdollHandles.children.find((c) => c.userData.handle === 'start');
    const end = this.ragdollHandles.children.find((c) => c.userData.handle === 'end');
    if (start) start.position.copy(startPos);
    if (end) end.position.copy(endPos);
  }

  private handleRagdollDrag = (event: PointerEvent) => {
    if (!this.viewport || !this.ragdollHandles || !this.selectedRagdoll) return;
    if (!this.ragdollHandleActive) return;

    // Update stylus state during drag
    this.pointerPressure = event.pressure ?? 0.5;
    this.pointerTiltX = event.tiltX ?? 0;
    this.pointerTiltY = event.tiltY ?? 0;
    this.pointerType = event.pointerType as 'mouse' | 'pen' | 'touch';

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const rag = this.ragdollBones.get(this.selectedRagdoll);
    if (!rag || !rag.body || !rag.baseLength) return;
    const center = rag.body.translation();
    const rot = rag.body.rotation();
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(
      new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w),
    );
    this.ragdollHandleLine.set(
      new THREE.Vector3(center.x, center.y, center.z).addScaledVector(axis, -10),
      new THREE.Vector3(center.x, center.y, center.z).addScaledVector(axis, 10),
    );
    this.ragdollHandleRay.origin.copy(this.raycaster.ray.origin);
    this.ragdollHandleRay.direction.copy(this.raycaster.ray.direction);
    const closest = this.closestPointOnLineToRay(
      this.ragdollHandleLine,
      this.ragdollHandleRay,
      this.ragdollHandleTemp,
    );
    const half = new THREE.Vector3(center.x, center.y, center.z).distanceTo(closest);

    // Apply pressure-based sensitivity: lighter pressure = finer control
    let pressureMultiplier = 1.0;
    if (this.pointerType === 'pen' && this.pointerPressure > 0) {
      // Map pressure (0-1) to multiplier (0.3-1.0)
      // Light pressure gives fine control, heavy pressure gives coarse control
      pressureMultiplier = 0.3 + this.pointerPressure * 0.7;
    }

    const rawLengthScale = (half * 2) / rag.baseLength;
    const adjustedLengthScale = 1.0 + (rawLengthScale - 1.0) * pressureMultiplier;
    const lengthScale = Math.max(0.3, Math.min(2.0, adjustedLengthScale));

    const cfg = this.playerConfig.ragdollRig[rag.name] ?? { radiusScale: 1, lengthScale: 1 };
    cfg.lengthScale = lengthScale;
    this.playerConfig.ragdollRig[rag.name] = cfg;
    this.updateRagdollHandles();
  };

  private handleRagdollDragEnd = (event: PointerEvent) => {
    if (!this.ragdollHandleActive) return;
    this.ragdollHandleActive = null;
    this.buildRagdoll();
    this.updateRagdollHandles();
  };

  private detachRagdollTransform() {
    if (!this.ragdollTransform) return;
    this.ragdollTransform.detach();
    setTransformControlsVisible(this.ragdollTransform, false);
    this.selectedRagdoll = null;
  }

  private sanitizeTransformControls() {
    const sanitize = (control: TransformControls | null) => {
      if (!control) return;
      const target = transformControlsInternal(control).object;
      if (!target || !target.parent) {
        control.detach();
        setTransformControlsVisible(control, false);
      }
    };
    sanitize(this.ragdollTransform);
    sanitize(this.levelTransform);
  }

  private resizeRenderer() {
    if (!this.viewport) return;
    const rect = this.viewport.getBoundingClientRect();
    const width = rect.width || window.innerWidth;
    const height = rect.height || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private refreshTimelineLabels() {
    if (!this.timelineHeader) return;
    this.timelineHeader.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'timeline-row header';
    const bone = this.selectedBone ?? this.bones[0];
    const label = bone ? this.getBoneKey(bone) : 'none';
    header.innerHTML = `<span>Bone</span><span class="timeline-scale">${label}</span>`;
    this.timelineHeader.appendChild(header);
  }

  private async loadMixamoFile(
    file: File,
    select: HTMLSelectElement,
    status: HTMLElement,
    previewStatus?: HTMLElement,
  ) {
    if (!this.vrm) return;
    const arrayBuffer = await file.arrayBuffer();
    const object = this.fbxLoader.parse(arrayBuffer, '');
    const clips = Array.isArray(object.animations) ? object.animations : [];
    if (clips.length === 0) {
      status.textContent = 'FBX: no animation found';
      return;
    }
    const source: MixamoEntry['source'] = (() => {
      const names = new Set<string>();
      object.traverse((node) => {
        const raw = node.name?.toLowerCase?.() ?? '';
        if (raw) names.add(raw);
      });
      if ([...names].some((n) => n.includes('mixamorig'))) return 'mixamo';
      return 'generic';
    })();

    let loaded = 0;
    const baseName = file.name.replace(/\.fbx$/i, '');
    const ensureUniqueName = (candidate: string) => {
      let name = candidate;
      let i = 2;
      while (this.mixamoEntries.some((entry) => entry.name === name)) {
        name = `${candidate}_${i}`;
        i += 1;
      }
      return name;
    };
    for (const [index, clip] of clips.entries()) {
      const clipName = (clip.name || '').trim();
      const entryName = ensureUniqueName(
        clipName && clipName.toLowerCase() !== 'take 001'
          ? `${baseName}_${clipName.replace(/\s+/g, '_')}`
          : clips.length > 1
            ? `${baseName}_clip_${index + 1}`
            : baseName,
      );
      const entry: MixamoEntry = {
        name: entryName,
        clip,
        rig: object,
        source,
      };
      this.mixamoEntries.push(entry);
      const option = document.createElement('option');
      option.value = entry.name;
      option.textContent = entry.name;
      option.dataset.source = source;
      select.appendChild(option);
      loaded += 1;
      if (!select.value) select.value = entry.name;
    }
    status.textContent = `FBX: loaded ${loaded} clip${loaded > 1 ? 's' : ''} from ${baseName} (${source})`;
    if (previewStatus && this.currentMixamo == null && select.value) {
      this.previewMixamo(select.value, previewStatus);
    }
  }

  private previewMixamo(name: string, status: HTMLElement) {
    if (!this.vrm || !name) return;
    const entry = this.mixamoEntries.find((item) => item.name === name);
    if (!entry) return;
    this.resetPose();
    this.disableRagdoll();
    if (!this.mixer) this.mixer = new THREE.AnimationMixer(this.vrm.scene);
    this.stopMixamoPreview();
    const retargeted = retargetMixamoClip(
      { clip: entry.clip, rig: entry.rig },
      this.vrm,
      'editor',
      {
        includePosition: false,
      },
    );
    this.retargetedClip = retargeted;
    this.retargetedName = retargeted.name;
    this.currentMixamo = this.mixer.clipAction(retargeted);
    this.currentMixamo.setLoop(THREE.LoopRepeat, Infinity);
    this.currentMixamo.play();
    status.textContent = `FBX: preview ${entry.name} (${entry.source})`;
  }

  private stopMixamoPreview() {
    if (this.currentMixamo) {
      this.currentMixamo.stop();
      this.currentMixamo = null;
    }
  }

  private bakeMixamoToClip(name: string, jsonBox: HTMLTextAreaElement, status: HTMLElement) {
    if (!this.vrm || !name) return;
    const entry = this.mixamoEntries.find((item) => item.name === name);
    if (!entry) return;
    this.pushUndo();
    if (!this.mixer) this.mixer = new THREE.AnimationMixer(this.vrm.scene);
    this.stopMixamoPreview();
    this.disableRagdoll();
    const retargeted = retargetMixamoClip(
      { clip: entry.clip, rig: entry.rig },
      this.vrm,
      'editor',
      {
        includePosition: false,
      },
    );
    this.retargetedClip = retargeted;
    this.retargetedName = retargeted.name;
    const action = this.mixer.clipAction(retargeted);
    action.play();
    action.paused = true;
    const frames: BoneFrame[] = [];
    const rawDuration = Math.min(MAX_DURATION, retargeted.duration);
    const totalFrames = Math.max(1, Math.round(rawDuration * this.fps));
    const duration = totalFrames / this.fps;
    for (let f = 0; f <= totalFrames; f += 1) {
      const t = Math.min(duration, this.getFrameTime(f));
      action.time = t;
      this.mixer.update(0);
      const bones: Record<string, { x: number; y: number; z: number; w: number }> = {};
      for (const bone of this.bones) {
        const q = bone.quaternion;
        bones[this.getBoneKey(bone)] = { x: q.x, y: q.y, z: q.z, w: q.w };
      }
      const root = this.boneByKey.get(ROOT_BONE_KEY);
      const rootPos = root
        ? { x: root.position.x, y: root.position.y, z: root.position.z }
        : undefined;
      frames.push({ time: t, bones, rootPos });
    }
    action.stop();
    this.clip = { duration, frames };
    this.normalizeClipToFrameGrid();
    this.time = 0;
    this.overrideRangeStartFrame = 0;
    this.overrideRangeEndFrame = Math.max(0, this.getTotalFrames() - 1);
    this.rebuildClipKeyMap();
    this.updateTimeline();
    this.refreshJson(jsonBox);
    this.drawTimeline();
    const durationInput = this.hud.querySelector('[data-duration]') as HTMLInputElement;
    const timeInput = this.hud.querySelector('[data-time]') as HTMLInputElement;
    const overrideRangeWrap = this.hud.querySelector('[data-override-range]') as HTMLDivElement;
    const overrideStartHandle = this.hud.querySelector(
      '[data-override-start-handle]',
    ) as HTMLDivElement;
    const overrideEndHandle = this.hud.querySelector(
      '[data-override-end-handle]',
    ) as HTMLDivElement;
    if (durationInput) durationInput.value = String(this.getTotalFrames());
    if (timeInput) {
      timeInput.max = duration.toFixed(4);
      timeInput.step = (1 / this.fps).toFixed(4);
    }
    this.syncOverrideRangeUi(
      overrideRangeWrap,
      overrideStartHandle,
      overrideEndHandle,
      this.overrideMode,
    );
    status.textContent = `FBX: baked ${entry.name} (${entry.source})`;
  }

  private buildAnimationClip() {
    return buildAnimationClipFromData(`editor_${this.retargetedName}`, this.clip, {
      rootKey: ROOT_BONE_KEY,
    });
  }

  private getRagdollMuscleConfig() {
    const cfg = this.playerConfig.ragdollMuscle ?? {};
    return {
      enabled: cfg.enabled ?? false,
      stiffness: Number(cfg.stiffness ?? 70),
      damping: Number(cfg.damping ?? 16),
      maxTorque: Number(cfg.maxTorque ?? 70),
    };
  }

  private getActiveRagdollDriveForBone(
    name: string,
  ): { group: 'core' | 'neck' | 'arm' | 'leg'; stiffness: number; damping: number; forceLimit: number } {
    return getRagdollDriveForBone(name);
  }

  private getRagdollSimConfig() {
    const cfg = this.playerConfig.ragdollSim ?? {};
    return {
      jointStiffnessScale: Number(cfg.jointStiffnessScale ?? 1),
      jointDampingScale: Number(cfg.jointDampingScale ?? 1),
      bodyLinearDampingScale: Number(cfg.bodyLinearDampingScale ?? 1),
      bodyAngularDampingScale: Number(cfg.bodyAngularDampingScale ?? 1),
      groundFriction: Number(cfg.groundFriction ?? 2.2),
      bodyFriction: Number(cfg.bodyFriction ?? 1.6),
      maxSubsteps: Number(cfg.maxSubsteps ?? 4),
      substepHz: Number(cfg.substepHz ?? 90),
      limitBlend: Number(cfg.limitBlend ?? 0.45),
      linearBleed: Number(cfg.linearBleed ?? 0.985),
      angularBleed: Number(cfg.angularBleed ?? 0.88),
      groundSlideDamping: Number(cfg.groundSlideDamping ?? 0.92),
      groundSlideYThreshold: Number(cfg.groundSlideYThreshold ?? 0.5),
      groundSlideDeadzone: Number(cfg.groundSlideDeadzone ?? 0.08),
      maxLinearVelocity: Number(cfg.maxLinearVelocity ?? 16),
      maxAngularVelocity: Number(cfg.maxAngularVelocity ?? 12),
      startImpulseY: Number(cfg.startImpulseY ?? -0.35),
    };
  }

  private async ensureRapier() {
    if (this.rapierReady) return this.rapierReady;
    this.rapierReady = import('@dimforge/rapier3d-compat')
      .then(async (mod) => {
        await mod.init();
        this.rapier = mod;
      })
      .catch((err) => console.warn('Rapier init failed', err));
    return this.rapierReady;
  }

  private async toggleRagdoll(status?: HTMLElement) {
    if (!this.vrm) return;
    if (this.ragdollEnabled) {
      this.disableRagdoll();
      if (status) status.textContent = 'Ragdoll: off';
      this.resetPose();
      return;
    }
    await this.ensureRapier();
    if (!this.rapier) return;
    this.stopMixamoPreview();
    this.buildRagdoll();
    this.ragdollEnabled = true;
    this.ragdollVisible = true;
    this.ragdollMode = 'ragdoll';
    this.ragdollActivationTime = 0;
    this.isPlaying = false;
    if (status) status.textContent = 'Ragdoll: on';
  }

  private disableRagdoll() {
    this.detachRagdollTransform();
    this.ragdollEnabled = false;
    this.ragdollRecording = false;
    this.ragdollMode = 'off';
    this.ragdollControlKeys.clear();
    this.ragdollActivationTime = 0;
    this.ragdollWorld = null;
    this.ragdollBones.clear();
    this.ragdollVisible = false;
    for (const mesh of this.ragdollDebugMeshes) {
      this.scene.remove(mesh);
    }
    this.ragdollDebugMeshes = [];
    if (this.ragdollHandles) this.ragdollHandles.visible = false;
  }

  private async toggleRagdollVisual(status?: HTMLElement) {
    if (!this.vrm) return;
    if (this.ragdollVisible) {
      this.ragdollVisible = false;
      this.detachRagdollTransform();
      for (const mesh of this.ragdollDebugMeshes) {
        mesh.visible = false;
      }
      if (this.ragdollHandles) this.ragdollHandles.visible = false;
      if (!this.ragdollEnabled) this.ragdollMode = 'off';
      if (status) status.textContent = this.ragdollEnabled ? 'Ragdoll: on' : 'Ragdoll: off';
      return;
    }
    await this.ensureRapier();
    if (!this.rapier) return;
    if (!this.ragdollWorld || this.ragdollDebugMeshes.length === 0) {
      this.buildRagdoll();
      if (!this.ragdollEnabled) {
        // keep physics paused when only visualizing
        for (const body of this.ragdollBones.values()) {
          body.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
          body.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        }
      }
    }
    this.ragdollVisible = true;
    if (!this.ragdollEnabled) this.ragdollMode = 'reactive';
    for (const mesh of this.ragdollDebugMeshes) {
      mesh.visible = true;
    }
    if (this.ragdollHandles) this.ragdollHandles.visible = true;
    if (status) status.textContent = this.ragdollEnabled ? 'Ragdoll: on' : 'Ragdoll: visual';
  }

  private resetRagdollPose() {
    if (!this.ragdollWorld || this.ragdollBones.size === 0) {
      if (this.vrm) this.resetPose();
      return;
    }
    for (const rag of this.ragdollBones.values()) {
      const pos = rag.bone.getWorldPosition(new THREE.Vector3());
      const rot = rag.bone.getWorldQuaternion(new THREE.Quaternion());
      rag.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
      rag.body.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }, true);
      rag.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rag.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (this.vrm) {
      const hips = this.vrm.humanoid.getRawBoneNode('hips');
      if (hips)
        this.hipsOffset
          .copy(hips.getWorldPosition(new THREE.Vector3()))
          .sub(this.vrm.scene.position);
    }
    this.ragdollActivationTime = 0;
  }

  private buildRagdoll() {
    if (!this.vrm || !this.rapier) return;
    this.detachRagdollTransform();
    const RAPIER = this.rapier;
    const sim = this.getRagdollSimConfig();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.ragdollWorld = world;
    const ground = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
    const groundBody = world.createRigidBody(ground);
    const groundCollider = RAPIER.ColliderDesc.cuboid(25, 0.5, 25)
      .setTranslation(0, -0.5, 0)
      .setFriction(Math.max(0, sim.groundFriction))
      .setRestitution(0);
    if (RAPIER.CoefficientCombineRule) {
      groundCollider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max);
    }
    world.createCollider(groundCollider, groundBody);
    this.ragdollBones.clear();
    for (const mesh of this.ragdollDebugMeshes) {
      this.scene.remove(mesh);
    }
    this.ragdollDebugMeshes = [];
    const humanoid = this.vrm.humanoid;
    const getBone = (name: string) =>
      humanoid.getRawBoneNode(name as HumanBoneName) ?? this.boneByKey.get(name) ?? null;
    const tmpVec = new THREE.Vector3();
    const tmpVec2 = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const boneQuat = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const jointStiffness = 40;
    const jointDamping = 13;
    const spineStiffness = 58;
    const spineDamping = 16;
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
    const jointTuning: Record<string, { stiffness: number; damping: number }> = {
      spine: { stiffness: 58, damping: 16 },
      chest: { stiffness: 58, damping: 16 },
      upperChest: { stiffness: 56, damping: 16 },
      neck: { stiffness: 45, damping: 14 },
      head: { stiffness: 40, damping: 13 },
      leftUpperArm: { stiffness: 32, damping: 12 },
      rightUpperArm: { stiffness: 32, damping: 12 },
      leftLowerArm: { stiffness: 34, damping: 12 },
      rightLowerArm: { stiffness: 34, damping: 12 },
      leftHand: { stiffness: 24, damping: 10 },
      rightHand: { stiffness: 24, damping: 10 },
      leftUpperLeg: { stiffness: 44, damping: 14 },
      rightUpperLeg: { stiffness: 44, damping: 14 },
      leftLowerLeg: { stiffness: 46, damping: 14 },
      rightLowerLeg: { stiffness: 46, damping: 14 },
      leftFoot: { stiffness: 30, damping: 11 },
      rightFoot: { stiffness: 30, damping: 11 },
    };
    const fallbackBallJointLimits: Record<string, { swingDeg: number; twistDeg: number }> = {
      spine: { swingDeg: 20, twistDeg: 20 },
      chest: { swingDeg: 22, twistDeg: 22 },
      upperChest: { swingDeg: 25, twistDeg: 28 },
      neck: { swingDeg: 35, twistDeg: 40 },
      head: { swingDeg: 45, twistDeg: 55 },
      leftUpperArm: { swingDeg: 105, twistDeg: 80 },
      rightUpperArm: { swingDeg: 105, twistDeg: 80 },
      leftHand: { swingDeg: 35, twistDeg: 35 },
      rightHand: { swingDeg: 35, twistDeg: 35 },
      leftUpperLeg: { swingDeg: 95, twistDeg: 50 },
      rightUpperLeg: { swingDeg: 95, twistDeg: 50 },
      leftFoot: { swingDeg: 35, twistDeg: 20 },
      rightFoot: { swingDeg: 35, twistDeg: 20 },
    };
    const spineJointChildren = new Set(['spine', 'chest', 'upperChest', 'neck', 'head']);

    const rootBone = getBone('hips');
    if (rootBone) {
      rootBone.getWorldPosition(tmpVec);
      this.hipsOffset.copy(tmpVec).sub(this.vrm.scene.position);
    }

    for (const segment of RAGDOLL_SEGMENT_PROFILE) {
      const rigCfg = (this.playerConfig.ragdollRig[segment.name] ?? {}) as {
        radiusScale?: number;
        lengthScale?: number;
        sourceBone?: string;
        childBone?: string;
        offset?: Vec3;
        rot?: Vec3;
        swingLimit?: number;
        twistLimit?: number;
      };
      const sourceBoneName = rigCfg.sourceBone?.trim();
      const childBoneName = rigCfg.childBone?.trim();
      const bone = getBone(sourceBoneName || segment.bone);
      if (!bone) continue;
      const child = resolveRagdollSegmentChildBone({
        segmentName: segment.name,
        sourceBone: bone,
        preferredChildBone: childBoneName || segment.childBone,
        jointProfileChildBone: RAGDOLL_JOINT_PROFILE.find((entry) => entry.parent === segment.name)
          ?.child,
        getBone,
      });
      const lengthScale = Math.max(0.3, Number(rigCfg.lengthScale ?? 1));
      const radiusScale = Math.max(0.3, Number(rigCfg.radiusScale ?? 1));
      bone.getWorldPosition(tmpVec);
      bone.getWorldQuaternion(boneQuat);
      child?.getWorldPosition(tmpVec2);
      const rotationOffset = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          Number(rigCfg.rot?.x ?? 0),
          Number(rigCfg.rot?.y ?? 0),
          Number(rigCfg.rot?.z ?? 0),
        ),
      );
      const segmentFrame = computeRagdollSegmentFrame({
        segment,
        bonePosition: tmpVec,
        boneQuaternion: boneQuat,
        childPosition: child ? tmpVec2 : null,
        rigOffsetLocal: new THREE.Vector3(
          Number(rigCfg.offset?.x ?? 0),
          Number(rigCfg.offset?.y ?? 0),
          Number(rigCfg.offset?.z ?? 0),
        ),
        rigRotationOffset: rotationOffset,
      });
      const axis = segmentFrame.axis;
      const center = segmentFrame.center;
      tmpQuat.copy(segmentFrame.bodyQuaternion);
      const bodyToBone = tmpQuat.clone().invert().multiply(boneQuat);
      const linearDamping = 0.5 * Math.max(0, sim.bodyLinearDampingScale);
      const angularDamping = 1.5 * Math.max(0, sim.bodyAngularDampingScale);
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setRotation({ x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w })
        .setLinearDamping(linearDamping)
        .setAngularDamping(angularDamping)
        .setCanSleep(true)
        .setCcdEnabled(true);
      const body = world.createRigidBody(bodyDesc);
      const membership = getRagdollBodyGroup(segment.name);
      const filter = RAGDOLL_COLLISION_GROUP_ENV | (RAGDOLL_ALL_BODY_GROUPS & ~membership);
      const collider =
        segment.shape === 'sphere'
          ? RAPIER.ColliderDesc.ball(
              (segment.dimensions as { radius: number }).radius * radiusScale,
            ).setCollisionGroups((membership << 16) | filter)
          : RAPIER.ColliderDesc.cuboid(
              ((segment.dimensions as { width: number }).width * radiusScale) / 2,
              ((segment.dimensions as { height: number }).height * lengthScale) / 2,
              ((segment.dimensions as { depth: number }).depth * radiusScale) / 2,
            ).setCollisionGroups((membership << 16) | filter);
      collider
        .setMass(Math.max(0.1, segment.mass))
        .setFriction(Math.max(0, sim.bodyFriction))
        .setRestitution(0);
      if (RAPIER.CoefficientCombineRule) {
        collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max);
      }
      world.createCollider(collider, body);
      const debugMat = new THREE.MeshBasicMaterial({
        color: 0x6ee7b7,
        wireframe: true,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      const debugMesh =
        segment.shape === 'sphere'
          ? new THREE.Mesh(
              new THREE.SphereGeometry(
                (segment.dimensions as { radius: number }).radius * radiusScale,
                8,
                8,
              ),
              debugMat,
            )
          : new THREE.Mesh(
              new THREE.BoxGeometry(
                (segment.dimensions as { width: number }).width * radiusScale,
                (segment.dimensions as { height: number }).height * lengthScale,
                (segment.dimensions as { depth: number }).depth * radiusScale,
              ),
              debugMat,
            );
      debugMesh.renderOrder = 12;
      debugMesh.userData.ragdollName = segment.name;
      debugMesh.visible = this.ragdollEnabled || this.ragdollVisible;
      debugMesh.position.copy(center);
      debugMesh.quaternion.copy(tmpQuat);
      this.scene.add(debugMesh);
      this.ragdollDebugMeshes.push(debugMesh);
      const radius =
        segment.shape === 'sphere'
          ? (segment.dimensions as { radius: number }).radius * radiusScale
          : ((segment.dimensions as { height: number }).height * lengthScale) * 0.5;
      const ragBone: RagdollBone = {
        name: segment.name,
        driveGroup: this.getActiveRagdollDriveForBone(segment.name).group,
        bone,
        child,
        body,
        bodyToBone,
        muscleScale: muscleScaleByBone[segment.name] ?? 1,
        baseLength:
          segment.shape === 'sphere'
            ? (segment.dimensions as { radius: number }).radius * 2 * lengthScale
            : (segment.dimensions as { height: number }).height * lengthScale,
        radius,
        settleTime: 0,
        axis,
        basePos: center.clone(),
        baseRot: tmpQuat.clone(),
        boneWorldQuat: boneQuat.clone(),
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
      const profileSocketLimit =
        jointProfile?.type === 'socket'
          ? {
              swingDeg: Math.max(
                Number(jointProfile.limitYDeg ?? 0),
                Number(jointProfile.limitZDeg ?? 0),
              ),
              twistDeg: Math.max(
                Math.abs(Number(jointProfile.twistMinDeg ?? 0)),
                Math.abs(Number(jointProfile.twistMaxDeg ?? 0)),
              ),
            }
          : null;
      const ballLimit = profileSocketLimit ?? fallbackBallJointLimits[segment.name];
      if (ballLimit) {
        ragBone.swingLimitRad = THREE.MathUtils.degToRad(
          Number(rigCfg.swingLimit ?? ballLimit.swingDeg),
        );
        ragBone.twistLimitRad = THREE.MathUtils.degToRad(
          Number(rigCfg.twistLimit ?? ballLimit.twistDeg),
        );
        const parentName = RAGDOLL_BONE_DEFS.find((def) => def.name === segment.name)?.parent;
        if (parentName) {
          const parentBone = getBone(parentName);
          if (parentBone) {
            const parentWorldQuat = parentBone.getWorldQuaternion(new THREE.Quaternion());
            ragBone.twistAxisLocal = axis.clone().applyQuaternion(parentWorldQuat.invert()).normalize();
          }
        }
      }
      this.ragdollBones.set(segment.name, ragBone);
    }
    const pelvis = this.ragdollBones.get('hips');
    if (pelvis) {
      pelvis.body.applyImpulse({ x: 0, y: sim.startImpulseY, z: 0 }, true);
    }

    for (const jointDef of RAGDOLL_JOINT_PROFILE) {
      const childBone = this.ragdollBones.get(jointDef.child);
      const parentBone = this.ragdollBones.get(jointDef.parent);
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
      const isSpineJoint = spineJointChildren.has(jointDef.child);
      const preset = jointTuning[jointDef.child];
      const stiffnessBase =
        jointDef.stiffness ?? preset?.stiffness ?? (isSpineJoint ? spineStiffness : jointStiffness);
      const dampingBase =
        jointDef.damping ?? preset?.damping ?? (isSpineJoint ? spineDamping : jointDamping);
      const stiffness = stiffnessBase * Math.max(0, sim.jointStiffnessScale);
      const damping = dampingBase * Math.max(0, sim.jointDampingScale);
      let jointData: RAPIER.JointData;
      if (hinge) {
        const axis = new RAPIER.Vector3(hinge.axis[0], hinge.axis[1], hinge.axis[2]);
        jointData = RAPIER.JointData.revolute(anchor1, anchor2, axis);
      } else {
        jointData = RAPIER.JointData.spherical(anchor1, anchor2);
      }
      jointData.stiffness = stiffness;
      jointData.damping = damping;
      const joint = world.createImpulseJoint(jointData, parentBody, childBody, true);
      if (hinge) {
        (joint as RevoluteJointLike).setLimits?.(hinge.min, hinge.max);
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

  private stepRagdoll(delta: number) {
    if (!this.ragdollWorld || !this.rapier || !this.vrm) return;
    this.ragdollActivationTime += delta;
    const sim = this.getRagdollSimConfig();
    this.applyRagdollSteering(delta);
    this.applyRagdollMuscles(delta);
    const clampedDelta = THREE.MathUtils.clamp(delta, 1 / 180, 1 / 20);
    const maxSubsteps = Math.max(1, Math.min(8, Math.round(sim.maxSubsteps)));
    const substepHz = THREE.MathUtils.clamp(sim.substepHz, 30, 240);
    const substeps = Math.max(1, Math.min(maxSubsteps, Math.ceil(clampedDelta / (1 / substepHz))));
    const stepDt = clampedDelta / substeps;
    this.ragdollWorld.timestep = stepDt;
    for (let i = 0; i < substeps; i += 1) {
      this.ragdollWorld.step();
    }
    const parentQuat = new THREE.Quaternion();
    const parentQuatInv = new THREE.Quaternion();
    const currentWorldQuat = new THREE.Quaternion();
    const childQuat = new THREE.Quaternion();
    const relQuat = new THREE.Quaternion();
    const twistQuat = new THREE.Quaternion();
    const swingQuat = new THREE.Quaternion();
    const clampedRelQuat = new THREE.Quaternion();
    const childPos = new THREE.Vector3();
    const childAng = new THREE.Vector3();
    const axisLocal = new THREE.Vector3();
    const twistVec = new THREE.Vector3();
    // Hard-clamp anatomical joints so they cannot exceed human ranges.
    for (const ragBone of this.ragdollBones.values()) {
      if (!ragBone.parent) continue;
      const isSleeping = (ragBone.body as SleepingBodyLike).isSleeping?.() ?? false;
      if (isSleeping) continue;
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
      currentWorldQuat.slerp(childQuat, THREE.MathUtils.clamp(sim.limitBlend, 0, 1)).normalize();
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
    // Safety clamps: cap runaway velocities that cause floor tunneling and flailing spirals.
    const maxLinVel = Math.max(0.1, sim.maxLinearVelocity);
    const maxAngVel = Math.max(0.1, sim.maxAngularVelocity);
    const lin = new THREE.Vector3();
    const ang = new THREE.Vector3();
    for (const ragBone of this.ragdollBones.values()) {
      const lv = ragBone.body.linvel();
      lin.set(lv.x, lv.y, lv.z);
      if (Math.abs(lin.y) < Math.max(0, sim.groundSlideYThreshold)) {
        lin.x *= THREE.MathUtils.clamp(sim.groundSlideDamping, 0, 1);
        lin.z *= THREE.MathUtils.clamp(sim.groundSlideDamping, 0, 1);
      }
      if (Math.hypot(lin.x, lin.z) < Math.max(0, sim.groundSlideDeadzone)) {
        lin.x = 0;
        lin.z = 0;
      }
      lin.multiplyScalar(THREE.MathUtils.clamp(sim.linearBleed, 0, 1));
      ragBone.body.setLinvel({ x: lin.x, y: lin.y, z: lin.z }, false);
      const linLen = lin.length();
      if (linLen > maxLinVel) {
        lin.multiplyScalar(maxLinVel / linLen);
        ragBone.body.setLinvel({ x: lin.x, y: lin.y, z: lin.z }, false);
      }
      const av = ragBone.body.angvel();
      ang.set(av.x, av.y, av.z);
      ang.multiplyScalar(THREE.MathUtils.clamp(sim.angularBleed, 0, 1));
      ragBone.body.setAngvel({ x: ang.x, y: ang.y, z: ang.z }, false);
      const angLen = ang.length();
      if (angLen > maxAngVel) {
        ang.multiplyScalar(maxAngVel / angLen);
        ragBone.body.setAngvel({ x: ang.x, y: ang.y, z: ang.z }, false);
      }
      const settleLin = Math.hypot(lin.x, lin.z);
      const settleY = Math.abs(lin.y);
      const settleAng = ang.length();
      if (settleLin < 0.05 && settleY < 0.06 && settleAng < 0.08) {
        ragBone.settleTime = (ragBone.settleTime ?? 0) + clampedDelta;
      } else {
        ragBone.settleTime = 0;
      }
      if ((ragBone.settleTime ?? 0) > 0.35) {
        ragBone.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        ragBone.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        ragBone.body.sleep();
      }
    }
    const parentWorld = new THREE.Quaternion();
    const invParent = new THREE.Quaternion();
    const bodyQuat = new THREE.Quaternion();
    const targetWorld = new THREE.Quaternion();
    const bodyPos = new THREE.Vector3();
    for (const ragBone of this.ragdollBones.values()) {
      const { bone, body } = ragBone;
      const rot = body.rotation();
      bodyQuat.set(rot.x, rot.y, rot.z, rot.w);
      targetWorld.copy(bodyQuat);
      if (ragBone.bodyToBone) {
        targetWorld.multiply(ragBone.bodyToBone);
      }
      if (bone.parent) {
        bone.parent.getWorldQuaternion(parentWorld);
        invParent.copy(parentWorld).invert();
        const rel = invParent.clone().multiply(targetWorld);
        bone.quaternion.copy(rel);
      } else {
        bone.quaternion.copy(targetWorld);
      }
    }
    this.vrm.scene.updateMatrixWorld(true);
    for (const mesh of this.ragdollDebugMeshes) {
      const name = mesh.userData.ragdollName as string;
      const ragBone = this.ragdollBones.get(name);
      if (!ragBone) continue;
      const pos = ragBone.body.translation();
      const rot = ragBone.body.rotation();
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      mesh.scale.set(1, 1, 1);
    }
    const hipsBody = this.ragdollBones.get('hips');
    if (hipsBody) {
      const pos = hipsBody.body.translation();
      bodyPos.set(pos.x, pos.y, pos.z);
      this.vrm.scene.position.copy(bodyPos).sub(this.hipsOffset);
    }
    if (this.ragdollRecording) {
      this.ragdollTime += delta;
      if (this.ragdollTime >= this.ragdollNextSample) {
        this.addKeyframe(this.ragdollTime);
        this.ragdollNextSample += 1 / SAMPLE_RATE;
      }
      if (this.ragdollTime >= MAX_DURATION) {
        this.ragdollRecording = false;
      }
    }
    this.updateRagdollHandles();
  }

  private getRagdollSteerInput() {
    const has = (key: string) => this.ragdollControlKeys.has(key);
    const x = (has('d') || has('arrowright') ? 1 : 0) - (has('a') || has('arrowleft') ? 1 : 0);
    const z = (has('w') || has('arrowup') ? 1 : 0) - (has('s') || has('arrowdown') ? 1 : 0);
    if (x === 0 && z === 0) return null;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3().addScaledVector(right, x).addScaledVector(forward, z);
    if (move.lengthSq() < 1e-6) return null;
    move.normalize();
    return move;
  }

  private applyRagdollSteering(delta: number) {
    if (!this.ragdollEnabled || !this.ragdollWorld) return;
    const move = this.getRagdollSteerInput();
    if (!move) return;
    const hips = this.ragdollBones.get('hips');
    const chest = this.ragdollBones.get('chest');
    const targets = [hips, chest].filter(Boolean) as RagdollBone[];
    if (targets.length === 0) return;
    const impulseMag = 30 * delta;
    const torqueAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), move).normalize();
    const torqueMag = 10 * delta;
    for (const rag of targets) {
      rag.body.applyImpulse(
        { x: move.x * impulseMag, y: 0, z: move.z * impulseMag },
        true,
      );
      if (Number.isFinite(torqueAxis.x)) {
        rag.body.applyTorqueImpulse(
          { x: torqueAxis.x * torqueMag, y: torqueAxis.y * torqueMag, z: torqueAxis.z * torqueMag },
          true,
        );
      }
    }
  }

  private syncRagdollReactivePose(delta: number) {
    if (!this.vrm || !this.ragdollWorld || this.ragdollBones.size === 0) return;
    const alpha = THREE.MathUtils.clamp(delta * 14, 0, 1);
    const targetPos = new THREE.Vector3();
    const targetQuat = new THREE.Quaternion();
    const currPos = new THREE.Vector3();
    const currQuat = new THREE.Quaternion();
    for (const ragBone of this.ragdollBones.values()) {
      ragBone.bone.getWorldPosition(targetPos);
      ragBone.bone.getWorldQuaternion(targetQuat);
      const p = ragBone.body.translation();
      const q = ragBone.body.rotation();
      currPos.set(p.x, p.y, p.z).lerp(targetPos, alpha);
      currQuat.set(q.x, q.y, q.z, q.w).slerp(targetQuat, alpha);
      ragBone.body.setTranslation({ x: currPos.x, y: currPos.y, z: currPos.z }, true);
      ragBone.body.setRotation(
        { x: currQuat.x, y: currQuat.y, z: currQuat.z, w: currQuat.w },
        true,
      );
      ragBone.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      ragBone.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  private updateRagdollDebugFromBodies() {
    for (const mesh of this.ragdollDebugMeshes) {
      const name = mesh.userData.ragdollName as string;
      const ragBone = this.ragdollBones.get(name);
      if (!ragBone) continue;
      const pos = ragBone.body.translation();
      const rot = ragBone.body.rotation();
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      mesh.scale.set(1, 1, 1);
    }
    this.updateRagdollHandles();
  }

  private applyRagdollMuscles(delta: number) {
    if (!this.ragdollEnabled || delta <= 0) return;
    const cfg = this.getRagdollMuscleConfig();
    if (!cfg.enabled) return;
    const kpBase = Math.max(0, Number(cfg.stiffness) || 0);
    const kdBase = Math.max(0, Number(cfg.damping) || 0);
    const maxTorqueBase = Math.max(0, Number(cfg.maxTorque) || 0);
    if (kpBase <= 0 || maxTorqueBase <= 0) return;
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
    const baseStiffnessScale = kpBase / 70;
    const baseDampingScale = kdBase / 16;
    const baseForceScale = maxTorqueBase / 70;
    const transitionDuration = 0.15;
    const transitionStiffnessBoost = 3;
    const transitionT = THREE.MathUtils.clamp(this.ragdollActivationTime / transitionDuration, 0, 1);
    const transitionBoost = THREE.MathUtils.lerp(transitionStiffnessBoost, 1, transitionT);
    for (const ragBone of this.ragdollBones.values()) {
      if (!ragBone.parent || !ragBone.targetLocalQuat) continue;
      const drive = this.getActiveRagdollDriveForBone(ragBone.name);
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
      angle = THREE.MathUtils.clamp(angle, -1.1, 1.1);
      axisWorld.copy(axisLocal).applyQuaternion(parentQuat).normalize();
      const pVel = ragBone.parent.body.angvel();
      const cVel = ragBone.body.angvel();
      parentAngVel.set(pVel.x, pVel.y, pVel.z);
      childAngVel.set(cVel.x, cVel.y, cVel.z);
      relAngVel.copy(childAngVel).sub(parentAngVel);
      const axisVel = relAngVel.dot(axisWorld);
      const muscleScale = ragBone.muscleScale ?? 1;
      const kp = drive.stiffness * baseStiffnessScale * transitionBoost * muscleScale;
      const kd = drive.damping * baseDampingScale * Math.sqrt(Math.max(0.2, muscleScale));
      const maxTorque = drive.forceLimit * baseForceScale * muscleScale;
      const torqueMag = THREE.MathUtils.clamp(kp * angle - kd * axisVel, -maxTorque, maxTorque);
      if (!Number.isFinite(torqueMag) || Math.abs(torqueMag) < 1e-4) continue;
      const maxImpulse = maxTorque * delta * 0.7;
      const impulseMag = THREE.MathUtils.clamp(torqueMag * delta, -maxImpulse, maxImpulse);
      const impulse = axisWorld.clone().multiplyScalar(impulseMag);
      ragBone.body.applyTorqueImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
      ragBone.parent.body.applyTorqueImpulse({ x: -impulse.x, y: -impulse.y, z: -impulse.z }, true);
    }
  }

  private updateRagdollDebugFromBones() {
    if (!this.vrm || this.ragdollBones.size === 0) return;
    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const center = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion();
    for (const mesh of this.ragdollDebugMeshes) {
      const name = mesh.userData.ragdollName as string;
      const ragBone = this.ragdollBones.get(name);
      if (!ragBone) continue;
      ragBone.bone.getWorldPosition(start);
      if (ragBone.child) {
        ragBone.child.getWorldPosition(end);
      } else {
        axis.copy(ragBone.axis ?? up).normalize();
        end.copy(start).addScaledVector(axis, Math.max(0.08, ragBone.baseLength ?? 0.2));
      }
      axis.copy(end).sub(start);
      const len = axis.length();
      if (len > 1e-6) {
        axis.multiplyScalar(1 / len);
      } else {
        axis.copy(ragBone.axis ?? up).normalize();
      }
      center.copy(start).add(end).multiplyScalar(0.5);
      quat.setFromUnitVectors(up, axis);
      mesh.position.copy(center);
      mesh.quaternion.copy(quat);
      const baseLen = Math.max(0.08, ragBone.baseLength ?? 0.2);
      mesh.scale.set(1, Math.max(0.5, len / baseLen), 1);
    }
    this.updateRagdollHandles();
  }

  private collectBonePoints(_threshold: number) {
    return new Map<string, THREE.Vector3[]>();
  }

  private startRagdollRecording() {
    this.pushUndo();
    this.clip.frames = [];
    this.setTotalFrames(Math.max(1, Math.round(MAX_DURATION * this.fps)));
    this.ragdollTime = 0;
    this.ragdollNextSample = 0;
    this.overrideRangeStartFrame = 0;
    this.overrideRangeEndFrame = Math.max(0, this.getTotalFrames() - 1);
    const overrideRangeWrap = this.hud.querySelector('[data-override-range]') as HTMLDivElement;
    const overrideStartHandle = this.hud.querySelector(
      '[data-override-start-handle]',
    ) as HTMLDivElement;
    const overrideEndHandle = this.hud.querySelector(
      '[data-override-end-handle]',
    ) as HTMLDivElement;
    this.syncOverrideRangeUi(
      overrideRangeWrap,
      overrideStartHandle,
      overrideEndHandle,
      this.overrideMode,
    );
    this.ragdollRecording = true;
    this.drawTimeline();
  }

  private resizeTimeline() {
    if (!this.timeline) return;
    const wrapRect = this.timelineWrap?.getBoundingClientRect();
    const rect = this.timeline.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(wrapRect?.width ?? rect.width ?? 1));
    const rowHeight = 28;
    const heightPx = Math.max(rect.height, rowHeight);
    this.timeline.width = Math.max(1, Math.floor(cssWidth * this.dpr));
    this.timeline.height = Math.max(1, Math.floor(heightPx * this.dpr));
    this.timeline.style.width = '100%';
  }

  private drawTimeline() {
    if (!this.timeline) return;
    const ctx = this.timeline.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const width = this.timeline.width;
    const height = this.timeline.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f131b';
    ctx.fillRect(0, 0, width, height);

    const totalFrames = this.getTotalFrames();
    const { lanePadX, usableWidth, stepPitch, gap, cellSize, laneY } =
      this.computeTimelineLaneMetrics(totalFrames, width, height, this.dpr);
    const cellOffsetY = laneY;
    const keyBorder = Math.max(1, Math.floor(this.dpr * 1.1));
    const gridBorder = Math.max(1, Math.floor(this.dpr * 0.75));

    const keyedFrames = new Set<number>();
    for (const frame of this.clip.frames) {
      keyedFrames.add(THREE.MathUtils.clamp(Math.round(frame.time * this.fps), 0, totalFrames - 1));
    }
    ctx.fillStyle = 'rgba(148,163,184,0.08)';
    ctx.fillRect(
      lanePadX,
      laneY - Math.max(1, Math.floor(4 * this.dpr)),
      usableWidth,
      cellSize + Math.max(2, Math.floor(8 * this.dpr)),
    );

    const majorFrameStep = Math.max(1, this.fps);
    const minorFrameStep = Math.max(1, Math.round(this.fps / 2));

    for (let f = 0; f < totalFrames; f += 1) {
      const x = lanePadX + f * stepPitch + gap * 0.5;
      const hasKey = keyedFrames.has(f);

      if (f % majorFrameStep === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = Math.max(1, Math.floor(this.dpr * 0.7));
        ctx.beginPath();
        ctx.moveTo(Math.floor(x) + 0.5, laneY - Math.max(4, Math.floor(6 * this.dpr)));
        ctx.lineTo(Math.floor(x) + 0.5, laneY - Math.max(1, Math.floor(2 * this.dpr)));
        ctx.stroke();
      } else if (minorFrameStep > 1 && f % minorFrameStep === 0) {
        ctx.strokeStyle = 'rgba(148,163,184,0.2)';
        ctx.lineWidth = Math.max(1, Math.floor(this.dpr * 0.55));
        ctx.beginPath();
        ctx.moveTo(Math.floor(x) + 0.5, laneY - Math.max(2, Math.floor(4 * this.dpr)));
        ctx.lineTo(Math.floor(x) + 0.5, laneY - 1);
        ctx.stroke();
      }

      let frameFill = f % 2 === 0 ? 'rgba(148,163,184,0.24)' : 'rgba(148,163,184,0.16)';
      let frameStroke = 'rgba(148,163,184,0.45)';
      if (hasKey) {
        frameFill = 'rgba(245,200,76,0.75)';
        frameStroke = 'rgba(245,200,76,0.95)';
      }
      ctx.fillStyle = frameFill;
      ctx.fillRect(x, cellOffsetY, Math.max(1, cellSize), Math.max(1, cellSize));
      ctx.strokeStyle = frameStroke;
      ctx.lineWidth = hasKey ? keyBorder : gridBorder;
      ctx.strokeRect(
        x + 0.5,
        cellOffsetY + 0.5,
        Math.max(1, cellSize - 1),
        Math.max(1, cellSize - 1),
      );
    }

    const playFrame = THREE.MathUtils.clamp(Math.round(this.time * this.fps), 0, totalFrames - 1);
    const playX = lanePadX + playFrame * stepPitch + gap * 0.5;
    ctx.strokeStyle = '#fef08a';
    ctx.lineWidth = Math.max(1, Math.floor(this.dpr * 1.6));
    ctx.strokeRect(
      playX - Math.max(1, Math.floor(1 * this.dpr)),
      cellOffsetY - Math.max(1, Math.floor(1 * this.dpr)),
      Math.max(2, cellSize + Math.max(2, Math.floor(2 * this.dpr))),
      Math.max(2, cellSize + Math.max(2, Math.floor(2 * this.dpr))),
    );
  }
}
