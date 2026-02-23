import * as THREE from 'three';

export type RagdollDriveGroup = 'core' | 'neck' | 'arm' | 'leg';

export type RagdollJointProfile = {
  parent: string;
  child: string;
  type: 'socket' | 'hinge';
  axis?: [number, number, number];
  limitYDeg?: number;
  limitZDeg?: number;
  twistMinDeg?: number;
  twistMaxDeg?: number;
  limitMin?: number;
  limitMax?: number;
  stiffness: number;
  damping: number;
  drive: {
    group: RagdollDriveGroup;
    stiffness: number;
    damping: number;
    forceLimit: number;
  };
};

export type RagdollSegmentProfile = {
  name: string;
  bone: string;
  childBone?: string;
  shape: 'box' | 'sphere';
  dimensions:
    | { width: number; height: number; depth: number }
    | { radius: number };
  mass: number;
  offset: { x: number; y: number; z: number };
};

// Directly mapped from tSe in RAGDOLLCONTROLEXAMPLE.js
export const RAGDOLL_SEGMENT_PROFILE: RagdollSegmentProfile[] = [
  {
    name: 'hips',
    bone: 'hips',
    shape: 'box',
    dimensions: { width: 0.28, height: 0.2, depth: 0.2 },
    mass: 12,
    offset: { x: 0, y: 0.1, z: 0 },
  },
  {
    name: 'chest',
    bone: 'chest',
    shape: 'box',
    dimensions: { width: 0.3, height: 0.25, depth: 0.2 },
    mass: 15,
    offset: { x: 0, y: 0.125, z: 0 },
  },
  {
    name: 'head',
    bone: 'head',
    shape: 'sphere',
    dimensions: { radius: 0.12 },
    mass: 4,
    offset: { x: 0, y: 0.1, z: 0 },
  },
  {
    name: 'leftUpperArm',
    bone: 'leftUpperArm',
    childBone: 'leftLowerArm',
    shape: 'box',
    dimensions: { width: 0.1, height: 0.32, depth: 0.1 },
    mass: 3,
    offset: { x: 0, y: -0.16, z: 0 },
  },
  {
    name: 'leftLowerArm',
    bone: 'leftLowerArm',
    childBone: 'leftHand',
    shape: 'box',
    dimensions: { width: 0.08, height: 0.28, depth: 0.08 },
    mass: 2,
    offset: { x: 0, y: -0.14, z: 0 },
  },
  {
    name: 'rightUpperArm',
    bone: 'rightUpperArm',
    childBone: 'rightLowerArm',
    shape: 'box',
    dimensions: { width: 0.1, height: 0.32, depth: 0.1 },
    mass: 3,
    offset: { x: 0, y: -0.16, z: 0 },
  },
  {
    name: 'rightLowerArm',
    bone: 'rightLowerArm',
    childBone: 'rightHand',
    shape: 'box',
    dimensions: { width: 0.08, height: 0.28, depth: 0.08 },
    mass: 2,
    offset: { x: 0, y: -0.14, z: 0 },
  },
  {
    name: 'leftUpperLeg',
    bone: 'leftUpperLeg',
    childBone: 'leftLowerLeg',
    shape: 'box',
    dimensions: { width: 0.12, height: 0.4, depth: 0.12 },
    mass: 7,
    offset: { x: 0, y: -0.2, z: 0 },
  },
  {
    name: 'leftLowerLeg',
    bone: 'leftLowerLeg',
    childBone: 'leftFoot',
    shape: 'box',
    dimensions: { width: 0.1, height: 0.38, depth: 0.1 },
    mass: 5,
    offset: { x: 0, y: -0.19, z: 0 },
  },
  {
    name: 'rightUpperLeg',
    bone: 'rightUpperLeg',
    childBone: 'rightLowerLeg',
    shape: 'box',
    dimensions: { width: 0.12, height: 0.4, depth: 0.12 },
    mass: 7,
    offset: { x: 0, y: -0.2, z: 0 },
  },
  {
    name: 'rightLowerLeg',
    bone: 'rightLowerLeg',
    childBone: 'rightFoot',
    shape: 'box',
    dimensions: { width: 0.1, height: 0.38, depth: 0.1 },
    mass: 5,
    offset: { x: 0, y: -0.19, z: 0 },
  },
];

export const RAGDOLL_BONE_DEFS: Array<{ name: string; parent?: string }> = [
  { name: 'hips' },
  { name: 'spine', parent: 'hips' },
  { name: 'chest', parent: 'spine' },
  { name: 'upperChest', parent: 'chest' },
  { name: 'neck', parent: 'upperChest' },
  { name: 'head', parent: 'neck' },
  { name: 'leftUpperArm', parent: 'upperChest' },
  { name: 'leftLowerArm', parent: 'leftUpperArm' },
  { name: 'leftHand', parent: 'leftLowerArm' },
  { name: 'rightUpperArm', parent: 'upperChest' },
  { name: 'rightLowerArm', parent: 'rightUpperArm' },
  { name: 'rightHand', parent: 'rightLowerArm' },
  { name: 'leftUpperLeg', parent: 'hips' },
  { name: 'leftLowerLeg', parent: 'leftUpperLeg' },
  { name: 'leftFoot', parent: 'leftLowerLeg' },
  { name: 'rightUpperLeg', parent: 'hips' },
  { name: 'rightLowerLeg', parent: 'rightUpperLeg' },
  { name: 'rightFoot', parent: 'rightLowerLeg' },
];

export const RAGDOLL_JOINT_PROFILE: RagdollJointProfile[] = [
  {
    parent: 'hips',
    child: 'chest',
    type: 'socket',
    limitYDeg: 20,
    limitZDeg: 20,
    twistMinDeg: -15,
    twistMaxDeg: 15,
    stiffness: 100,
    damping: 10,
    drive: { group: 'core', stiffness: 800, damping: 80, forceLimit: 1000 },
  },
  {
    parent: 'chest',
    child: 'head',
    type: 'socket',
    limitYDeg: 20,
    limitZDeg: 25,
    twistMinDeg: -20,
    twistMaxDeg: 20,
    stiffness: 100,
    damping: 10,
    drive: { group: 'neck', stiffness: 1200, damping: 120, forceLimit: 1500 },
  },
  {
    parent: 'chest',
    child: 'leftUpperArm',
    type: 'socket',
    limitYDeg: 55,
    limitZDeg: 55,
    twistMinDeg: -15,
    twistMaxDeg: 15,
    stiffness: 100,
    damping: 10,
    drive: { group: 'arm', stiffness: 350, damping: 35, forceLimit: 500 },
  },
  {
    parent: 'leftUpperArm',
    child: 'leftLowerArm',
    type: 'hinge',
    axis: [1, 0, 0],
    limitMin: THREE.MathUtils.degToRad(-5),
    limitMax: THREE.MathUtils.degToRad(130),
    stiffness: 250,
    damping: 25,
    drive: { group: 'arm', stiffness: 400, damping: 40, forceLimit: 600 },
  },
  {
    parent: 'chest',
    child: 'rightUpperArm',
    type: 'socket',
    limitYDeg: 55,
    limitZDeg: 55,
    twistMinDeg: -15,
    twistMaxDeg: 15,
    stiffness: 100,
    damping: 10,
    drive: { group: 'arm', stiffness: 350, damping: 35, forceLimit: 500 },
  },
  {
    parent: 'rightUpperArm',
    child: 'rightLowerArm',
    type: 'hinge',
    axis: [1, 0, 0],
    limitMin: THREE.MathUtils.degToRad(-5),
    limitMax: THREE.MathUtils.degToRad(130),
    stiffness: 250,
    damping: 25,
    drive: { group: 'arm', stiffness: 400, damping: 40, forceLimit: 600 },
  },
  {
    parent: 'hips',
    child: 'leftUpperLeg',
    type: 'socket',
    limitYDeg: 45,
    limitZDeg: 45,
    twistMinDeg: -15,
    twistMaxDeg: 15,
    stiffness: 100,
    damping: 10,
    drive: { group: 'leg', stiffness: 800, damping: 80, forceLimit: 1000 },
  },
  {
    parent: 'leftUpperLeg',
    child: 'leftLowerLeg',
    type: 'hinge',
    axis: [1, 0, 0],
    limitMin: THREE.MathUtils.degToRad(-5),
    limitMax: THREE.MathUtils.degToRad(130),
    stiffness: 100,
    damping: 10,
    drive: { group: 'leg', stiffness: 650, damping: 65, forceLimit: 850 },
  },
  {
    parent: 'hips',
    child: 'rightUpperLeg',
    type: 'socket',
    limitYDeg: 45,
    limitZDeg: 45,
    twistMinDeg: -15,
    twistMaxDeg: 15,
    stiffness: 100,
    damping: 10,
    drive: { group: 'leg', stiffness: 800, damping: 80, forceLimit: 1000 },
  },
  {
    parent: 'rightUpperLeg',
    child: 'rightLowerLeg',
    type: 'hinge',
    axis: [1, 0, 0],
    limitMin: THREE.MathUtils.degToRad(-5),
    limitMax: THREE.MathUtils.degToRad(130),
    stiffness: 100,
    damping: 10,
    drive: { group: 'leg', stiffness: 650, damping: 65, forceLimit: 850 },
  },
];

const DRIVE_FALLBACK = { group: 'core' as const, stiffness: 800, damping: 80, forceLimit: 1000 };

export const getRagdollDriveForBone = (boneName: string) => {
  const joint = RAGDOLL_JOINT_PROFILE.find((entry) => entry.child === boneName);
  if (joint) return joint.drive;
  if (boneName === 'neck' || boneName === 'head') {
    return { group: 'neck' as const, stiffness: 1200, damping: 120, forceLimit: 1500 };
  }
  if (boneName.includes('UpperArm') || boneName.includes('LowerArm') || boneName.includes('Hand')) {
    return { group: 'arm' as const, stiffness: 350, damping: 35, forceLimit: 500 };
  }
  if (boneName.includes('UpperLeg') || boneName.includes('LowerLeg') || boneName.includes('Foot')) {
    return { group: 'leg' as const, stiffness: 800, damping: 80, forceLimit: 1000 };
  }
  return DRIVE_FALLBACK;
};

export const getRagdollJointForChild = (childBoneName: string) =>
  RAGDOLL_JOINT_PROFILE.find((entry) => entry.child === childBoneName);
