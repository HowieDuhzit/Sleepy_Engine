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

const defaultProjectId = 'prototype';
const defaultSceneName = 'prototype';
const projectsDir = process.env.PROJECTS_DIR ?? path.join(process.cwd(), 'projects');

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

export const loadSceneObstacles = async (options?: { projectId?: string; sceneName?: string }) => {
  const projectId = safeSegment(options?.projectId ?? defaultProjectId) || defaultProjectId;
  const sceneName = String(options?.sceneName ?? defaultSceneName);
  const scenesPath = path.join(projectsDir, projectId, 'scenes', 'scenes.json');

  try {
    const raw = await fs.readFile(scenesPath, 'utf8');
    const payload = JSON.parse(raw) as { scenes?: Array<{ name: string; obstacles?: SceneObstacle[] }> };
    const scene = payload.scenes?.find((entry) => entry.name === sceneName) ?? payload.scenes?.[0];
    return Array.isArray(scene?.obstacles) ? scene.obstacles.map((obs, index) => toObstacle(obs, index)) : [];
  } catch {
    return [];
  }
};
