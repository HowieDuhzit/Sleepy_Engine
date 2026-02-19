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

export type SocialProfileRecord = {
  id: string;
  displayName: string;
  status: string;
  bio: string;
  updatedAt: string;
  lastSeenAt: string;
};

export type SocialFriendRecord = {
  id: string;
  name: string;
  status: string;
  online: boolean;
};

export type SocialMessageRecord = {
  id: string;
  from: string;
  to: string;
  text: string;
  createdAt: string;
};

export type SocialStateRecord = {
  profile: SocialProfileRecord;
  friends: SocialFriendRecord[];
  chats: Record<string, SocialMessageRecord[]>;
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

export const getSocialState = async (clientId: string) => {
  const res = await fetch(`/api/social/state?clientId=${encodeURIComponent(clientId)}`, {
    cache: 'no-store',
  });
  return readJson<SocialStateRecord>(res);
};

export const saveSocialProfile = async (payload: {
  clientId: string;
  displayName: string;
  status: string;
  bio: string;
}) => {
  const res = await fetch('/api/social/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean; profile: SocialProfileRecord }>(res);
};

export const sendSocialMessage = async (payload: { clientId: string; friendId: string; text: string }) => {
  const res = await fetch('/api/social/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean; message: SocialMessageRecord }>(res);
};

export const addSocialFriend = async (payload: { clientId: string; friendId: string }) => {
  const res = await fetch('/api/social/friends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean }>(res);
};
