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

export const parseClipPayload = (payload: unknown): ClipData | null => {
  if (!payload || typeof payload !== 'object') return null;
  if ('clip' in (payload as any)) {
    const clip = (payload as any).clip;
    return clip &&
      typeof clip === 'object' &&
      typeof clip.duration === 'number' &&
      Array.isArray(clip.frames)
      ? (clip as ClipData)
      : null;
  }
  if ('duration' in (payload as any) && 'frames' in (payload as any)) {
    const clip = payload as ClipData;
    return typeof clip.duration === 'number' && Array.isArray(clip.frames) ? clip : null;
  }
  return null;
};

export const isClipData = (payload: unknown): payload is ClipData => {
  if (!payload || typeof payload !== 'object') return false;
  const data = payload as ClipData;
  return typeof data.duration === 'number' && Array.isArray(data.frames);
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
