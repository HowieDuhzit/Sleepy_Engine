import path from 'path';
import { promises as fs } from 'fs';
import { type Obstacle } from '@sleepy/shared';

type SceneObstacle = {
  id?: string;
  x?: number;
  y?: number;
  z?: number;
  width?: number;
  height?: number;
  depth?: number;
  position?: { x: number; y: number; z: number };
  size?: { x: number; y: number; z: number };
};
type SceneConfig = {
  name: string;
  obstacles?: SceneObstacle[];
  components?: Record<string, Record<string, unknown>>;
  crowd?: { enabled?: boolean };
  ground?: {
    y?: number;
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
};

export type SceneObstaclePhysicsConfig = {
  enabled: boolean;
  bodyType: 'static' | 'dynamic' | 'kinematic';
  mass: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  gravityScale: number;
  spawnHeightOffset: number;
  initialVelocity: { x: number; y: number; z: number };
  isTrigger: boolean;
};

type SceneGroundTerrainConfig = {
  enabled: boolean;
  preset: 'cinematic' | 'alpine' | 'dunes' | 'islands';
  size: number;
  resolution: number;
  maxHeight: number;
  roughness: number;
  seed: number;
};

const defaultGameId = 'prototype';
const defaultSceneName = 'main';
const gamesDir =
  process.env.GAMES_DIR ??
  process.env.PROJECTS_DIR ??
  path.join(process.cwd(), 'server', 'projects');

const safeSegment = (value: string) => value.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
const asNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const defaultPhysics = (): SceneObstaclePhysicsConfig => ({
  enabled: false,
  bodyType: 'static',
  mass: 1,
  friction: 0.7,
  restitution: 0.05,
  linearDamping: 0,
  gravityScale: 1,
  spawnHeightOffset: 0,
  initialVelocity: { x: 0, y: 0, z: 0 },
  isTrigger: false,
});

const toObstaclePhysics = (component: Record<string, unknown>): SceneObstaclePhysicsConfig => {
  const base = defaultPhysics();
  const physics = asRecord(component.physics);
  const collider = asRecord(component.collider);
  const bodyTypeRaw = String(physics.bodyType ?? base.bodyType).toLowerCase();
  const bodyType: SceneObstaclePhysicsConfig['bodyType'] =
    bodyTypeRaw === 'dynamic' || bodyTypeRaw === 'kinematic' ? bodyTypeRaw : 'static';
  const velocity = asRecord(physics.initialVelocity ?? physics.velocity);
  const enabled = physics.enabled === true;
  return {
    enabled,
    bodyType,
    mass: Math.max(0.01, asNumber(physics.mass, base.mass)),
    friction: Math.max(0, asNumber(physics.friction, base.friction)),
    restitution: Math.max(0, Math.min(1, asNumber(physics.restitution, base.restitution))),
    linearDamping: Math.max(0, asNumber(physics.linearDamping, base.linearDamping)),
    gravityScale: asNumber(physics.gravityScale, base.gravityScale),
    spawnHeightOffset: asNumber(physics.spawnHeightOffset ?? physics.spawn, base.spawnHeightOffset),
    initialVelocity: {
      x: asNumber(velocity.x, 0),
      y: asNumber(velocity.y, 0),
      z: asNumber(velocity.z, 0),
    },
    isTrigger: collider.isTrigger === true,
  };
};

const toObstacle = (input: SceneObstacle, index: number): Obstacle => {
  if (input.position && input.size) {
    return {
      id: input.id ?? `obstacle_${index}`,
      position: {
        x: asNumber(input.position.x, 0),
        y: asNumber(input.position.y, 0),
        z: asNumber(input.position.z, 0),
      },
      size: {
        x: Math.max(0.01, asNumber(input.size.x, 1)),
        y: Math.max(0.01, asNumber(input.size.y, 1)),
        z: Math.max(0.01, asNumber(input.size.z, 1)),
      },
    };
  }

  return {
    id: input.id ?? `obstacle_${index}`,
    position: {
      x: asNumber(input.x, 0),
      y: asNumber(input.y, 0),
      z: asNumber(input.z, 0),
    },
    size: {
      x: Math.max(0.01, asNumber(input.width, 1)),
      y: Math.max(0.01, asNumber(input.height, 1)),
      z: Math.max(0.01, asNumber(input.depth, 1)),
    },
  };
};

export const loadSceneConfig = async (options?: { gameId?: string; sceneName?: string }) => {
  const gameId = safeSegment(options?.gameId ?? defaultGameId) || defaultGameId;
  const sceneName = String(options?.sceneName ?? defaultSceneName);
  const scenesPath = path.join(gamesDir, gameId, 'scenes', 'scenes.json');

  try {
    const raw = await fs.readFile(scenesPath, 'utf8');
    const payload = JSON.parse(raw) as { scenes?: SceneConfig[] };
    const scene = payload.scenes?.find((entry) => entry.name === sceneName) ?? payload.scenes?.[0];
    const obstacles = Array.isArray(scene?.obstacles)
      ? scene.obstacles.map((obs, index) => toObstacle(obs, index))
      : [];
    const obstaclePhysics: Record<string, SceneObstaclePhysicsConfig> = {};
    const components = asRecord(scene?.components);
    for (const obstacle of obstacles) {
      const key = `obstacle:${obstacle.id}`;
      obstaclePhysics[obstacle.id] = toObstaclePhysics(asRecord(components[key]));
    }
    const crowdEnabled = scene?.crowd?.enabled === true;
    const groundY = asNumber(scene?.ground?.y, 0);
    const terrainRaw = scene?.ground?.terrain;
    const terrain: SceneGroundTerrainConfig | null =
      terrainRaw && terrainRaw.enabled === true
        ? {
            enabled: true,
            preset: (terrainRaw.preset ?? 'cinematic') as SceneGroundTerrainConfig['preset'],
            size: Math.max(16, asNumber(terrainRaw.size, 120)),
            resolution: Math.max(8, Math.min(128, asNumber(terrainRaw.resolution, 48))),
            maxHeight: Math.max(1, asNumber(terrainRaw.maxHeight, 12)),
            roughness: Math.max(0.2, Math.min(0.95, asNumber(terrainRaw.roughness, 0.56))),
            seed: Math.floor(asNumber(terrainRaw.seed, 1337)),
          }
        : null;
    return { obstacles, obstaclePhysics, crowdEnabled, groundY, terrain };
  } catch (error) {
    console.error('Failed to load scene config; using empty defaults.', {
      gameId,
      sceneName,
      scenesPath,
      error,
    });
    return { obstacles: [], obstaclePhysics: {}, crowdEnabled: false, groundY: 0, terrain: null };
  }
};

export const loadSceneObstacles = async (options?: { gameId?: string; sceneName?: string }) => {
  const config = await loadSceneConfig(options);
  return config.obstacles;
};
