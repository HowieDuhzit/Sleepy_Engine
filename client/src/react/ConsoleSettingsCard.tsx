import React, { useMemo, useState } from 'react';
import { PlayerProfileCard } from './PlayerProfileCard';
import type {
  ColorblindMode,
  ContentMaturity,
  DifficultyPreset,
  GlobalSettings,
  NetworkRegion,
  PartyPrivacy,
  QualityPreset,
  SubtitleSize,
} from '../settings/global-settings';

const SETTINGS_TABS = [
  'profile',
  'audio',
  'video',
  'gameplay',
  'accessibility',
  'network',
  'storage',
  'account',
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

type ConsoleSettingsCardProps = {
  gameId: string;
  gameName: string;
  startScene: string;
  settings: GlobalSettings;
  onChange: (next: GlobalSettings) => void;
  onReset: () => void;
  onClose: () => void;
};

const QUALITY_OPTIONS: Array<{ value: QualityPreset; label: string }> = [
  { value: 'performance', label: 'Performance' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'quality', label: 'Quality' },
  { value: 'cinematic', label: 'Cinematic' },
];

const DIFFICULTY_OPTIONS: Array<{ value: DifficultyPreset; label: string }> = [
  { value: 'story', label: 'Story' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
  { value: 'nightmare', label: 'Nightmare' },
];

const SUBTITLE_OPTIONS: Array<{ value: SubtitleSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

const REGION_OPTIONS: Array<{ value: NetworkRegion; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'na-east', label: 'NA East' },
  { value: 'na-west', label: 'NA West' },
  { value: 'eu-central', label: 'EU Central' },
  { value: 'ap-southeast', label: 'AP Southeast' },
];

const COLORBLIND_OPTIONS: Array<{ value: ColorblindMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'protanopia', label: 'Protanopia' },
  { value: 'deuteranopia', label: 'Deuteranopia' },
  { value: 'tritanopia', label: 'Tritanopia' },
];

const PARTY_OPTIONS: Array<{ value: PartyPrivacy; label: string }> = [
  { value: 'public', label: 'Public' },
  { value: 'friends', label: 'Friends' },
  { value: 'invite-only', label: 'Invite Only' },
];

const MATURITY_OPTIONS: Array<{ value: ContentMaturity; label: string }> = [
  { value: 'teen', label: 'Teen' },
  { value: 'mature', label: 'Mature' },
  { value: 'unfiltered', label: 'Unfiltered' },
];

export function ConsoleSettingsCard({
  gameId,
  gameName,
  startScene,
  settings,
  onChange,
  onReset,
  onClose,
}: ConsoleSettingsCardProps) {
  const [tab, setTab] = useState<SettingsTab>('profile');

  const completion = useMemo(() => {
    let score = 0;
    if (settings.profile.displayName.trim().length > 0) score += 1;
    if (settings.profile.bio.trim().length > 0) score += 1;
    if (settings.audio.masterVolume >= 50) score += 1;
    if (settings.storage.cloudSavesEnabled) score += 1;
    if (settings.network.telemetryOptIn) score += 1;
    return Math.round((score / 5) * 100);
  }, [settings]);

  const update = (next: GlobalSettings) => onChange(next);

  return (
    <section className="nxe-settings-modal nxe-console-settings" onClick={(event) => event.stopPropagation()}>
      <header className="nxe-settings-modal-header nxe-console-settings-header">
        <div>
          <h3>Console Settings</h3>
          <p>
            {gameName} • {startScene} • Profile completion {completion}%
          </p>
        </div>
        <div className="nxe-console-settings-header-actions">
          <button className="nxe-settings-modal-close" onClick={onReset}>
            Reset All
          </button>
          <button className="nxe-settings-modal-close" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </div>
      </header>

      <div className="nxe-console-settings-tabs" role="tablist" aria-label="Settings categories">
        {SETTINGS_TABS.map((item) => (
          <button
            key={item}
            className={`nxe-console-settings-tab ${tab === item ? 'active' : ''}`}
            onClick={() => setTab(item)}
            role="tab"
            aria-selected={tab === item}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="nxe-console-settings-body">
        {tab === 'profile' ? (
          <div className="nxe-console-grid">
            <section className="nxe-console-panel">
              <h4>Identity</h4>
              <label className="nxe-console-field">
                <span>Display Name</span>
                <input
                  value={settings.profile.displayName}
                  maxLength={32}
                  onChange={(event) =>
                    update({
                      ...settings,
                      profile: { ...settings.profile, displayName: event.target.value },
                    })
                  }
                />
              </label>
              <label className="nxe-console-field">
                <span>Online Status</span>
                <input
                  value={settings.profile.onlineStatus}
                  maxLength={48}
                  onChange={(event) =>
                    update({
                      ...settings,
                      profile: { ...settings.profile, onlineStatus: event.target.value },
                    })
                  }
                />
              </label>
              <label className="nxe-console-field">
                <span>Bio</span>
                <textarea
                  value={settings.profile.bio}
                  rows={4}
                  maxLength={180}
                  onChange={(event) =>
                    update({
                      ...settings,
                      profile: { ...settings.profile, bio: event.target.value },
                    })
                  }
                />
              </label>
            </section>

            <section className="nxe-console-panel">
              <h4>Presence</h4>
              <label className="nxe-console-field">
                <span>Region Label</span>
                <input
                  value={settings.profile.regionLabel}
                  maxLength={32}
                  onChange={(event) =>
                    update({
                      ...settings,
                      profile: { ...settings.profile, regionLabel: event.target.value },
                    })
                  }
                />
              </label>
              <div className="nxe-console-kpis">
                <span>Cloud Sync {settings.storage.cloudSavesEnabled ? 'ON' : 'OFF'}</span>
                <span>Crossplay {settings.gameplay.crossplayEnabled ? 'ON' : 'OFF'}</span>
                <span>Voice Chat {settings.network.voiceChatEnabled ? 'ON' : 'OFF'}</span>
              </div>
            </section>
          </div>
        ) : null}

        {tab === 'audio' ? (
          <div className="nxe-console-grid">
            <section className="nxe-console-panel">
              <h4>Mix</h4>
              <RangeField
                label="Master"
                value={settings.audio.masterVolume}
                min={0}
                max={100}
                onChange={(value) => update({ ...settings, audio: { ...settings.audio, masterVolume: value } })}
              />
              <RangeField
                label="Music"
                value={settings.audio.musicVolume}
                min={0}
                max={100}
                onChange={(value) => update({ ...settings, audio: { ...settings.audio, musicVolume: value } })}
              />
              <RangeField
                label="Effects"
                value={settings.audio.sfxVolume}
                min={0}
                max={100}
                onChange={(value) => update({ ...settings, audio: { ...settings.audio, sfxVolume: value } })}
              />
              <RangeField
                label="Voice Chat"
                value={settings.audio.voiceChatVolume}
                min={0}
                max={100}
                onChange={(value) => update({ ...settings, audio: { ...settings.audio, voiceChatVolume: value } })}
              />
            </section>
            <section className="nxe-console-panel">
              <h4>Toggles</h4>
              <SwitchField
                label="Mute All"
                checked={settings.audio.muteAll}
                onChange={(checked) => update({ ...settings, audio: { ...settings.audio, muteAll: checked } })}
              />
              <SwitchField
                label="Menu Music"
                checked={settings.audio.menuMusicEnabled}
                onChange={(checked) =>
                  update({ ...settings, audio: { ...settings.audio, menuMusicEnabled: checked } })
                }
              />
            </section>
          </div>
        ) : null}

        {tab === 'video' ? (
          <div className="nxe-console-grid">
            <section className="nxe-console-panel">
              <h4>Display</h4>
              <SelectField
                label="Quality Preset"
                value={settings.video.qualityPreset}
                options={QUALITY_OPTIONS}
                onChange={(qualityPreset) => update({ ...settings, video: { ...settings.video, qualityPreset } })}
              />
              <RangeField
                label="Brightness"
                value={Math.round(settings.video.brightness * 100)}
                min={50}
                max={160}
                onChange={(value) => update({ ...settings, video: { ...settings.video, brightness: value / 100 } })}
              />
              <RangeField
                label="Gamma"
                value={Math.round(settings.video.gamma * 100)}
                min={50}
                max={160}
                onChange={(value) => update({ ...settings, video: { ...settings.video, gamma: value / 100 } })}
              />
              <RangeField
                label="Field of View"
                value={settings.video.fieldOfView}
                min={70}
                max={120}
                onChange={(value) => update({ ...settings, video: { ...settings.video, fieldOfView: value } })}
              />
            </section>
            <section className="nxe-console-panel">
              <h4>Effects</h4>
              <SwitchField
                label="VSync"
                checked={settings.video.vSync}
                onChange={(checked) => update({ ...settings, video: { ...settings.video, vSync: checked } })}
              />
              <SwitchField
                label="HDR"
                checked={settings.video.hdr}
                onChange={(checked) => update({ ...settings, video: { ...settings.video, hdr: checked } })}
              />
              <SwitchField
                label="FPS Counter"
                checked={settings.video.showFps}
                onChange={(checked) => update({ ...settings, video: { ...settings.video, showFps: checked } })}
              />
              <RangeField
                label="Motion Blur"
                value={settings.video.motionBlur}
                min={0}
                max={100}
                onChange={(value) => update({ ...settings, video: { ...settings.video, motionBlur: value } })}
              />
            </section>
          </div>
        ) : null}

        {tab === 'gameplay' ? (
          <div className="nxe-console-grid">
            <section className="nxe-console-panel">
              <h4>Core Gameplay</h4>
              <SelectField
                label="Difficulty"
                value={settings.gameplay.difficulty}
                options={DIFFICULTY_OPTIONS}
                onChange={(difficulty) => update({ ...settings, gameplay: { ...settings.gameplay, difficulty } })}
              />
              <SwitchField
                label="Crossplay"
                checked={settings.gameplay.crossplayEnabled}
                onChange={(checked) =>
                  update({ ...settings, gameplay: { ...settings.gameplay, crossplayEnabled: checked } })
                }
              />
              <SwitchField
                label="Invert Y Axis"
                checked={settings.gameplay.invertYAxis}
                onChange={(checked) =>
                  update({ ...settings, gameplay: { ...settings.gameplay, invertYAxis: checked } })
                }
              />
            </section>
            <section className="nxe-console-panel">
              <h4>Controls</h4>
              <RangeField
                label="Vibration"
                value={settings.gameplay.controllerVibration}
                min={0}
                max={100}
                onChange={(value) =>
                  update({ ...settings, gameplay: { ...settings.gameplay, controllerVibration: value } })
                }
              />
              <RangeField
                label="Aim Sensitivity"
                value={Math.round(settings.gameplay.aimSensitivity * 100)}
                min={30}
                max={250}
                onChange={(value) =>
                  update({ ...settings, gameplay: { ...settings.gameplay, aimSensitivity: value / 100 } })
                }
              />
              <RangeField
                label="Camera Shake"
                value={settings.gameplay.cameraShake}
                min={0}
                max={100}
                onChange={(value) => update({ ...settings, gameplay: { ...settings.gameplay, cameraShake: value } })}
              />
              <RangeField
                label="Auto Save (min)"
                value={settings.gameplay.autoSaveMinutes}
                min={3}
                max={30}
                onChange={(value) =>
                  update({ ...settings, gameplay: { ...settings.gameplay, autoSaveMinutes: value } })
                }
              />
            </section>
          </div>
        ) : null}

        {tab === 'accessibility' ? (
          <div className="nxe-console-grid">
            <section className="nxe-console-panel">
              <h4>Readability</h4>
              <SwitchField
                label="Subtitles"
                checked={settings.accessibility.subtitlesEnabled}
                onChange={(checked) =>
                  update({ ...settings, accessibility: { ...settings.accessibility, subtitlesEnabled: checked } })
                }
              />
              <SelectField
                label="Subtitle Size"
                value={settings.accessibility.subtitleSize}
                options={SUBTITLE_OPTIONS}
                onChange={(subtitleSize) =>
                  update({ ...settings, accessibility: { ...settings.accessibility, subtitleSize } })
                }
              />
              <RangeField
                label="UI Scale"
                value={Math.round(settings.accessibility.uiScale * 100)}
                min={90}
                max={120}
                onChange={(value) =>
                  update({ ...settings, accessibility: { ...settings.accessibility, uiScale: value / 100 } })
                }
              />
            </section>
            <section className="nxe-console-panel">
              <h4>Assist</h4>
              <SwitchField
                label="High Contrast UI"
                checked={settings.accessibility.highContrastUi}
                onChange={(checked) =>
                  update({ ...settings, accessibility: { ...settings.accessibility, highContrastUi: checked } })
                }
              />
              <SwitchField
                label="Reduced Motion"
                checked={settings.accessibility.reducedMotion}
                onChange={(checked) =>
                  update({ ...settings, accessibility: { ...settings.accessibility, reducedMotion: checked } })
                }
              />
              <SwitchField
                label="Text to Speech"
                checked={settings.accessibility.textToSpeech}
                onChange={(checked) =>
                  update({ ...settings, accessibility: { ...settings.accessibility, textToSpeech: checked } })
                }
              />
              <SelectField
                label="Colorblind Mode"
                value={settings.accessibility.colorblindMode}
                options={COLORBLIND_OPTIONS}
                onChange={(colorblindMode) =>
                  update({ ...settings, accessibility: { ...settings.accessibility, colorblindMode } })
                }
              />
            </section>
          </div>
        ) : null}

        {tab === 'network' ? (
          <div className="nxe-console-grid">
            <section className="nxe-console-panel">
              <h4>Matchmaking</h4>
              <SelectField
                label="Region"
                value={settings.network.region}
                options={REGION_OPTIONS}
                onChange={(region) => update({ ...settings, network: { ...settings.network, region } })}
              />
              <SelectField
                label="Party Privacy"
                value={settings.network.partyPrivacy}
                options={PARTY_OPTIONS}
                onChange={(partyPrivacy) => update({ ...settings, network: { ...settings.network, partyPrivacy } })}
              />
              <SwitchField
                label="Crossplay"
                checked={settings.gameplay.crossplayEnabled}
                onChange={(checked) =>
                  update({ ...settings, gameplay: { ...settings.gameplay, crossplayEnabled: checked } })
                }
              />
            </section>
            <section className="nxe-console-panel">
              <h4>Comms and Data</h4>
              <SwitchField
                label="Voice Chat"
                checked={settings.network.voiceChatEnabled}
                onChange={(checked) =>
                  update({ ...settings, network: { ...settings.network, voiceChatEnabled: checked } })
                }
              />
              <SwitchField
                label="Push To Talk"
                checked={settings.network.pushToTalk}
                onChange={(checked) => update({ ...settings, network: { ...settings.network, pushToTalk: checked } })}
              />
              <SwitchField
                label="Telemetry"
                checked={settings.network.telemetryOptIn}
                onChange={(checked) =>
                  update({ ...settings, network: { ...settings.network, telemetryOptIn: checked } })
                }
              />
            </section>
          </div>
        ) : null}

        {tab === 'storage' ? (
          <div className="nxe-console-grid">
            <section className="nxe-console-panel">
              <h4>Save Data</h4>
              <SwitchField
                label="Cloud Saves"
                checked={settings.storage.cloudSavesEnabled}
                onChange={(checked) =>
                  update({ ...settings, storage: { ...settings.storage, cloudSavesEnabled: checked } })
                }
              />
              <SwitchField
                label="Auto Highlights"
                checked={settings.storage.autoCaptureHighlights}
                onChange={(checked) =>
                  update({ ...settings, storage: { ...settings.storage, autoCaptureHighlights: checked } })
                }
              />
              <SwitchField
                label="Streamer Mode"
                checked={settings.storage.streamerMode}
                onChange={(checked) => update({ ...settings, storage: { ...settings.storage, streamerMode: checked } })}
              />
              <SwitchField
                label="Allow Mods"
                checked={settings.storage.allowMods}
                onChange={(checked) => update({ ...settings, storage: { ...settings.storage, allowMods: checked } })}
              />
              <SelectField
                label="Maturity Filter"
                value={settings.storage.maturityFilter}
                options={MATURITY_OPTIONS}
                onChange={(maturityFilter) =>
                  update({ ...settings, storage: { ...settings.storage, maturityFilter } })
                }
              />
            </section>
            <section className="nxe-console-panel">
              <h4>Storage Notes</h4>
              <p className="nxe-console-note">
                Global settings apply to all games in this client profile. You can keep cloud saves on for continuity
                while disabling highlights to reduce disk churn.
              </p>
            </section>
          </div>
        ) : null}

        {tab === 'account' ? (
          <div className="nxe-console-grid nxe-console-grid-account">
            <section className="nxe-console-panel">
              <h4>Wallet and Avatar</h4>
              <p className="nxe-console-note">
                Account actions are shared across all games. Uploading a default VRM updates the menu and player
                presentation everywhere.
              </p>
              <PlayerProfileCard gameId={gameId} scene={startScene} gameName={gameName} />
            </section>
          </div>
        ) : null}
      </div>
    </section>
  );
}

type SwitchFieldProps = {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
};

function SwitchField({ label, checked, onChange }: SwitchFieldProps) {
  return (
    <label className="nxe-console-toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

type RangeFieldProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

function RangeField({ label, value, min, max, onChange }: RangeFieldProps) {
  return (
    <label className="nxe-console-range-row">
      <span>{label}</span>
      <div>
        <input
          type="range"
          value={value}
          min={min}
          max={max}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <strong>{value}</strong>
      </div>
    </label>
  );
}

type SelectFieldProps<T extends string> = {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
};

function SelectField<T extends string>({ label, value, options, onChange }: SelectFieldProps<T>) {
  return (
    <label className="nxe-console-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
