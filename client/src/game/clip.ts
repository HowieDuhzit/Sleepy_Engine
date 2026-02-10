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
    tracks.push(new THREE.QuaternionKeyframeTrack(`${prefix}${key}.quaternion`, track.times, track.values));
  }
  if (rootTimes.length) {
    tracks.push(new THREE.VectorKeyframeTrack(`${prefix}${rootKey}.position`, rootTimes, rootValues));
  }
  return new THREE.AnimationClip(name, clip.duration, tracks);
};
