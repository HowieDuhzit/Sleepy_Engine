import type { Obstacle } from '@sleepy/shared';

export type GameMeta = {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type SceneGroundRecord = {
  type?: string;
  width?: number;
  depth?: number;
  y?: number;
  textureRepeat?: number;
};

export type ScenePlayerRecord = {
  avatar?: string;
};

export type SceneCrowdRecord = {
  enabled?: boolean;
  avatar?: string;
};

export type SceneObstacleRecord =
  | Obstacle
  | {
      id?: string;
      x?: number;
      y?: number;
      z?: number;
      width?: number;
      height?: number;
      depth?: number;
    };

export type SceneRecord = {
  name: string;
  obstacles?: SceneObstacleRecord[];
  ground?: SceneGroundRecord;
  player?: ScenePlayerRecord;
  crowd?: SceneCrowdRecord;
};

const readJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return (await response.json()) as T;
};

export const listGames = async (cacheBust = false) => {
  const url = cacheBust ? `/api/games?t=${Date.now()}` : '/api/games';
  const res = await fetch(url, { cache: 'no-store' });
  const data = await readJson<{ games: GameMeta[] }>(res);
  return data.games;
};

export const createGame = async (payload: { name: string; description?: string }) => {
  const res = await fetch('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ id: string; name: string }>(res);
};

export const deleteGame = async (gameId: string) => {
  const res = await fetch(`/api/games/${encodeURIComponent(gameId)}`, {
    method: 'DELETE',
  });
  return readJson<{ ok: boolean; id: string }>(res);
};

export const getGameScenes = async (gameId: string) => {
  const res = await fetch(`/api/games/${gameId}/scenes`, { cache: 'no-store' });
  return readJson<{ scenes?: SceneRecord[] }>(res);
};

export const saveGameScenes = async (gameId: string, payload: { scenes: SceneRecord[] }) => {
  const res = await fetch(`/api/games/${gameId}/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean; file: string }>(res);
};

export const getGamePlayer = async <T>(gameId: string) => {
  const res = await fetch(`/api/games/${gameId}/player`, { cache: 'no-store' });
  return readJson<T>(res);
};

export const saveGamePlayer = async (gameId: string, payload: unknown) => {
  const res = await fetch(`/api/games/${gameId}/player`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean; file: string }>(res);
};

export const listGameAnimations = async (gameId: string) => {
  const res = await fetch(`/api/games/${gameId}/animations`, { cache: 'no-store' });
  return readJson<{ files?: string[] }>(res);
};

export const getGameAnimation = async (gameId: string, name: string) => {
  const res = await fetch(`/api/games/${gameId}/animations/${encodeURIComponent(name)}`, {
    cache: 'no-store',
  });
  return readJson<unknown>(res);
};

export const saveGameAnimation = async (gameId: string, name: string, payload: unknown) => {
  const res = await fetch(`/api/games/${gameId}/animations/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean; file: string }>(res);
};

export const getGameAvatarUrl = (gameId: string, name: string) =>
  `/api/games/${gameId}/avatars/${encodeURIComponent(name)}`;

export const listGameAvatars = async (gameId: string) => {
  const res = await fetch(`/api/games/${gameId}/avatars`, { cache: 'no-store' });
  return readJson<{ files?: string[] }>(res);
};

export const uploadGameAvatar = async (gameId: string, name: string, file: File) => {
  const body = await file.arrayBuffer();
  const res = await fetch(`/api/games/${gameId}/avatars/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  return readJson<{ ok: boolean; file: string }>(res);
};
