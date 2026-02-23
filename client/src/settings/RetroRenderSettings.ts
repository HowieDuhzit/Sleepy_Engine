export type RenderStylePreset = 'legacy' | 'soft' | 'arcade' | 'cinematic' | 'modern';
export type RenderResolutionPreset = 'low' | 'medium' | 'native';

export interface RetroRenderSettingsConfig {
  enabled: boolean;
  stylePreset: RenderStylePreset;
  resolutionPreset: RenderResolutionPreset;
  customWidth?: number;
  customHeight?: number;
  jitterIntensity: number;
  affineMapping: boolean;
  pixelated: boolean;
  antiAliasing: boolean;
  textureFiltering: 'nearest' | 'bilinear' | 'trilinear';
  blur: boolean;
  blurStrength: number;
  colorQuantization: boolean;
  colorBits: number;
  dithering: boolean;
  ditherStrength: number;
  crtEffects: boolean;
  scanlineIntensity: number;
  curvature: number;
  vignette: number;
  brightness: number;
  chromaticAberration: boolean;
  chromaticOffset: number;
  contrast: number;
  saturation: number;
  gamma: number;
  exposure: number;
}

export class RetroRenderSettings {
  private static instance: RetroRenderSettings;
  public config: RetroRenderSettingsConfig;

  private constructor() {
    const saved = localStorage.getItem('retro-settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Record<string, unknown>;
        this.config = {
          ...RetroRenderSettings.getDefaultConfig(),
          ...this.normalizeLegacyConfig(parsed),
        };
      } catch {
        this.config = RetroRenderSettings.getDefaultConfig();
      }
    } else {
      this.config = RetroRenderSettings.getDefaultConfig();
    }
  }

  public static getInstance(): RetroRenderSettings {
    if (!RetroRenderSettings.instance) {
      RetroRenderSettings.instance = new RetroRenderSettings();
    }
    return RetroRenderSettings.instance;
  }

  public static getDefaultConfig(): RetroRenderSettingsConfig {
    return {
      enabled: false,
      stylePreset: 'legacy',
      resolutionPreset: 'low',
      jitterIntensity: 1.0,
      affineMapping: true,
      pixelated: true,
      antiAliasing: false,
      textureFiltering: 'nearest',
      blur: false,
      blurStrength: 0.0,
      colorQuantization: true,
      colorBits: 5,
      dithering: true,
      ditherStrength: 0.8,
      crtEffects: true,
      scanlineIntensity: 0.3,
      curvature: 0.1,
      vignette: 0.4,
      brightness: 1.3,
      chromaticAberration: true,
      chromaticOffset: 0.002,
      contrast: 1.1,
      saturation: 1.0,
      gamma: 1.0,
      exposure: 1.0,
    };
  }

  private normalizeLegacyConfig(input: Record<string, unknown>): Partial<RetroRenderSettingsConfig> {
    const legacyStyle = String(input.stylePreset ?? 'legacy').toLowerCase();
    const styleMap: Record<string, RenderStylePreset> = {
      legacy: 'legacy',
      soft: 'soft',
      arcade: 'arcade',
      cinematic: 'cinematic',
      modern: 'modern',
    };

    const legacyRes = String(input.resolutionPreset ?? 'low').toLowerCase();
    const resolutionMap: Record<string, RenderResolutionPreset> = {
      low: 'low',
      medium: 'medium',
      native: 'native',
    };

    return {
      ...input,
      stylePreset: styleMap[legacyStyle] ?? 'legacy',
      resolutionPreset: resolutionMap[legacyRes] ?? 'low',
    } as Partial<RetroRenderSettingsConfig>;
  }

  public static getPreset(
    preset: 'authentic' | 'lite' | 'modern',
  ): Partial<RetroRenderSettingsConfig> {
    switch (preset) {
      case 'authentic':
        return {
          enabled: true,
          resolutionPreset: 'low',
          jitterIntensity: 1.0,
          affineMapping: true,
          pixelated: true,
          colorQuantization: true,
          colorBits: 5,
          dithering: true,
          ditherStrength: 0.8,
          crtEffects: true,
          scanlineIntensity: 0.3,
          curvature: 0.1,
          vignette: 0.4,
          brightness: 1.3,
          chromaticAberration: true,
          chromaticOffset: 0.002,
          contrast: 1.1,
          saturation: 1.0,
          gamma: 1.0,
          exposure: 1.0,
        };
      case 'lite':
        return {
          enabled: true,
          resolutionPreset: 'medium',
          jitterIntensity: 0.5,
          affineMapping: true,
          pixelated: true,
          colorQuantization: true,
          colorBits: 6,
          dithering: true,
          ditherStrength: 0.4,
          crtEffects: false,
          chromaticAberration: false,
          brightness: 1.2,
          contrast: 1.05,
          saturation: 1.0,
          gamma: 1.0,
          exposure: 1.0,
        };
      case 'modern':
        return {
          enabled: false,
          resolutionPreset: 'native',
          jitterIntensity: 0,
          affineMapping: false,
          pixelated: false,
          colorQuantization: false,
          dithering: false,
          crtEffects: false,
          chromaticAberration: false,
          brightness: 1.0,
          contrast: 1.0,
          saturation: 1.0,
          gamma: 1.0,
          exposure: 1.0,
        };
    }
  }

  public static getStylePreset(style: RenderStylePreset): Partial<RetroRenderSettingsConfig> {
    switch (style) {
      case 'legacy':
        return {
          enabled: true,
          stylePreset: 'legacy',
          resolutionPreset: 'low',
          jitterIntensity: 1.0,
          affineMapping: true,
          pixelated: true,
          antiAliasing: false,
          textureFiltering: 'nearest',
          blur: false,
          blurStrength: 0.0,
          colorQuantization: true,
          colorBits: 5,
          dithering: true,
          ditherStrength: 0.8,
          crtEffects: true,
          scanlineIntensity: 0.3,
          curvature: 0.1,
          vignette: 0.4,
          brightness: 1.3,
          chromaticAberration: true,
          chromaticOffset: 0.002,
          contrast: 1.1,
          saturation: 1.0,
          gamma: 1.0,
          exposure: 1.0,
        };
      case 'soft':
        return {
          enabled: true,
          stylePreset: 'soft',
          resolutionPreset: 'low',
          jitterIntensity: 0.3,
          affineMapping: false,
          pixelated: false,
          antiAliasing: true,
          textureFiltering: 'bilinear',
          blur: true,
          blurStrength: 1.2,
          colorQuantization: true,
          colorBits: 7,
          dithering: false,
          ditherStrength: 0.3,
          crtEffects: true,
          scanlineIntensity: 0.2,
          curvature: 0.08,
          vignette: 0.3,
          brightness: 1.2,
          chromaticAberration: false,
          chromaticOffset: 0.001,
          contrast: 1.05,
          saturation: 0.95,
          gamma: 1.05,
          exposure: 1.0,
        };
      case 'arcade':
        return {
          enabled: true,
          stylePreset: 'arcade',
          resolutionPreset: 'medium',
          jitterIntensity: 0,
          affineMapping: false,
          pixelated: false,
          antiAliasing: true,
          textureFiltering: 'bilinear',
          blur: false,
          blurStrength: 0.3,
          colorQuantization: false,
          colorBits: 8,
          dithering: false,
          ditherStrength: 0,
          crtEffects: true,
          scanlineIntensity: 0.15,
          curvature: 0.05,
          vignette: 0.2,
          brightness: 1.15,
          chromaticAberration: false,
          chromaticOffset: 0,
          contrast: 1.08,
          saturation: 1.05,
          gamma: 1.0,
          exposure: 1.0,
        };
      case 'cinematic':
        return {
          enabled: true,
          stylePreset: 'cinematic',
          resolutionPreset: 'native',
          jitterIntensity: 0,
          affineMapping: false,
          pixelated: false,
          antiAliasing: true,
          textureFiltering: 'trilinear',
          blur: false,
          blurStrength: 0,
          colorQuantization: false,
          colorBits: 8,
          dithering: false,
          ditherStrength: 0,
          crtEffects: false,
          scanlineIntensity: 0.1,
          curvature: 0.02,
          vignette: 0.15,
          brightness: 1.1,
          chromaticAberration: false,
          chromaticOffset: 0,
          contrast: 1.1,
          saturation: 1.1,
          gamma: 1.0,
          exposure: 1.05,
        };
      case 'modern':
        return {
          enabled: false,
          stylePreset: 'modern',
          resolutionPreset: 'native',
          jitterIntensity: 0,
          affineMapping: false,
          pixelated: false,
          antiAliasing: true,
          textureFiltering: 'trilinear',
          blur: false,
          blurStrength: 0,
          colorQuantization: false,
          colorBits: 8,
          dithering: false,
          ditherStrength: 0,
          crtEffects: false,
          scanlineIntensity: 0,
          curvature: 0,
          vignette: 0,
          brightness: 1,
          chromaticAberration: false,
          chromaticOffset: 0,
          contrast: 1,
          saturation: 1,
          gamma: 1,
          exposure: 1,
        };
    }
  }

  public applyStylePreset(style: RenderStylePreset): void {
    this.config = { ...this.config, ...RetroRenderSettings.getStylePreset(style) };
    this.save();
  }

  public getResolution(): { width: number; height: number } {
    if (this.config.customWidth && this.config.customHeight) {
      return { width: this.config.customWidth, height: this.config.customHeight };
    }
    const aspect = window.innerWidth / window.innerHeight;
    switch (this.config.resolutionPreset) {
      case 'low':
        return { width: Math.floor(240 * aspect), height: 240 };
      case 'medium':
        return { width: Math.floor(480 * aspect), height: 480 };
      case 'native':
        return { width: window.innerWidth, height: window.innerHeight };
    }
  }

  public applyPreset(preset: 'authentic' | 'lite' | 'modern'): void {
    this.config = { ...this.config, ...RetroRenderSettings.getPreset(preset) };
    this.save();
  }

  public update(partial: Partial<RetroRenderSettingsConfig>): void {
    this.config = { ...this.config, ...partial };
    this.save();
  }

  public save(): void {
    localStorage.setItem('retro-settings', JSON.stringify(this.config));
  }

  public reset(): void {
    this.config = RetroRenderSettings.getDefaultConfig();
    this.save();
  }
}

export const retroRenderSettings = RetroRenderSettings.getInstance();
