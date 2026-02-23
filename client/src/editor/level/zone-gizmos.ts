import * as THREE from 'three';

export type ZoneType = 'trigger' | 'spawn' | 'damage' | 'safe';

export type ZoneGizmoDefinition = {
  id: string;
  name: string;
  type: ZoneType;
  mesh: THREE.Mesh;
};

type ZoneStyle = {
  color: number;
  icon: string;
  label: string;
};

type ZoneGizmoEntry = {
  id: string;
  type: ZoneType;
  name: string;
  mesh: THREE.Mesh;
  group: THREE.Group;
  marker: THREE.Mesh;
  markerMaterial: THREE.MeshStandardMaterial;
  label: THREE.Sprite;
  labelMaterial: THREE.SpriteMaterial;
  labelTexture: THREE.CanvasTexture;
  labelContext: CanvasRenderingContext2D;
  labelKey: string;
};

const ZONE_STYLES: Record<ZoneType, ZoneStyle> = {
  trigger: { color: 0xc084fc, icon: 'T', label: 'Trigger' },
  spawn: { color: 0x22c55e, icon: 'S', label: 'Spawn' },
  damage: { color: 0xff6b6b, icon: '!', label: 'Damage' },
  safe: { color: 0x60a5fa, icon: '+', label: 'Safe' },
};

const LABEL_WIDTH = 320;
const LABEL_HEIGHT = 96;
const SELECTED_SCALE = 1.15;
const BASE_MARKER_SCALE = 0.16;
const BASE_LABEL_WIDTH_WORLD = 2.25;
const BASE_LABEL_HEIGHT_WORLD = 0.68;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class ZoneGizmos {
  private readonly root = new THREE.Group();
  private readonly entries = new Map<string, ZoneGizmoEntry>();
  private readonly freeEntries: ZoneGizmoEntry[] = [];
  private readonly markerGeometry = new THREE.OctahedronGeometry(1, 0);
  private readonly seenIds = new Set<string>();
  private selectedZoneId: string | null = null;

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'level-zone-gizmos';
    this.root.renderOrder = 90;
    this.scene.add(this.root);
  }

  sync(zones: readonly ZoneGizmoDefinition[]) {
    this.seenIds.clear();

    for (const zone of zones) {
      this.seenIds.add(zone.id);
      const entry = this.entries.get(zone.id) ?? this.acquireEntry(zone.id);
      const requiresLabelUpdate = entry.labelKey !== this.getLabelKey(zone);

      entry.id = zone.id;
      entry.mesh = zone.mesh;
      entry.name = zone.name;
      entry.type = zone.type;

      if (requiresLabelUpdate) {
        entry.labelKey = this.getLabelKey(zone);
        this.renderLabel(entry);
      }

      this.applyStyle(entry);
      entry.group.visible = true;
    }

    for (const [id, entry] of this.entries) {
      if (this.seenIds.has(id)) continue;
      this.entries.delete(id);
      entry.group.visible = false;
      this.freeEntries.push(entry);
    }

    if (this.selectedZoneId && !this.entries.has(this.selectedZoneId)) {
      this.selectedZoneId = null;
    }

    this.updateSelectionVisuals();
  }

  setSelectedZoneId(zoneId: string | null) {
    if (this.selectedZoneId === zoneId) return;
    this.selectedZoneId = zoneId;
    this.updateSelectionVisuals();
  }

  update(camera: THREE.Camera) {
    const cameraPosition = camera.position;

    for (const entry of this.entries.values()) {
      const mesh = entry.mesh;
      entry.group.position.set(
        mesh.position.x,
        mesh.position.y + mesh.scale.y * 0.5 + 0.65,
        mesh.position.z,
      );

      const distance = cameraPosition.distanceTo(entry.group.position);
      const scale = clamp(distance * 0.03, 0.8, 1.45);
      const selected = this.selectedZoneId === entry.id;
      const selectedScale = selected ? SELECTED_SCALE : 1;

      entry.label.scale.set(
        BASE_LABEL_WIDTH_WORLD * scale * selectedScale,
        BASE_LABEL_HEIGHT_WORLD * scale * selectedScale,
        1,
      );
      const markerScale = BASE_MARKER_SCALE * scale * selectedScale;
      entry.marker.scale.setScalar(markerScale);
    }
  }

  dispose() {
    this.scene.remove(this.root);
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    for (const entry of this.freeEntries) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.freeEntries.length = 0;
    this.markerGeometry.dispose();
  }

  private acquireEntry(id: string) {
    const reused = this.freeEntries.pop();
    const entry = reused ?? this.createEntry();
    entry.id = id;
    this.entries.set(id, entry);
    return entry;
  }

  private createEntry(): ZoneGizmoEntry {
    const markerMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x000000,
      emissiveIntensity: 0,
      roughness: 0.35,
      metalness: 0.1,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const marker = new THREE.Mesh(this.markerGeometry, markerMaterial);
    marker.position.y = 0;
    marker.renderOrder = 91;

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = LABEL_WIDTH;
    labelCanvas.height = LABEL_HEIGHT;
    const labelContext = labelCanvas.getContext('2d');
    if (!labelContext) {
      throw new Error('Failed to create label canvas context');
    }
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    labelTexture.minFilter = THREE.LinearFilter;
    labelTexture.magFilter = THREE.LinearFilter;
    labelTexture.generateMipmaps = false;
    const labelMaterial = new THREE.SpriteMaterial({
      map: labelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0.96,
    });
    const label = new THREE.Sprite(labelMaterial);
    label.position.set(0, 0.32, 0);
    label.renderOrder = 92;

    const group = new THREE.Group();
    group.add(marker, label);
    this.root.add(group);

    return {
      id: '',
      type: 'trigger',
      name: '',
      mesh: marker,
      group,
      marker,
      markerMaterial,
      label,
      labelMaterial,
      labelTexture,
      labelContext,
      labelKey: '',
    };
  }

  private applyStyle(entry: ZoneGizmoEntry) {
    const style = ZONE_STYLES[entry.type] ?? ZONE_STYLES.trigger;
    entry.markerMaterial.color.setHex(style.color);
    entry.markerMaterial.emissive.setHex(style.color);
    entry.markerMaterial.emissiveIntensity = this.selectedZoneId === entry.id ? 0.5 : 0.16;
  }

  private renderLabel(entry: ZoneGizmoEntry) {
    const ctx = entry.labelContext;
    const style = ZONE_STYLES[entry.type] ?? ZONE_STYLES.trigger;
    const zoneName = entry.name.trim() || entry.id;

    ctx.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);

    const chipY = 12;
    const chipHeight = LABEL_HEIGHT - chipY * 2;
    const radius = 18;

    ctx.fillStyle = 'rgba(10, 14, 24, 0.74)';
    this.roundRectPath(ctx, 0, chipY, LABEL_WIDTH, chipHeight, radius);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 2;
    this.roundRectPath(ctx, 1, chipY + 1, LABEL_WIDTH - 2, chipHeight - 2, radius - 1);
    ctx.stroke();

    ctx.fillStyle = this.toHexColor(style.color);
    ctx.beginPath();
    ctx.arc(36, LABEL_HEIGHT * 0.5, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(8, 10, 16, 0.9)';
    ctx.font = '700 16px "Trebuchet MS", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.icon, 36, LABEL_HEIGHT * 0.5 + 1);

    ctx.fillStyle = 'rgba(232,236,245,0.96)';
    ctx.textAlign = 'left';
    ctx.font = '600 22px "Trebuchet MS", "Segoe UI", sans-serif';
    const title = zoneName.length > 20 ? `${zoneName.slice(0, 19)}...` : zoneName;
    ctx.fillText(title, 62, LABEL_HEIGHT * 0.5 - 8);

    ctx.fillStyle = 'rgba(170,179,196,0.92)';
    ctx.font = '500 16px "Trebuchet MS", "Segoe UI", sans-serif';
    ctx.fillText(style.label, 62, LABEL_HEIGHT * 0.5 + 18);

    entry.labelTexture.needsUpdate = true;
  }

  private updateSelectionVisuals() {
    for (const entry of this.entries.values()) {
      const selected = this.selectedZoneId === entry.id;
      entry.labelMaterial.opacity = selected ? 1 : 0.9;
      this.applyStyle(entry);
    }
  }

  private getLabelKey(zone: ZoneGizmoDefinition) {
    return `${zone.type}|${zone.name}`;
  }

  private toHexColor(hex: number) {
    return `#${new THREE.Color(hex).getHexString()}`;
  }

  private roundRectPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ) {
    const r = Math.min(radius, width * 0.5, height * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  private disposeEntry(entry: ZoneGizmoEntry) {
    entry.group.removeFromParent();
    entry.labelMaterial.dispose();
    entry.labelTexture.dispose();
    entry.markerMaterial.dispose();
  }
}
