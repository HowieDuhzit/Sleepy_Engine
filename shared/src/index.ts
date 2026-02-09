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
};

export type ZoneHeat = {
  zoneId: string;
  heat: number;
  phase: number;
};

export const PROTOCOL = {
  input: 'input',
  snapshot: 'snapshot',
  event: 'event',
} as const;

export const PLAYER_RADIUS = 0.6;
export const MOVE_SPEED = 6;
export const SPRINT_MULTIPLIER = 1.6;
export const CROUCH_MULTIPLIER = 0.55;
export const SLIDE_ACCEL = 10;
export const SLIDE_FRICTION = 6;
export const GROUND_Y = 0.6;
export const GRAVITY = -22;
export const JUMP_SPEED = 8;

export const OBSTACLES: Obstacle[] = [
  { id: 'block-a', position: { x: 12, y: 0.25, z: 6 }, size: { x: 3, y: 1.5, z: 8 } },
  { id: 'block-b', position: { x: -14, y: 0.25, z: -10 }, size: { x: 10, y: 1.5, z: 3 } },
  { id: 'block-c', position: { x: -10, y: 0.25, z: 14 }, size: { x: 6, y: 1.5, z: 3 } },
];

export function resolveCircleAabb(
  position: Vec3,
  radius: number,
  obstacle: Obstacle,
): Vec3 {
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
