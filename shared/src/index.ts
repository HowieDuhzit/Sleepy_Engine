export type Vec3 = { x: number; y: number; z: number };

export type Obstacle = {
  id: string;
  position: Vec3;
  size: { x: number; y: number; z: number };
};

export type PlayerInput = {
  seq: number;
  moveX: number;
  moveZ: number;
  lookYaw: number;
  lookPitch: number;
  animState: string;
  animTime: number;
  sprint: boolean;
  attack: boolean;
  interact: boolean;
  jump: boolean;
  crouch: boolean;
};

export type PlayerSnapshot = {
  id: string;
  position: Vec3;
  velocity: Vec3;
  health: number;
  stamina: number;
  lookYaw: number;
  lookPitch: number;
  animState: string;
  animTime: number;
  yaw: number;
};

export type WorldSnapshot = {
  players: Record<string, PlayerSnapshot>;
  heat: number;
  phase: number;
};

export type CrowdAgentSnapshot = {
  id: number;
  position: Vec3;
  velocity: Vec3;
  state?: string;
  stateTime?: number;
};

export type CrowdSnapshot = {
  agents: CrowdAgentSnapshot[];
};

export type ZoneHeat = {
  zoneId: string;
  heat: number;
  phase: number;
};

export const PROTOCOL = {
  input: 'input',
  snapshot: 'snapshot',
  crowd: 'crowd',
  event: 'event',
} as const;

export const PLAYER_RADIUS = 0.6;
export const MOVE_SPEED = 6;
export const SPRINT_MULTIPLIER = 1.6;
export const CROUCH_MULTIPLIER = 0.55;
export const SLIDE_ACCEL = 10;
export const SLIDE_FRICTION = 6;
export const GROUND_Y = 0;
export const GRAVITY = -22;
export const JUMP_SPEED = 8;
export const STEP_HEIGHT = 0.7;
export const ATTACK_RANGE = 2.2;
export const ATTACK_COOLDOWN = 0.45;
export const ATTACK_DAMAGE = 12;
export const ATTACK_KNOCKBACK = 4.5;
export const CROWD_COUNT = 48;
export const CROWD_RADIUS = 0.35;
export const CROWD_SPEED = 1.4;
export const CROWD_REPEL_RADIUS = 2.2;
export const CROWD_REPEL_FORCE = 2.8;
export const CROWD_BOUNDS = 45;
export const CROWD_ATTACK_RANGE = 1.6;
export const CROWD_ATTACK_COOLDOWN = 0.9;
export const CROWD_ATTACK_DAMAGE = 6;
export const CROWD_FLEE_TIME = 2.6;
export const CROWD_FIGHT_TIME = 2.0;
export const CROWD_HIT_KNOCKBACK = 2.8;

export const OBSTACLES: Obstacle[] = [
  { id: 'low-wall-a', position: { x: -8, y: 0, z: -6 }, size: { x: 6, y: 1, z: 1.2 } },
  { id: 'low-wall-b', position: { x: 10, y: 0, z: -4 }, size: { x: 5, y: 1, z: 1.2 } },
  { id: 'low-wall-c', position: { x: 4, y: 0, z: 10 }, size: { x: 6, y: 1, z: 1.2 } },
  { id: 'platform-a', position: { x: -12, y: 0, z: 10 }, size: { x: 6, y: 1.4, z: 6 } },
  { id: 'platform-b', position: { x: 14, y: 0, z: 12 }, size: { x: 6, y: 1.8, z: 6 } },
  { id: 'block-tall', position: { x: 0, y: 0, z: -14 }, size: { x: 4, y: 2.6, z: 4 } },
  { id: 'block-mid', position: { x: -2, y: 0, z: 2 }, size: { x: 3.5, y: 1.0, z: 3.5 } },
  { id: 'block-mid-2', position: { x: 8, y: 0, z: 2 }, size: { x: 3.5, y: 1.0, z: 3.5 } },
  { id: 'stair-1', position: { x: -2, y: 0, z: -2 }, size: { x: 2.8, y: 0.6, z: 2.8 } },
  { id: 'stair-2', position: { x: -2, y: 0, z: -5 }, size: { x: 2.8, y: 1.2, z: 2.8 } },
  { id: 'ramp-step-1', position: { x: 6, y: 0, z: -10 }, size: { x: 4, y: 0.4, z: 2 } },
  { id: 'ramp-step-2', position: { x: 6, y: 0, z: -8 }, size: { x: 4, y: 0.8, z: 2 } },
  { id: 'ramp-step-3', position: { x: 6, y: 0, z: -6 }, size: { x: 4, y: 1.2, z: 2 } },
  { id: 'ramp-step-4', position: { x: 6, y: 0, z: -4 }, size: { x: 4, y: 1.6, z: 2 } },
  { id: 'stair-test-1', position: { x: -10, y: 0, z: -10 }, size: { x: 3, y: 0.3, z: 2 } },
  { id: 'stair-test-2', position: { x: -10, y: 0, z: -8 }, size: { x: 3, y: 0.6, z: 2 } },
  { id: 'stair-test-3', position: { x: -10, y: 0, z: -6 }, size: { x: 3, y: 0.9, z: 2 } },
];

export function resolveCircleAabb(
  position: Vec3,
  radius: number,
  obstacle: Obstacle,
): Vec3 {
  if (position.y >= obstacle.position.y + obstacle.size.y - STEP_HEIGHT) {
    return position;
  }
  const halfX = obstacle.size.x / 2;
  const halfZ = obstacle.size.z / 2;
  const minX = obstacle.position.x - halfX;
  const maxX = obstacle.position.x + halfX;
  const minZ = obstacle.position.z - halfZ;
  const maxZ = obstacle.position.z + halfZ;

  if (
    position.x < minX - radius ||
    position.x > maxX + radius ||
    position.z < minZ - radius ||
    position.z > maxZ + radius
  ) {
    return position;
  }

  const closestX = Math.max(minX, Math.min(position.x, maxX));
  const closestZ = Math.max(minZ, Math.min(position.z, maxZ));
  const dx = position.x - closestX;
  const dz = position.z - closestZ;
  const distSq = dx * dx + dz * dz;

  if (distSq >= radius * radius) {
    return position;
  }

  if (distSq === 0) {
    const left = position.x - minX;
    const right = maxX - position.x;
    const down = position.z - minZ;
    const up = maxZ - position.z;
    const minSide = Math.min(left, right, down, up);
    if (minSide === left) return { ...position, x: minX - radius };
    if (minSide === right) return { ...position, x: maxX + radius };
    if (minSide === down) return { ...position, z: minZ - radius };
    return { ...position, z: maxZ + radius };
  }

  const dist = Math.sqrt(distSq);
  const push = radius - dist;
  return {
    ...position,
    x: position.x + (dx / dist) * push,
    z: position.z + (dz / dist) * push,
  };
}

export function resolveCircleCircle(
  position: Vec3,
  radius: number,
  other: Vec3,
  otherRadius: number,
): Vec3 {
  const dx = position.x - other.x;
  const dz = position.z - other.z;
  const distSq = dx * dx + dz * dz;
  const minDist = radius + otherRadius;
  if (distSq >= minDist * minDist) return position;
  if (distSq === 0) return { ...position, x: position.x + minDist, z: position.z };
  const dist = Math.sqrt(distSq);
  const push = (minDist - dist) / dist;
  return {
    ...position,
    x: position.x + dx * push,
    z: position.z + dz * push,
  };
}
