import React from 'react';
import { ReactPSXSettingsPanel } from './ReactPSXSettingsPanel';
import { UiButton } from './ui-primitives';

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
      'div',
      { className: 'settings-menu ui-card game-settings-panel' },
      h('h2', { className: 'settings-menu-title' }, 'Settings'),
      h(ReactPSXSettingsPanel),
      h('h3', { className: 'settings-menu-subtitle' }, 'Camera'),
      h(
        'label',
        { className: 'settings-menu-field' },
        'Camera Distance: ',
        h('span', null, camera.orbitRadius.toFixed(1), 'm'),
        h('input', {
          type: 'range',
          min: 1,
          max: 15,
          step: 0.5,
          value: camera.orbitRadius,
          onInput: (event: React.FormEvent<HTMLInputElement>) =>
            onCameraChange({ orbitRadius: parseFloat(event.currentTarget.value) }),
        })
      ),
      h(
        'label',
        { className: 'settings-menu-field' },
        'Camera Smoothing: ',
        h('span', null, `${Math.round(camera.cameraSmoothing * 100)}%`),
        h('input', {
          type: 'range',
          min: 0,
          max: 100,
          step: 5,
          value: Math.round(camera.cameraSmoothing * 100),
          onInput: (event: React.FormEvent<HTMLInputElement>) =>
            onCameraChange({ cameraSmoothing: parseFloat(event.currentTarget.value) / 100 }),
        })
      ),
      h(
        'label',
        { className: 'settings-menu-field' },
        'Camera Sensitivity: ',
        h('span', null, `${camera.cameraSensitivity.toFixed(1)}x`),
        h('input', {
          type: 'range',
          min: 0.1,
          max: 3,
          step: 0.1,
          value: camera.cameraSensitivity,
          onInput: (event: React.FormEvent<HTMLInputElement>) =>
            onCameraChange({ cameraSensitivity: parseFloat(event.currentTarget.value) }),
        })
      ),
      h(
        'label',
        { className: 'settings-menu-check' },
        h('input', {
          type: 'checkbox',
          checked: camera.firstPersonMode,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            onCameraChange({ firstPersonMode: event.target.checked }),
        }),
        'First Person Mode'
      ),
      h(UiButton, { className: 'menu-back-button', onClick: onClose }, 'Close')
    )
  );
}
