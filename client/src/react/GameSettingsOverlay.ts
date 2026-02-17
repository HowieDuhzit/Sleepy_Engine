import React from 'react';
import { ReactPSXSettingsPanel } from './ReactPSXSettingsPanel';
import { UiButton, UiCard, UiRangeRow, UiSectionTitle, UiSwitchRow } from './ui-primitives';

const h = React.createElement;

type CameraSettings = {
  orbitRadius: number;
  cameraSmoothing: number;
  cameraSensitivity: number;
  firstPersonMode: boolean;
};

type Props = {
  open: boolean;
  camera: CameraSettings;
  onClose: () => void;
  onCameraChange: (patch: Partial<CameraSettings>) => void;
};

export function GameSettingsOverlay({ open, camera, onClose, onCameraChange }: Props) {
  if (!open) return null;

  return h(
    'div',
    { className: 'game-settings-overlay' },
    h(
      UiCard,
      { className: 'settings-menu game-settings-panel' },
      h('h2', { className: 'settings-menu-title' }, 'Settings'),
      h(ReactPSXSettingsPanel),
      h(UiSectionTitle, { className: 'settings-menu-subtitle' }, 'Camera'),
      h(UiRangeRow, {
        label: 'Camera Distance',
        valueLabel: `${camera.orbitRadius.toFixed(1)}m`,
        min: 1,
        max: 15,
        step: 0.5,
        value: camera.orbitRadius,
        onInput: (value) => onCameraChange({ orbitRadius: value }),
      }),
      h(UiRangeRow, {
        label: 'Camera Smoothing',
        valueLabel: `${Math.round(camera.cameraSmoothing * 100)}%`,
        min: 0,
        max: 100,
        step: 5,
        value: Math.round(camera.cameraSmoothing * 100),
        onInput: (value) => onCameraChange({ cameraSmoothing: value / 100 }),
      }),
      h(UiRangeRow, {
        label: 'Camera Sensitivity',
        valueLabel: `${camera.cameraSensitivity.toFixed(1)}x`,
        min: 0.1,
        max: 3,
        step: 0.1,
        value: camera.cameraSensitivity,
        onInput: (value) => onCameraChange({ cameraSensitivity: value }),
      }),
      h(UiSwitchRow, {
        label: 'First Person Mode',
        checked: camera.firstPersonMode,
        onChange: (value) => onCameraChange({ firstPersonMode: value }),
      }),
      h(UiButton, { className: 'menu-back-button', onClick: onClose }, 'Close'),
    ),
  );
}
