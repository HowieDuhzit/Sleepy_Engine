import React, { useMemo, useState } from 'react';
import { retroRenderSettings, type RenderStylePreset } from '../settings/RetroRenderSettings';
import {
  UiDivider,
  UiField,
  UiRangeRow,
  UiSectionTitle,
  UiSelect,
  UiSwitchRow,
} from './ui-primitives';

const h = React.createElement;

type QualityPreset = 'authentic' | 'lite' | 'modern';
type SettingsState = typeof retroRenderSettings.config;

function notifyChange() {
  window.dispatchEvent(new CustomEvent('retro-settings-changed'));
}

function applyPatch(patch: Partial<SettingsState>) {
  retroRenderSettings.update(patch);
  notifyChange();
}

export function ReactRetroSettingsPanel() {
  const [settings, setSettings] = useState<SettingsState>({ ...retroRenderSettings.config });
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>('authentic');

  const sync = () => setSettings({ ...retroRenderSettings.config });

  const sliders = useMemo(
    () =>
      [
        { key: 'brightness', label: 'Brightness', min: 0.5, max: 2.0, step: 0.1 },
        { key: 'contrast', label: 'Contrast', min: 0.5, max: 2.0, step: 0.1 },
        { key: 'saturation', label: 'Saturation', min: 0.0, max: 2.0, step: 0.1 },
        { key: 'gamma', label: 'Gamma', min: 0.5, max: 2.0, step: 0.1 },
        { key: 'exposure', label: 'Exposure', min: 0.5, max: 2.0, step: 0.1 },
      ] as const,
    [],
  );

  return h(
    'div',
    { id: 'retro-settings-panel', className: 'retro-settings-panel' },
    h(UiSectionTitle, { className: 'retro-settings-title' }, 'Retro Render Settings'),

    h(UiSwitchRow, {
      className: 'retro-check',
      label: 'Enable Retro Mode',
      checked: settings.enabled,
      onChange: (enabled) => {
        applyPatch({ enabled });
        sync();
      },
    }),

    h(
      'div',
      { className: 'retro-section' },
      h(UiField, {
        className: 'retro-field',
        label: 'Style Preset',
        control: h(
          UiSelect,
          {
            value: settings.stylePreset,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
              retroRenderSettings.applyStylePreset(event.target.value as RenderStylePreset);
              notifyChange();
              sync();
            },
          },
          h('option', { value: 'legacy' }, 'Legacy'),
          h('option', { value: 'soft' }, 'Soft Focus'),
          h('option', { value: 'arcade' }, 'Arcade Clean'),
          h('option', { value: 'cinematic' }, 'Cinematic'),
          h('option', { value: 'modern' }, 'Modern (No Effects)'),
        ),
      }),
    ),

    h(
      'div',
      { className: 'retro-section' },
      h(UiField, {
        className: 'retro-field',
        label: 'Quality Preset',
        control: h(
          UiSelect,
          {
            value: qualityPreset,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
              const nextPreset = event.target.value as QualityPreset;
              setQualityPreset(nextPreset);
              retroRenderSettings.applyPreset(nextPreset);
              notifyChange();
              sync();
            },
          },
          h('option', { value: 'authentic' }, 'Authentic'),
          h('option', { value: 'lite' }, 'Enhanced'),
          h('option', { value: 'modern' }, 'Disabled'),
        ),
      }),
    ),

    h(UiDivider, { className: 'retro-divider' }),

    h(
      'div',
      { className: 'retro-section' },
      ...[
        { key: 'affineMapping', label: 'Affine Texture Mapping' },
        { key: 'colorQuantization', label: 'Reduced Color Depth' },
        { key: 'dithering', label: 'Dithering' },
        { key: 'crtEffects', label: 'CRT Effects' },
        { key: 'chromaticAberration', label: 'Chromatic Aberration' },
      ].map((item) =>
        h(UiSwitchRow, {
          key: item.key,
          className: 'retro-check',
          label: item.label,
          checked: settings[item.key as keyof SettingsState] as boolean,
          onChange: (checked) => {
            applyPatch({ [item.key]: checked } as Partial<SettingsState>);
            sync();
          },
        }),
      ),
    ),

    h(UiDivider, { className: 'retro-divider' }),

    h(
      'div',
      { className: 'retro-section' },
      h(UiSectionTitle, { className: 'retro-subtitle' }, 'Color & Lighting'),
      ...sliders.map((slider) => {
        const value = settings[slider.key as keyof SettingsState] as number;
        return h(UiRangeRow, {
          key: slider.key,
          className: 'retro-slider',
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
      }),
    ),

    h(
      'div',
      { className: 'retro-note' },
      h(
        'small',
        null,
        h('strong', null, 'Style Notes'),
        h('br'),
        'Legacy: low-res jittered retro look',
        h('br'),
        'Soft Focus: filtered, smoother retro look',
        h('br'),
        'Arcade Clean: cleaner image with subtle CRT response',
        h('br'),
        'Cinematic: polished grading with minimal retro artifacts',
      ),
    ),
  );
}
