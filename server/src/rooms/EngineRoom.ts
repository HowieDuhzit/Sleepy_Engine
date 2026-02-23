import colyseusPkg from 'colyseus';
import { EngineState, PlayerState } from '../state/EngineState.js';
import { loadSceneConfig, type SceneObstaclePhysicsConfig } from './scene-obstacle-loader.js';
import {
  PROTOCOL,
  PlayerInput,
  MOVE_SPEED,
  SPRINT_MULTIPLIER,
  CROUCH_MULTIPLIER,
  SLIDE_ACCEL,
  SLIDE_FRICTION,
  PLAYER_RADIUS,
  CROWD_COUNT,
  CROWD_RADIUS,
  CROWD_SPEED,
  CROWD_ATTACK_RANGE,
  CROWD_ATTACK_COOLDOWN,
  CROWD_ATTACK_DAMAGE,
  CROWD_FLEE_TIME,
  CROWD_FIGHT_TIME,
  CROWD_HIT_KNOCKBACK,
  CROWD_REPEL_RADIUS,
  CROWD_REPEL_FORCE,
  CROWD_BOUNDS,
  GRAVITY,
  JUMP_SPEED,
  GROUND_Y,
  ATTACK_RANGE,
  ATTACK_COOLDOWN,
  ATTACK_DAMAGE,
  ATTACK_KNOCKBACK,
  OBSTACLES,
  type Obstacle,
  type ObstacleDynamicsSnapshot,
  resolveCircleAabb,
  resolveCircleCircle,
} from '@sleepy/shared';

const { Room } = colyseusPkg as typeof import('colyseus');
type Client = import('colyseus').Client;

type NavCell = { i: number; j: number };
type RoomOptions = {
  gameId?: string;
  sceneName?: string;
};
type TerrainPreset = 'cinematic' | 'alpine' | 'dunes' | 'islands';
type SceneTerrain = {
  enabled: boolean;
  preset: TerrainPreset;
  size: number;
  resolution: number;
  maxHeight: number;
  roughness: number;
  seed: number;
};
const JUMP_COYOTE_SECONDS = 0.14;
const DYNAMIC_OBSTACLE_PUSH_IMPULSE = 0.95;
const DYNAMIC_OBSTACLE_PUSH_MAX_SPEED = 16;
const DYNAMIC_OBSTACLE_SOLVER_ITERATIONS = 2;
const DYNAMIC_OBSTACLE_MIN_MASS = 0.05;
const DYNAMIC_OBSTACLE_PUSH_CONTACT_MARGIN = 0.1;

class NavGrid {
  private half: number;
  private cell: number;
  private cols: number;
  private rows: number;
  private blocked = new Set<string>();

  constructor(half: number, cell: number, obstacles: Obstacle[]) {
    this.half = half;
    this.cell = cell;
    this.cols = Math.floor((half * 2) / cell);
    this.rows = Math.floor((half * 2) / cell);
    for (let i = 0; i < this.cols; i += 1) {
      for (let j = 0; j < this.rows; j += 1) {
        const pos = this.cellToWorld(i, j);
        if (this.isBlocked(pos.x, pos.z, obstacles)) {
          this.blocked.add(this.key(i, j));
        }
      }
    }
  }

  private key(i: number, j: number) {
    return `${i},${j}`;
  }

  private isBlocked(x: number, z: number, obstacles: Obstacle[]) {
    for (const obstacle of obstacles) {
      const halfX = obstacle.size.x / 2 + CROWD_RADIUS;
      const halfZ = obstacle.size.z / 2 + CROWD_RADIUS;
      if (
        Math.abs(x - obstacle.position.x) <= halfX &&
        Math.abs(z - obstacle.position.z) <= halfZ
      ) {
        return true;
      }
    }
    return false;
  }

  worldToCell(x: number, z: number) {
    const i = Math.floor((x + this.half) / this.cell);
    const j = Math.floor((z + this.half) / this.cell);
    return { i, j };
  }

  cellToWorld(i: number, j: number) {
    return {
      x: -this.half + i * this.cell + this.cell / 2,
      z: -this.half + j * this.cell + this.cell / 2,
    };
  }

  randomOpen() {
    for (let tries = 0; tries < 20; tries += 1) {
      const i = Math.floor(Math.random() * this.cols);
      const j = Math.floor(Math.random() * this.rows);
      if (!this.blocked.has(this.key(i, j))) {
        return this.cellToWorld(i, j);
      }
    }
    return null;
  }

  findPath(sx: number, sz: number, gx: number, gz: number) {
    const start = this.worldToCell(sx, sz);
    const goal = this.worldToCell(gx, gz);
    const startKey = this.key(start.i, start.j);
    const goalKey = this.key(goal.i, goal.j);
    if (this.blocked.has(goalKey)) return null;

    const open: NavCell[] = [start];
    const came = new Map<string, string>();
    const gScore = new Map<string, number>();
    gScore.set(startKey, 0);

    const h = (a: NavCell, b: NavCell) => Math.abs(a.i - b.i) + Math.abs(a.j - b.j);

    while (open.length > 0) {
      const score = (n: NavCell) => (gScore.get(this.key(n.i, n.j)) ?? Infinity) + h(n, goal);
      open.sort((a, b) => score(a) - score(b));
      const current = open.shift();
      if (!current) break;
      const currentKey = this.key(current.i, current.j);
      if (currentKey === goalKey) {
        const path: Array<{ x: number; z: number }> = [];
        let k: string | undefined = currentKey;
        while (k) {
          const parts = k.split(',');
          const ci = Number(parts[0] ?? 0);
          const cj = Number(parts[1] ?? 0);
          path.push(this.cellToWorld(ci, cj));
          k = came.get(k);
        }
        return path.reverse();
      }

      const neighbors = [
        { i: current.i + 1, j: current.j },
        { i: current.i - 1, j: current.j },
        { i: current.i, j: current.j + 1 },
        { i: current.i, j: current.j - 1 },
      ];
      for (const n of neighbors) {
        if (n.i < 0 || n.j < 0 || n.i >= this.cols || n.j >= this.rows) continue;
        const nKey = this.key(n.i, n.j);
        if (this.blocked.has(nKey)) continue;
        const tentative = (gScore.get(currentKey) ?? 0) + 1;
        if (tentative < (gScore.get(nKey) ?? Infinity)) {
          came.set(nKey, currentKey);
          gScore.set(nKey, tentative);
          if (!open.find((o) => o.i === n.i && o.j === n.j)) {
            open.push(n);
          }
        }
      }
    }
    return null;
  }
}

type DynamicObstacleBody = {
  obstacle: Obstacle;
  physics: SceneObstaclePhysicsConfig;
  velocity: { x: number; y: number; z: number };
};

export class EngineRoom extends Room {
  declare state: EngineState;
  private obstacles: Obstacle[] = OBSTACLES;
  private crowdEnabled = false;
  private obstaclePhysics = new Map<string, SceneObstaclePhysicsConfig>();
  private obstacleVelocity = new Map<string, { x: number; y: number; z: number }>();
  private groundY = GROUND_Y;
  private terrain: SceneTerrain | null = null;
  private inputBuffer = new Map<string, PlayerInput>();
  private jumpCoyoteTimers = new Map<string, number>();
  private lastInputSeq = new Map<string, number>();
  private lastAttackAt = new Map<string, number>();
  private elapsed = 0;
  private readonly navCell = 2.5;
  private readonly navHalf = CROWD_BOUNDS;
  private navGrid!: NavGrid;
  private readonly CROWD_NEAR_RADIUS = 50; // Only send crowd within 50m of players
  private crowd = Array.from({ length: CROWD_COUNT }, (_, id) => ({
    id,
    x: (Math.random() - 0.5) * 30,
    y: GROUND_Y,
    z: (Math.random() - 0.5) * 30,
    vx: 0,
    vy: 0,
    vz: 0,
    targetX: 0,
    targetZ: 0,
    path: [] as Array<{ x: number; z: number }>,
    pathIndex: 0,
    health: 30,
    state: 'idle' as 'idle' | 'walk' | 'run' | 'hit' | 'attack',
    stateTimer: 0,
    stateTime: 0,
    behavior: 'wander' as 'wander' | 'flee' | 'fight',
    behaviorTimer: 0,
    lastAttackAt: -Infinity,
    threatId: '' as string,
  }));

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

  private sampleTerrainHeight(terrain: SceneTerrain, x: number, z: number) {
    const size = Math.max(16, Math.min(320, terrain.size));
    const maxHeight = Math.max(1, Math.min(64, terrain.maxHeight));
    const roughness = Math.max(0.2, Math.min(0.95, terrain.roughness));
    const nx = x / size;
    const nz = z / size;
    const macro = this.terrainFbm(nx * 4.2, nz * 4.2, terrain.seed, 5, roughness);
    const detail = this.terrainFbm(nx * 10.5, nz * 10.5, terrain.seed + 101, 3, roughness);
    const ridge =
      1 - Math.abs(2 * this.terrainFbm(nx * 6.5, nz * 6.5, terrain.seed + 53, 4, 0.6) - 1);
    const radius = Math.sqrt(nx * nx + nz * nz);
    const islandMask = Math.max(0, 1 - Math.min(1, Math.pow(radius / 0.68, 2.4)));
    const spawnMask = Math.min(1, Math.max(0, (radius - 0.09) / 0.16));

    let elevation = macro * 0.68 + detail * 0.22 + ridge * 0.35;
    if (terrain.preset === 'alpine') elevation = macro * 0.55 + ridge * 0.6 + detail * 0.25;
    if (terrain.preset === 'dunes') elevation = macro * 0.45 + detail * 0.2;
    if (terrain.preset === 'islands') elevation = (macro * 0.58 + ridge * 0.26) * islandMask;
    if (terrain.preset === 'cinematic') {
      elevation = (macro * 0.64 + ridge * 0.4 + detail * 0.18) * (0.55 + islandMask * 0.45);
    }
    elevation *= spawnMask;
    return Math.max(0, elevation * maxHeight);
  }

  private sampleGroundHeight(x: number, z: number) {
    let height = this.groundY;
    const terrain = this.terrain?.enabled ? this.terrain : null;
    if (terrain) {
      const half = Math.max(16, terrain.size) * 0.5;
      if (Math.abs(x) <= half && Math.abs(z) <= half) {
        height = this.groundY + this.sampleTerrainHeight(terrain, x, z);
      }
    }
    for (const obstacle of this.obstacles) {
      const halfX = obstacle.size.x / 2;
      const halfZ = obstacle.size.z / 2;
      if (
        Math.abs(x - obstacle.position.x) <= halfX &&
        Math.abs(z - obstacle.position.z) <= halfZ
      ) {
        height = Math.max(height, obstacle.position.y + obstacle.size.y);
      }
    }
    return height;
  }

  private isDynamicObstacleId(obstacleId: string) {
    const physics = this.obstaclePhysics.get(obstacleId);
    if (!physics) return false;
    if (!physics.enabled) return false;
    if (physics.bodyType !== 'dynamic') return false;
    if (physics.isTrigger) return false;
    return true;
  }

  private getDynamicObstacleBodies() {
    const bodies: DynamicObstacleBody[] = [];
    for (const obstacle of this.obstacles) {
      const obstacleId = String(obstacle.id ?? '').trim();
      if (!obstacleId || !this.isDynamicObstacleId(obstacleId)) continue;
      const physics = this.obstaclePhysics.get(obstacleId);
      if (!physics) continue;
      const velocity = this.obstacleVelocity.get(obstacleId) ?? { x: 0, y: 0, z: 0 };
      bodies.push({ obstacle, physics, velocity });
    }
    return bodies;
  }

  private sampleGroundHeightWithoutDynamic(ignoreObstacleId: string, x: number, z: number) {
    let height = this.groundY;
    const terrain = this.terrain?.enabled ? this.terrain : null;
    if (terrain) {
      const half = Math.max(16, terrain.size) * 0.5;
      if (Math.abs(x) <= half && Math.abs(z) <= half) {
        height = this.groundY + this.sampleTerrainHeight(terrain, x, z);
      }
    }
    for (const obstacle of this.obstacles) {
      const obstacleId = String(obstacle.id ?? '').trim();
      if (!obstacleId || obstacleId === ignoreObstacleId || this.isDynamicObstacleId(obstacleId)) continue;
      const halfX = obstacle.size.x / 2;
      const halfZ = obstacle.size.z / 2;
      if (Math.abs(x - obstacle.position.x) <= halfX && Math.abs(z - obstacle.position.z) <= halfZ) {
        height = Math.max(height, obstacle.position.y + obstacle.size.y);
      }
    }
    return height;
  }

  private async loadRoomObstacles(options?: RoomOptions) {
    const sceneConfig = await loadSceneConfig(options);
    this.obstacles = sceneConfig.obstacles;
    this.obstaclePhysics.clear();
    this.obstacleVelocity.clear();
    for (const obstacle of this.obstacles) {
      const obstacleId = String(obstacle.id ?? '').trim();
      if (!obstacleId) continue;
      const physics = sceneConfig.obstaclePhysics[obstacleId];
      if (!physics) continue;
      this.obstaclePhysics.set(obstacleId, physics);
      if (physics.enabled && physics.bodyType === 'dynamic' && !physics.isTrigger) {
        obstacle.position.y += physics.spawnHeightOffset;
        this.obstacleVelocity.set(obstacleId, {
          x: physics.initialVelocity.x,
          y: physics.initialVelocity.y,
          z: physics.initialVelocity.z,
        });
      }
    }
    this.crowdEnabled = sceneConfig.crowdEnabled;
    this.groundY = Number.isFinite(sceneConfig.groundY) ? sceneConfig.groundY : GROUND_Y;
    this.terrain = sceneConfig.terrain;
    if (!this.crowdEnabled) {
      this.crowd = [];
    }
  }

  private sanitizeInput(input: PlayerInput): PlayerInput {
    const clampUnit = (value: number) =>
      Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    const sanitizeBool = (value: unknown) => value === true;
    const sanitizeNumber = (value: number, fallback = 0) =>
      Number.isFinite(value) ? value : fallback;
    const moveX = clampUnit(input.moveX);
    const moveZ = clampUnit(input.moveZ);
    const magnitude = Math.hypot(moveX, moveZ);
    const normalizedMoveX = magnitude > 1 ? moveX / magnitude : moveX;
    const normalizedMoveZ = magnitude > 1 ? moveZ / magnitude : moveZ;
    return {
      seq: Math.max(0, Math.floor(sanitizeNumber(input.seq))),
      moveX: normalizedMoveX,
      moveZ: normalizedMoveZ,
      lookYaw: sanitizeNumber(input.lookYaw),
      lookPitch: sanitizeNumber(input.lookPitch),
      animState: typeof input.animState === 'string' ? input.animState : 'idle',
      animTime: sanitizeNumber(input.animTime),
      sprint: sanitizeBool(input.sprint),
      attack: sanitizeBool(input.attack),
      interact: sanitizeBool(input.interact),
      jump: sanitizeBool(input.jump),
      crouch: sanitizeBool(input.crouch),
      ragdoll: sanitizeBool(input.ragdoll),
    };
  }

  async onCreate(options?: RoomOptions) {
    const sanitizeSegment = (value: string | undefined, fallback: string) => {
      const cleaned = (value ?? '').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
      return cleaned || fallback;
    };
    const gameId = sanitizeSegment(options?.gameId, 'prototype');
    const sceneName = sanitizeSegment(options?.sceneName, 'prototype');

    this.setMetadata({ gameId, sceneName });
    this.setState(new EngineState());
    this.maxClients = 16;
    this.setPrivate(false);
    await this.loadRoomObstacles({ gameId, sceneName });
    this.setSimulationInterval((dt) => this.update(dt), 1000 / 20);
    this.navGrid = new NavGrid(this.navHalf, this.navCell, this.obstacles);

    this.onMessage(PROTOCOL.input, (client, message: PlayerInput) => {
      const input = this.sanitizeInput(message);
      const lastSeq = this.lastInputSeq.get(client.sessionId) ?? -1;
      if (input.seq <= lastSeq) return;
      this.lastInputSeq.set(client.sessionId, input.seq);
      this.inputBuffer.set(client.sessionId, input);
    });
  }

  onJoin(client: Client) {
    const player = new PlayerState();
    player.id = client.sessionId;
    player.x = (Math.random() - 0.5) * 10;
    player.z = (Math.random() - 0.5) * 10;
    player.y = this.sampleGroundHeight(player.x, player.z);
    player.vy = 0;
    this.state.players.set(client.sessionId, player);
    this.jumpCoyoteTimers.set(client.sessionId, 0);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputBuffer.delete(client.sessionId);
    this.jumpCoyoteTimers.delete(client.sessionId);
    this.lastInputSeq.delete(client.sessionId);
  }

  private pushDynamicObstacleByPlayer(
    player: PlayerState,
    obstacle: Obstacle,
    delta: number,
    probeX: number,
    probeY: number,
    probeZ: number,
  ) {
    if (delta <= 0) return;
    const obstacleId = String(obstacle.id ?? '').trim();
    if (!obstacleId || !this.isDynamicObstacleId(obstacleId)) return;
    const halfX = obstacle.size.x * 0.5;
    const halfZ = obstacle.size.z * 0.5;
    if (
      Math.abs(probeX - obstacle.position.x) >
        halfX + PLAYER_RADIUS + DYNAMIC_OBSTACLE_PUSH_CONTACT_MARGIN ||
      Math.abs(probeZ - obstacle.position.z) >
        halfZ + PLAYER_RADIUS + DYNAMIC_OBSTACLE_PUSH_CONTACT_MARGIN
    ) {
      return;
    }
    if (probeY >= obstacle.position.y + obstacle.size.y + 0.1) return;

    const minX = obstacle.position.x - halfX;
    const maxX = obstacle.position.x + halfX;
    const minZ = obstacle.position.z - halfZ;
    const maxZ = obstacle.position.z + halfZ;
    const clampedX = Math.max(minX, Math.min(probeX, maxX));
    const clampedZ = Math.max(minZ, Math.min(probeZ, maxZ));
    let normalX = probeX - clampedX;
    let normalZ = probeZ - clampedZ;
    let distance = Math.hypot(normalX, normalZ);

    if (distance < 1e-5) {
      const left = Math.abs(probeX - minX);
      const right = Math.abs(maxX - probeX);
      const front = Math.abs(maxZ - probeZ);
      const back = Math.abs(probeZ - minZ);
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

    const penetration = PLAYER_RADIUS + DYNAMIC_OBSTACLE_PUSH_CONTACT_MARGIN - distance;
    if (penetration <= 0) return;

    obstacle.position.x += normalX * penetration;
    obstacle.position.z += normalZ * penetration;

    const playerSpeedX = Math.max(-DYNAMIC_OBSTACLE_PUSH_MAX_SPEED, Math.min(DYNAMIC_OBSTACLE_PUSH_MAX_SPEED, player.vx));
    const playerSpeedZ = Math.max(-DYNAMIC_OBSTACLE_PUSH_MAX_SPEED, Math.min(DYNAMIC_OBSTACLE_PUSH_MAX_SPEED, player.vz));
    const normalSpeed = Math.max(0, playerSpeedX * normalX + playerSpeedZ * normalZ);
    const tangentX = playerSpeedX - normalX * normalSpeed;
    const tangentZ = playerSpeedZ - normalZ * normalSpeed;

    const physics = this.obstaclePhysics.get(obstacleId);
    const mass = Math.max(DYNAMIC_OBSTACLE_MIN_MASS, physics?.mass ?? 1);
    const inverseMassScale = 1 / mass;
    const velocity = this.obstacleVelocity.get(obstacleId) ?? { x: 0, y: 0, z: 0 };
    velocity.x +=
      (normalX * normalSpeed * DYNAMIC_OBSTACLE_PUSH_IMPULSE + tangentX * 0.35) * inverseMassScale;
    velocity.z +=
      (normalZ * normalSpeed * DYNAMIC_OBSTACLE_PUSH_IMPULSE + tangentZ * 0.35) * inverseMassScale;
    velocity.x = Math.max(-DYNAMIC_OBSTACLE_PUSH_MAX_SPEED, Math.min(DYNAMIC_OBSTACLE_PUSH_MAX_SPEED, velocity.x));
    velocity.z = Math.max(-DYNAMIC_OBSTACLE_PUSH_MAX_SPEED, Math.min(DYNAMIC_OBSTACLE_PUSH_MAX_SPEED, velocity.z));
    this.obstacleVelocity.set(obstacleId, velocity);
  }

  private resolveDynamicObstacleVsStatic(body: DynamicObstacleBody, obstacle: Obstacle) {
    const bodyHalfX = body.obstacle.size.x * 0.5;
    const bodyHalfZ = body.obstacle.size.z * 0.5;
    const otherHalfX = obstacle.size.x * 0.5;
    const otherHalfZ = obstacle.size.z * 0.5;
    const bodyTop = body.obstacle.position.y + body.obstacle.size.y;
    const obstacleTop = obstacle.position.y + obstacle.size.y;
    if (body.obstacle.position.y >= obstacleTop || obstacle.position.y >= bodyTop) return;

    const dx = body.obstacle.position.x - obstacle.position.x;
    const dz = body.obstacle.position.z - obstacle.position.z;
    const overlapX = bodyHalfX + otherHalfX - Math.abs(dx);
    const overlapZ = bodyHalfZ + otherHalfZ - Math.abs(dz);
    if (overlapX <= 0 || overlapZ <= 0) return;

    if (overlapX < overlapZ) {
      const sign = dx >= 0 ? 1 : -1;
      body.obstacle.position.x += overlapX * sign;
      if (body.velocity.x * sign < 0) body.velocity.x = -body.velocity.x * body.physics.restitution;
      return;
    }

    const sign = dz >= 0 ? 1 : -1;
    body.obstacle.position.z += overlapZ * sign;
    if (body.velocity.z * sign < 0) body.velocity.z = -body.velocity.z * body.physics.restitution;
  }

  private resolveDynamicObstaclePair(a: DynamicObstacleBody, b: DynamicObstacleBody) {
    const aHalfX = a.obstacle.size.x * 0.5;
    const aHalfZ = a.obstacle.size.z * 0.5;
    const bHalfX = b.obstacle.size.x * 0.5;
    const bHalfZ = b.obstacle.size.z * 0.5;
    const aTop = a.obstacle.position.y + a.obstacle.size.y;
    const bTop = b.obstacle.position.y + b.obstacle.size.y;
    if (a.obstacle.position.y >= bTop || b.obstacle.position.y >= aTop) return;

    const dx = a.obstacle.position.x - b.obstacle.position.x;
    const dz = a.obstacle.position.z - b.obstacle.position.z;
    const overlapX = aHalfX + bHalfX - Math.abs(dx);
    const overlapZ = aHalfZ + bHalfZ - Math.abs(dz);
    if (overlapX <= 0 || overlapZ <= 0) return;

    const aMass = Math.max(DYNAMIC_OBSTACLE_MIN_MASS, a.physics.mass);
    const bMass = Math.max(DYNAMIC_OBSTACLE_MIN_MASS, b.physics.mass);
    const totalMass = aMass + bMass;
    const aCorrection = bMass / totalMass;
    const bCorrection = aMass / totalMass;
    const restitution = Math.min(a.physics.restitution, b.physics.restitution);

    if (overlapX < overlapZ) {
      const sign = dx >= 0 ? 1 : -1;
      a.obstacle.position.x += overlapX * aCorrection * sign;
      b.obstacle.position.x -= overlapX * bCorrection * sign;
      const relative = (a.velocity.x - b.velocity.x) * sign;
      if (relative < 0) {
        const impulse = (-(1 + restitution) * relative) / (1 / aMass + 1 / bMass);
        a.velocity.x += (impulse / aMass) * sign;
        b.velocity.x -= (impulse / bMass) * sign;
      }
      return;
    }

    const sign = dz >= 0 ? 1 : -1;
    a.obstacle.position.z += overlapZ * aCorrection * sign;
    b.obstacle.position.z -= overlapZ * bCorrection * sign;
    const relative = (a.velocity.z - b.velocity.z) * sign;
    if (relative < 0) {
      const impulse = (-(1 + restitution) * relative) / (1 / aMass + 1 / bMass);
      a.velocity.z += (impulse / aMass) * sign;
      b.velocity.z -= (impulse / bMass) * sign;
    }
  }

  private simulateDynamicObstacles(delta: number) {
    if (delta <= 0) return;
    const bodies = this.getDynamicObstacleBodies();
    if (bodies.length === 0) return;

    for (const body of bodies) {
      body.velocity.y += GRAVITY * body.physics.gravityScale * delta;
      const damping = Math.max(0, 1 - body.physics.linearDamping * delta);
      body.velocity.x *= damping;
      body.velocity.y *= damping;
      body.velocity.z *= damping;
      body.obstacle.position.x += body.velocity.x * delta;
      body.obstacle.position.y += body.velocity.y * delta;
      body.obstacle.position.z += body.velocity.z * delta;
      const ground = this.sampleGroundHeightWithoutDynamic(
        body.obstacle.id,
        body.obstacle.position.x,
        body.obstacle.position.z,
      );
      if (body.obstacle.position.y <= ground) {
        body.obstacle.position.y = ground;
        if (Math.abs(body.velocity.y) < 0.25) {
          body.velocity.y = 0;
        } else {
          body.velocity.y = -body.velocity.y * body.physics.restitution;
        }
        const groundFriction = Math.max(0, 1 - body.physics.friction * delta * 2);
        body.velocity.x *= groundFriction;
        body.velocity.z *= groundFriction;
      }
    }

    for (let iteration = 0; iteration < DYNAMIC_OBSTACLE_SOLVER_ITERATIONS; iteration += 1) {
      for (const body of bodies) {
        for (const obstacle of this.obstacles) {
          const obstacleId = String(obstacle.id ?? '').trim();
          if (!obstacleId || obstacleId === body.obstacle.id || this.isDynamicObstacleId(obstacleId)) continue;
          this.resolveDynamicObstacleVsStatic(body, obstacle);
        }
      }

      for (let i = 0; i < bodies.length; i += 1) {
        for (let j = i + 1; j < bodies.length; j += 1) {
          const bodyA = bodies[i];
          const bodyB = bodies[j];
          if (!bodyA || !bodyB) continue;
          this.resolveDynamicObstaclePair(bodyA, bodyB);
        }
      }
    }

    for (const body of bodies) {
      this.obstacleVelocity.set(body.obstacle.id, body.velocity);
    }
  }

  private update(dt: number) {
    const delta = dt / 1000;
    this.elapsed += delta;
    let heatDelta = 0;
    for (const [id, player] of this.state.players.entries()) {
      const input = this.inputBuffer.get(id);
      if (!input) continue;

      player.ragdoll = input.ragdoll === true;
      player.lookYaw = input.lookYaw;
      player.lookPitch = input.lookPitch;
      player.animState = input.animState;
      player.animTime = input.animTime;

      if (player.ragdoll) {
        player.vx = 0;
        player.vy = 0;
        player.vz = 0;
        continue;
      }

      const speed =
        MOVE_SPEED * (input.sprint ? SPRINT_MULTIPLIER : input.crouch ? CROUCH_MULTIPLIER : 1);
      const slideMode = input.sprint || input.crouch;
      const accel = Math.min(1, SLIDE_ACCEL * delta);
      const targetVx = input.moveX * speed;
      const targetVz = input.moveZ * speed;
      if (slideMode) {
        player.vx += (targetVx - player.vx) * accel;
        player.vz += (targetVz - player.vz) * accel;
        if (Math.abs(input.moveX) < 0.05 && Math.abs(input.moveZ) < 0.05) {
          const damping = Math.max(0, 1 - SLIDE_FRICTION * delta);
          player.vx *= damping;
          player.vz *= damping;
        }
      } else {
        player.vx = targetVx;
        player.vz = targetVz;
      }

      if (Math.abs(player.vx) > 0.05 || Math.abs(player.vz) > 0.05) {
        player.yaw = Math.atan2(player.vx, player.vz) + Math.PI;
      }

      const nextX = player.x + player.vx * delta;
      const nextZ = player.z + player.vz * delta;
      let resolved = { x: nextX, y: player.y, z: nextZ };
      for (const obstacle of this.obstacles) {
        const obstacleId = String(obstacle.id ?? '').trim();
        if (obstacleId && this.isDynamicObstacleId(obstacleId)) {
          this.pushDynamicObstacleByPlayer(player, obstacle, delta, nextX, player.y, nextZ);
        }
        resolved = resolveCircleAabb(resolved, PLAYER_RADIUS, obstacle);
      }

      const groundHeight = this.sampleGroundHeight(resolved.x, resolved.z);
      const nearGround = player.y <= groundHeight + 0.06;
      const descendingSlow = player.vy <= 0.5;
      const grounded = nearGround && descendingSlow;
      const coyote = this.jumpCoyoteTimers.get(id) ?? 0;
      const nextCoyote = grounded ? JUMP_COYOTE_SECONDS : Math.max(0, coyote - delta);
      const canJumpFromGround = grounded || coyote > 0;

      if (input.jump && canJumpFromGround) {
        player.vy = JUMP_SPEED;
        this.jumpCoyoteTimers.set(id, 0);
      } else if (grounded && player.vy < 0) {
        // Keep motion glued to terrain while running over uneven surfaces.
        player.vy = 0;
        this.jumpCoyoteTimers.set(id, nextCoyote);
      } else {
        this.jumpCoyoteTimers.set(id, nextCoyote);
      }

      player.vy += GRAVITY * delta;
      player.y += player.vy * delta;
      if (player.y <= groundHeight) {
        player.y = groundHeight;
        if (player.vy < 0) player.vy = 0;
      }

      player.x = resolved.x;
      player.z = resolved.z;

      player.stamina = Math.max(0, Math.min(100, player.stamina - (input.sprint ? 8 : 2) * delta));
    }

    this.simulateDynamicObstacles(delta);

    const playersArray = Array.from(this.state.players.values()).filter((player) => !player.ragdoll);
    for (let i = 0; i < playersArray.length; i += 1) {
      for (let j = i + 1; j < playersArray.length; j += 1) {
        const a = playersArray[i];
        const b = playersArray[j];
        if (!a || !b) continue;
        const posA = resolveCircleCircle(
          { x: a.x, y: a.y, z: a.z },
          PLAYER_RADIUS,
          b,
          PLAYER_RADIUS,
        );
        const posB = resolveCircleCircle(
          { x: b.x, y: b.y, z: b.z },
          PLAYER_RADIUS,
          a,
          PLAYER_RADIUS,
        );
        a.x = posA.x;
        a.z = posA.z;
        b.x = posB.x;
        b.z = posB.z;
      }
    }

    for (const agent of this.crowd) {
      if (agent.stateTimer > 0) {
        agent.stateTimer = Math.max(0, agent.stateTimer - delta);
        agent.stateTime += delta;
      } else {
        agent.stateTime = 0;
      }
      if (agent.behaviorTimer > 0) {
        agent.behaviorTimer = Math.max(0, agent.behaviorTimer - delta);
        if (agent.behaviorTimer === 0) {
          agent.behavior = 'wander';
        }
      }
      if (agent.path.length === 0 || agent.pathIndex >= agent.path.length) {
        const target = this.navGrid.randomOpen();
        if (target) {
          agent.targetX = target.x;
          agent.targetZ = target.z;
          const path = this.navGrid.findPath(agent.x, agent.z, agent.targetX, agent.targetZ);
          agent.path = path ?? [];
          agent.pathIndex = 0;
        }
      }
      if (agent.path.length > 0 && agent.pathIndex < agent.path.length) {
        const waypoint = agent.path[agent.pathIndex];
        if (!waypoint) continue;
        const dx = waypoint.x - agent.x;
        const dz = waypoint.z - agent.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.6) {
          agent.pathIndex += 1;
        }
      }

      let ax = 0;
      let az = 0;
      let behaviorSpeed = CROWD_SPEED;
      for (const player of this.state.players.values()) {
        if (player.ragdoll) continue;
        const dx = agent.x - player.x;
        const dz = agent.z - player.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > CROWD_REPEL_RADIUS * CROWD_REPEL_RADIUS) continue;
        const dist = Math.max(0.001, Math.sqrt(distSq));
        const force = (CROWD_REPEL_FORCE * (CROWD_REPEL_RADIUS - dist)) / CROWD_REPEL_RADIUS;
        ax += (dx / dist) * force;
        az += (dz / dist) * force;
      }
      if (agent.behavior !== 'wander') {
        const players = Array.from(this.state.players.values()).filter((player) => !player.ragdoll);
        if (players.length > 0) {
          const firstPlayer = players[0];
          if (!firstPlayer) continue;
          let target = firstPlayer;
          let best = Infinity;
          for (const player of players) {
            const dx = player.x - agent.x;
            const dz = player.z - agent.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < best) {
              best = distSq;
              target = player;
            }
          }
          const dx = target.x - agent.x;
          const dz = target.z - agent.z;
          const dist = Math.max(0.001, Math.hypot(dx, dz));
          if (agent.behavior === 'fight') {
            ax += (dx / dist) * 2.2;
            az += (dz / dist) * 2.2;
            behaviorSpeed = CROWD_SPEED * 1.6;
            if (dist <= CROWD_ATTACK_RANGE) {
              if (this.elapsed - agent.lastAttackAt >= CROWD_ATTACK_COOLDOWN) {
                agent.lastAttackAt = this.elapsed;
                agent.state = 'attack';
                agent.stateTimer = 0.25;
                agent.stateTime = 0;
                target.health = Math.max(0, target.health - CROWD_ATTACK_DAMAGE);
                target.vx += (dx / dist) * CROWD_HIT_KNOCKBACK;
                target.vz += (dz / dist) * CROWD_HIT_KNOCKBACK;
              }
            }
          } else if (agent.behavior === 'flee') {
            ax += (-dx / dist) * 2.4;
            az += (-dz / dist) * 2.4;
            behaviorSpeed = CROWD_SPEED * 1.9;
          }
        }
      } else if (agent.path.length > 0 && agent.pathIndex < agent.path.length) {
        const waypoint = agent.path[agent.pathIndex];
        if (!waypoint) continue;
        const dx = waypoint.x - agent.x;
        const dz = waypoint.z - agent.z;
        const dist = Math.max(0.001, Math.hypot(dx, dz));
        ax += (dx / dist) * 1.6;
        az += (dz / dist) * 1.6;
      } else {
        const wander = 0.6;
        ax += Math.cos(this.elapsed * 0.6 + agent.id) * wander;
        az += Math.sin(this.elapsed * 0.5 + agent.id * 1.3) * wander;
      }

      agent.vx += ax * delta;
      agent.vz += az * delta;
      const speed = Math.hypot(agent.vx, agent.vz);
      if (speed > behaviorSpeed) {
        agent.vx = (agent.vx / speed) * behaviorSpeed;
        agent.vz = (agent.vz / speed) * behaviorSpeed;
      }
      agent.x += agent.vx * delta;
      agent.z += agent.vz * delta;
      agent.x = Math.max(-CROWD_BOUNDS, Math.min(CROWD_BOUNDS, agent.x));
      agent.z = Math.max(-CROWD_BOUNDS, Math.min(CROWD_BOUNDS, agent.z));

      let resolved = { x: agent.x, y: agent.y, z: agent.z };
      for (const obstacle of this.obstacles) {
        resolved = resolveCircleAabb(resolved, CROWD_RADIUS, obstacle);
      }
      agent.x = resolved.x;
      agent.z = resolved.z;
      if (agent.stateTimer <= 0) {
        const moveSpeed = Math.hypot(agent.vx, agent.vz);
        if (agent.behavior === 'flee' || agent.behavior === 'fight') {
          agent.state = 'run';
        } else if (moveSpeed > 0.25) {
          agent.state = 'walk';
        } else {
          agent.state = 'idle';
        }
      }
    }

    for (const player of this.state.players.values()) {
      if (player.ragdoll) continue;
      let pos = { x: player.x, y: player.y, z: player.z };
      for (const agent of this.crowd) {
        pos = resolveCircleCircle(pos, PLAYER_RADIUS, agent, CROWD_RADIUS);
      }
      player.x = pos.x;
      player.z = pos.z;
    }

    for (const [id, player] of this.state.players.entries()) {
      const input = this.inputBuffer.get(id);
      if (!input || !input.attack) continue;
      if (player.ragdoll) continue;
      const last = this.lastAttackAt.get(id) ?? -Infinity;
      if (this.elapsed - last < ATTACK_COOLDOWN) continue;
      this.lastAttackAt.set(id, this.elapsed);
      heatDelta += 0.02;

      for (const [otherId, other] of this.state.players.entries()) {
        if (otherId === id) continue;
        if (other.ragdoll) continue;
        const dx = other.x - player.x;
        const dz = other.z - player.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > ATTACK_RANGE * ATTACK_RANGE) continue;
        const dist = Math.max(0.001, Math.sqrt(distSq));
        const nx = dx / dist;
        const nz = dz / dist;
        other.health = Math.max(0, other.health - ATTACK_DAMAGE);
        other.vx += nx * ATTACK_KNOCKBACK;
        other.vz += nz * ATTACK_KNOCKBACK;
      }

      for (const agent of this.crowd) {
        const dx = agent.x - player.x;
        const dz = agent.z - player.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > ATTACK_RANGE * ATTACK_RANGE) continue;
        const dist = Math.max(0.001, Math.sqrt(distSq));
        const nx = dx / dist;
        const nz = dz / dist;
        agent.health = Math.max(0, agent.health - ATTACK_DAMAGE);
        agent.vx += nx * CROWD_HIT_KNOCKBACK;
        agent.vz += nz * CROWD_HIT_KNOCKBACK;
        agent.state = 'hit';
        agent.stateTimer = 0.3;
        agent.stateTime = 0;
        agent.threatId = id;
        const fightRoll = agent.health > 12 && Math.random() < 0.35;
        agent.behavior = fightRoll ? 'fight' : 'flee';
        agent.behaviorTimer = fightRoll ? CROWD_FIGHT_TIME : CROWD_FLEE_TIME;
      }
    }

    this.state.heat = Math.max(0, Math.min(1, this.state.heat + heatDelta - 0.01 * delta));
    this.state.phase = this.state.heat > 0.7 ? 2 : this.state.heat > 0.4 ? 1 : 0;

    const snapshot: Record<
      string,
      {
        id: string;
        position: { x: number; y: number; z: number };
        velocity: { x: number; y: number; z: number };
        health: number;
        stamina: number;
        lookYaw: number;
        lookPitch: number;
        animState: string;
        animTime: number;
        yaw: number;
        ragdoll: boolean;
      }
    > = {};
    for (const [id, player] of this.state.players.entries()) {
      snapshot[id] = {
        id,
        position: { x: player.x, y: player.y, z: player.z },
        velocity: { x: player.vx, y: player.vy, z: player.vz },
        health: player.health,
        stamina: player.stamina,
        lookYaw: player.lookYaw,
        lookPitch: player.lookPitch,
        animState: player.animState,
        animTime: player.animTime,
        yaw: player.yaw,
        ragdoll: player.ragdoll,
      };
    }
    this.broadcast(PROTOCOL.snapshot, {
      players: snapshot,
      heat: this.state.heat,
      phase: this.state.phase,
    });
    // Spatial culling: only send crowd agents near players
    const nearAgents = this.crowd.filter((agent) => {
      // Check if agent is within radius of any player
      for (const player of this.state.players.values()) {
        const dx = agent.x - player.x;
        const dz = agent.z - player.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < this.CROWD_NEAR_RADIUS * this.CROWD_NEAR_RADIUS) {
          return true;
        }
      }
      return false;
    });

    // Send crowd updates every tick (20Hz) for smooth motion
    this.broadcast(PROTOCOL.crowd, {
      agents: nearAgents.map((agent) => ({
        id: agent.id,
        position: { x: agent.x, y: agent.y, z: agent.z },
        velocity: { x: agent.vx, y: agent.vy, z: agent.vz },
        state: agent.state,
        stateTime: agent.stateTime,
      })),
    });

    const obstacleDynamicsSnapshot: ObstacleDynamicsSnapshot = {
      obstacles: this.obstacles.map((obstacle) => ({
        id: obstacle.id,
        position: {
          x: obstacle.position.x,
          y: obstacle.position.y,
          z: obstacle.position.z,
        },
        size: {
          x: obstacle.size.x,
          y: obstacle.size.y,
          z: obstacle.size.z,
        },
      })),
    };
    this.broadcast(PROTOCOL.obstacleDynamics, obstacleDynamicsSnapshot);
  }
}
