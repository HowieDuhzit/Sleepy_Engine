import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import { PSXRenderer } from '../rendering/PSXRenderer';
import { PSXPostProcessor } from '../postprocessing/PSXPostProcessor';
import { psxSettings } from '../settings/PSXSettings';
import { retargetMixamoClip } from '../game/retarget';
import {
  createGame,
  deleteGame,
  getGameAnimation,
  getGameAvatarUrl,
  listGameAvatars,
  getGameScenes,
  listGames,
  saveGameAnimation,
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
type LevelGround = {
  type?: 'concrete';
  width?: number;
  depth?: number;
  y?: number;
  textureRepeat?: number;
  terrain?: {
    enabled?: boolean;
    preset?: 'cinematic' | 'alpine' | 'dunes' | 'islands';
    size?: number;
    resolution?: number;
    maxHeight?: number;
    roughness?: number;
    seed?: number;
  };
};
type LevelTerrainConfig = NonNullable<LevelGround['terrain']>;
type NormalizedLevelGround = {
  type: 'concrete';
  width: number;
  depth: number;
  y: number;
  textureRepeat: number;
  terrain?: Required<LevelTerrainConfig>;
};
type LevelScene = {
  name: string;
  obstacles?: LevelObstacle[];
  ground?: LevelGround;
  player?: { avatar?: string; x?: number; y?: number; z?: number; yaw?: number };
  crowd?: {
    enabled?: boolean;
    avatar?: string;
    x?: number;
    y?: number;
    z?: number;
    radius?: number;
  };
};

type LevelObjectKind = 'ground' | 'player' | 'crowd' | 'obstacle';
type LevelSceneObjectRef = {
  id: string;
  label: string;
  kind: LevelObjectKind;
  object: THREE.Object3D;
  obstacleId?: string;
};

type CharacterRole = 'player' | 'npc' | 'boss' | 'neutral';
type ControllerMode = 'third_person' | 'first_person' | 'ai_only' | 'hybrid';

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

type UndoEntry = {
  clip: ClipData;
  time: number;
};

const UNDO_MAX = 50;

export class EditorApp {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private psxRenderer: PSXRenderer | null = null;
  private psxPostProcessor: PSXPostProcessor | null = null;

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
  private ragdollEnabled = false;
  private ragdollVisible = false;
  private ragdollRecording = false;
  private ragdollTime = 0;
  private ragdollNextSample = 0;
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
  private levelGroundMesh: THREE.Mesh | null = null;
  private levelCrowdMarker: THREE.Group | null = null;
  private levelPlayerMarker: THREE.Group | null = null;
  private levelObstacleMeshes = new Map<string, THREE.Mesh>();
  private selectedLevelObjectId: string | null = null;
  private levelSceneObjects = new Map<string, LevelSceneObjectRef>();
  private levelSceneListEl: HTMLSelectElement | null = null;
  private levelSceneObstaclesEl: HTMLTextAreaElement | null = null;
  private levelSceneJsonEl: HTMLTextAreaElement | null = null;
  private levelObjectSelectEl: HTMLSelectElement | null = null;
  private levelHierarchyEl: HTMLDivElement | null = null;
  private levelSceneStateRef: { scenes: LevelScene[] } | null = null;
  private levelCameraMode: 'free' | 'locked' = 'free';
  private levelCameraModeButton: HTMLButtonElement | null = null;
  private levelFreeFlyActive = false;
  private levelFreeFlyPointerId: number | null = null;
  private levelFreeFlyLastMouse = { x: 0, y: 0 };
  private levelFreeFlyKeys = new Set<string>();
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
  private currentTab: 'animation' | 'player' | 'level' | 'settings' = 'animation';
  private refreshClipsFunction: (() => Promise<void>) | null = null;
  private refreshScenesFunction: (() => Promise<void>) | null = null;
  private refreshPlayerInputsFunction: (() => void) | null = null;
  private refreshPlayerAvatarsFunction: (() => Promise<void>) | null = null;
  private loadGamesListFunction: (() => Promise<void>) | null = null;
  private selectGameFunction: ((gameId: string) => Promise<void>) | null = null;
  private applyTabFunction: ((tab: 'animation' | 'player' | 'level' | 'settings') => void) | null =
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
          this.undo();
        } else {
          this.triggerHapticFeedback('heavy');
          this.redo();
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
  private readonly ragdollDefs: { name: string; parent?: string }[] = [
    { name: 'hips' },
    { name: 'spine', parent: 'hips' },
    { name: 'chest', parent: 'spine' },
    { name: 'upperChest', parent: 'chest' },
    { name: 'neck', parent: 'upperChest' },
    { name: 'head', parent: 'neck' },
    { name: 'leftUpperArm', parent: 'upperChest' },
    { name: 'leftLowerArm', parent: 'leftUpperArm' },
    { name: 'leftHand', parent: 'leftLowerArm' },
    { name: 'rightUpperArm', parent: 'upperChest' },
    { name: 'rightLowerArm', parent: 'rightUpperArm' },
    { name: 'rightHand', parent: 'rightLowerArm' },
    { name: 'leftUpperLeg', parent: 'hips' },
    { name: 'leftLowerLeg', parent: 'leftUpperLeg' },
    { name: 'leftFoot', parent: 'leftLowerLeg' },
    { name: 'rightUpperLeg', parent: 'hips' },
    { name: 'rightLowerLeg', parent: 'rightUpperLeg' },
    { name: 'rightFoot', parent: 'rightLowerLeg' },
  ];
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

    // Initialize PSX rendering system
    const psxRes = psxSettings.getResolution();
    this.psxRenderer = new PSXRenderer(this.renderer, {
      baseWidth: psxRes.width,
      baseHeight: psxRes.height,
      enabled: psxSettings.config.enabled,
      pixelated: psxSettings.config.pixelated,
    });

    this.psxPostProcessor = new PSXPostProcessor(this.renderer, this.scene, this.camera, {
      enabled: psxSettings.config.enabled,
      blur: psxSettings.config.blur,
      blurStrength: psxSettings.config.blurStrength,
      colorQuantization: psxSettings.config.colorQuantization,
      colorBits: psxSettings.config.colorBits,
      dithering: psxSettings.config.dithering,
      ditherStrength: psxSettings.config.ditherStrength,
      crtEffects: psxSettings.config.crtEffects,
      scanlineIntensity: psxSettings.config.scanlineIntensity,
      curvature: psxSettings.config.curvature,
      vignette: psxSettings.config.vignette,
      brightness: psxSettings.config.brightness,
      chromaticAberration: psxSettings.config.chromaticAberration,
      chromaticOffset: psxSettings.config.chromaticOffset,
      contrast: psxSettings.config.contrast,
      saturation: psxSettings.config.saturation,
      gamma: psxSettings.config.gamma,
      exposure: psxSettings.config.exposure,
    });

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 1.2, 0);
    this.controls.minDistance = 1.4;
    this.controls.maxDistance = 20;

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
    this.renderer.domElement.addEventListener('contextmenu', this.handleLevelFreeFlyContextMenu);
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
    window.addEventListener('keydown', this.handleLevelFreeFlyKeyDown);
    window.addEventListener('keyup', this.handleLevelFreeFlyKeyUp);
    window.addEventListener('psx-settings-changed', this.handlePSXSettingsChange);
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

  private handlePSXSettingsChange = () => {
    // Update PSX renderers when settings change globally
    if (this.psxRenderer) {
      const res = psxSettings.getResolution();
      this.psxRenderer.setEnabled(psxSettings.config.enabled);
      this.psxRenderer.setResolution(res.width, res.height);
      this.psxRenderer.setPixelated(psxSettings.config.pixelated);
    }

    if (this.psxPostProcessor) {
      this.psxPostProcessor.setEnabled(psxSettings.config.enabled);
      this.psxPostProcessor.setBlur(psxSettings.config.blur, psxSettings.config.blurStrength);
      this.psxPostProcessor.setColorQuantization(
        psxSettings.config.colorQuantization,
        psxSettings.config.colorBits,
      );
      this.psxPostProcessor.setDithering(
        psxSettings.config.dithering,
        psxSettings.config.ditherStrength,
      );
      this.psxPostProcessor.setCRTEffects(psxSettings.config.crtEffects);
      this.psxPostProcessor.setChromaticAberration(
        psxSettings.config.chromaticAberration,
        psxSettings.config.chromaticOffset,
      );
      this.psxPostProcessor.setBrightness(psxSettings.config.brightness);
      this.psxPostProcessor.setContrast(psxSettings.config.contrast);
      this.psxPostProcessor.setSaturation(psxSettings.config.saturation);
      this.psxPostProcessor.setGamma(psxSettings.config.gamma);
      this.psxPostProcessor.setExposure(psxSettings.config.exposure);
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

  public setTabFromUi(tab: 'animation' | 'player' | 'level' | 'settings') {
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
    tab: 'animation' | 'player' | 'level' | 'settings',
    area: 'left' | 'bottom',
    host: HTMLElement,
  ) {
    const key = `${area}:${tab}`;
    const selector =
      area === 'left'
        ? `.editor-left[data-tab-panel="${tab}"]`
        : `.editor-bottom[data-tab-panel="${tab}"]`;
    const panel =
      this.externalPanelNodes.get(key) ??
      (this.hud.querySelector(selector) as HTMLDivElement | null);
    if (!panel) return false;
    host.innerHTML = '';
    panel.style.display = area === 'left' ? 'flex' : '';
    panel.style.visibility = '';
    panel.hidden = false;
    if (area === 'left') {
      panel.style.flexDirection = 'column';
      panel.style.minHeight = '0';
      panel.style.overflowY = tab === 'player' || tab === 'level' ? 'auto' : '';
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
    window.removeEventListener('keydown', this.handleLevelFreeFlyKeyDown);
    window.removeEventListener('keyup', this.handleLevelFreeFlyKeyUp);
    window.removeEventListener('psx-settings-changed', this.handlePSXSettingsChange);
    this.renderer.domElement.removeEventListener('pointerdown', this.handleViewportPick);
    window.removeEventListener('pointermove', this.handleLevelFreeFlyPointerMove);
    window.removeEventListener('pointerup', this.handleLevelFreeFlyPointerUp);
    this.renderer.domElement.removeEventListener('contextmenu', this.handleLevelFreeFlyContextMenu);
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

    // Update PSX resolution
    if (this.psxRenderer) {
      const psxRes = psxSettings.getResolution();
      this.psxRenderer.setResolution(psxRes.width, psxRes.height);
    }

    if (this.psxPostProcessor) {
      const { innerWidth, innerHeight } = window;
      this.psxPostProcessor.setSize(innerWidth, innerHeight);
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
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    } else if (mod && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      this.redo();
    } else if (mod && e.key === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod && e.key === 'c') {
      e.preventDefault();
      this.copyKeyframeAtTime(this.time);
    } else if (mod && e.key === 'v') {
      e.preventDefault();
      this.pasteKeyframeAtTime(this.time);
    }
  };

  private getActiveScene(): THREE.Scene {
    switch (this.currentTab) {
      case 'animation':
      case 'player':
        return this.characterScene;
      case 'level':
        return this.levelScene;
      case 'settings':
        return this.settingsScene;
      default:
        return this.characterScene;
    }
  }

  private switchToTab(tab: 'animation' | 'player' | 'level' | 'settings') {
    this.currentTab = tab;
    if (tab !== 'level') {
      this.stopLevelFreeFly();
    }

    // VRM stays in character scene for both animation and player tabs
    // No need to move it between scenes anymore since they're consolidated

    // Update PSX post-processor to use the new scene
    if (this.psxPostProcessor) {
      // We need to recreate the post-processor with the new scene
      this.psxPostProcessor.dispose();
      this.psxPostProcessor = new PSXPostProcessor(
        this.renderer,
        this.getActiveScene(),
        this.camera,
        {
          enabled: psxSettings.config.enabled,
          blur: psxSettings.config.blur,
          blurStrength: psxSettings.config.blurStrength,
          colorQuantization: psxSettings.config.colorQuantization,
          colorBits: psxSettings.config.colorBits,
          dithering: psxSettings.config.dithering,
          ditherStrength: psxSettings.config.ditherStrength,
          crtEffects: psxSettings.config.crtEffects,
          scanlineIntensity: psxSettings.config.scanlineIntensity,
          curvature: psxSettings.config.curvature,
          vignette: psxSettings.config.vignette,
          brightness: psxSettings.config.brightness,
          chromaticAberration: psxSettings.config.chromaticAberration,
          chromaticOffset: psxSettings.config.chromaticOffset,
          contrast: psxSettings.config.contrast,
          saturation: psxSettings.config.saturation,
          gamma: psxSettings.config.gamma,
          exposure: psxSettings.config.exposure,
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
    } else if (tab === 'settings') {
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
        }
      : undefined;
    return {
      type: 'concrete',
      width: Math.max(1, Number(ground.width ?? 120)),
      depth: Math.max(1, Number(ground.depth ?? 120)),
      y: Number(ground.y ?? 0),
      textureRepeat: Math.max(1, Number(ground.textureRepeat ?? 12)),
      terrain,
    };
  }

  private createEditorConcreteTexture() {
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
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      data[i] = Math.min(255, Math.max(0, r + n));
      data[i + 1] = Math.min(255, Math.max(0, g + n));
      data[i + 2] = Math.min(255, Math.max(0, b + n));
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

  private getCurrentLevelSceneEntry() {
    const sceneState = this.levelSceneStateRef;
    const sceneList = this.levelSceneListEl;
    if (!sceneState || !sceneList) return null;
    return sceneState.scenes.find((scene) => scene.name === sceneList.value) ?? null;
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

  private refreshLevelObjectSelect() {
    if (!this.levelObjectSelectEl) return;
    this.levelObjectSelectEl.innerHTML = '';
    const entries = Array.from(this.levelSceneObjects.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
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
        button.addEventListener('click', () => {
          this.selectLevelObject(entry.id);
        });
        this.levelHierarchyEl.appendChild(button);
      }
    }
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
          ? 'Free-fly camera: pan/rotate/zoom anywhere'
          : 'Object-locked camera: orbits selected object';
    }
    this.syncLevelCameraTarget();
  }

  private canUseLevelFreeFly() {
    return this.currentTab === 'level' && this.levelCameraMode === 'free';
  }

  private startLevelFreeFly(event: PointerEvent) {
    if (!this.canUseLevelFreeFly()) return;
    this.levelFreeFlyActive = true;
    this.levelFreeFlyPointerId = event.pointerId;
    this.levelFreeFlyLastMouse = { x: event.clientX, y: event.clientY };
    this.levelFreeFlyKeys.clear();
    if (this.controls) this.controls.enabled = false;
    this.renderer.domElement.style.cursor = 'grabbing';
  }

  private stopLevelFreeFly() {
    if (!this.levelFreeFlyActive) return;
    this.levelFreeFlyActive = false;
    this.levelFreeFlyPointerId = null;
    this.levelFreeFlyKeys.clear();
    if (this.controls) this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
  }

  private handleLevelFreeFlyPointerMove = (event: PointerEvent) => {
    if (!this.levelFreeFlyActive || !this.canUseLevelFreeFly()) return;
    if (this.levelFreeFlyPointerId !== null && event.pointerId !== this.levelFreeFlyPointerId) return;
    const dx = event.clientX - this.levelFreeFlyLastMouse.x;
    const dy = event.clientY - this.levelFreeFlyLastMouse.y;
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
    if (this.levelFreeFlyPointerId === null || event.pointerId === this.levelFreeFlyPointerId) {
      this.stopLevelFreeFly();
    }
  };

  private handleLevelFreeFlyKeyDown = (event: KeyboardEvent) => {
    if (!this.levelFreeFlyActive || !this.canUseLevelFreeFly()) return;
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', ' ', 'shift'].includes(key)) {
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

  private handleLevelFreeFlyContextMenu = (event: MouseEvent) => {
    if (this.currentTab === 'level' && this.levelCameraMode === 'free') {
      event.preventDefault();
    }
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
      const id = `obstacle:${obstacleId}`;
      this.levelSceneObjects.set(id, {
        id,
        label: `Obstacle: ${obstacleId}`,
        kind: 'obstacle',
        object: mesh,
        obstacleId,
      });
    }
  }

  private updateLevelVisualizationFromState(obstacles: LevelObstacle[]) {
    const scene = this.getCurrentLevelSceneEntry();
    if (scene && !scene.player) scene.player = {};
    const ground = this.normalizeLevelGround(scene?.ground);
    if (this.levelGroundMesh) {
      this.levelScene.remove(this.levelGroundMesh);
      this.levelGroundMesh.geometry.dispose();
      if (this.levelGroundMesh.material instanceof THREE.Material)
        this.levelGroundMesh.material.dispose();
      this.levelGroundMesh = null;
    }
    if (ground) {
      const concreteTexture = this.createEditorConcreteTexture();
      concreteTexture.repeat.set(ground.textureRepeat, ground.textureRepeat);
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
          map: concreteTexture,
          flatShading: terrain !== null,
          roughness: 0.95,
          metalness: 0.05,
          color: 0xffffff,
        }),
      );
      this.levelGroundMesh.position.y = ground.y;
      this.levelGroundMesh.userData.levelObjectId = 'ground';
      this.levelScene.add(this.levelGroundMesh);
    }

    if (this.levelPlayerMarker) {
      this.levelScene.remove(this.levelPlayerMarker);
      this.levelPlayerMarker = null;
    }
    const player = scene?.player ?? {};
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
    this.levelObstacleGroup.clear();

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
    }
    this.rebuildLevelSceneObjects();
    this.refreshLevelObjectSelect();
  }

  private selectLevelObject(objectId: string | null) {
    this.selectedLevelObjectId = objectId;

    for (const [id, mesh] of this.levelObstacleMeshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const selected = objectId === `obstacle:${id}`;
      mat.color.set(selected ? 0xf59e0b : 0x666666);
      mat.emissive.set(selected ? 0x201008 : 0x000000);
      mat.emissiveIntensity = selected ? 0.5 : 0;
    }
    if (this.levelGroundMesh) {
      const mat = this.levelGroundMesh.material as THREE.MeshStandardMaterial;
      mat.emissive = new THREE.Color(objectId === 'ground' ? 0x112233 : 0x000000);
      mat.emissiveIntensity = objectId === 'ground' ? 0.25 : 0;
    }
    if (this.levelPlayerMarker) {
      this.levelPlayerMarker.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.material && mesh.material instanceof THREE.MeshStandardMaterial) {
          mesh.material.emissiveIntensity = objectId === 'player' ? 0.75 : 0.3;
        }
      });
    }
    if (this.levelCrowdMarker) {
      this.levelCrowdMarker.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.material && mesh.material instanceof THREE.MeshStandardMaterial) {
          mesh.material.emissiveIntensity = objectId === 'crowd' ? 0.85 : 0.35;
        }
      });
    }

    if (this.levelObjectSelectEl) {
      this.levelObjectSelectEl.value = objectId ?? '';
    }
    if (this.levelHierarchyEl) {
      const items = this.levelHierarchyEl.querySelectorAll<HTMLButtonElement>('.bone-list-item');
      items.forEach((item) =>
        item.classList.toggle('active', item.dataset.levelObjectId === objectId),
      );
    }

    if (!this.levelTransform) return;
    const entry = objectId ? (this.levelSceneObjects.get(objectId) ?? null) : null;
    if (entry?.object && entry.object.parent) {
      this.levelTransform.attach(entry.object);
      setTransformControlsVisible(this.levelTransform, true);
    } else {
      this.levelTransform.detach();
      setTransformControlsVisible(this.levelTransform, false);
    }
    this.syncLevelCameraTarget();
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
      scene.player = player;
    } else if (entry.kind === 'crowd') {
      const crowd = scene.crowd ?? { enabled: true };
      crowd.enabled = true;
      crowd.x = entry.object.position.x;
      crowd.y = entry.object.position.y;
      crowd.z = entry.object.position.z;
      crowd.radius = Math.max(1, 12 * entry.object.scale.x);
      scene.crowd = crowd;
    }
    this.syncLevelTextEditors();
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
      this.selectLevelObject(hitId);
      this.triggerHapticFeedback('light');
    }
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
    if (isAnimationTab && this.ragdollVisible && !this.ragdollEnabled) {
      this.updateRagdollDebugFromBones();
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
      if (this.levelFreeFlyActive && this.canUseLevelFreeFly()) {
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward).normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const move = new THREE.Vector3();
        if (this.levelFreeFlyKeys.has('w')) move.add(forward);
        if (this.levelFreeFlyKeys.has('s')) move.sub(forward);
        if (this.levelFreeFlyKeys.has('d')) move.add(right);
        if (this.levelFreeFlyKeys.has('a')) move.sub(right);
        if (this.levelFreeFlyKeys.has('e') || this.levelFreeFlyKeys.has(' ')) move.add(up);
        if (this.levelFreeFlyKeys.has('q')) move.sub(up);
        if (move.lengthSq() > 0) {
          move.normalize();
          const speed = (this.levelFreeFlyKeys.has('shift') ? 22 : 11) * delta;
          this.camera.position.addScaledVector(move, speed);
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

    // Render with PSX effects or standard
    if (psxSettings.config.enabled && this.psxPostProcessor) {
      this.psxPostProcessor.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    this.animationId = requestAnimationFrame(this.tick);
  };

  private createHud() {
    const hud = document.createElement('div');
    hud.className = 'editor-ui';
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
      '<label class="field"><span>Controller</span><select data-profile-controller><option value="third_person">Third Person</option><option value="first_person">First Person</option><option value="ai_only">AI Only</option><option value="hybrid">Hybrid</option></select></label>',
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
      '<label class="field"><span>Selected</span><select data-level-object></select></label>',
      '<div class="panel-title">Scene Hierarchy</div>',
      '<div class="bone-list" data-level-hierarchy></div>',
      '<div class="panel-actions">',
      '<button data-level-add>Add Box</button>',
      '<button data-level-duplicate>Duplicate</button>',
      '<button data-level-delete>Delete</button>',
      '</div>',
      '<label class="field"><span>Transform Mode</span><select data-level-transform-mode><option value="translate">Move</option><option value="rotate">Rotate</option><option value="scale">Scale</option></select></label>',
      '<label class="field"><span>Snap Step</span><input data-level-snap type="number" min="0" step="0.1" value="0.5" /></label>',
      '<button data-level-focus>Focus Selected</button>',
      '<div class="panel-title">Terrain Generator</div>',
      '<label class="field"><span>Preset</span><select data-level-terrain-preset><option value="cinematic">Cinematic</option><option value="alpine">Alpine</option><option value="dunes">Dunes</option><option value="islands">Islands</option></select></label>',
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
      '<div class="clip-status" data-level-terrain-status>Procedural terrain deforms the ground mesh from a seeded heightfield.</div>',
      '<div class="clip-status" data-level-status>Select an object in viewport or list to edit transform.</div>',
      '</div>',
      '</div>',
      '<div class="editor-view" data-viewport>',
      '<div class="viewport-overlay">',
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
      '<div class="editor-left" data-tab-panel="settings" style="display:none;">',
      '<div class="panel">',
      '<div class="panel-title">Console Graphics</div>',
      '<label class="field">',
      '<span>Console Preset</span>',
      '<select data-console-preset>',
      '<option value="ps1">PlayStation 1 (1994)</option>',
      '<option value="n64">Nintendo 64 (1996)</option>',
      '<option value="dreamcast">Sega Dreamcast (1998)</option>',
      '<option value="xbox">Xbox (2001)</option>',
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
        | 'settings'
        | undefined;
      if (!tab) continue;
      if (panel.classList.contains('editor-left')) {
        this.externalPanelNodes.set(`left:${tab}`, panel);
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
    const applyTab = (tab: 'animation' | 'player' | 'level' | 'settings') => {
      this.switchToTab(tab);
      hud.classList.toggle('mode-animation', tab === 'animation');
      hud.classList.toggle('mode-player', tab === 'player');
      hud.classList.toggle('mode-level', tab === 'level');
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
      this.resizeRenderer();
      this.resizeTimeline();
      this.drawTimeline();
      this.fitCameraToVrm();
    };
    this.applyTabFunction = applyTab;

    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab as 'animation' | 'player' | 'level' | 'settings';
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
    const profileFactionInput = hud.querySelector('[data-profile-faction]') as HTMLInputElement;
    const profileHealthInput = hud.querySelector('[data-profile-health]') as HTMLInputElement;
    const profileStaminaInput = hud.querySelector('[data-profile-stamina]') as HTMLInputElement;
    const profileTagsInput = hud.querySelector('[data-profile-tags]') as HTMLInputElement;
    const profileDescriptionInput = hud.querySelector(
      '[data-profile-description]',
    ) as HTMLInputElement;
    const rigShowInput = hud.querySelector('[data-rig-show]') as HTMLInputElement;
    const rigBoneSelect = hud.querySelector('[data-rig-bone]') as HTMLSelectElement;
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
    const sceneObstacles = hud.querySelector('[data-scene-obstacles]') as HTMLTextAreaElement;
    const sceneJson = hud.querySelector('[data-scene-json]') as HTMLTextAreaElement;
    const levelObjectSelect = hud.querySelector('[data-level-object]') as HTMLSelectElement;
    const levelHierarchy = hud.querySelector('[data-level-hierarchy]') as HTMLDivElement;
    const levelAddBtn = hud.querySelector('[data-level-add]') as HTMLButtonElement;
    const levelDuplicateBtn = hud.querySelector('[data-level-duplicate]') as HTMLButtonElement;
    const levelDeleteBtn = hud.querySelector('[data-level-delete]') as HTMLButtonElement;
    const levelTransformMode = hud.querySelector(
      '[data-level-transform-mode]',
    ) as HTMLSelectElement;
    const levelSnapInput = hud.querySelector('[data-level-snap]') as HTMLInputElement;
    const levelFocusBtn = hud.querySelector('[data-level-focus]') as HTMLButtonElement;
    const levelTerrainPreset = hud.querySelector('[data-level-terrain-preset]') as HTMLSelectElement;
    const levelTerrainSize = hud.querySelector('[data-level-terrain-size]') as HTMLInputElement;
    const levelTerrainRes = hud.querySelector('[data-level-terrain-res]') as HTMLInputElement;
    const levelTerrainHeight = hud.querySelector('[data-level-terrain-height]') as HTMLInputElement;
    const levelTerrainRoughness = hud.querySelector(
      '[data-level-terrain-roughness]',
    ) as HTMLInputElement;
    const levelTerrainSeed = hud.querySelector('[data-level-terrain-seed]') as HTMLInputElement;
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
    const levelStatus = hud.querySelector('[data-level-status]') as HTMLDivElement;
    const levelCameraModeBtn = hud.querySelector(
      '[data-level-camera-mode]',
    ) as HTMLButtonElement | null;
    this.levelCameraModeButton = levelCameraModeBtn;
    this.setLevelCameraMode('free');
    levelCameraModeBtn?.addEventListener('click', () => {
      this.setLevelCameraMode(this.levelCameraMode === 'free' ? 'locked' : 'free');
      if (levelStatus) {
        levelStatus.textContent =
          this.levelCameraMode === 'free'
            ? 'Camera mode: free fly'
            : 'Camera mode: object locked';
      }
    });

    // Settings tab controls
    const consolePresetSelect = hud.querySelector('[data-console-preset]') as HTMLSelectElement;
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
    const loadSceneFromState = (name: string) => {
      const entry = sceneState.scenes.find((s) => s.name === name);
      if (!entry) return;
      sceneList.value = entry.name;
      sceneNameInput.value = entry.name;
      sceneObstacles.value = JSON.stringify(entry.obstacles ?? [], null, 2);
      const terrain = this.normalizeLevelGround(entry.ground)?.terrain;
      if (terrain) {
        levelTerrainPreset.value = terrain.preset ?? 'cinematic';
        levelTerrainSize.value = String(Math.max(16, Number(terrain.size ?? 96)));
        levelTerrainRes.value = String(Math.max(8, Number(terrain.resolution ?? 28)));
        levelTerrainHeight.value = String(Math.max(1, Number(terrain.maxHeight ?? 10)));
        levelTerrainRoughness.value = String(
          Math.max(0.2, Math.min(0.95, Number(terrain.roughness ?? 0.56))),
        );
        levelTerrainSeed.value = String(Math.floor(Number(terrain.seed ?? 1337)));
      }
      syncSceneJson();
      // Update level scene visualization
      this.updateLevelVisualization(entry.obstacles ?? []);
    };

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
        sceneState.scenes = (data.scenes ?? [{ name: 'main', obstacles: [] }]).map(
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
              ground: ground ?? undefined,
              player: scene.player ? { ...scene.player } : undefined,
              crowd: scene.crowd ? { ...scene.crowd } : undefined,
            };
          },
        );
        syncSceneSelect();
        loadSceneFromState(sceneState.scenes[0]?.name ?? 'main');
        setSceneStatus(`Scenes: ${sceneState.scenes.length}`, 'ok');
      } catch (err) {
        sceneState.scenes = [
          {
            name: 'main',
            obstacles: [],
          },
        ];
        syncSceneSelect();
        loadSceneFromState('main');
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
      const name = (sceneNameInput.value || '').trim() || `scene_${sceneState.scenes.length + 1}`;
      if (sceneState.scenes.find((s) => s.name === name)) {
        setSceneStatus('Scene already exists', 'warn');
        return;
      }
      sceneState.scenes.push({ name, obstacles: [] });
      syncSceneSelect();
      sceneList.value = name;
      loadSceneFromState(name);
    });
    sceneSaveBtn?.addEventListener('click', async () => {
      const name = (sceneNameInput.value || '').trim() || sceneList.value || 'main';
      let obstacles: LevelObstacle[] = [];
      try {
        obstacles = JSON.parse(sceneObstacles.value || '[]') as LevelObstacle[];
      } catch (err) {
        setSceneStatus(`Invalid JSON: ${String(err)}`, 'warn');
        return;
      }
      const entry = sceneState.scenes.find((s) => s.name === name);
      if (entry) {
        entry.obstacles = obstacles;
      } else {
        sceneState.scenes.push({ name, obstacles });
      }
      syncSceneSelect();
      sceneList.value = name;
      syncSceneJson();
      // Update level visualization
      this.updateLevelVisualization(obstacles);
      await saveScenes();
    });
    sceneDeleteBtn?.addEventListener('click', async () => {
      const name = sceneList.value;
      sceneState.scenes = sceneState.scenes.filter((s) => s.name !== name);
      if (sceneState.scenes.length === 0) {
        sceneState.scenes.push({ name: 'main', obstacles: [] });
      }
      syncSceneSelect();
      loadSceneFromState(sceneState.scenes[0]?.name ?? 'main');
      syncSceneJson();
      await saveScenes();
    });

    levelObjectSelect.addEventListener('change', () => {
      this.selectLevelObject(levelObjectSelect.value || null);
      if (levelStatus)
        levelStatus.textContent = levelObjectSelect.value
          ? `Selected ${levelObjectSelect.value}`
          : 'No object selected';
    });

    levelTransformMode.addEventListener('change', () => {
      if (!this.levelTransform) return;
      const mode = levelTransformMode.value as 'translate' | 'rotate' | 'scale';
      this.levelTransform.setMode(mode);
      if (levelStatus) levelStatus.textContent = `Transform mode: ${mode}`;
    });

    levelSnapInput.addEventListener('change', () => {
      if (!this.levelTransform) return;
      const snap = Math.max(0, Number(levelSnapInput.value) || 0);
      this.levelTransform.setTranslationSnap(snap > 0 ? snap : null);
      this.levelTransform.setRotationSnap(
        snap > 0 ? THREE.MathUtils.degToRad(Math.max(1, snap * 10)) : null,
      );
      this.levelTransform.setScaleSnap(snap > 0 ? snap : null);
      if (levelStatus) levelStatus.textContent = snap > 0 ? `Snap: ${snap}` : 'Snap: off';
    });
    levelTransformMode.value = 'translate';
    levelSnapInput.dispatchEvent(new Event('change'));

    levelAddBtn.addEventListener('click', () => {
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

    levelDuplicateBtn.addEventListener('click', () => {
      const selectedId = this.selectedLevelObjectId;
      const scene = this.getCurrentLevelSceneEntry();
      if (!selectedId || !scene || !selectedId.startsWith('obstacle:')) return;
      const selectedObstacleId = selectedId.replace('obstacle:', '');
      const obstacles = scene.obstacles ?? [];
      const index = obstacles.findIndex(
        (item, idx) => this.normalizeLevelObstacle(item ?? {}, idx).id === selectedObstacleId,
      );
      if (index < 0) return;
      const source = this.normalizeLevelObstacle(obstacles[index] ?? {}, index);
      const id = `obstacle_${obstacles.length + 1}`;
      obstacles.push({ ...source, id, x: source.x + 1 });
      scene.obstacles = obstacles;
      this.updateLevelVisualization(obstacles);
      this.selectLevelObject(`obstacle:${id}`);
      this.syncLevelTextEditors();
      if (levelStatus) levelStatus.textContent = `Duplicated ${selectedObstacleId} -> ${id}`;
    });

    levelDeleteBtn.addEventListener('click', () => {
      const selectedId = this.selectedLevelObjectId;
      const scene = this.getCurrentLevelSceneEntry();
      if (!selectedId || !scene || !selectedId.startsWith('obstacle:')) return;
      const selectedObstacleId = selectedId.replace('obstacle:', '');
      const obstacles = (scene.obstacles ?? []).filter(
        (item, idx) => this.normalizeLevelObstacle(item ?? {}, idx).id !== selectedObstacleId,
      );
      scene.obstacles = obstacles;
      this.updateLevelVisualization(obstacles);
      this.syncLevelTextEditors();
      if (levelStatus) levelStatus.textContent = `Deleted ${selectedObstacleId}`;
    });

    levelFocusBtn.addEventListener('click', () => {
      const selectedId = this.selectedLevelObjectId;
      const entry = selectedId ? this.levelSceneObjects.get(selectedId) : null;
      if (!entry || !this.controls) return;
      this.controls.target.copy(entry.object.position);
      this.camera.position.set(
        entry.object.position.x + 4,
        entry.object.position.y + 4,
        entry.object.position.z + 4,
      );
      this.controls.update();
    });

    const setTerrainStatus = (text: string, tone: 'ok' | 'warn' = 'ok') => {
      if (!levelTerrainStatus) return;
      levelTerrainStatus.textContent = text;
      levelTerrainStatus.dataset.tone = tone;
    };

    const runTerrainGeneration = (mode: 'apply' | 'remix' | 'clear') => {
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
      };
      nextGround.width = Math.max(nextGround.width, size + 12);
      nextGround.depth = Math.max(nextGround.depth, size + 12);
      nextGround.terrain = {
        enabled: true,
        preset: (levelTerrainPreset.value as 'cinematic' | 'alpine' | 'dunes' | 'islands') || 'cinematic',
        size,
        resolution,
        maxHeight,
        roughness,
        seed,
      };
      scene.ground = nextGround;
      // Clear legacy generated block terrain from previous implementation.
      scene.obstacles = currentObstacles.filter((item, idx) => {
        const id = this.normalizeLevelObstacle(item ?? {}, idx).id;
        return !id.startsWith('terrain_');
      });

      this.updateLevelVisualization(scene.obstacles);
      this.syncLevelTextEditors();
      setTerrainStatus(
        `${mode === 'remix' ? 'Remixed' : 'Applied'} ${levelTerrainPreset.value} mesh (seed ${seed})`,
        'ok',
      );
      if (levelStatus) levelStatus.textContent = `Terrain mesh ready (${levelTerrainPreset.value})`;
    };

    levelTerrainGenerateBtn?.addEventListener('click', () => runTerrainGeneration('apply'));
    levelTerrainAppendBtn?.addEventListener('click', () => runTerrainGeneration('remix'));
    levelTerrainClearBtn?.addEventListener('click', () => runTerrainGeneration('clear'));

    void loadScenes();

    // Settings tab initialization and handlers
    if (consolePresetSelect) {
      consolePresetSelect.value = psxSettings.config.consolePreset;
      consolePresetSelect.addEventListener('change', () => {
        psxSettings.applyConsolePreset(
          consolePresetSelect.value as 'ps1' | 'n64' | 'dreamcast' | 'xbox' | 'modern',
        );
        // Update sliders and displays to reflect preset values
        if (brightnessInput) {
          brightnessInput.value = psxSettings.config.brightness.toString();
          if (brightnessVal) brightnessVal.textContent = psxSettings.config.brightness.toFixed(2);
        }
        if (contrastInput) {
          contrastInput.value = psxSettings.config.contrast.toString();
          if (contrastVal) contrastVal.textContent = psxSettings.config.contrast.toFixed(2);
        }
        if (saturationInput) {
          saturationInput.value = psxSettings.config.saturation.toString();
          if (saturationVal) saturationVal.textContent = psxSettings.config.saturation.toFixed(2);
        }
        if (gammaInput) {
          gammaInput.value = psxSettings.config.gamma.toString();
          if (gammaVal) gammaVal.textContent = psxSettings.config.gamma.toFixed(2);
        }
        if (exposureInput) {
          exposureInput.value = psxSettings.config.exposure.toString();
          if (exposureVal) exposureVal.textContent = psxSettings.config.exposure.toFixed(2);
        }
        window.dispatchEvent(new CustomEvent('psx-settings-changed'));
      });
    }

    if (brightnessInput) {
      brightnessInput.value = psxSettings.config.brightness.toString();
      if (brightnessVal) brightnessVal.textContent = psxSettings.config.brightness.toFixed(2);
      brightnessInput.addEventListener('input', () => {
        const value = parseFloat(brightnessInput.value);
        if (brightnessVal) brightnessVal.textContent = value.toFixed(2);
        psxSettings.update({ brightness: value });
        if (this.psxPostProcessor) this.psxPostProcessor.setBrightness(value);
      });
    }

    if (contrastInput) {
      contrastInput.value = psxSettings.config.contrast.toString();
      if (contrastVal) contrastVal.textContent = psxSettings.config.contrast.toFixed(2);
      contrastInput.addEventListener('input', () => {
        const value = parseFloat(contrastInput.value);
        if (contrastVal) contrastVal.textContent = value.toFixed(2);
        psxSettings.update({ contrast: value });
        if (this.psxPostProcessor) this.psxPostProcessor.setContrast(value);
      });
    }

    if (saturationInput) {
      saturationInput.value = psxSettings.config.saturation.toString();
      if (saturationVal) saturationVal.textContent = psxSettings.config.saturation.toFixed(2);
      saturationInput.addEventListener('input', () => {
        const value = parseFloat(saturationInput.value);
        if (saturationVal) saturationVal.textContent = value.toFixed(2);
        psxSettings.update({ saturation: value });
        if (this.psxPostProcessor) this.psxPostProcessor.setSaturation(value);
      });
    }

    if (gammaInput) {
      gammaInput.value = psxSettings.config.gamma.toString();
      if (gammaVal) gammaVal.textContent = psxSettings.config.gamma.toFixed(2);
      gammaInput.addEventListener('input', () => {
        const value = parseFloat(gammaInput.value);
        if (gammaVal) gammaVal.textContent = value.toFixed(2);
        psxSettings.update({ gamma: value });
        if (this.psxPostProcessor) this.psxPostProcessor.setGamma(value);
      });
    }

    if (exposureInput) {
      exposureInput.value = psxSettings.config.exposure.toString();
      if (exposureVal) exposureVal.textContent = psxSettings.config.exposure.toFixed(2);
      exposureInput.addEventListener('input', () => {
        const value = parseFloat(exposureInput.value);
        if (exposureVal) exposureVal.textContent = value.toFixed(2);
        psxSettings.update({ exposure: value });
        if (this.psxPostProcessor) this.psxPostProcessor.setExposure(value);
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
        offset: { x: 0, y: 0, z: 0 },
        rot: { x: 0, y: 0, z: 0 },
        swingLimit: 45,
        twistLimit: 35,
      };
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
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.levelScene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(5, 10, 5);
    this.levelScene.add(directional);

    // Add a grid for reference
    const gridHelper = new THREE.GridHelper(100, 100, 0x444444, 0x222222);
    gridHelper.position.y = 0.01; // Slightly above ground to prevent z-fighting
    this.levelScene.add(gridHelper);

    this.levelObstacleGroup.name = 'level-obstacles';
    this.levelScene.add(this.levelObstacleGroup);

    // Obstacles are loaded from the selected scene in the level editor UI.
  }

  private createSettingsScene() {
    // Minimal scene for settings preview
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    this.settingsScene.add(ambient);

    // Add a simple preview cube for graphics settings testing
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x4488ff, roughness: 0.5 });
    const cube = new THREE.Mesh(geometry, material);
    cube.position.set(0, 1, 0);
    this.settingsScene.add(cube);

    // Add floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshStandardMaterial({ color: 0x333333 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.settingsScene.add(floor);
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
    this.isPlaying = false;
    if (status) status.textContent = 'Ragdoll: on';
  }

  private disableRagdoll() {
    this.detachRagdollTransform();
    this.ragdollEnabled = false;
    this.ragdollRecording = false;
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
    const getBone = (name: string) => humanoid.getRawBoneNode(name as HumanBoneName);
    const defs = this.ragdollDefs;

    const tmpVec = new THREE.Vector3();
    const tmpVec2 = new THREE.Vector3();
    const tmpVec3 = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const tmpQuat2 = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const jointStiffness = 40;
    const jointDamping = 13;
    const spineStiffness = 58;
    const spineDamping = 16;
    const fallbackLengths: Record<string, number> = {
      hips: 0.28,
      spine: 0.22,
      chest: 0.2,
      upperChest: 0.18,
      neck: 0.12,
      head: 0.2,
      leftUpperArm: 0.34,
      leftLowerArm: 0.28,
      leftHand: 0.16,
      rightUpperArm: 0.34,
      rightLowerArm: 0.28,
      rightHand: 0.16,
      leftUpperLeg: 0.46,
      leftLowerLeg: 0.44,
      leftFoot: 0.2,
      rightUpperLeg: 0.46,
      rightLowerLeg: 0.44,
      rightFoot: 0.2,
    };
    const segmentRadii: Record<string, number> = {
      hips: 0.12,
      spine: 0.08,
      chest: 0.09,
      upperChest: 0.085,
      neck: 0.055,
      head: 0.095,
      leftUpperArm: 0.04,
      leftLowerArm: 0.035,
      leftHand: 0.032,
      rightUpperArm: 0.04,
      rightLowerArm: 0.035,
      rightHand: 0.032,
      leftUpperLeg: 0.06,
      leftLowerLeg: 0.05,
      leftFoot: 0.045,
      rightUpperLeg: 0.06,
      rightLowerLeg: 0.05,
      rightFoot: 0.045,
    };
    const segmentDensity: Record<string, number> = {
      hips: 70,
      spine: 65,
      chest: 62,
      upperChest: 58,
      neck: 44,
      head: 48,
      leftUpperArm: 36,
      leftLowerArm: 32,
      leftHand: 26,
      rightUpperArm: 36,
      rightLowerArm: 32,
      rightHand: 26,
      leftUpperLeg: 50,
      leftLowerLeg: 44,
      leftFoot: 34,
      rightUpperLeg: 50,
      rightLowerLeg: 44,
      rightFoot: 34,
    };
    const muscleScaleByBone: Record<string, number> = {
      hips: 1.25,
      spine: 1.2,
      chest: 1.15,
      upperChest: 1.1,
      neck: 1.0,
      head: 0.9,
      leftUpperArm: 0.85,
      leftLowerArm: 0.75,
      leftHand: 0.65,
      rightUpperArm: 0.85,
      rightLowerArm: 0.75,
      rightHand: 0.65,
      leftUpperLeg: 1.0,
      leftLowerLeg: 0.9,
      leftFoot: 0.75,
      rightUpperLeg: 1.0,
      rightLowerLeg: 0.9,
      rightFoot: 0.75,
    };
    const COLLISION_GROUP_ENV = 0x0001;
    const COLLISION_GROUP_TORSO = 0x0002;
    const COLLISION_GROUP_ARM_L = 0x0004;
    const COLLISION_GROUP_ARM_R = 0x0008;
    const COLLISION_GROUP_LEG_L = 0x0010;
    const COLLISION_GROUP_LEG_R = 0x0020;
    const getBodyGroup = (name: string) => {
      if (
        name === 'hips' ||
        name === 'spine' ||
        name === 'chest' ||
        name === 'upperChest' ||
        name === 'neck' ||
        name === 'head'
      ) {
        return COLLISION_GROUP_TORSO;
      }
      if (
        name.startsWith('leftUpperArm') ||
        name.startsWith('leftLowerArm') ||
        name.startsWith('leftHand')
      ) {
        return COLLISION_GROUP_ARM_L;
      }
      if (
        name.startsWith('rightUpperArm') ||
        name.startsWith('rightLowerArm') ||
        name.startsWith('rightHand')
      ) {
        return COLLISION_GROUP_ARM_R;
      }
      if (
        name.startsWith('leftUpperLeg') ||
        name.startsWith('leftLowerLeg') ||
        name.startsWith('leftFoot')
      ) {
        return COLLISION_GROUP_LEG_L;
      }
      if (
        name.startsWith('rightUpperLeg') ||
        name.startsWith('rightLowerLeg') ||
        name.startsWith('rightFoot')
      ) {
        return COLLISION_GROUP_LEG_R;
      }
      return COLLISION_GROUP_TORSO;
    };
    const allBodyGroups =
      COLLISION_GROUP_TORSO |
      COLLISION_GROUP_ARM_L |
      COLLISION_GROUP_ARM_R |
      COLLISION_GROUP_LEG_L |
      COLLISION_GROUP_LEG_R;
    const hingeJoints: Record<
      string,
      { axis: [number, number, number]; min: number; max: number }
    > = {
      leftLowerArm: { axis: [1, 0, 0], min: 0, max: 2.1 },
      rightLowerArm: { axis: [1, 0, 0], min: 0, max: 2.1 },
      leftLowerLeg: { axis: [1, 0, 0], min: 0, max: 2.35 },
      rightLowerLeg: { axis: [1, 0, 0], min: 0, max: 2.35 },
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
    const ballJointLimits: Record<string, { swingDeg: number; twistDeg: number }> = {
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

    const childByParent = new Map<string, string>();
    for (const def of defs) {
      if (def.parent && !childByParent.has(def.parent)) childByParent.set(def.parent, def.name);
    }
    const terminalChildFallback: Record<string, string> = {
      leftFoot: 'leftToes',
      rightFoot: 'rightToes',
    };
    const terminalAxisHintLocal: Record<string, THREE.Vector3> = {
      leftFoot: new THREE.Vector3(0, 0, 1),
      rightFoot: new THREE.Vector3(0, 0, 1),
    };

    for (const def of defs) {
      const bone = getBone(def.name);
      if (!bone) continue;
      bone.getWorldPosition(tmpVec); // start at this joint
      const childName = childByParent.get(def.name) ?? terminalChildFallback[def.name];
      const child = childName ? getBone(childName) : null;
      const axis = new THREE.Vector3(0, 1, 0);
      const start = tmpVec.clone();
      const end = tmpVec2.copy(start);
      if (child) {
        child.getWorldPosition(end);
        const dir = end.clone().sub(start);
        if (dir.lengthSq() > 1e-8) {
          axis.copy(dir.normalize());
        }
      } else {
        const parentName = def.parent;
        const parent = parentName ? getBone(parentName) : null;
        const axisHint = terminalAxisHintLocal[def.name];
        if (axisHint) {
          bone.getWorldQuaternion(tmpQuat2);
          axis.copy(axisHint).applyQuaternion(tmpQuat2).normalize();
        } else if (parent) {
          parent.getWorldPosition(tmpVec3);
          axis.copy(start).sub(tmpVec3);
          if (axis.lengthSq() > 1e-8) {
            axis.normalize();
          } else {
            bone.getWorldQuaternion(tmpQuat2);
            axis.copy(up).applyQuaternion(tmpQuat2).normalize();
          }
        } else {
          bone.getWorldQuaternion(tmpQuat2);
          axis.copy(up).applyQuaternion(tmpQuat2).normalize();
        }
        const fallbackLength = fallbackLengths[def.name] ?? 0.25;
        end.copy(start).add(axis.clone().multiplyScalar(fallbackLength));
      }
      const segmentLength = Math.max(0.08, start.distanceTo(end));
      const center = start.clone().add(end).multiplyScalar(0.5);
      tmpQuat.setFromUnitVectors(up, axis);
      const boneWorldQuat = bone.getWorldQuaternion(new THREE.Quaternion());
      const rigCfg = (this.playerConfig.ragdollRig[def.name] ?? {}) as {
        radiusScale?: number;
        lengthScale?: number;
        offset?: Vec3;
        rot?: Vec3;
        swingLimit?: number;
        twistLimit?: number;
      };
      const offsetLocal = new THREE.Vector3(
        Number(rigCfg.offset?.x ?? 0),
        Number(rigCfg.offset?.y ?? 0),
        Number(rigCfg.offset?.z ?? 0),
      );
      const offsetWorld = offsetLocal.applyQuaternion(boneWorldQuat);
      center.add(offsetWorld);
      const rotOffset = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          Number(rigCfg.rot?.x ?? 0),
          Number(rigCfg.rot?.y ?? 0),
          Number(rigCfg.rot?.z ?? 0),
        ),
      );
      tmpQuat.multiply(rotOffset).normalize();
      const bodyToBone = tmpQuat.clone().invert().multiply(boneWorldQuat);
      const lengthScale = Math.max(0.3, Number(rigCfg.lengthScale ?? 1));
      const radiusScale = Math.max(0.3, Number(rigCfg.radiusScale ?? 1));
      const scaledLength = segmentLength * lengthScale;
      let radius = (segmentRadii[def.name] ?? 0.05) * radiusScale;
      radius = Math.min(radius, scaledLength * 0.35);
      radius = Math.max(0.02, radius);
      const halfHeight = Math.max(0, scaledLength * 0.5 - radius);
      const limb =
        def.name.includes('Arm') ||
        def.name.includes('Leg') ||
        def.name.includes('Hand') ||
        def.name.includes('Foot');
      const axial =
        def.name === 'hips' ||
        def.name === 'spine' ||
        def.name === 'chest' ||
        def.name === 'upperChest';
      const linearDampingBase = axial ? 4.2 : limb ? 3.2 : 3.6;
      const angularDampingBase = axial ? 6.5 : limb ? 5.2 : 5.8;
      const linearDamping = linearDampingBase * Math.max(0, sim.bodyLinearDampingScale);
      const angularDamping = angularDampingBase * Math.max(0, sim.bodyAngularDampingScale);
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setRotation({ x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w })
        .setLinearDamping(linearDamping)
        .setAngularDamping(angularDamping)
        .setCanSleep(true)
        .setCcdEnabled(true);
      const body = world.createRigidBody(bodyDesc);
      const membership = getBodyGroup(def.name);
      const filter = COLLISION_GROUP_ENV | (allBodyGroups & ~membership);
      const collider = (
        halfHeight > 0.01
          ? RAPIER.ColliderDesc.capsule(halfHeight, radius)
          : RAPIER.ColliderDesc.ball(radius)
      ).setCollisionGroups((membership << 16) | filter);
      collider
        .setDensity(segmentDensity[def.name] ?? 40)
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
        halfHeight > 0.01
          ? new THREE.Mesh(new THREE.CapsuleGeometry(radius, halfHeight * 2, 6, 10), debugMat)
          : new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 8), debugMat);
      debugMesh.renderOrder = 12;
      debugMesh.userData.ragdollName = def.name;
      debugMesh.visible = this.ragdollEnabled || this.ragdollVisible;
      debugMesh.position.copy(center);
      debugMesh.quaternion.copy(tmpQuat);
      this.scene.add(debugMesh);
      this.ragdollDebugMeshes.push(debugMesh);
      const ragBone: RagdollBone = {
        name: def.name,
        bone,
        child,
        body,
        bodyToBone,
        muscleScale: muscleScaleByBone[def.name] ?? 1,
        baseLength: scaledLength,
        radius,
        settleTime: 0,
        axis,
        basePos: center.clone(),
        baseRot: tmpQuat.clone(),
        boneWorldQuat: boneWorldQuat.clone(),
      };
      const hinge = hingeJoints[def.name];
      if (hinge) {
        ragBone.hingeAxisLocal = new THREE.Vector3(
          hinge.axis[0],
          hinge.axis[1],
          hinge.axis[2],
        ).normalize();
        ragBone.hingeMin = hinge.min;
        ragBone.hingeMax = hinge.max;
      }
      const ballLimit = ballJointLimits[def.name];
      if (ballLimit) {
        ragBone.swingLimitRad = THREE.MathUtils.degToRad(
          Number(rigCfg.swingLimit ?? ballLimit.swingDeg),
        );
        ragBone.twistLimitRad = THREE.MathUtils.degToRad(
          Number(rigCfg.twistLimit ?? ballLimit.twistDeg),
        );
        if (def.parent) {
          const parentBone = getBone(def.parent);
          if (parentBone) {
            const parentWorldQuat = parentBone.getWorldQuaternion(new THREE.Quaternion());
            ragBone.twistAxisLocal = axis
              .clone()
              .applyQuaternion(parentWorldQuat.invert())
              .normalize();
          }
        }
      }
      this.ragdollBones.set(def.name, ragBone);
    }
    const pelvis = this.ragdollBones.get('hips');
    if (pelvis) {
      pelvis.body.applyImpulse({ x: 0, y: sim.startImpulseY, z: 0 }, true);
    }

    for (const def of defs) {
      if (!def.parent) continue;
      const childBone = this.ragdollBones.get(def.name);
      const parentBone = this.ragdollBones.get(def.parent);
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
      const hinge = hingeJoints[def.name];
      const isSpineJoint = spineJointChildren.has(def.name);
      const preset = jointTuning[def.name];
      const stiffnessBase = preset?.stiffness ?? (isSpineJoint ? spineStiffness : jointStiffness);
      const dampingBase = preset?.damping ?? (isSpineJoint ? spineDamping : jointDamping);
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
      const pRotInit = parentBody.rotation();
      const cRotInit = childBody.rotation();
      const parentBodyQuat = new THREE.Quaternion(pRotInit.x, pRotInit.y, pRotInit.z, pRotInit.w);
      const childBodyQuat = new THREE.Quaternion(cRotInit.x, cRotInit.y, cRotInit.z, cRotInit.w);
      childBone.targetLocalQuat = parentBodyQuat.invert().multiply(childBodyQuat).normalize();
    }
  }

  private stepRagdoll(delta: number) {
    if (!this.ragdollWorld || !this.rapier || !this.vrm) return;
    const sim = this.getRagdollSimConfig();
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
    for (const ragBone of this.ragdollBones.values()) {
      if (!ragBone.parent || !ragBone.targetLocalQuat) continue;
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
      const kp = kpBase * muscleScale;
      const kd = kdBase * Math.sqrt(Math.max(0.2, muscleScale));
      const maxTorque = maxTorqueBase * muscleScale;
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
