import * as THREE from 'three';
import type { RagdollSegmentProfile } from './ragdoll-profile';

export const RAGDOLL_COLLISION_GROUP_ENV = 0x0001;
export const RAGDOLL_COLLISION_GROUP_TORSO = 0x0002;
export const RAGDOLL_COLLISION_GROUP_ARM_L = 0x0004;
export const RAGDOLL_COLLISION_GROUP_ARM_R = 0x0008;
export const RAGDOLL_COLLISION_GROUP_LEG_L = 0x0010;
export const RAGDOLL_COLLISION_GROUP_LEG_R = 0x0020;

export const RAGDOLL_ALL_BODY_GROUPS =
  RAGDOLL_COLLISION_GROUP_TORSO |
  RAGDOLL_COLLISION_GROUP_ARM_L |
  RAGDOLL_COLLISION_GROUP_ARM_R |
  RAGDOLL_COLLISION_GROUP_LEG_L |
  RAGDOLL_COLLISION_GROUP_LEG_R;

export const getRagdollBodyGroup = (name: string) => {
  if (
    name === 'hips' ||
    name === 'spine' ||
    name === 'chest' ||
    name === 'upperChest' ||
    name === 'neck' ||
    name === 'head'
  ) {
    return RAGDOLL_COLLISION_GROUP_TORSO;
  }
  if (name.startsWith('leftUpperArm') || name.startsWith('leftLowerArm') || name.startsWith('leftHand')) {
    return RAGDOLL_COLLISION_GROUP_ARM_L;
  }
  if (name.startsWith('rightUpperArm') || name.startsWith('rightLowerArm') || name.startsWith('rightHand')) {
    return RAGDOLL_COLLISION_GROUP_ARM_R;
  }
  if (name.startsWith('leftUpperLeg') || name.startsWith('leftLowerLeg') || name.startsWith('leftFoot')) {
    return RAGDOLL_COLLISION_GROUP_LEG_L;
  }
  if (name.startsWith('rightUpperLeg') || name.startsWith('rightLowerLeg') || name.startsWith('rightFoot')) {
    return RAGDOLL_COLLISION_GROUP_LEG_R;
  }
  return RAGDOLL_COLLISION_GROUP_TORSO;
};

type SegmentFrameInput = {
  segment: RagdollSegmentProfile;
  bonePosition: THREE.Vector3;
  boneQuaternion: THREE.Quaternion;
  childPosition: THREE.Vector3 | null;
  rigOffsetLocal?: THREE.Vector3;
  rigRotationOffset?: THREE.Quaternion;
};

export const computeRagdollSegmentFrame = ({
  segment,
  bonePosition,
  boneQuaternion,
  childPosition,
  rigOffsetLocal,
  rigRotationOffset,
}: SegmentFrameInput) => {
  const axis = new THREE.Vector3(0, 1, 0);
  let correctionLocal: THREE.Quaternion | null = null;
  if (childPosition) {
    const dir = childPosition.clone().sub(bonePosition);
    if (dir.lengthSq() > 1e-8) {
      const dirWorld = dir.normalize();
      const dirLocal = dirWorld.clone().applyQuaternion(boneQuaternion.clone().invert());
      correctionLocal = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dirLocal,
      );
      axis.copy(dirWorld);
    }
  }
  const alignedBoneQuat = boneQuaternion.clone();
  if (correctionLocal) {
    alignedBoneQuat.multiply(correctionLocal).normalize();
  } else {
    axis.applyQuaternion(boneQuaternion).normalize();
  }
  const offsetLocal = new THREE.Vector3(
    segment.offset.x,
    correctionLocal ? -segment.offset.y : segment.offset.y,
    segment.offset.z,
  );
  const offsetWorld = offsetLocal.applyQuaternion(alignedBoneQuat);
  const center = bonePosition.clone().add(offsetWorld);
  if (rigOffsetLocal) {
    center.add(rigOffsetLocal.clone().applyQuaternion(boneQuaternion));
  }
  const bodyQuaternion = alignedBoneQuat.clone();
  if (rigRotationOffset) {
    bodyQuaternion.multiply(rigRotationOffset).normalize();
  }
  return { center, axis, bodyQuaternion, correctionLocal };
};

type ResolveRagdollSegmentChildBoneInput = {
  segmentName: string;
  sourceBone: THREE.Object3D;
  preferredChildBone?: string;
  jointProfileChildBone?: string;
  getBone: (name: string) => THREE.Object3D | null;
};

export const resolveRagdollSegmentChildBone = ({
  segmentName,
  sourceBone,
  preferredChildBone,
  jointProfileChildBone,
  getBone,
}: ResolveRagdollSegmentChildBoneInput) => {
  const tryBone = (value?: string | null) => (value ? getBone(value) : null);
  const direct = tryBone(preferredChildBone);
  if (direct) return direct;
  const byJoint = tryBone(jointProfileChildBone);
  if (byJoint) return byJoint;
  if (segmentName.startsWith('leftUpperArm') || segmentName.startsWith('leftLowerArm')) {
    return tryBone('leftHand');
  }
  if (segmentName.startsWith('rightUpperArm') || segmentName.startsWith('rightLowerArm')) {
    return tryBone('rightHand');
  }
  if (segmentName.startsWith('leftUpperLeg') || segmentName.startsWith('leftLowerLeg')) {
    return tryBone('leftFoot');
  }
  if (segmentName.startsWith('rightUpperLeg') || segmentName.startsWith('rightLowerLeg')) {
    return tryBone('rightFoot');
  }
  const sourcePos = sourceBone.getWorldPosition(new THREE.Vector3());
  const queue: THREE.Object3D[] = [...sourceBone.children];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (next instanceof THREE.Bone) {
      const nextPos = next.getWorldPosition(new THREE.Vector3());
      if (sourcePos.distanceToSquared(nextPos) > 1e-6) return next;
    }
    queue.push(...next.children);
  }
  return null;
};
