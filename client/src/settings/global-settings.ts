import { menuAudio } from '../audio/menu-audio';

export const GLOBAL_SETTINGS_STORAGE_KEY = 'nxe_global_settings_v1';

export type QualityPreset = 'performance' | 'balanced' | 'quality' | 'cinematic';
export type DifficultyPreset = 'story' | 'normal' | 'hard' | 'nightmare';
export type SubtitleSize = 'small' | 'medium' | 'large';
export type ColorblindMode = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export type NetworkRegion = 'auto' | 'na-east' | 'na-west' | 'eu-central' | 'ap-southeast';
export type PartyPrivacy = 'public' | 'friends' | 'invite-only';
export type ContentMaturity = 'teen' | 'mature' | 'unfiltered';

export type GlobalSettings = {
  version: 1;
  profile: {
    displayName: string;
    onlineStatus: string;
    bio: string;
    regionLabel: string;
  };
  audio: {
    muteAll: boolean;
    masterVolume: number;
    musicVolume: number;
    sfxVolume: number;
    voiceChatVolume: number;
    menuMusicEnabled: boolean;
  };
  video: {
    qualityPreset: QualityPreset;
    brightness: number;
    gamma: number;
    fieldOfView: number;
    vSync: boolean;
    hdr: boolean;
    showFps: boolean;
    motionBlur: number;
  };
  gameplay: {
    difficulty: DifficultyPreset;
    crossplayEnabled: boolean;
    invertYAxis: boolean;
    controllerVibration: number;
    aimSensitivity: number;
    cameraShake: number;
    autoSaveMinutes: number;
  };
  accessibility: {
    subtitlesEnabled: boolean;
    subtitleSize: SubtitleSize;
    highContrastUi: boolean;
    colorblindMode: ColorblindMode;
    reducedMotion: boolean;
    textToSpeech: boolean;
    uiScale: number;
  };
  network: {
    region: NetworkRegion;
    voiceChatEnabled: boolean;
    pushToTalk: boolean;
    telemetryOptIn: boolean;
    partyPrivacy: PartyPrivacy;
  };
  storage: {
    cloudSavesEnabled: boolean;
    autoCaptureHighlights: boolean;
    streamerMode: boolean;
    allowMods: boolean;
    maturityFilter: ContentMaturity;
  };
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const getDefaultGlobalSettings = (): GlobalSettings => ({
  version: 1,
  profile: {
    displayName: 'Player One',
    onlineStatus: 'Ready to squad up',
    bio: 'Built for high-score runs and smooth frame pacing.',
    regionLabel: 'United States',
  },
  audio: {
    muteAll: false,
    masterVolume: 82,
    musicVolume: 65,
    sfxVolume: 78,
    voiceChatVolume: 70,
    menuMusicEnabled: true,
  },
  video: {
    qualityPreset: 'quality',
    brightness: 1,
    gamma: 1,
    fieldOfView: 90,
    vSync: true,
    hdr: false,
    showFps: false,
    motionBlur: 20,
  },
  gameplay: {
    difficulty: 'normal',
    crossplayEnabled: true,
    invertYAxis: false,
    controllerVibration: 80,
    aimSensitivity: 1,
    cameraShake: 60,
    autoSaveMinutes: 10,
  },
  accessibility: {
    subtitlesEnabled: true,
    subtitleSize: 'medium',
    highContrastUi: false,
    colorblindMode: 'off',
    reducedMotion: false,
    textToSpeech: false,
    uiScale: 1,
  },
  network: {
    region: 'auto',
    voiceChatEnabled: true,
    pushToTalk: false,
    telemetryOptIn: true,
    partyPrivacy: 'friends',
  },
  storage: {
    cloudSavesEnabled: true,
    autoCaptureHighlights: true,
    streamerMode: false,
    allowMods: false,
    maturityFilter: 'mature',
  },
});

const sanitizeGlobalSettings = (value: unknown): GlobalSettings => {
  const defaults = getDefaultGlobalSettings();
  if (!isObject(value)) return defaults;

  const profile = isObject(value.profile) ? value.profile : {};
  const audio = isObject(value.audio) ? value.audio : {};
  const video = isObject(value.video) ? value.video : {};
  const gameplay = isObject(value.gameplay) ? value.gameplay : {};
  const accessibility = isObject(value.accessibility) ? value.accessibility : {};
  const network = isObject(value.network) ? value.network : {};
  const storage = isObject(value.storage) ? value.storage : {};

  return {
    ...defaults,
    profile: {
      displayName: typeof profile.displayName === 'string' ? profile.displayName.slice(0, 32) : defaults.profile.displayName,
      onlineStatus: typeof profile.onlineStatus === 'string' ? profile.onlineStatus.slice(0, 48) : defaults.profile.onlineStatus,
      bio: typeof profile.bio === 'string' ? profile.bio.slice(0, 180) : defaults.profile.bio,
      regionLabel: typeof profile.regionLabel === 'string' ? profile.regionLabel.slice(0, 32) : defaults.profile.regionLabel,
    },
    audio: {
      muteAll: typeof audio.muteAll === 'boolean' ? audio.muteAll : defaults.audio.muteAll,
      masterVolume: clamp(Number(audio.masterVolume ?? defaults.audio.masterVolume), 0, 100),
      musicVolume: clamp(Number(audio.musicVolume ?? defaults.audio.musicVolume), 0, 100),
      sfxVolume: clamp(Number(audio.sfxVolume ?? defaults.audio.sfxVolume), 0, 100),
      voiceChatVolume: clamp(Number(audio.voiceChatVolume ?? defaults.audio.voiceChatVolume), 0, 100),
      menuMusicEnabled: typeof audio.menuMusicEnabled === 'boolean' ? audio.menuMusicEnabled : defaults.audio.menuMusicEnabled,
    },
    video: {
      qualityPreset:
        video.qualityPreset === 'performance' ||
        video.qualityPreset === 'balanced' ||
        video.qualityPreset === 'quality' ||
        video.qualityPreset === 'cinematic'
          ? video.qualityPreset
          : defaults.video.qualityPreset,
      brightness: clamp(Number(video.brightness ?? defaults.video.brightness), 0.5, 1.6),
      gamma: clamp(Number(video.gamma ?? defaults.video.gamma), 0.5, 1.6),
      fieldOfView: clamp(Number(video.fieldOfView ?? defaults.video.fieldOfView), 70, 120),
      vSync: typeof video.vSync === 'boolean' ? video.vSync : defaults.video.vSync,
      hdr: typeof video.hdr === 'boolean' ? video.hdr : defaults.video.hdr,
      showFps: typeof video.showFps === 'boolean' ? video.showFps : defaults.video.showFps,
      motionBlur: clamp(Number(video.motionBlur ?? defaults.video.motionBlur), 0, 100),
    },
    gameplay: {
      difficulty:
        gameplay.difficulty === 'story' ||
        gameplay.difficulty === 'normal' ||
        gameplay.difficulty === 'hard' ||
        gameplay.difficulty === 'nightmare'
          ? gameplay.difficulty
          : defaults.gameplay.difficulty,
      crossplayEnabled:
        typeof gameplay.crossplayEnabled === 'boolean'
          ? gameplay.crossplayEnabled
          : defaults.gameplay.crossplayEnabled,
      invertYAxis: typeof gameplay.invertYAxis === 'boolean' ? gameplay.invertYAxis : defaults.gameplay.invertYAxis,
      controllerVibration: clamp(Number(gameplay.controllerVibration ?? defaults.gameplay.controllerVibration), 0, 100),
      aimSensitivity: clamp(Number(gameplay.aimSensitivity ?? defaults.gameplay.aimSensitivity), 0.3, 2.5),
      cameraShake: clamp(Number(gameplay.cameraShake ?? defaults.gameplay.cameraShake), 0, 100),
      autoSaveMinutes: clamp(Number(gameplay.autoSaveMinutes ?? defaults.gameplay.autoSaveMinutes), 3, 30),
    },
    accessibility: {
      subtitlesEnabled:
        typeof accessibility.subtitlesEnabled === 'boolean'
          ? accessibility.subtitlesEnabled
          : defaults.accessibility.subtitlesEnabled,
      subtitleSize:
        accessibility.subtitleSize === 'small' ||
        accessibility.subtitleSize === 'medium' ||
        accessibility.subtitleSize === 'large'
          ? accessibility.subtitleSize
          : defaults.accessibility.subtitleSize,
      highContrastUi:
        typeof accessibility.highContrastUi === 'boolean'
          ? accessibility.highContrastUi
          : defaults.accessibility.highContrastUi,
      colorblindMode:
        accessibility.colorblindMode === 'off' ||
        accessibility.colorblindMode === 'protanopia' ||
        accessibility.colorblindMode === 'deuteranopia' ||
        accessibility.colorblindMode === 'tritanopia'
          ? accessibility.colorblindMode
          : defaults.accessibility.colorblindMode,
      reducedMotion:
        typeof accessibility.reducedMotion === 'boolean'
          ? accessibility.reducedMotion
          : defaults.accessibility.reducedMotion,
      textToSpeech:
        typeof accessibility.textToSpeech === 'boolean'
          ? accessibility.textToSpeech
          : defaults.accessibility.textToSpeech,
      uiScale: clamp(Number(accessibility.uiScale ?? defaults.accessibility.uiScale), 0.9, 1.2),
    },
    network: {
      region:
        network.region === 'auto' ||
        network.region === 'na-east' ||
        network.region === 'na-west' ||
        network.region === 'eu-central' ||
        network.region === 'ap-southeast'
          ? network.region
          : defaults.network.region,
      voiceChatEnabled:
        typeof network.voiceChatEnabled === 'boolean'
          ? network.voiceChatEnabled
          : defaults.network.voiceChatEnabled,
      pushToTalk: typeof network.pushToTalk === 'boolean' ? network.pushToTalk : defaults.network.pushToTalk,
      telemetryOptIn:
        typeof network.telemetryOptIn === 'boolean' ? network.telemetryOptIn : defaults.network.telemetryOptIn,
      partyPrivacy:
        network.partyPrivacy === 'public' || network.partyPrivacy === 'friends' || network.partyPrivacy === 'invite-only'
          ? network.partyPrivacy
          : defaults.network.partyPrivacy,
    },
    storage: {
      cloudSavesEnabled:
        typeof storage.cloudSavesEnabled === 'boolean'
          ? storage.cloudSavesEnabled
          : defaults.storage.cloudSavesEnabled,
      autoCaptureHighlights:
        typeof storage.autoCaptureHighlights === 'boolean'
          ? storage.autoCaptureHighlights
          : defaults.storage.autoCaptureHighlights,
      streamerMode: typeof storage.streamerMode === 'boolean' ? storage.streamerMode : defaults.storage.streamerMode,
      allowMods: typeof storage.allowMods === 'boolean' ? storage.allowMods : defaults.storage.allowMods,
      maturityFilter:
        storage.maturityFilter === 'teen' || storage.maturityFilter === 'mature' || storage.maturityFilter === 'unfiltered'
          ? storage.maturityFilter
          : defaults.storage.maturityFilter,
    },
  };
};

export const loadGlobalSettings = (): GlobalSettings => {
  if (typeof window === 'undefined') return getDefaultGlobalSettings();
  const raw = window.localStorage.getItem(GLOBAL_SETTINGS_STORAGE_KEY);
  if (!raw) return getDefaultGlobalSettings();
  try {
    return sanitizeGlobalSettings(JSON.parse(raw));
  } catch {
    return getDefaultGlobalSettings();
  }
};

export const saveGlobalSettings = (settings: GlobalSettings) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
};

export const resetGlobalSettings = (): GlobalSettings => {
  const defaults = getDefaultGlobalSettings();
  saveGlobalSettings(defaults);
  return defaults;
};

export const applyGlobalSettings = (settings: GlobalSettings) => {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.style.setProperty('--nxe-ui-scale', settings.accessibility.uiScale.toFixed(2));
    root.style.setProperty('--nxe-menu-brightness', settings.video.brightness.toFixed(2));
    root.style.setProperty('--nxe-menu-gamma', settings.video.gamma.toFixed(2));
    root.style.setProperty('--nxe-menu-motion-blur', (settings.video.motionBlur / 100).toFixed(2));
    root.style.setProperty('--nxe-menu-shake', (settings.gameplay.cameraShake / 100).toFixed(2));
    root.style.setProperty('--nxe-aim-sensitivity', settings.gameplay.aimSensitivity.toFixed(2));
    root.style.setProperty('--nxe-controller-vibration', (settings.gameplay.controllerVibration / 100).toFixed(2));
    root.style.setProperty('--nxe-autosave-minutes', `${settings.gameplay.autoSaveMinutes}`);
    root.setAttribute('data-nxe-motion', settings.accessibility.reducedMotion ? 'reduced' : 'full');
    root.setAttribute('data-nxe-contrast', settings.accessibility.highContrastUi ? 'high' : 'normal');
    root.setAttribute('data-nxe-colorblind', settings.accessibility.colorblindMode);
    root.setAttribute('data-nxe-quality', settings.video.qualityPreset);
    root.setAttribute('data-nxe-vsync', settings.video.vSync ? 'on' : 'off');
    root.setAttribute('data-nxe-hdr', settings.video.hdr ? 'on' : 'off');
    root.setAttribute('data-nxe-show-fps', settings.video.showFps ? 'on' : 'off');
    root.setAttribute('data-nxe-subtitles', settings.accessibility.subtitlesEnabled ? 'on' : 'off');
    root.setAttribute('data-nxe-subtitle-size', settings.accessibility.subtitleSize);
    root.setAttribute('data-nxe-crossplay', settings.gameplay.crossplayEnabled ? 'on' : 'off');
    root.setAttribute('data-nxe-invert-y', settings.gameplay.invertYAxis ? 'on' : 'off');
    root.setAttribute('data-nxe-region', settings.network.region);
    root.setAttribute('data-nxe-party-privacy', settings.network.partyPrivacy);
    root.setAttribute('data-nxe-voice-chat', settings.network.voiceChatEnabled ? 'on' : 'off');
    root.setAttribute('data-nxe-push-to-talk', settings.network.pushToTalk ? 'on' : 'off');
    root.setAttribute('data-nxe-telemetry', settings.network.telemetryOptIn ? 'on' : 'off');
    root.setAttribute('data-nxe-cloud-saves', settings.storage.cloudSavesEnabled ? 'on' : 'off');
    root.setAttribute('data-nxe-streamer-mode', settings.storage.streamerMode ? 'on' : 'off');
    root.setAttribute('data-nxe-allow-mods', settings.storage.allowMods ? 'on' : 'off');
    root.setAttribute('data-nxe-maturity-filter', settings.storage.maturityFilter);
  }

  menuAudio.configureMix({
    muteAll: settings.audio.muteAll,
    master: settings.audio.masterVolume / 100,
    ui: settings.audio.sfxVolume / 100,
    ambient: settings.audio.musicVolume / 100,
  });
  menuAudio.setMenuAmbient(settings.audio.menuMusicEnabled && !settings.audio.muteAll);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<GlobalSettings>('nxe:global-settings-changed', {
        detail: settings,
      }),
    );
  }
};
