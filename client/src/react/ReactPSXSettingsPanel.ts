import React, { useMemo, useState } from 'react';
import { psxSettings } from '../settings/PSXSettings';
import { UiDivider, UiField, UiRangeRow, UiSectionTitle, UiSelect, UiSwitchRow } from './ui-primitives';

const h = React.createElement;

type ConsolePreset = 'ps1' | 'n64' | 'dreamcast' | 'xbox' | 'modern';
type QualityPreset = 'authentic' | 'lite' | 'modern';

type SettingsState = typeof psxSettings.config;

function notifyChange() {
  window.dispatchEvent(new CustomEvent('psx-settings-changed'));
}

function applyPatch(patch: Partial<SettingsState>) {
  psxSettings.update(patch);
  notifyChange();
}

export function ReactPSXSettingsPanel() {
  const [settings, setSettings] = useState<SettingsState>({ ...psxSettings.config });
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>('authentic');

  const sync = () => setSettings({ ...psxSettings.config });

  const sliders = useMemo(
    () => [
      { key: 'brightness', label: 'Brightness', min: 0.5, max: 2.0, step: 0.1 },
      { key: 'contrast', label: 'Contrast', min: 0.5, max: 2.0, step: 0.1 },
      { key: 'saturation', label: 'Saturation', min: 0.0, max: 2.0, step: 0.1 },
      { key: 'gamma', label: 'Gamma', min: 0.5, max: 2.0, step: 0.1 },
      { key: 'exposure', label: 'Exposure', min: 0.5, max: 2.0, step: 0.1 },
    ] as const,
    []
  );

  return h(
    'div',
    { id: 'psx-settings-panel', className: 'psx-settings-panel' },
    h(UiSectionTitle, { className: 'psx-settings-title' }, 'Retro Console Graphics'),

    h(UiSwitchRow, {
      className: 'psx-check',
      label: 'Enable Retro Mode',
      checked: settings.enabled,
      onChange: (enabled) => {
        applyPatch({ enabled });
        sync();
      },
    }),

    h(
      'div',
      { className: 'psx-section' },
      h(UiField, {
        className: 'psx-field',
        label: 'Console Preset',
        control: h(
          UiSelect,
          {
            value: settings.consolePreset,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
              psxSettings.applyConsolePreset(event.target.value as ConsolePreset);
              notifyChange();
              sync();
            },
          },
          h('option', { value: 'ps1' }, 'PlayStation 1 (1994)'),
          h('option', { value: 'n64' }, 'Nintendo 64 (1996)'),
          h('option', { value: 'dreamcast' }, 'Sega Dreamcast (1998)'),
          h('option', { value: 'xbox' }, 'Xbox (2001)'),
          h('option', { value: 'modern' }, 'Modern (No Effects)')
        ),
      })
    ),

    h(
      'div',
      { className: 'psx-section' },
      h(UiField, {
        className: 'psx-field',
        label: 'Quality Preset',
        control: h(
          UiSelect,
          {
            value: qualityPreset,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
              const nextPreset = event.target.value as QualityPreset;
              setQualityPreset(nextPreset);
              psxSettings.applyPreset(nextPreset);
              notifyChange();
              sync();
            },
          },
          h('option', { value: 'authentic' }, 'Authentic'),
          h('option', { value: 'lite' }, 'Enhanced'),
          h('option', { value: 'modern' }, 'Disabled')
        ),
      })
    ),

    h(UiDivider, { className: 'psx-divider' }),

    h(
      'div',
      { className: 'psx-section' },
      ...[
        { key: 'affineMapping', label: 'Affine Texture Mapping' },
        { key: 'colorQuantization', label: '15-bit Color (Color Banding)' },
        { key: 'dithering', label: 'Dithering' },
        { key: 'crtEffects', label: 'CRT Effects' },
        { key: 'chromaticAberration', label: 'Chromatic Aberration' },
      ].map((item) =>
        h(UiSwitchRow, {
          key: item.key,
          className: 'psx-check',
          label: item.label,
          checked: settings[item.key as keyof SettingsState] as boolean,
          onChange: (checked) => {
            applyPatch({ [item.key]: checked } as Partial<SettingsState>);
            sync();
          },
        })
      )
    ),

    h(UiDivider, { className: 'psx-divider' }),

    h(
      'div',
      { className: 'psx-section' },
      h(UiSectionTitle, { className: 'psx-subtitle' }, 'Color & Lighting'),
      ...sliders.map((slider) => {
        const value = settings[slider.key as keyof SettingsState] as number;
        return h(UiRangeRow, {
          key: slider.key,
          className: 'psx-slider',
          label: slider.label,
          valueLabel: value.toFixed(1),
          min: slider.min,
          max: slider.max,
          step: slider.step,
          value,
          onInput: (next) => {
            applyPatch({ [slider.key]: next } as Partial<SettingsState>);
            sync();
          },
        });
      })
    ),

    h(
      'div',
      { className: 'psx-note' },
      h(
        'small',
        null,
        h('strong', null, 'Retro Console Mode'),
        ' recreates authentic classic console graphics.',
        h('br'),
        h('br'),
        h('strong', null, 'PS1:'),
        ' Wobbly textures, vertex jitter, 15-bit color',
        h('br'),
        h('strong', null, 'N64:'),
        ' Blurry bilinear filtering, fog, 21-bit color',
        h('br'),
        h('strong', null, 'Dreamcast:'),
        ' Clean VGA output, hardware AA',
        h('br'),
        h('strong', null, 'Xbox:'),
        ' HD-era graphics, advanced effects'
      )
    )
  );
}
