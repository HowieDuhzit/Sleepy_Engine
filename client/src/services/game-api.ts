import type {
  GameModelRecord,
  GameModelTextureRecord,
  SaveGameModelPayload,
} from '@sleepy/shared/model-assets';
import type { Obstacle } from '@sleepy/shared';

export type {
  GameModelRecord,
  GameModelTextureRecord,
  SaveGameModelPayload,
} from '@sleepy/shared/model-assets';

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
  texturePreset?: 'concrete' | 'grass' | 'sand' | 'rock' | 'snow' | 'lava';
  water?: {
    enabled?: boolean;
    level?: number;
    opacity?: number;
    waveAmplitude?: number;
    waveFrequency?: number;
    waveSpeed?: number;
    colorShallow?: string;
    colorDeep?: string;
    specularStrength?: number;
  };
  terrain?: {
    enabled?: boolean;
    preset?: 'cinematic' | 'alpine' | 'dunes' | 'islands';
    size?: number;
    resolution?: number;
    maxHeight?: number;
    roughness?: number;
    seed?: number;
    sculptStamps?: Array<{
      x?: number;
      z?: number;
      radius?: number;
      strength?: number;
      mode?: 'raise' | 'lower' | 'smooth' | 'flatten';
      targetHeight?: number;
    }>;
  };
};

export type ScenePlayerRecord = {
  avatar?: string;
  controller?: 'third_person' | 'first_person' | 'ragdoll' | 'ai_only' | 'hybrid';
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
  zones?: Array<{
    id?: string;
    name?: string;
    tag?: string;
    x?: number;
    y?: number;
    z?: number;
    width?: number;
    height?: number;
    depth?: number;
    type?: 'trigger' | 'spawn' | 'damage' | 'safe';
  }>;
  roads?: Array<{
    id?: string;
    name?: string;
    width?: number;
    yOffset?: number;
    material?: 'asphalt' | 'dirt' | 'neon';
    points?: Array<{ x?: number; y?: number; z?: number }>;
  }>;
  environment?: {
    preset?: 'clear_day' | 'sunset' | 'night' | 'foggy' | 'overcast';
    fogNear?: number;
    fogFar?: number;
    skybox?: {
      enabled?: boolean;
      preset?: 'clear_day' | 'sunset_clouds' | 'midnight_stars' | 'nebula';
      intensity?: number;
    };
  };
  logic?: {
    nodes?: Array<Record<string, unknown>>;
    links?: Array<Record<string, unknown>>;
  };
  components?: Record<string, Record<string, unknown>>;
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

const MODEL_PHYSICS_DEFAULTS = {
  enabled: true,
  bodyType: 'dynamic' as const,
  mass: 1,
  friction: 0.6,
  restitution: 0.1,
  linearDamping: 0.05,
  angularDamping: 0.1,
  gravityScale: 1,
  spawnHeightOffset: 1,
  initialVelocity: { x: 0, y: 0, z: 0 },
};

const asFiniteNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampFiniteNumber = (value: unknown, min: number, max: number, fallback: number) =>
  Math.min(max, Math.max(min, asFiniteNumber(value, fallback)));

const normalizeModelPhysics = (physics: unknown): NonNullable<GameModelRecord['physics']> => {
  const raw = physics && typeof physics === 'object' ? (physics as Record<string, unknown>) : {};
  const bodyTypeRaw = String(raw.bodyType ?? MODEL_PHYSICS_DEFAULTS.bodyType).toLowerCase();
  const bodyType =
    bodyTypeRaw === 'dynamic' || bodyTypeRaw === 'kinematic' || bodyTypeRaw === 'static'
      ? bodyTypeRaw
      : MODEL_PHYSICS_DEFAULTS.bodyType;
  const damping =
    raw.damping && typeof raw.damping === 'object' ? (raw.damping as Record<string, unknown>) : {};
  const spawn =
    raw.spawn && typeof raw.spawn === 'object' ? (raw.spawn as Record<string, unknown>) : null;
  const velocity =
    raw.initialVelocity && typeof raw.initialVelocity === 'object'
      ? (raw.initialVelocity as Record<string, unknown>)
      : raw.velocity && typeof raw.velocity === 'object'
        ? (raw.velocity as Record<string, unknown>)
        : {};
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : MODEL_PHYSICS_DEFAULTS.enabled,
    bodyType,
    mass: Math.max(bodyType === 'dynamic' ? 0.01 : 0, asFiniteNumber(raw.mass, MODEL_PHYSICS_DEFAULTS.mass)),
    friction: Math.max(0, asFiniteNumber(raw.friction, MODEL_PHYSICS_DEFAULTS.friction)),
    restitution: clampFiniteNumber(raw.restitution, 0, 1, MODEL_PHYSICS_DEFAULTS.restitution),
    linearDamping: Math.max(
      0,
      asFiniteNumber(raw.linearDamping ?? damping.linear, MODEL_PHYSICS_DEFAULTS.linearDamping),
    ),
    angularDamping: Math.max(
      0,
      asFiniteNumber(raw.angularDamping ?? damping.angular, MODEL_PHYSICS_DEFAULTS.angularDamping),
    ),
    gravityScale: asFiniteNumber(raw.gravityScale, MODEL_PHYSICS_DEFAULTS.gravityScale),
    spawnHeightOffset: clampFiniteNumber(
      raw.spawnHeightOffset ?? (typeof raw.spawn === 'number' ? raw.spawn : spawn?.heightOffset),
      -10,
      50,
      MODEL_PHYSICS_DEFAULTS.spawnHeightOffset,
    ),
    initialVelocity: {
      x: clampFiniteNumber(velocity.x, -30, 30, MODEL_PHYSICS_DEFAULTS.initialVelocity.x),
      y: clampFiniteNumber(velocity.y, -30, 30, MODEL_PHYSICS_DEFAULTS.initialVelocity.y),
      z: clampFiniteNumber(velocity.z, -30, 30, MODEL_PHYSICS_DEFAULTS.initialVelocity.z),
    },
  };
};

const normalizeModelRecord = (record: GameModelRecord, modelIdFallback?: string): GameModelRecord => ({
  ...record,
  id: String(record.id || modelIdFallback || '').trim(),
  physics: normalizeModelPhysics(record.physics),
});

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

export const listGameModels = async (gameId: string) => {
  const res = await fetch(`/api/games/${encodeURIComponent(gameId)}/assets/models`, {
    cache: 'no-store',
  });
  const data = await readJson<{
    items?: GameModelRecord[];
    models?: Array<GameModelRecord | string>;
  }>(res);
  if (Array.isArray(data.items)) return data.items.map((entry) => normalizeModelRecord(entry));
  if (!Array.isArray(data.models)) return [];
  const records = data.models.filter((entry): entry is GameModelRecord => typeof entry === 'object');
  if (records.length > 0) return records.map((entry) => normalizeModelRecord(entry));
  const ids = data.models.filter((entry): entry is string => typeof entry === 'string');
  const loaded = await Promise.all(
    ids.map(async (id) => {
      try {
        return await getGameModel(gameId, id);
      } catch {
        return null;
      }
    }),
  );
  return loaded
    .filter((entry: GameModelRecord | null): entry is GameModelRecord => Boolean(entry))
    .map((entry: GameModelRecord) => normalizeModelRecord(entry));
};

export const getGameModel = async (gameId: string, modelId: string) => {
  const res = await fetch(
    `/api/games/${encodeURIComponent(gameId)}/assets/models/${encodeURIComponent(modelId)}`,
    {
      cache: 'no-store',
    },
  );
  const record = await readJson<GameModelRecord>(res);
  return normalizeModelRecord(record, modelId);
};

export const saveGameModel = async (gameId: string, payload: SaveGameModelPayload) => {
  const modelId = (payload.id ?? payload.name).trim();
  const record = {
    id: modelId,
    name: payload.name,
    sourceFile: payload.sourceFile,
    originOffset: payload.originOffset,
    collider: payload.collider,
    physics: normalizeModelPhysics(payload.physics),
    textures: payload.textures,
    sourcePath: payload.sourcePath ?? payload.sourceFile,
    files: payload.files ?? [],
    materials: payload.materials ?? [],
    updatedAt: new Date().toISOString(),
  };
  const res = await fetch(`/api/games/${encodeURIComponent(gameId)}/assets/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelId,
      record,
    }),
  });
  return readJson<{ ok: boolean; model?: GameModelRecord; file?: string; id?: string }>(res);
};

export const getGameModelFileUrl = (gameId: string, modelId: string, name: string) =>
  `/api/games/${encodeURIComponent(gameId)}/assets/models/${encodeURIComponent(modelId)}/files/${encodeURIComponent(name)}`;

export const uploadGameModelFile = async (
  gameId: string,
  modelId: string,
  name: string,
  file: File,
) => {
  const body = await file.arrayBuffer();
  const res = await fetch(
    `/api/games/${encodeURIComponent(gameId)}/assets/models/${encodeURIComponent(modelId)}/files/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    },
  );
  return readJson<{ ok: boolean; file: string }>(res);
};

export const deleteGameModel = async (gameId: string, modelId: string) => {
  const res = await fetch(
    `/api/games/${encodeURIComponent(gameId)}/assets/models/${encodeURIComponent(modelId)}`,
    {
      method: 'DELETE',
    },
  );
  return readJson<{ ok: boolean; id?: string }>(res);
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
