import * as THREE from 'three';

export type BoneFrame = {
  time: number;
  bones: Record<string, { x: number; y: number; z: number; w: number }>;
  rootPos?: { x: number; y: number; z: number };
};

export type ClipData = {
  duration: number;
  frames: BoneFrame[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const isQuaternionLike = (
  value: unknown,
): value is {
  x: number;
  y: number;
  z: number;
  w: number;
} => {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.z === 'number' &&
    typeof value.w === 'number'
  );
};

const isBoneFrame = (value: unknown): value is BoneFrame => {
  if (!isRecord(value) || typeof value.time !== 'number' || !isRecord(value.bones)) return false;
  if (!Object.values(value.bones).every((bone) => isQuaternionLike(bone))) return false;
  if (value.rootPos === undefined) return true;
  return (
    isRecord(value.rootPos) &&
    typeof value.rootPos.x === 'number' &&
    typeof value.rootPos.y === 'number' &&
    typeof value.rootPos.z === 'number'
  );
};

export const parseClipPayload = (payload: unknown): ClipData | null => {
  if (!isRecord(payload)) return null;
  if ('clip' in payload) {
    const clip = payload.clip;
    return isClipData(clip) ? clip : null;
  }
  if ('duration' in payload && 'frames' in payload) {
    return isClipData(payload) ? payload : null;
  }
  return null;
};

export const isClipData = (payload: unknown): payload is ClipData => {
  if (!isRecord(payload)) return false;
  return (
    typeof payload.duration === 'number' &&
    Array.isArray(payload.frames) &&
    payload.frames.every(isBoneFrame)
  );
};

export const buildAnimationClipFromData = (
  name: string,
  clip: ClipData,
  options?: { prefix?: string; rootKey?: string },
) => {
  const prefix = options?.prefix ?? '';
  const rootKey = options?.rootKey ?? 'hips';
  const boneTracks: Map<string, { times: number[]; values: number[] }> = new Map();
  const rootTimes: number[] = [];
  const rootValues: number[] = [];
  for (const frame of clip.frames) {
    for (const [boneKey, q] of Object.entries(frame.bones)) {
      if (!q) continue;
      const track = boneTracks.get(boneKey) ?? { times: [], values: [] };
      track.times.push(frame.time);
      track.values.push(q.x, q.y, q.z, q.w);
      boneTracks.set(boneKey, track);
    }
    if (frame.rootPos) {
      rootTimes.push(frame.time);
      rootValues.push(frame.rootPos.x, frame.rootPos.y, frame.rootPos.z);
    }
  }
  const tracks: THREE.QuaternionKeyframeTrack[] = [];
  for (const [key, track] of boneTracks.entries()) {
    if (!track.times.length) continue;
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${prefix}${key}.quaternion`, track.times, track.values),
    );
  }
  if (rootTimes.length) {
    tracks.push(
      new THREE.VectorKeyframeTrack(`${prefix}${rootKey}.position`, rootTimes, rootValues),
    );
  }
  return new THREE.AnimationClip(name, clip.duration, tracks);
};

const mirrorMatrix = new THREE.Matrix4().makeScale(-1, 1, 1);
const mirrorQuat = (q: { x: number; y: number; z: number; w: number }) => {
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion(q.x, q.y, q.z, q.w),
  );
  const mirrored = new THREE.Matrix4().multiplyMatrices(mirrorMatrix, rot).multiply(mirrorMatrix);
  const out = new THREE.Quaternion();
  out.setFromRotationMatrix(mirrored);
  return { x: out.x, y: out.y, z: out.z, w: out.w };
};

const swapBoneName = (name: string) => {
  if (name.startsWith('left')) return `right${name.slice(4)}`;
  if (name.startsWith('right')) return `left${name.slice(5)}`;
  return name;
};

export const mirrorClipData = (clip: ClipData): ClipData => {
  return {
    duration: clip.duration,
    frames: clip.frames.map((frame) => {
      const bones: Record<string, { x: number; y: number; z: number; w: number }> = {};
      for (const [boneKey, q] of Object.entries(frame.bones)) {
        const mirroredKey = swapBoneName(boneKey);
        bones[mirroredKey] = mirrorQuat(q);
      }
      return {
        time: frame.time,
        bones,
        rootPos: frame.rootPos
          ? { x: -frame.rootPos.x, y: frame.rootPos.y, z: frame.rootPos.z }
          : undefined,
      };
    }),
  };
};
