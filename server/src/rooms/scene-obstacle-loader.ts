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
  crowd?: { enabled?: boolean };
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
    const obstacles = Array.isArray(scene?.obstacles) ? scene.obstacles.map((obs, index) => toObstacle(obs, index)) : [];
    const crowdEnabled = scene?.crowd?.enabled === true;
    return { obstacles, crowdEnabled };
  } catch {
    return { obstacles: [], crowdEnabled: false };
  }
};

export const loadSceneObstacles = async (options?: { gameId?: string; sceneName?: string }) => {
  const config = await loadSceneConfig(options);
  return config.obstacles;
};
