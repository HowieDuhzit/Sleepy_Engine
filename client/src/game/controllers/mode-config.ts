export type ControllerMode = 'third_person' | 'first_person' | 'ragdoll' | 'ai_only' | 'hybrid';
export type RuntimeControllerMode = 'third_person' | 'first_person' | 'ragdoll';

export type ControllerTuning = {
  moveSpeed?: number;
  sprintMultiplier?: number;
  crouchMultiplier?: number;
  slideAccel?: number;
  slideFriction?: number;
  gravity?: number;
  jumpSpeed?: number;
  walkThreshold?: number;
  runThreshold?: number;
  cameraDistance?: number;
  cameraHeight?: number;
  cameraShoulder?: number;
  cameraShoulderHeight?: number;
  cameraSensitivity?: number;
  cameraSmoothing?: number;
  cameraMinPitch?: number;
  cameraMaxPitch?: number;
  targetSmoothSpeed?: number;
  lockMovement?: boolean;
};

export type ControllerModeConfigs = {
  third_person: ControllerTuning;
  first_person: ControllerTuning;
  ragdoll: ControllerTuning;
};

export const createDefaultControllerModeConfigs = (): ControllerModeConfigs => ({
  third_person: {},
  first_person: {
    cameraDistance: 0.02,
    cameraHeight: 1.62,
    cameraShoulder: 0,
    cameraShoulderHeight: 0,
    cameraSmoothing: 0.08,
  },
  ragdoll: {
    lockMovement: true,
    moveSpeed: 0,
    jumpSpeed: 0,
  },
});

export const resolveRuntimeControllerMode = (
  controller: ControllerMode | string | null | undefined,
): RuntimeControllerMode => {
  if (controller === 'first_person') return 'first_person';
  if (controller === 'ragdoll') return 'ragdoll';
  return 'third_person';
};

export const normalizeControllerModeConfigs = (
  input: Partial<Record<RuntimeControllerMode, ControllerTuning>> | null | undefined,
): ControllerModeConfigs => {
  const defaults = createDefaultControllerModeConfigs();
  return {
    third_person: { ...defaults.third_person, ...(input?.third_person ?? {}) },
    first_person: { ...defaults.first_person, ...(input?.first_person ?? {}) },
    ragdoll: { ...defaults.ragdoll, ...(input?.ragdoll ?? {}) },
  };
};

