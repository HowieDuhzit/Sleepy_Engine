import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import { retargetMixamoClip } from '../game/retarget';
import type * as RAPIER from '@dimforge/rapier3d-compat';
import { buildAnimationClipFromData, type BoneFrame, type ClipData } from '../game/clip';

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

type RagdollBone = {
  name: string;
  bone: THREE.Object3D;
  body: RAPIER.RigidBody;
  parent?: RagdollBone;
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
  private boneVisualsVisible = true;
  private overrideMode = false;

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

    this.hud = this.createHud();
    this.viewport?.appendChild(this.renderer.domElement);
    this.container.appendChild(this.hud);
    this.resizeRenderer();
    this.renderer.domElement.addEventListener('pointerdown', this.handleViewportPick);
    this.viewport?.addEventListener('dragover', this.handleDragOver);
    this.viewport?.addEventListener('drop', this.handleDrop);
    this.viewport?.addEventListener('dragleave', this.handleDragLeave);

    window.addEventListener('resize', this.handleResize);
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
      '<div class="editor-shell">',
      '<div class="editor-left">',
      '<div class="panel">',
      '<div class="panel-title">Rig</div>',
      '<div class="panel-actions">',
      '<button data-bones-toggle>Hide Bones</button>',
      '<button data-reset>Reset Pose</button>',
      '<button data-clear>Clear Clip</button>',
      '</div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Mixamo</div>',
      '<label class="field"><span>FBX</span><input data-mixamo-file type="file" accept=".fbx" /></label>',
      '<label class="field"><span>Clip</span><select data-mixamo-clip></select></label>',
      '<div class="panel-actions">',
      '<button data-mixamo-preview>Preview</button>',
      '<button data-mixamo-bake>Bake</button>',
      '<button data-mixamo-stop>Stop</button>',
      '</div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Ragdoll</div>',
      '<div class="panel-actions">',
      '<button data-ragdoll>Enable</button>',
      '<button data-ragdoll-visual>Visualize</button>',
      '<button data-ragdoll-reset>Reset</button>',
      '<button data-ragdoll-record>Record</button>',
      '<button data-ragdoll-stop>Stop</button>',
      '</div>',
      '</div>',
      '<div class="panel">',
      '<div class="panel-title">Clip Data</div>',
      '<button data-download>Download JSON</button>',
      '<textarea data-json rows="10"></textarea>',
      '</div>',
      '</div>',
      '<div class="editor-view" data-viewport>',
      '<div class="viewport-label">Viewport</div>',
      '<div class="axis-widget" aria-hidden="true">',
      '<canvas data-axis width="80" height="80"></canvas>',
      '</div>',
      '<div class="bone-overlay" data-bone-overlay>',
      '<div class="bone-overlay-title">Bone</div>',
      '<label class="field"><span>Rot X</span><input data-rot-x type="range" min="-3.14" max="3.14" step="0.01" /></label>',
      '<label class="field"><span>Rot Y</span><input data-rot-y type="range" min="-3.14" max="3.14" step="0.01" /></label>',
      '<label class="field"><span>Rot Z</span><input data-rot-z type="range" min="-3.14" max="3.14" step="0.01" /></label>',
      '<div class="bone-overlay-pos" data-pos-group>',
      '<label class="field"><span>Pos X</span><input data-pos-x type="number" step="0.01" /></label>',
      '<label class="field"><span>Pos Y</span><input data-pos-y type="number" step="0.01" /></label>',
      '<label class="field"><span>Pos Z</span><input data-pos-z type="number" step="0.01" /></label>',
      '</div>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="editor-bottom">',
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
      '<div class="timeline-grid">',
      '<div class="timeline-header" data-timeline-header></div>',
      '<div class="timeline-canvas-wrap" data-timeline-wrap>',
      '<canvas data-timeline height="64"></canvas>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');

    const timeInput = hud.querySelector('[data-time]') as HTMLInputElement;
    const durationInput = hud.querySelector('[data-duration]') as HTMLInputElement;
    const fpsInput = hud.querySelector('[data-fps]') as HTMLInputElement;
    const addBtn = hud.querySelector('[data-add]') as HTMLButtonElement;
    const playButtons = Array.from(hud.querySelectorAll('[data-play]')) as HTMLButtonElement[];
    const stopButtons = Array.from(hud.querySelectorAll('[data-stop]')) as HTMLButtonElement[];
    const bonesToggleBtn = hud.querySelector('[data-bones-toggle]') as HTMLButtonElement;
    const resetBtn = hud.querySelector('[data-reset]') as HTMLButtonElement;
    const clearBtn = hud.querySelector('[data-clear]') as HTMLButtonElement;
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
    this.resizeTimeline();
    this.drawTimeline();

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
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
      const rowHeight = 20;
      if (y <= rowHeight) {
        const t = (x / this.timeline.width) * this.clip.duration;
        this.time = t;
        this.applyClipAtTime(t);
        this.updateTimeline();
        return;
      }
      const boneIndex = Math.floor((y - rowHeight) / rowHeight);
      const totalFrames = Math.max(1, Math.floor(this.clip.duration * this.fps));
      const frameIndex = Math.min(totalFrames - 1, Math.floor((x / this.timeline.width) * totalFrames));
      const bone = this.bones[boneIndex];
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

    downloadBtn.addEventListener('click', () => {
      const name = this.retargetedName || 'trashy_clip';
      const blob = new Blob([JSON.stringify(this.clip, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });

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
          link.download = 'trashy-animation.glb';
          link.click();
          URL.revokeObjectURL(url);
        },
        (err) => console.warn('GLTF export failed', err),
        { binary: true, animations: [clip] },
      );
    });

    mixamoFile.addEventListener('change', () => {
      const file = mixamoFile.files?.[0];
      if (!file) return;
      this.loadMixamoFile(file, mixamoSelect, mixamoStatus);
      mixamoFile.value = '';
    });

    mixamoPreview.addEventListener('click', () => {
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
    vrm.scene.position.y = 0;
    this.scene.add(vrm.scene);
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper = null;
    }
    const hips = vrm.humanoid.getRawBoneNode('hips');
    if (hips && this.controls) {
      const target = hips.getWorldPosition(new THREE.Vector3());
      this.controls.target.copy(target);
      this.camera.position.set(target.x, target.y + 0.4, target.z - 4.2);
      this.camera.lookAt(target);
      this.controls.update();
    }
    this.boneScale = this.computeBoneScale();
    this.collectBones();
    this.buildBoneGizmos();
    this.populateBoneList();
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
    const hits = this.raycaster.intersectObjects(Array.from(this.boneMarkers.values()), false);
    if (!hits[0]) return;
    const name = hits[0].object.userData.boneName as string | undefined;
    if (!name) return;
    const bone = this.boneByName.get(name) ?? null;
    this.setSelectedBone(bone);
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
    header.innerHTML = '<span>Bone</span><span class="timeline-scale">Time</span>';
    this.timelineHeader.appendChild(header);
    for (const bone of this.bones) {
      const row = document.createElement('div');
      row.className = 'timeline-row';
      row.textContent = this.getBoneKey(bone);
      this.timelineHeader.appendChild(row);
    }
  }

  private async loadMixamoFile(file: File, select: HTMLSelectElement, status: HTMLElement) {
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
    select.value = entry.name;
    status.textContent = `Mixamo: loaded ${entry.name}`;
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
    const defs: { name: string; parent?: string }[] = [
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

    const tmpVec = new THREE.Vector3();
    const tmpVec2 = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const axisQuat = new THREE.Quaternion();
    const bonePoints = this.collectBonePoints(0.25);

    const rootBone = getBone('hips');
    if (rootBone) {
      rootBone.getWorldPosition(tmpVec);
      this.hipsOffset.copy(tmpVec).sub(this.vrm.scene.position);
    }

    for (const def of defs) {
      const bone = getBone(def.name);
      if (!bone) continue;
      bone.getWorldPosition(tmpVec);
      const child = bone.children.find((childBone) => childBone.type === 'Bone');
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
      let radius = Math.max(0.045, boneRadiusMap[def.name] ?? length * 0.18);
      let minProj = 0;
      let maxProj = length;
      const points = bonePoints.get(bone.name);
      if (points && points.length > 4 && child) {
        const axis = tmpVec2.clone().sub(tmpVec).normalize();
        minProj = Infinity;
        maxProj = -Infinity;
        let maxDist = radius;
        for (const p of points) {
          const rel = p.clone().sub(tmpVec);
          const proj = rel.dot(axis);
          minProj = Math.min(minProj, proj);
          maxProj = Math.max(maxProj, proj);
          const closest = axis.clone().multiplyScalar(proj);
          const dist = rel.sub(closest).length();
          maxDist = Math.max(maxDist, dist);
        }
        minProj = Math.max(0, minProj);
        maxProj = Math.max(minProj + 0.05, maxProj);
        length = Math.max(0.1, maxProj - minProj);
        radius = Math.max(0.045, maxDist);
      }
      const halfHeight = Math.max(0.05, length * 0.5 - radius);
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(tmpVec.x, tmpVec.y, tmpVec.z)
        .setLinearDamping(1.2)
        .setAngularDamping(1.1);
      if (child) {
        const axis = tmpVec2.clone().sub(tmpVec).normalize();
        axisQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        bodyDesc.setRotation({
          x: axisQuat.x,
          y: axisQuat.y,
          z: axisQuat.z,
          w: axisQuat.w,
        });
      }
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
      debugMesh.visible = true;
      this.scene.add(debugMesh);
      this.ragdollDebugMeshes.push(debugMesh);
      const ragBone: RagdollBone = { name: def.name, bone, body };
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
        bone.quaternion.copy(invParent.multiply(bodyQuat));
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
  }

  private collectBonePoints(threshold: number) {
    const map = new Map<string, THREE.Vector3[]>();
    if (!this.vrm) return map;
    const tmp = new THREE.Vector3();
    this.vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.geometry) return;
      const pos = mesh.geometry.getAttribute('position');
      const skinIndex = mesh.geometry.getAttribute('skinIndex');
      const skinWeight = mesh.geometry.getAttribute('skinWeight');
      if (!pos || !skinIndex || !skinWeight) return;
      const skeleton = mesh.skeleton;
      for (let i = 0; i < pos.count; i += 1) {
        (mesh as unknown as { boneTransform: (index: number, target: THREE.Vector3) => void }).boneTransform(
          i,
          tmp,
        );
        const idx = [
          Number(skinIndex.getX(i) ?? 0),
          Number(skinIndex.getY(i) ?? 0),
          Number(skinIndex.getZ(i) ?? 0),
          Number(skinIndex.getW(i) ?? 0),
        ];
        const w = [
          Number(skinWeight.getX(i) ?? 0),
          Number(skinWeight.getY(i) ?? 0),
          Number(skinWeight.getZ(i) ?? 0),
          Number(skinWeight.getW(i) ?? 0),
        ];
        for (let j = 0; j < 4; j += 1) {
          const weight = w[j] ?? 0;
          if (weight < threshold) continue;
          const boneIndex = idx[j] ?? 0;
          if (boneIndex === undefined || boneIndex === null) continue;
          const bone = skeleton.bones[boneIndex];
          if (!bone) continue;
          const arr = map.get(bone.name) ?? [];
          arr.push(tmp.clone());
          map.set(bone.name, arr);
        }
      }
    });
    return map;
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
    const rowHeight = 20;
    const headerRows = 1;
    const totalRows = headerRows + Math.max(1, this.bones.length);
    const heightPx = Math.max(rect.height, totalRows * rowHeight);
    const totalFrames = Math.max(1, Math.floor(this.clip.duration * this.fps));
    const cellWidth = 12;
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
    const rowHeight = 20 * this.dpr;
    const headerHeight = rowHeight;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#121418';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1b1e25';
    ctx.fillRect(0, 0, width, headerHeight);
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
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let r = 0; r <= this.bones.length; r += 1) {
      const y = headerHeight + r * rowHeight;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    const boxWidth = cellWidth;
    const boxHeight = rowHeight * 0.6;
    let index = 0;
    for (const bone of this.bones) {
      const rowY = headerHeight + index * rowHeight + rowHeight * 0.2;
      if (bone === this.selectedBone) {
        ctx.fillStyle = 'rgba(245,200,76,0.08)';
        ctx.fillRect(0, rowY - rowHeight * 0.2, width, rowHeight);
      }
      for (let f = 0; f < totalFrames; f += 1) {
        const x = f * boxWidth;
        const t = f / this.fps;
        const frame = this.clip.frames.find((fr) => Math.abs(fr.time - t) < 1e-4);
        const hasKey = frame && frame.bones[this.getBoneKey(bone)];
        ctx.fillStyle = hasKey ? '#f5c84c' : 'rgba(255,255,255,0.06)';
        ctx.fillRect(x + 1, rowY + 1, Math.max(1, boxWidth - 2), boxHeight);
      }
      index += 1;
    }
    const playX = (this.time / this.clip.duration) * width;
    ctx.strokeStyle = '#fef08a';
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, height);
    ctx.stroke();
  }
}
