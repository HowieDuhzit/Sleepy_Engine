import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import { retargetMixamoClip } from '../game/retarget';
import type * as RAPIER from '@dimforge/rapier3d-compat';
import { buildAnimationClipFromData, parseClipPayload, type BoneFrame, type ClipData } from '../game/clip';

const MAX_DURATION = 10;
const SAMPLE_RATE = 30;
const ROOT_BONE_KEY = 'hips';

type MixamoEntry = {
  name: string;
  clip: THREE.AnimationClip;
  rig: THREE.Object3D;
};

type RestPose = {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
};

type Vec3 = { x: number; y: number; z: number };

type RagdollBone = {
  name: string;
  bone: THREE.Object3D;
  body: RAPIER.RigidBody;
  parent?: RagdollBone;
  baseLength?: number;
  axis?: THREE.Vector3;
  basePos?: THREE.Vector3;
  baseRot?: THREE.Quaternion;
  boneWorldQuat?: THREE.Quaternion;
};

export class EditorApp {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private viewport: HTMLDivElement | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private viewportObserver: ResizeObserver | null = null;
  private boneMarkers: Map<string, THREE.Mesh> = new Map();
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
  private bones: THREE.Object3D[] = [];
  private boneByName = new Map<string, THREE.Object3D>();
  private boneByKey = new Map<string, THREE.Object3D>();
  private selectedBone: THREE.Object3D | null = null;
  private restPose = new Map<string, RestPose>();
  private time = 0;
  private isPlaying = false;
  private clip: ClipData = { duration: 5, frames: [] };
  private mixer: THREE.AnimationMixer | null = null;
  private mixamoEntries: MixamoEntry[] = [];
  private currentMixamo: THREE.AnimationAction | null = null;
  private retargetedClip: THREE.AnimationClip | null = null;
  private retargetedName = 'none';
  private fps = 30;
  private rapier: typeof import('@dimforge/rapier3d-compat') | null = null;
  private rapierReady: Promise<void> | null = null;
  private ragdollWorld: RAPIER.World | null = null;
  private ragdollBones: Map<string, RagdollBone> = new Map();
  private ragdollEnabled = false;
  private ragdollVisible = false;
  private ragdollRecording = false;
  private ragdollTime = 0;
  private ragdollNextSample = 0;
  private hipsOffset = new THREE.Vector3();
  private dpr = Math.min(window.devicePixelRatio, 2);
  private skeletonHelper: THREE.SkeletonHelper | null = null;
  private ragdollDebugMeshes: THREE.Object3D[] = [];
  private dragActive = false;
  private boneOverlay: HTMLDivElement | null = null;
  private boneGizmoGroup: THREE.Group | null = null;
  private boneGizmos: Map<string, { joint: THREE.Mesh; stick: THREE.Mesh; parent?: THREE.Object3D }> =
    new Map();
  private ragdollTransform: TransformControls | null = null;
  private selectedRagdoll: string | null = null;
  private ragdollHandles: THREE.Group | null = null;
  private ragdollHandleActive: 'start' | 'end' | null = null;
  private ragdollHandleRay = new THREE.Ray();
  private ragdollHandleLine = new THREE.Line3();
  private ragdollHandleTemp = new THREE.Vector3();
  private ragdollHandleTemp2 = new THREE.Vector3();

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
  private boneVisualsVisible = true;
  private overrideMode = false;
  private currentTab: 'animation' | 'player' = 'animation';
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
  private playerConfig = {
    ikOffset: 0.02,
    capsuleRadiusScale: 1,
    capsuleHeightScale: 1,
    capsuleYOffset: 0,
    ragdollRig: {} as Record<
      string,
      { radiusScale: number; lengthScale: number; offset?: Vec3; rot?: Vec3; swingLimit?: number; twistLimit?: number }
    >,
  };

  constructor(container: HTMLElement | null) {
    if (!container) throw new Error('Missing #app container');
    this.container = container;
    this.container.tabIndex = 0;

    this.gltfLoader.register((parser) => new VRMLoaderPlugin(parser));
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0b0c12, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0b0c12, 12, 90);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(0, 1.6, -4.2);
    this.camera.lookAt(0, 1.4, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 1.2, 0);
    this.controls.minDistance = 1.4;
    this.controls.maxDistance = 20;

    this.ragdollTransform = new TransformControls(this.camera, this.renderer.domElement);
    (this.ragdollTransform as unknown as THREE.Object3D).visible = false;
    this.ragdollTransform.setMode('translate');
    this.ragdollTransform.addEventListener('dragging-changed', (event) => {
      if (this.controls) this.controls.enabled = !event.value;
    });
    this.scene.add(this.ragdollTransform as unknown as THREE.Object3D);

    this.hud = this.createHud();
    this.viewport?.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.container.appendChild(this.hud);
    this.resizeRenderer();
    this.renderer.domElement.addEventListener('pointerdown', this.handleViewportPick);
    window.addEventListener('pointermove', this.handleRagdollDrag);
    window.addEventListener('pointerup', this.handleRagdollDragEnd);
    this.viewport?.addEventListener('dragover', this.handleDragOver);
    this.viewport?.addEventListener('drop', this.handleDrop);
    this.viewport?.addEventListener('dragleave', this.handleDragLeave);

    window.addEventListener('resize', this.handleResize);
    if (this.viewport) {
      this.viewportObserver = new ResizeObserver(() => {
        this.resizeRenderer();
        this.fitCameraToVrm();
      });
      this.viewportObserver.observe(this.viewport);
    }
    this.loadVrm();
  }

  start() {
    if (this.animationId !== null) return;
    this.clock.start();
    this.tick();
  }

  stop() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('pointerdown', this.handleViewportPick);
    window.removeEventListener('pointermove', this.handleRagdollDrag);
    window.removeEventListener('pointerup', this.handleRagdollDragEnd);
    if (this.viewportObserver && this.viewport) {
      this.viewportObserver.unobserve(this.viewport);
      this.viewportObserver.disconnect();
      this.viewportObserver = null;
    }
    this.viewport?.removeEventListener('dragover', this.handleDragOver);
    this.viewport?.removeEventListener('drop', this.handleDrop);
    this.viewport?.removeEventListener('dragleave', this.handleDragLeave);
    this.renderer.dispose();
    this.container.innerHTML = '';
  }

  private handleResize = () => {
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.resizeRenderer();
    this.resizeTimeline();
    this.fitCameraToVrm();
  };

  private tick = () => {
    const delta = this.clock.getDelta();
    if (this.ragdollEnabled && this.ragdollWorld) {
      this.stepRagdoll(delta);
    } else if (this.isPlaying) {
      this.time += delta;
      if (this.time > this.clip.duration) this.time = 0;
    }
    if (this.ragdollVisible && !this.ragdollEnabled) {
      this.updateRagdollDebugFromBones();
    }
    if (this.vrm && this.controls) {
      const hips = this.vrm.humanoid.getRawBoneNode('hips');
      if (hips) {
        hips.getWorldPosition(this.controls.target);
      }
    }
    this.controls?.update();
    if (this.vrm) this.vrm.update(delta);
    if (this.mixer && this.currentMixamo) this.mixer.update(delta);
    if (this.isPlaying) {
      this.applyClipAtTime(this.time);
      this.updateTimeline();
    }
    this.updateBoneMarkers();
    this.updateBoneGizmos();
    this.drawAxisWidget();
    this.renderer.render(this.scene, this.camera);
    this.animationId = requestAnimationFrame(this.tick);
  };

  private createHud() {
    const hud = document.createElement('div');
    hud.className = 'editor-ui';
    hud.innerHTML = [
      '<div class="editor-header">',
      '<div class="editor-title">Sleepy Engine Editor</div>',
      '<div class="editor-tabs">',
      '<button class="editor-tab active" data-tab="animation">Animation</button>',
      '<button class="editor-tab" data-tab="player">Player</button>',
      '</div>',
      '</div>',
      '<div class="editor-shell">',
      '<div class="editor-left" data-tab-panel="animation" style="display:none;"></div>',
      '<div class="editor-left" data-tab-panel="player" style="display:none;">',
      '<div class="panel">',
      '<div class="panel-title">Player Controller</div>',
      '<label class="field"><span>IK Offset</span><input data-ik-offset type="number" step="0.01" /></label>',
      '<label class="field"><span>Capsule Radius Scale</span><input data-cap-radius type="number" step="0.05" /></label>',
      '<label class="field"><span>Capsule Height Scale</span><input data-cap-height type="number" step="0.05" /></label>',
      '<label class="field"><span>Capsule Y Offset</span><input data-cap-y type="number" step="0.01" /></label>',
      '<div class="panel-actions">',
      '<button data-player-load>Load</button>',
      '<button data-player-save>Save</button>',
      '</div>',
      '<div class="clip-status" data-player-status></div>',
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
      '</div>',
      '<div class="editor-view" data-viewport>',
      '<div class="viewport-overlay">',
      '<div class="overlay-stack">',
      '<div class="overlay-group">',
      '<button class="icon-btn" data-bones-toggle title="Toggle Bones">B</button>',
      '<label class="overlay-slider" data-bone-scale-wrap style="display:none;">',
      '<span>Size</span>',
      '<input data-bone-scale type="range" min="0.02" max="0.2" step="0.01" />',
      '</label>',
      '<button class="icon-btn" data-reset title="Reset Pose">R</button>',
      '<button class="icon-btn" data-clear title="Clear Clip">C</button>',
      '</div>',
      '<div class="overlay-group">',
      '<button class="icon-btn" data-ragdoll title="Ragdoll">RG</button>',
      '<button class="icon-btn" data-ragdoll-visual title="Ragdoll Visual">RV</button>',
      '<button class="icon-btn" data-ragdoll-reset title="Ragdoll Reset">RR</button>',
      '<button class="icon-btn" data-ragdoll-record title="Ragdoll Record">REC</button>',
      '<button class="icon-btn" data-ragdoll-stop title="Ragdoll Stop">STP</button>',
      '</div>',
      '</div>',
      '<div class="overlay-bottom-left">',
      '<div class="overlay-tabs">',
      '<button class="overlay-tab active" data-overlay-tab="mixamo">Mixamo</button>',
      '<button class="overlay-tab" data-overlay-tab="clips">Clips</button>',
      '</div>',
      '<div class="overlay-panel" data-overlay-panel="mixamo">',
      '<label class="field"><span>FBX</span><input data-mixamo-file type="file" accept=".fbx" multiple /></label>',
      '<label class="field"><span>Clip</span><select data-mixamo-clip></select></label>',
      '<div class="panel-actions">',
      '<button data-mixamo-preview>Preview</button>',
      '<button data-mixamo-bake>Bake</button>',
      '<button data-mixamo-stop>Stop</button>',
      '</div>',
      '<div class="clip-status" data-mixamo-status>Mixamo: none</div>',
      '</div>',
      '<div class="overlay-panel" data-overlay-panel="clips" style="display:none;">',
      '<div class="panel" data-clip-panel>',
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
      '<label class="duration-field"><span>FPS</span><input data-fps type="number" min="5" max="60" step="1" value="30" /></label>',
      '<label class="duration-field"><span>Duration</span><input data-duration type="number" min="1" max="10" step="0.1" value="5" /></label>',
      '</div>',
      '<span class="timeline-status" data-mixamo-status>Mixamo: none</span>',
      '<span class="timeline-status" data-ragdoll-status>Ragdoll: off</span>',
      '</div>',
      '<div class="timeline-grid timeline-midi">',
      '<div class="timeline-header" data-timeline-header></div>',
      '<div class="timeline-canvas-wrap" data-timeline-wrap>',
      '<canvas data-timeline height="64"></canvas>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');

    const tabButtons = Array.from(hud.querySelectorAll('[data-tab]')) as HTMLButtonElement[];
    const tabPanels = Array.from(hud.querySelectorAll('[data-tab-panel]')) as HTMLDivElement[];
    const overlayTabs = Array.from(hud.querySelectorAll('[data-overlay-tab]')) as HTMLButtonElement[];
    const overlayPanels = Array.from(hud.querySelectorAll('[data-overlay-panel]')) as HTMLDivElement[];
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
    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab as 'animation' | 'player';
        this.currentTab = tab;
        hud.classList.toggle('mode-animation', tab === 'animation');
        hud.classList.toggle('mode-player', tab === 'player');
        for (const btn of tabButtons) {
          btn.classList.toggle('active', btn.dataset.tab === tab);
        }
        for (const panel of tabPanels) {
          const show = panel.dataset.tabPanel === tab;
          panel.style.display = show ? '' : 'none';
        }
        this.resizeRenderer();
        this.fitCameraToVrm();
      });
    });

    overlayTabs.forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.overlayTab;
        if (!tab) return;
        for (const btn of overlayTabs) {
          btn.classList.toggle('active', btn.dataset.overlayTab === tab);
        }
        for (const panel of overlayPanels) {
          panel.style.display = panel.dataset.overlayPanel === tab ? '' : 'none';
        }
      });
    });

    hud.classList.add('mode-animation');

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
    const ragdollBtn = hud.querySelector('[data-ragdoll]') as HTMLButtonElement;
    const ragdollVisualBtn = hud.querySelector('[data-ragdoll-visual]') as HTMLButtonElement;
    const ragdollResetBtn = hud.querySelector('[data-ragdoll-reset]') as HTMLButtonElement;
    const ragdollRecordBtn = hud.querySelector('[data-ragdoll-record]') as HTMLButtonElement;
    const ragdollStopBtn = hud.querySelector('[data-ragdoll-stop]') as HTMLButtonElement;
    const ragdollStatus = hud.querySelector('[data-ragdoll-status]') as HTMLSpanElement;
    const timeline = hud.querySelector('[data-timeline]') as HTMLCanvasElement;
    const timelineHeader = hud.querySelector('[data-timeline-header]') as HTMLDivElement;
    const timelineWrap = hud.querySelector('[data-timeline-wrap]') as HTMLDivElement;
    const stepBack = hud.querySelector('[data-step-back]') as HTMLButtonElement;
    const stepForward = hud.querySelector('[data-step-forward]') as HTMLButtonElement;
    const overrideBtn = hud.querySelector('[data-override]') as HTMLButtonElement;
    const playerStatus = hud.querySelector('[data-player-status]') as HTMLDivElement;
    const ikOffsetInput = hud.querySelector('[data-ik-offset]') as HTMLInputElement;
    const capRadiusInput = hud.querySelector('[data-cap-radius]') as HTMLInputElement;
    const capHeightInput = hud.querySelector('[data-cap-height]') as HTMLInputElement;
    const capYOffsetInput = hud.querySelector('[data-cap-y]') as HTMLInputElement;
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
    const playerLoadButton = hud.querySelector('[data-player-load]') as HTMLButtonElement;
    const playerSaveButton = hud.querySelector('[data-player-save]') as HTMLButtonElement;
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
    timeInput.value = '0';
    this.resizeTimeline();
    this.drawTimeline();
    if (boneScaleInput) {
      this.boneScale = this.computeBoneScale() * 0.5;
      boneScaleInput.value = this.boneScale.toFixed(2);
    }
    if (boneScaleWrap) {
      boneScaleWrap.style.display = this.boneVisualsVisible ? 'flex' : 'none';
    }

    const setPlayerInputs = () => {
      if (!ikOffsetInput) return;
      ikOffsetInput.value = this.playerConfig.ikOffset.toFixed(2);
      capRadiusInput.value = this.playerConfig.capsuleRadiusScale.toFixed(2);
      capHeightInput.value = this.playerConfig.capsuleHeightScale.toFixed(2);
      capYOffsetInput.value = this.playerConfig.capsuleYOffset.toFixed(2);
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
        if (!name) return;
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
    };

    const readPlayerInputs = () => {
      this.playerConfig.ikOffset = Number(ikOffsetInput.value) || 0;
      this.playerConfig.capsuleRadiusScale = Number(capRadiusInput.value) || 1;
      this.playerConfig.capsuleHeightScale = Number(capHeightInput.value) || 1;
      this.playerConfig.capsuleYOffset = Number(capYOffsetInput.value) || 0;
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
    };

    playerLoadButton?.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/player-config', { cache: 'no-store' });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as Partial<typeof this.playerConfig>;
        this.playerConfig = { ...this.playerConfig, ...data };
        setPlayerInputs();
        if (playerStatus) playerStatus.textContent = 'Loaded player config.';
      } catch (error) {
        if (playerStatus) playerStatus.textContent = `Load failed: ${String(error)}`;
      }
    });

    playerSaveButton?.addEventListener('click', async () => {
      try {
        readPlayerInputs();
        const res = await fetch('/api/player-config', {
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

    setPlayerInputs();
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
    rigRadiusInput?.addEventListener('input', () => {
      const name = rigBoneSelect.value;
      if (!name) return;
      this.playerConfig.ragdollRig[name] = {
        radiusScale: Number(rigRadiusInput.value) || 1,
        lengthScale: Number(rigLengthInput.value) || 1,
        offset: { x: Number(rigOffX.value) || 0, y: Number(rigOffY.value) || 0, z: Number(rigOffZ.value) || 0 },
        rot: { x: Number(rigRotX.value) || 0, y: Number(rigRotY.value) || 0, z: Number(rigRotZ.value) || 0 },
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
        offset: { x: Number(rigOffX.value) || 0, y: Number(rigOffY.value) || 0, z: Number(rigOffZ.value) || 0 },
        rot: { x: Number(rigRotX.value) || 0, y: Number(rigRotY.value) || 0, z: Number(rigRotZ.value) || 0 },
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
        offset: { x: Number(rigOffX.value) || 0, y: Number(rigOffY.value) || 0, z: Number(rigOffZ.value) || 0 },
        rot: { x: Number(rigRotX.value) || 0, y: Number(rigRotY.value) || 0, z: Number(rigRotZ.value) || 0 },
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
        void this.toggleRagdollVisual(ragdollStatus);
      } else if (!rigShowInput.checked && this.ragdollVisible) {
        void this.toggleRagdollVisual(ragdollStatus);
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
      const cfg = this.playerConfig.ragdollRig[this.selectedRagdoll] ?? { radiusScale: 1, lengthScale: 1 };
      cfg.offset = { x: offsetLocal.x, y: offsetLocal.y, z: offsetLocal.z };
      cfg.rot = { x: euler.x, y: euler.y, z: euler.z };
      this.playerConfig.ragdollRig[this.selectedRagdoll] = cfg;
      setPlayerInputs();
    });
    void (async () => {
      try {
        const res = await fetch('/api/player-config', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as Partial<typeof this.playerConfig>;
        this.playerConfig = { ...this.playerConfig, ...data };
        setPlayerInputs();
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
      const wrap = this.timelineWrap;
      const rect = this.timeline.getBoundingClientRect();
      const scrollX = wrap ? wrap.scrollLeft : 0;
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left)) + scrollX;
      const totalFrames = Math.max(1, Math.floor(this.clip.duration * this.fps));
      const frameIndex = Math.min(totalFrames - 1, Math.floor((x / this.timeline.width) * totalFrames));
      const bone = this.selectedBone ?? this.bones[0];
      if (!bone) return;
      this.time = frameIndex / this.fps;
      this.toggleKeyframe(bone, this.time);
      this.updateTimeline();
    });

    timeInput.addEventListener('input', () => {
      this.time = parseFloat(timeInput.value);
      this.applyClipAtTime(this.time);
    });

    durationInput.addEventListener('change', () => {
      const value = Math.max(1, Math.min(MAX_DURATION, parseFloat(durationInput.value)));
      this.clip.duration = value;
      timeInput.max = value.toFixed(2);
      this.drawTimeline();
    });

    fpsInput.addEventListener('change', () => {
      const value = Math.max(5, Math.min(60, parseFloat(fpsInput.value)));
      this.fps = value;
      fpsInput.value = value.toFixed(0);
      this.drawTimeline();
    });

    addBtn.addEventListener('click', () => {
      if (this.overrideMode && this.selectedBone) {
        this.applyOverrideOffset(this.selectedBone, this.time);
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
      this.boneScale = value;
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
    });

    resetBtn.addEventListener('click', () => {
      this.resetPose();
      this.isPlaying = false;
    });

    clearBtn.addEventListener('click', () => {
      this.clip.frames = [];
      this.clip.duration = Math.max(1, Math.min(MAX_DURATION, parseFloat(durationInput.value)));
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
        const res = await fetch('/api/animations', { cache: 'no-store' });
        if (!res.ok) {
          setClipStatus(`List failed (${res.status})`, 'warn');
          return;
        }
        const data = (await res.json()) as { files?: string[] };
        const files = (data.files ?? []).filter((name) => name.toLowerCase().endsWith('.json'));
        clipSelect.innerHTML = '';
        for (const file of files) {
          const opt = document.createElement('option');
          opt.value = file;
          opt.textContent = file;
          clipSelect.appendChild(opt);
        }
        setClipStatus(`Files: ${files.length}`, 'ok');
      } catch (err) {
        setClipStatus(`List failed: ${String(err)}`, 'warn');
      }
    };

    saveBtn.addEventListener('click', async () => {
      const name = clipNameInput.value.trim() || this.retargetedName || 'clip';
      try {
        const res = await fetch(`/api/animations/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, clip: this.clip }),
        });
        if (!res.ok) {
          let detail = '';
          try {
            const body = await res.json();
            detail = body?.detail ? `: ${body.detail}` : '';
          } catch {
            // ignore
          }
          setClipStatus(`Save failed (${res.status})${detail}`, 'warn');
          return;
        }
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
      try {
        const res = await fetch(`/api/animations/${encodeURIComponent(name)}`, { cache: 'no-store' });
        if (!res.ok) {
          let detail = '';
          try {
            const body = await res.json();
            detail = body?.detail ? `: ${body.detail}` : '';
          } catch {
            // ignore
          }
          setClipStatus(`Load failed (${res.status})${detail}`, 'warn');
          return;
        }
        const payload = (await res.json()) as unknown;
        const data = parseClipPayload(payload);
        if (!data) return;
        this.clip = data;
        this.fillEmptyFramesFromPose();
        this.time = 0;
        this.rebuildClipKeyMap();
        durationInput.value = data.duration.toString();
        timeInput.max = data.duration.toFixed(2);
        timeInput.value = '0';
        this.applyClipAtTime(0);
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
      mixamoStatus.textContent = 'Mixamo: stopped';
    });

    mixamoBake.addEventListener('click', () => {
      this.bakeMixamoToClip(mixamoSelect.value, jsonBox, mixamoStatus);
    });

    ragdollBtn.addEventListener('click', () => {
      this.toggleRagdoll(ragdollStatus);
    });

    ragdollVisualBtn.addEventListener('click', () => {
      this.toggleRagdollVisual(ragdollStatus);
    });

    ragdollResetBtn.addEventListener('click', () => {
      this.resetRagdollPose();
      ragdollStatus.textContent = this.ragdollEnabled ? 'Ragdoll: on' : this.ragdollVisible ? 'Ragdoll: visual' : 'Ragdoll: off';
    });

    ragdollRecordBtn.addEventListener('click', () => {
      if (!this.ragdollEnabled) return;
      this.startRagdollRecording();
      ragdollStatus.textContent = 'Ragdoll: recording';
    });

    ragdollStopBtn.addEventListener('click', () => {
      this.ragdollRecording = false;
      ragdollStatus.textContent = this.ragdollEnabled ? 'Ragdoll: on' : 'Ragdoll: off';
    });

    return hud;
  }

  private refreshJson(textarea: HTMLTextAreaElement) {
    textarea.value = JSON.stringify(this.clip, null, 2);
  }

  private updateTimeline() {
    const timeInput = this.hud.querySelector('[data-time]') as HTMLInputElement;
    if (timeInput) timeInput.value = this.time.toFixed(2);
    this.drawTimeline();
  }

  private addKeyframe(time: number) {
    if (!this.vrm) return;
    const bones: Record<string, { x: number; y: number; z: number; w: number }> = {};
    for (const bone of this.bones) {
      const q = bone.quaternion;
      bones[this.getBoneKey(bone)] = { x: q.x, y: q.y, z: q.z, w: q.w };
    }
    const root = this.boneByKey.get(ROOT_BONE_KEY);
    const rootPos = root
      ? { x: root.position.x, y: root.position.y, z: root.position.z }
      : undefined;
    this.clip.frames.push({ time, bones, rootPos });
    this.clip.frames.sort((a, b) => a.time - b.time);
    this.rebuildClipKeyMap();
    this.drawTimeline();
  }

  private toggleKeyframe(bone: THREE.Object3D, time: number) {
    const snap = 1 / this.fps;
    const t = Math.round(time / snap) * snap;
    const key = this.getBoneKey(bone);
    if (this.overrideMode) {
      this.applyOverrideOffset(bone, t);
      this.drawTimeline();
      return;
    }
    const existing = this.clip.frames.find((frame) => Math.abs(frame.time - t) < 1e-4);
    if (existing) {
      if (existing.bones[key]) {
        delete existing.bones[key];
        if (key === ROOT_BONE_KEY) {
          delete existing.rootPos;
        }
      } else {
        const q = bone.quaternion;
        existing.bones[key] = { x: q.x, y: q.y, z: q.z, w: q.w };
        if (key === ROOT_BONE_KEY) {
          existing.rootPos = { x: bone.position.x, y: bone.position.y, z: bone.position.z };
        }
      }
      if (Object.keys(existing.bones).length === 0) {
        this.clip.frames = this.clip.frames.filter((frame) => frame !== existing);
      }
    } else {
      const q = bone.quaternion;
      this.clip.frames.push({
        time: t,
        bones: { [key]: { x: q.x, y: q.y, z: q.z, w: q.w } },
        rootPos: key === ROOT_BONE_KEY
          ? { x: bone.position.x, y: bone.position.y, z: bone.position.z }
          : undefined,
      });
      this.clip.frames.sort((a, b) => a.time - b.time);
    }
    this.rebuildClipKeyMap();
    this.applyClipAtTime(t);
    this.drawTimeline();
  }

  private applyOverrideOffset(bone: THREE.Object3D, time: number) {
    if (this.clip.frames.length === 0) return;
    const key = this.getBoneKey(bone);
    let prev: BoneFrame | null = null;
    let next: BoneFrame | null = null;
    for (let i = 0; i < this.clip.frames.length; i += 1) {
      const frame = this.clip.frames[i]!;
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
    const qa = prev!.bones[key];
    const qb = next!.bones[key];
    if (!qa || !qb) return;
    const span = Math.max(0.0001, next!.time - prev!.time);
    const t = THREE.MathUtils.clamp((time - prev!.time) / span, 0, 1);
    const base = new THREE.Quaternion(qa.x, qa.y, qa.z, qa.w).slerp(
      new THREE.Quaternion(qb.x, qb.y, qb.z, qb.w),
      t,
    );
    const current = bone.quaternion.clone();
    const offset = current.multiply(base.clone().invert());

    for (const frame of this.clip.frames) {
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
        const frame = this.clip.frames[i]!;
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
    const root = this.boneByKey.get(ROOT_BONE_KEY);
    if (root) {
      let prev: BoneFrame | null = null;
      let next: BoneFrame | null = null;
      for (let i = 0; i < frames.length; i += 1) {
        const frame = frames[i]!;
        if (!frame.rootPos) continue;
        if (frame.time <= time) prev = frame;
        if (frame.time >= time) {
          next = frame;
          break;
        }
      }
      if (prev || next) {
        if (!next) next = prev;
        if (!prev) prev = next;
        if (prev?.rootPos && next?.rootPos) {
          const span = Math.max(0.0001, next.time - prev.time);
          const t = THREE.MathUtils.clamp((time - prev.time) / span, 0, 1);
          root.position.set(
            THREE.MathUtils.lerp(prev.rootPos.x, next.rootPos.x, t),
            THREE.MathUtils.lerp(prev.rootPos.y, next.rootPos.y, t),
            THREE.MathUtils.lerp(prev.rootPos.z, next.rootPos.z, t),
          );
        }
      }
    }
    for (const [key, bone] of this.clipKeyMap.entries()) {
      let prev: BoneFrame | null = null;
      let next: BoneFrame | null = null;
      for (let i = 0; i < frames.length; i += 1) {
        const frame = frames[i]!;
        if (!frame.bones[key]) continue;
        if (frame.time <= time) prev = frame;
        if (frame.time >= time) {
          next = frame;
          break;
        }
      }
      if (!prev && !next) continue;
      if (!next) next = prev;
      if (!prev) prev = next;
      const qa = prev!.bones[key];
      const qb = next!.bones[key];
      if (!qa || !qb) continue;
      const span = Math.max(0.0001, next!.time - prev!.time);
      const t = THREE.MathUtils.clamp((time - prev!.time) / span, 0, 1);
      const q1 = new THREE.Quaternion(qa.x, qa.y, qa.z, qa.w);
      const q2 = new THREE.Quaternion(qb.x, qb.y, qb.z, qb.w);
      q1.slerp(q2, t);
      bone.quaternion.copy(q1);
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

  private loadVrm() {
    const url = '/avatars/default.vrm';
    this.gltfLoader.load(
      url,
      (gltf) => {
        this.applyVrm(gltf as any);
      },
      undefined,
      (err) => console.warn('VRM load failed', err),
    );

    this.createStudioSet();

    // Axis widget is rendered as UI overlay instead of in-world axes.
  }

  private createStudioSet() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x334466, 0.55);
    hemi.position.set(0, 20, 0);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(6, 8, 4);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-6, 4, -2);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(0, 6, -8);
    this.scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({
        color: 0x1a202c,
        roughness: 0.9,
        metalness: 0.05,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    const floorTex = this.createStudioTexture();
    if (floorTex) {
      (floor.material as THREE.MeshStandardMaterial).map = floorTex;
      (floor.material as THREE.MeshStandardMaterial).needsUpdate = true;
    }

    const cyclo = new THREE.Mesh(
      new THREE.CylinderGeometry(12, 12, 8, 64, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x0f141d,
        side: THREE.DoubleSide,
        roughness: 0.95,
      }),
    );
    cyclo.position.set(0, 4, 0);
    cyclo.rotation.y = Math.PI / 4;
    this.scene.add(cyclo);

    const backWall = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 12),
      new THREE.MeshStandardMaterial({
        color: 0x0b0f18,
        roughness: 0.95,
      }),
    );
    backWall.position.set(0, 6, -10);
    this.scene.add(backWall);

    const softboxMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.35,
      roughness: 0.3,
    });
    const softbox1 = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 0.2), softboxMat);
    softbox1.position.set(5, 4.5, 3);
    softbox1.rotation.y = -0.6;
    this.scene.add(softbox1);
    const softbox2 = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 0.2), softboxMat);
    softbox2.position.set(-5, 3.8, 2.5);
    softbox2.rotation.y = 0.7;
    this.scene.add(softbox2);

    const cStandMat = new THREE.MeshStandardMaterial({ color: 0x2b313c, roughness: 0.7 });
    const stand1 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 10), cStandMat);
    stand1.position.set(4.6, 1.6, 3.2);
    this.scene.add(stand1);
    const stand2 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.8, 10), cStandMat);
    stand2.position.set(-4.6, 1.4, 2.6);
    this.scene.add(stand2);
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

  private applyVrm(gltf: { scene: THREE.Group; userData: any }) {
    const scene = gltf.scene;
    if (typeof VRMUtils.removeUnnecessaryVertices === 'function') {
      VRMUtils.removeUnnecessaryVertices(scene);
    }
    if (typeof VRMUtils.removeUnnecessaryJoints === 'function') {
      VRMUtils.removeUnnecessaryJoints(scene);
    }
    const vrm = gltf.userData?.vrm as VRM | undefined;
    if (!vrm) return;
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      this.vrm = null;
    }
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper = null;
    }
    if (this.boneGizmoGroup) {
      this.scene.remove(this.boneGizmoGroup);
      this.boneGizmoGroup = null;
      this.boneGizmos.clear();
    }
    this.vrm = vrm;
    vrm.humanoid.autoUpdateHumanBones = false;
    vrm.scene.position.set(0, 0, 0);
    this.scene.add(vrm.scene);
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper = null;
    }
    requestAnimationFrame(() => {
      this.resizeRenderer();
      this.fitCameraToVrm(true);
    });
    this.boneScale = this.computeBoneScale();
    this.collectBones();
    this.buildBoneGizmos();
    this.populateBoneList();
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
      (gltf) => this.applyVrm(gltf as any),
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

    const camQuat = this.camera.quaternion.clone().invert();
    const axes = [
      { name: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#ef4444', neg: '#7f1d1d' },
      { name: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#22c55e', neg: '#14532d' },
      { name: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#3b82f6', neg: '#1e3a8a' },
    ];

    const drawAxis = (dir: THREE.Vector3, color: string, label: string) => {
      const v = dir.clone().applyQuaternion(camQuat);
      const x = center + v.x * scale;
      const y = center - v.y * scale;
      const depth = v.z;
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
      drawAxis(axis.dir.clone().multiplyScalar(-1), axis.neg, `-${axis.name}`);
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
      const bone = this.vrm.humanoid?.getRawBoneNode(name as any);
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
      const bone = bones[i]!;
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
    const geom = new THREE.SphereGeometry(this.boneScale * 0.6, 16, 12);
    for (const bone of this.bones) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x60a5fa, depthTest: false });
      const marker = new THREE.Mesh(geom, mat);
      marker.renderOrder = 10;
      marker.visible = this.boneVisualsVisible;
      marker.userData.boneName = bone.name;
      this.scene.add(marker);
      this.boneMarkers.set(bone.name, marker);
    }
  }

  private updateBoneMarkers() {
    if (!this.vrm) return;
    for (const bone of this.bones) {
      const marker = this.boneMarkers.get(bone.name);
      if (!marker) continue;
      const pos = bone.getWorldPosition(new THREE.Vector3());
      marker.position.copy(pos);
      const mat = marker.material as THREE.MeshBasicMaterial;
      mat.color.set(bone === this.selectedBone ? 0xf59e0b : 0x60a5fa);
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
    for (const bone of this.bones) {
      const gizmo = this.boneGizmos.get(bone.name);
      if (!gizmo) continue;
      bone.getWorldPosition(v0);
      gizmo.joint.position.copy(v0);
      const jointMat = gizmo.joint.material as THREE.MeshBasicMaterial;
      jointMat.color.set(bone === this.selectedBone ? 0xf59e0b : 0x93c5fd);
      const parent = gizmo.parent;
      if (parent && parent.type === 'Bone') {
        parent.getWorldPosition(v1);
        const dir = v0.clone().sub(v1);
        const len = dir.length();
        if (len > 0.001) {
          gizmo.stick.visible = true;
          gizmo.stick.position.copy(v1).addScaledVector(dir, 0.5);
          gizmo.stick.scale.set(1, len, 1);
          const quat = new THREE.Quaternion().setFromUnitVectors(up, dir.normalize());
          gizmo.stick.quaternion.copy(quat);
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
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
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
      if (mesh) {
        this.ragdollTransform.attach(mesh);
        (this.ragdollTransform as unknown as THREE.Object3D).visible = true;
      } else {
        this.ragdollTransform.detach();
        (this.ragdollTransform as unknown as THREE.Object3D).visible = false;
      }
    }
    this.ensureRagdollHandles();
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
    const lengthScale = Math.max(0.3, Math.min(2.0, (half * 2) / rag.baseLength));
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
    const clip = object.animations?.[0];
    if (!clip) {
      status.textContent = 'Mixamo: no animation found';
      return;
    }
    const entry: MixamoEntry = {
      name: file.name.replace(/\.fbx$/i, ''),
      clip,
      rig: object,
    };
    this.mixamoEntries.push(entry);
    const option = document.createElement('option');
    option.value = entry.name;
    option.textContent = entry.name;
    select.appendChild(option);
    if (!select.value) select.value = entry.name;
    status.textContent = `Mixamo: loaded ${entry.name}`;
    if (previewStatus && this.currentMixamo == null) {
      this.previewMixamo(entry.name, previewStatus);
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
    const retargeted = retargetMixamoClip({ clip: entry.clip, rig: entry.rig }, this.vrm, 'editor', {
      includePosition: false,
    });
    this.retargetedClip = retargeted;
    this.retargetedName = retargeted.name;
    this.currentMixamo = this.mixer.clipAction(retargeted);
    this.currentMixamo.setLoop(THREE.LoopRepeat, Infinity);
    this.currentMixamo.play();
    status.textContent = `Mixamo: preview ${entry.name}`;
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
    if (!this.mixer) this.mixer = new THREE.AnimationMixer(this.vrm.scene);
    this.stopMixamoPreview();
    this.disableRagdoll();
    const retargeted = retargetMixamoClip({ clip: entry.clip, rig: entry.rig }, this.vrm, 'editor', {
      includePosition: false,
    });
    this.retargetedClip = retargeted;
    this.retargetedName = retargeted.name;
    const action = this.mixer.clipAction(retargeted);
    action.play();
    action.paused = true;
    const frames: BoneFrame[] = [];
    const duration = Math.min(MAX_DURATION, retargeted.duration);
    for (let t = 0; t <= duration + 1e-4; t += 1 / SAMPLE_RATE) {
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
    this.time = 0;
    this.rebuildClipKeyMap();
    this.updateTimeline();
    this.refreshJson(jsonBox);
    this.drawTimeline();
    const durationInput = this.hud.querySelector('[data-duration]') as HTMLInputElement;
    const timeInput = this.hud.querySelector('[data-time]') as HTMLInputElement;
    if (durationInput) durationInput.value = duration.toFixed(2);
    if (timeInput) timeInput.max = duration.toFixed(2);
    status.textContent = `Mixamo: baked ${entry.name}`;
  }

  private buildAnimationClip() {
    return buildAnimationClipFromData(`editor_${this.retargetedName}`, this.clip, { rootKey: ROOT_BONE_KEY });
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

  private async toggleRagdoll(status: HTMLElement) {
    if (!this.vrm) return;
    if (this.ragdollEnabled) {
      this.disableRagdoll();
      status.textContent = 'Ragdoll: off';
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
    status.textContent = 'Ragdoll: on';
  }

  private disableRagdoll() {
    this.ragdollEnabled = false;
    this.ragdollRecording = false;
    this.ragdollWorld = null;
    this.ragdollBones.clear();
    this.ragdollVisible = false;
    for (const mesh of this.ragdollDebugMeshes) {
      this.scene.remove(mesh);
    }
    this.ragdollDebugMeshes = [];
  }

  private async toggleRagdollVisual(status: HTMLElement) {
    if (!this.vrm) return;
    if (this.ragdollVisible) {
      this.ragdollVisible = false;
      for (const mesh of this.ragdollDebugMeshes) {
        mesh.visible = false;
      }
      status.textContent = this.ragdollEnabled ? 'Ragdoll: on' : 'Ragdoll: off';
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
    status.textContent = this.ragdollEnabled ? 'Ragdoll: on' : 'Ragdoll: visual';
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
      if (hips) this.hipsOffset.copy(hips.getWorldPosition(new THREE.Vector3())).sub(this.vrm.scene.position);
    }
  }

  private buildRagdoll() {
    if (!this.vrm || !this.rapier) return;
    const RAPIER = this.rapier;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.ragdollWorld = world;
    const ground = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
    const groundBody = world.createRigidBody(ground);
    const groundCollider = RAPIER.ColliderDesc.cuboid(25, 0.05, 25).setTranslation(0, -0.05, 0);
    world.createCollider(groundCollider, groundBody);
    this.ragdollBones.clear();
    for (const mesh of this.ragdollDebugMeshes) {
      this.scene.remove(mesh);
    }
    this.ragdollDebugMeshes = [];
    const humanoid = this.vrm.humanoid;
    const getBone = (name: string) => humanoid.getRawBoneNode(name as any);
    const defs = this.ragdollDefs;

    const tmpVec = new THREE.Vector3();
    const tmpVec2 = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const axisQuat = new THREE.Quaternion();

    const rootBone = getBone('hips');
    if (rootBone) {
      rootBone.getWorldPosition(tmpVec);
      this.hipsOffset.copy(tmpVec).sub(this.vrm.scene.position);
    }

    for (const def of defs) {
      const bone = getBone(def.name);
      if (!bone) continue;
      bone.getWorldPosition(tmpVec);
      const childDef = defs.find((entry) => entry.parent === def.name);
      const child = childDef ? getBone(childDef.name) : null;
      let length = 0.25;
      if (child) {
        child.getWorldPosition(tmpVec2);
        length = Math.max(0.15, tmpVec.distanceTo(tmpVec2));
      }
      const boneRadiusMap: Record<string, number> = {
        hips: 0.12,
        spine: 0.1,
        chest: 0.11,
        upperChest: 0.11,
        neck: 0.06,
        head: 0.13,
        leftUpperArm: 0.06,
        rightUpperArm: 0.06,
        leftLowerArm: 0.055,
        rightLowerArm: 0.055,
        leftHand: 0.05,
        rightHand: 0.05,
        leftUpperLeg: 0.08,
        rightUpperLeg: 0.08,
        leftLowerLeg: 0.075,
        rightLowerLeg: 0.075,
        leftFoot: 0.06,
        rightFoot: 0.06,
      };
      const defaultArmRot =
        def.name === 'leftUpperArm' || def.name === 'leftLowerArm'
          ? { x: 0, y: 0, z: Math.PI / 2 }
          : def.name === 'rightUpperArm' || def.name === 'rightLowerArm'
            ? { x: 0, y: 0, z: -Math.PI / 2 }
            : { x: 0, y: 0, z: 0 };
      const rig = this.playerConfig.ragdollRig[def.name] ?? {
        radiusScale: 1,
        lengthScale: 1,
        offset: { x: 0, y: 0, z: 0 },
        rot: defaultArmRot,
        swingLimit: 45,
        twistLimit: 35,
      };
      length = Math.max(0.12, length * (rig.lengthScale ?? 1));
      let radius = Math.max(0.045, boneRadiusMap[def.name] ?? length * 0.18);
      radius = Math.max(0.03, radius * (rig.radiusScale ?? 1));
      const maxRadius = Math.max(0.03, length * 0.45);
      radius = Math.min(radius, maxRadius);
      const halfHeight = Math.max(0.05, length * 0.5 - radius);
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(tmpVec.x, tmpVec.y, tmpVec.z)
        .setLinearDamping(1.2)
        .setAngularDamping(1.1);
      let axis = new THREE.Vector3(0, 1, 0);
      let mid = tmpVec.clone();
      if (child) {
        axis = tmpVec2.clone().sub(tmpVec).normalize();
        mid = tmpVec.clone().add(tmpVec2).multiplyScalar(0.5);
      }
      const boneWorldQuat = bone.getWorldQuaternion(new THREE.Quaternion());
      const offsetLocal = new THREE.Vector3(rig.offset?.x ?? 0, rig.offset?.y ?? 0, rig.offset?.z ?? 0);
      const offsetWorld = offsetLocal.clone().applyQuaternion(boneWorldQuat);
      mid.add(offsetWorld);
      bodyDesc.setTranslation(mid.x, mid.y, mid.z);
      axisQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      const extraRot = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rig.rot?.x ?? 0, rig.rot?.y ?? 0, rig.rot?.z ?? 0),
      );
      const finalRot = axisQuat.clone().multiply(extraRot);
      bodyDesc.setRotation({ x: finalRot.x, y: finalRot.y, z: finalRot.z, w: finalRot.w });
      const body = world.createRigidBody(bodyDesc);
      const collider =
        halfHeight > 0.06
          ? RAPIER.ColliderDesc.capsule(halfHeight, radius)
          : RAPIER.ColliderDesc.ball(radius);
      world.createCollider(collider, body);
      const debugMat = new THREE.MeshBasicMaterial({
        color: 0x6ee7b7,
        wireframe: true,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      const debugMesh =
        halfHeight > 0.06
          ? new THREE.Mesh(new THREE.CapsuleGeometry(radius, halfHeight * 2, 6, 10), debugMat)
          : new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), debugMat);
      debugMesh.renderOrder = 12;
      debugMesh.userData.ragdollName = def.name;
      debugMesh.visible = this.ragdollEnabled || this.ragdollVisible;
      this.scene.add(debugMesh);
      this.ragdollDebugMeshes.push(debugMesh);
      const ragBone: RagdollBone = {
        name: def.name,
        bone,
        body,
        baseLength: length,
        axis,
        basePos: mid.clone(),
        baseRot: finalRot.clone(),
        boneWorldQuat,
      };
      this.ragdollBones.set(def.name, ragBone);
    }

    for (const def of defs) {
      if (!def.parent) continue;
      const childBone = this.ragdollBones.get(def.name);
      const parentBone = this.ragdollBones.get(def.parent);
      if (!childBone || !parentBone) continue;
      const parentBody = parentBone.body;
      const childBody = childBone.body;
      const parentPos = parentBody.translation();
      const parentRot = parentBody.rotation();
      const parentQuat = new THREE.Quaternion(parentRot.x, parentRot.y, parentRot.z, parentRot.w);
      const invParent = parentQuat.clone().invert();
      const anchorWorld = tmpVec.copy(childBone.bone.getWorldPosition(new THREE.Vector3()));
      const rel = anchorWorld.clone().sub(new THREE.Vector3(parentPos.x, parentPos.y, parentPos.z));
      rel.applyQuaternion(invParent);
      const joint = RAPIER.JointData.spherical(
        new RAPIER.Vector3(rel.x, rel.y, rel.z),
        new RAPIER.Vector3(0, 0, 0),
      );
      world.createImpulseJoint(joint, parentBody, childBody, true);
      childBone.parent = parentBone;
    }
  }

  private stepRagdoll(delta: number) {
    if (!this.ragdollWorld || !this.rapier || !this.vrm) return;
    this.ragdollWorld.timestep = Math.min(1 / 30, delta);
    this.ragdollWorld.step();
    const parentWorld = new THREE.Quaternion();
    const invParent = new THREE.Quaternion();
    const bodyQuat = new THREE.Quaternion();
    const bodyPos = new THREE.Vector3();
    for (const ragBone of this.ragdollBones.values()) {
      const { bone, body } = ragBone;
      const rot = body.rotation();
      bodyQuat.set(rot.x, rot.y, rot.z, rot.w);
      if (bone.parent) {
        bone.parent.getWorldQuaternion(parentWorld);
        invParent.copy(parentWorld).invert();
        const rel = invParent.clone().multiply(bodyQuat);
        const cfg = this.playerConfig.ragdollRig[ragBone.name];
        if (cfg && (cfg.swingLimit || cfg.twistLimit)) {
          const axis = new THREE.Vector3(0, 1, 0);
          const twist = new THREE.Quaternion();
          const swing = new THREE.Quaternion();
          const r = new THREE.Vector3(rel.x, rel.y, rel.z);
          const proj = axis.clone().multiplyScalar(r.dot(axis));
          twist.set(proj.x, proj.y, proj.z, rel.w).normalize();
          swing.copy(twist).invert().multiply(rel).normalize();
          const swingLimit = THREE.MathUtils.degToRad(cfg.swingLimit ?? 180);
          const twistLimit = THREE.MathUtils.degToRad(cfg.twistLimit ?? 180);
          const swingAngle = 2 * Math.acos(THREE.MathUtils.clamp(swing.w, -1, 1));
          const twistAngle = 2 * Math.acos(THREE.MathUtils.clamp(twist.w, -1, 1));
          const swingClamped = swingAngle > swingLimit && swingLimit > 0
            ? swing.clone().slerp(new THREE.Quaternion(), 1 - swingLimit / swingAngle)
            : swing;
          const twistClamped = twistAngle > twistLimit && twistLimit > 0
            ? twist.clone().slerp(new THREE.Quaternion(), 1 - twistLimit / twistAngle)
            : twist;
          const clampedRel = swingClamped.clone().multiply(twistClamped).normalize();
          const clampedWorld = parentWorld.clone().multiply(clampedRel);
          bone.quaternion.copy(invParent.multiply(clampedWorld));
          body.setRotation(
            { x: clampedWorld.x, y: clampedWorld.y, z: clampedWorld.z, w: clampedWorld.w },
            true,
          );
        } else {
          bone.quaternion.copy(rel);
        }
      } else {
        bone.quaternion.copy(bodyQuat);
      }
    }
    for (const mesh of this.ragdollDebugMeshes) {
      const name = mesh.userData.ragdollName as string;
      const ragBone = this.ragdollBones.get(name);
      if (!ragBone) continue;
      const pos = ragBone.body.translation();
      const rot = ragBone.body.rotation();
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
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

  private updateRagdollDebugFromBones() {
    if (!this.vrm || this.ragdollBones.size === 0) return;
    for (const mesh of this.ragdollDebugMeshes) {
      const name = mesh.userData.ragdollName as string;
      const ragBone = this.ragdollBones.get(name);
      if (!ragBone) continue;
      const pos = ragBone.bone.getWorldPosition(new THREE.Vector3());
      const rot = ragBone.bone.getWorldQuaternion(new THREE.Quaternion());
      mesh.position.copy(pos);
      mesh.quaternion.copy(rot);
    }
    this.updateRagdollHandles();
  }

  private collectBonePoints(_threshold: number) {
    return new Map<string, THREE.Vector3[]>();
  }

  private startRagdollRecording() {
    this.clip.frames = [];
    this.clip.duration = MAX_DURATION;
    this.ragdollTime = 0;
    this.ragdollNextSample = 0;
    this.ragdollRecording = true;
    this.drawTimeline();
  }

  private resizeTimeline() {
    if (!this.timeline) return;
    const rect = this.timeline.getBoundingClientRect();
    const rowHeight = 28;
    const heightPx = Math.max(rect.height, rowHeight);
    const totalFrames = Math.max(1, Math.floor(this.clip.duration * this.fps));
    const cellWidth = 18;
    const widthPx = Math.max(rect.width, totalFrames * cellWidth);
    this.timeline.width = Math.max(1, Math.floor(widthPx * this.dpr));
    this.timeline.height = Math.max(1, Math.floor(heightPx * this.dpr));
    this.timeline.style.width = `${widthPx}px`;
  }

  private drawTimeline() {
    if (!this.timeline) return;
    const ctx = this.timeline.getContext('2d');
    if (!ctx) return;
    const width = this.timeline.width;
    const height = this.timeline.height;
    const rowHeight = 28 * this.dpr;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#121418';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1 * this.dpr;
    const totalFrames = Math.max(1, Math.floor(this.clip.duration * this.fps));
    const cellWidth = width / totalFrames;
    for (let i = 0; i <= totalFrames; i += 1) {
      const x = i * cellWidth;
      const isMajor = i % this.fps === 0;
      ctx.globalAlpha = isMajor ? 0.6 : 0.2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const boxWidth = cellWidth;
    const boxHeight = rowHeight * 0.7;
    const rowY = (height - boxHeight) * 0.5;
    const bone = this.selectedBone ?? this.bones[0];
    const boneKey = bone ? this.getBoneKey(bone) : null;
    for (let f = 0; f < totalFrames; f += 1) {
      const x = f * boxWidth;
      const t = f / this.fps;
      const frame = this.clip.frames.find((fr) => Math.abs(fr.time - t) < 1e-4);
      const hasKey = boneKey ? frame && frame.bones[boneKey] : false;
      ctx.fillStyle = hasKey ? '#f5c84c' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(x + 1, rowY, Math.max(1, boxWidth - 2), boxHeight);
    }
    const playX = (this.time / this.clip.duration) * width;
    ctx.strokeStyle = '#fef08a';
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, height);
    ctx.stroke();
  }
}
