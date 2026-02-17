import * as THREE from 'three';
import { VRM } from '@pixiv/three-vrm';

type HumanBoneName = Parameters<VRM['humanoid']['getRawBoneNode']>[0];
type QuaternionLike = THREE.Quaternion | [number, number, number, number] | null | undefined;
type HumanoidInternals = {
  _boneRotations?: Record<string, QuaternionLike>;
  _parentWorldRotations?: Record<string, QuaternionLike>;
};

const getNormalizedHumanoidInternals = (value: unknown): HumanoidInternals | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  if (!('_normalizedHumanBones' in value)) return undefined;
  const normalized = value._normalizedHumanBones;
  if (!normalized || typeof normalized !== 'object') return undefined;
  return normalized as HumanoidInternals;
};

export function retargetMixamoClip(
  entry: { clip: THREE.AnimationClip; rig: THREE.Object3D },
  vrm: VRM,
  actorId: string,
  options?: { includePosition?: boolean },
) {
  const includePosition = options?.includePosition ?? false;
  const clip = entry.clip;
  const mixamoRig = entry.rig;
  const mixamoVRMRigMap: Record<string, HumanBoneName> = {
    mixamorigHips: 'hips',
    mixamorigSpine: 'spine',
    mixamorigSpine1: 'chest',
    mixamorigSpine2: 'upperChest',
    mixamorigNeck: 'neck',
    mixamorigHead: 'head',
    mixamorigLeftShoulder: 'leftShoulder',
    mixamorigLeftArm: 'leftUpperArm',
    mixamorigLeftForeArm: 'leftLowerArm',
    mixamorigLeftHand: 'leftHand',
    mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
    mixamorigLeftHandThumb2: 'leftThumbProximal',
    mixamorigLeftHandThumb3: 'leftThumbDistal',
    mixamorigLeftHandIndex1: 'leftIndexProximal',
    mixamorigLeftHandIndex2: 'leftIndexIntermediate',
    mixamorigLeftHandIndex3: 'leftIndexDistal',
    mixamorigLeftHandMiddle1: 'leftMiddleProximal',
    mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
    mixamorigLeftHandMiddle3: 'leftMiddleDistal',
    mixamorigLeftHandRing1: 'leftRingProximal',
    mixamorigLeftHandRing2: 'leftRingIntermediate',
    mixamorigLeftHandRing3: 'leftRingDistal',
    mixamorigLeftHandPinky1: 'leftLittleProximal',
    mixamorigLeftHandPinky2: 'leftLittleIntermediate',
    mixamorigLeftHandPinky3: 'leftLittleDistal',
    mixamorigRightShoulder: 'rightShoulder',
    mixamorigRightArm: 'rightUpperArm',
    mixamorigRightForeArm: 'rightLowerArm',
    mixamorigRightHand: 'rightHand',
    mixamorigRightHandPinky1: 'rightLittleProximal',
    mixamorigRightHandPinky2: 'rightLittleIntermediate',
    mixamorigRightHandPinky3: 'rightLittleDistal',
    mixamorigRightHandRing1: 'rightRingProximal',
    mixamorigRightHandRing2: 'rightRingIntermediate',
    mixamorigRightHandRing3: 'rightRingDistal',
    mixamorigRightHandMiddle1: 'rightMiddleProximal',
    mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
    mixamorigRightHandMiddle3: 'rightMiddleDistal',
    mixamorigRightHandIndex1: 'rightIndexProximal',
    mixamorigRightHandIndex2: 'rightIndexIntermediate',
    mixamorigRightHandIndex3: 'rightIndexDistal',
    mixamorigRightHandThumb1: 'rightThumbMetacarpal',
    mixamorigRightHandThumb2: 'rightThumbProximal',
    mixamorigRightHandThumb3: 'rightThumbDistal',
    mixamorigLeftUpLeg: 'leftUpperLeg',
    mixamorigLeftLeg: 'leftLowerLeg',
    mixamorigLeftFoot: 'leftFoot',
    mixamorigLeftToeBase: 'leftToes',
    mixamorigRightUpLeg: 'rightUpperLeg',
    mixamorigRightLeg: 'rightLowerLeg',
    mixamorigRightFoot: 'rightFoot',
    mixamorigRightToeBase: 'rightToes',
  };
  const normalizeMixamoName = (name: string) => {
    let cleaned = name;
    cleaned = cleaned.replace(/^mixamorig1/i, 'mixamorig');
    cleaned = cleaned.replace(/^mixamorig[:_]/i, 'mixamorig');
    cleaned = cleaned.replace(/^MixamoRig/i, '');
    cleaned = cleaned.replace(/^Armature/i, '');
    cleaned = cleaned.replace(/^[:_]/, '');
    if (/^mixamorig[A-Z]/.test(cleaned)) return cleaned;
    if (/^(Hips|Spine|Spine1|Spine2|Neck|Head|Left|Right)/.test(cleaned)) {
      return `mixamorig${cleaned}`;
    }
    return cleaned;
  };

  const humanoid = vrm.humanoid;
  const vrmMetaVersion = vrm.meta?.metaVersion ?? '1';
  const mixamoHips =
    mixamoRig.getObjectByName('mixamorigHips') ??
    mixamoRig.getObjectByName('mixamorig:Hips') ??
    mixamoRig.getObjectByName('Hips');
  const vrmHips = humanoid.getNormalizedBoneNode('hips');
  const v = new THREE.Vector3();
  const hipsPositionScale =
    mixamoHips && vrmHips ? vrmHips.getWorldPosition(v).y / mixamoHips.getWorldPosition(v).y : 1;

  const normalizedHumanoid = getNormalizedHumanoidInternals(humanoid);
  const boneRotations = normalizedHumanoid?._boneRotations ?? {};
  const parentWorldRotations = normalizedHumanoid?._parentWorldRotations ?? {};
  const resolveQuat = (value: QuaternionLike) => {
    if (!value) return new THREE.Quaternion();
    if (value instanceof THREE.Quaternion) return value.clone();
    if (Array.isArray(value) && value.length >= 4) {
      return new THREE.Quaternion(value[0], value[1], value[2], value[3]);
    }
    return new THREE.Quaternion();
  };

  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const quatA = new THREE.Quaternion();
  const quatB = new THREE.Quaternion();

  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const [nodeName, property] = track.name.split('.');
    if (!nodeName || !property) continue;
    const clean = normalizeMixamoName(nodeName);
    const vrmBone = mixamoVRMRigMap[clean];
    if (!vrmBone) continue;
    const vrmNormalizedNode = humanoid.getNormalizedBoneNode(vrmBone);
    const vrmRawNode = humanoid.getRawBoneNode(vrmBone);
    if (!vrmNormalizedNode || !vrmRawNode) continue;
    const vrmRawNodeName = vrmRawNode.name || `${actorId}_${vrmBone}_raw`;
    vrmRawNode.name = vrmRawNodeName;
    const mixamoRigNode =
      mixamoRig.getObjectByName(nodeName) ??
      mixamoRig.getObjectByName(clean) ??
      mixamoRig.getObjectByName(clean.replace(/^mixamorig/, 'mixamorig:'));
    if (!mixamoRigNode) continue;
    const times = track.times;

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const newTrackValues = new Float32Array(track.values.length);
      mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
      mixamoRigNode.parent?.getWorldQuaternion(parentRestWorldRotation);

      for (let i = 0; i < track.values.length; i += 4) {
        quatA.fromArray(track.values, i);
        quatA.premultiply(parentRestWorldRotation).multiply(restRotationInverse);

        const parentWorldRotation = resolveQuat(parentWorldRotations[vrmBone]);
        const invParentWorldRotation = quatB.copy(parentWorldRotation).invert();
        const boneRotation = resolveQuat(boneRotations[vrmBone]);

        quatA
          .multiply(parentWorldRotation)
          .premultiply(invParentWorldRotation)
          .multiply(boneRotation);
        quatA.toArray(newTrackValues, i);
      }

      const values = Array.from(newTrackValues).map((v2, i) =>
        vrmMetaVersion === '0' && i % 2 === 0 ? -v2 : v2,
      );
      tracks.push(
        new THREE.QuaternionKeyframeTrack(`${vrmRawNodeName}.${property}`, times, values),
      );
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      if (!includePosition) continue;
      const values = Array.from(track.values).map(
        (v2, i) => (vrmMetaVersion === '0' && i % 3 !== 1 ? -v2 : v2) * hipsPositionScale,
      );
      tracks.push(new THREE.VectorKeyframeTrack(`${vrmRawNodeName}.${property}`, times, values));
    }
  }

  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}
