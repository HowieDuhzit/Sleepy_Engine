export type ModelTextureSlot =
  | 'baseColor'
  | 'normal'
  | 'metallicRoughness'
  | 'occlusion'
  | 'emissive'
  | 'alpha';

export type ModelMaterialTextureMap = Partial<Record<ModelTextureSlot, string>>;

export type ModelMaterial = {
  id: string;
  name: string;
  textures: ModelMaterialTextureMap;
};

export type ModelAssetRecord = {
  id: string;
  gameId: string;
  name: string;
  sourcePath: string;
  thumbnailPath?: string;
  materials: ModelMaterial[];
  createdAt: string;
  updatedAt: string;
};

export type ModelAssetListResponse = {
  items: ModelAssetRecord[];
};

export type SaveModelAssetPayload = {
  id?: string;
  // Optional because game context usually comes from route params on the server.
  gameId?: string;
  name: string;
  sourcePath: string;
  thumbnailPath?: string;
  materials: ModelMaterial[];
};

export type GameModelTextureRecord = {
  baseColor?: string;
  normal?: string;
  roughness?: string;
  metalness?: string;
  emissive?: string;
};

export type GameModelColliderRecord = {
  shape?: 'box' | 'sphere' | 'capsule' | 'mesh';
  size?: { x?: number; y?: number; z?: number };
  radius?: number;
  height?: number;
  offset?: { x?: number; y?: number; z?: number };
  isTrigger?: boolean;
};

export type GameModelPhysicsRecord = {
  enabled?: boolean;
  bodyType?: 'static' | 'dynamic' | 'kinematic';
  mass?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  spawnHeightOffset?: number;
  initialVelocity?: {
    x?: number;
    y?: number;
    z?: number;
  };
};

export type GameModelRecord = {
  id: string;
  name: string;
  sourceFile: string;
  sourcePath?: string;
  originOffset?: {
    x?: number;
    y?: number;
    z?: number;
  };
  collider?: GameModelColliderRecord;
  physics?: GameModelPhysicsRecord;
  textures: GameModelTextureRecord;
  materials?: Array<{
    id: string;
    name: string;
    textures: Record<string, string>;
  }>;
  files?: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type SaveGameModelPayload = {
  id?: string;
  name: string;
  sourceFile: string;
  sourcePath?: string;
  originOffset?: {
    x?: number;
    y?: number;
    z?: number;
  };
  collider?: GameModelColliderRecord;
  physics?: GameModelPhysicsRecord;
  textures: GameModelTextureRecord;
  files?: string[];
  materials?: Array<{
    id: string;
    name: string;
    textures: Record<string, string>;
  }>;
};
