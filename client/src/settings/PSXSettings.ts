/**
 * PSX Settings Manager
 * Centralized configuration for PS1 aesthetic rendering
 */

export interface PSXSettingsConfig {
  // Master toggle
  enabled: boolean;

  // Console preset
  consolePreset: 'ps1' | 'n64' | 'dreamcast' | 'xbox' | 'modern';

  // Resolution
  resolutionPreset: 'ps1' | 'ps1-high' | 'native';
  customWidth?: number;
  customHeight?: number;

  // Rendering
  jitterIntensity: number;
  affineMapping: boolean;
  pixelated: boolean;
  antiAliasing: boolean;
  textureFiltering: 'nearest' | 'bilinear' | 'trilinear';

  // Post-processing
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

  // Color/Lighting adjustments
  contrast: number;
  saturation: number;
  gamma: number;
  exposure: number;
}

export class PSXSettings {
  private static instance: PSXSettings;
  public config: PSXSettingsConfig;

  private constructor() {
    // Load from localStorage or use defaults
    const saved = localStorage.getItem('psx-settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Merge with defaults to ensure all properties exist (for backwards compatibility)
        this.config = { ...PSXSettings.getDefaultConfig(), ...parsed };
      } catch {
        this.config = PSXSettings.getDefaultConfig();
      }
    } else {
      this.config = PSXSettings.getDefaultConfig();
    }
  }

  public static getInstance(): PSXSettings {
    if (!PSXSettings.instance) {
      PSXSettings.instance = new PSXSettings();
    }
    return PSXSettings.instance;
  }

  public static getDefaultConfig(): PSXSettingsConfig {
    return {
      enabled: false, // Start disabled by default
      consolePreset: 'ps1',
      resolutionPreset: 'ps1',
      jitterIntensity: 1.0,
      affineMapping: true,
      pixelated: true,
      antiAliasing: false,
      textureFiltering: 'nearest',
      blur: false,
      blurStrength: 0.0,
      colorQuantization: true,
      colorBits: 5, // 15-bit color (RGB555)
      dithering: true,
      ditherStrength: 0.8,
      crtEffects: true,
      scanlineIntensity: 0.3,
      curvature: 0.1,
      vignette: 0.4,
      brightness: 1.3, // Increased default brightness
      chromaticAberration: true,
      chromaticOffset: 0.002,
      contrast: 1.1,
      saturation: 1.0,
      gamma: 1.0,
      exposure: 1.0,
    };
  }

  public static getPreset(preset: 'authentic' | 'lite' | 'modern'): Partial<PSXSettingsConfig> {
    switch (preset) {
      case 'authentic':
        return {
          enabled: true,
          resolutionPreset: 'ps1',
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
          resolutionPreset: 'ps1-high',
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

  public static getConsolePreset(
    console: 'ps1' | 'n64' | 'dreamcast' | 'xbox' | 'modern',
  ): Partial<PSXSettingsConfig> {
    switch (console) {
      case 'ps1':
        return {
          enabled: true,
          consolePreset: 'ps1',
          resolutionPreset: 'ps1',
          jitterIntensity: 1.0,
          affineMapping: true,
          pixelated: true,
          antiAliasing: false,
          textureFiltering: 'nearest',
          blur: false,
          blurStrength: 0.0,
          colorQuantization: true,
          colorBits: 5, // 15-bit color
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

      case 'n64':
        return {
          enabled: true,
          consolePreset: 'n64',
          resolutionPreset: 'ps1', // Same low res as PS1
          jitterIntensity: 0.3, // Less jitter than PS1
          affineMapping: false, // N64 had perspective-correct texturing
          pixelated: false, // N64 used bilinear filtering (blurry)
          antiAliasing: true, // N64 had 3-point filtering
          textureFiltering: 'bilinear', // Characteristic N64 blur
          blur: true, // N64's signature blur
          blurStrength: 1.2,
          colorQuantization: true,
          colorBits: 7, // 21-bit color (better than PS1)
          dithering: false, // Less dithering than PS1
          ditherStrength: 0.3,
          crtEffects: true,
          scanlineIntensity: 0.2, // Lighter scanlines
          curvature: 0.08,
          vignette: 0.3,
          brightness: 1.2,
          chromaticAberration: false, // Cleaner than PS1
          chromaticOffset: 0.001,
          contrast: 1.05,
          saturation: 0.95, // Slightly desaturated N64 look
          gamma: 1.05, // Slightly brighter gamma
          exposure: 1.0,
        };

      case 'dreamcast':
        return {
          enabled: true,
          consolePreset: 'dreamcast',
          resolutionPreset: 'ps1-high', // 640x480 VGA
          jitterIntensity: 0.0, // No vertex jitter
          affineMapping: false,
          pixelated: false,
          antiAliasing: true, // Hardware AA
          textureFiltering: 'bilinear', // Good texture filtering
          blur: false, // Clean output
          blurStrength: 0.3,
          colorQuantization: false, // 24-bit color
          colorBits: 8,
          dithering: false,
          ditherStrength: 0.0,
          crtEffects: true,
          scanlineIntensity: 0.15, // Very subtle
          curvature: 0.05,
          vignette: 0.2,
          brightness: 1.15,
          chromaticAberration: false,
          chromaticOffset: 0.0,
          contrast: 1.08,
          saturation: 1.05, // Slightly more saturated
          gamma: 1.0,
          exposure: 1.0,
        };

      case 'xbox':
        return {
          enabled: true,
          consolePreset: 'xbox',
          resolutionPreset: 'native', // 480p/720p
          jitterIntensity: 0.0,
          affineMapping: false,
          pixelated: false,
          antiAliasing: true, // Good AA
          textureFiltering: 'trilinear', // Best filtering
          blur: false,
          blurStrength: 0.0,
          colorQuantization: false,
          colorBits: 8,
          dithering: false,
          ditherStrength: 0.0,
          crtEffects: false, // Xbox era = HD, less CRT
          scanlineIntensity: 0.1,
          curvature: 0.02,
          vignette: 0.15,
          brightness: 1.1,
          chromaticAberration: false,
          chromaticOffset: 0.0,
          contrast: 1.1,
          saturation: 1.1, // More vibrant
          gamma: 1.0,
          exposure: 1.05,
        };

      case 'modern':
        return {
          enabled: false,
          consolePreset: 'modern',
          resolutionPreset: 'native',
          jitterIntensity: 0.0,
          affineMapping: false,
          pixelated: false,
          antiAliasing: true,
          textureFiltering: 'trilinear',
          blur: false,
          blurStrength: 0.0,
          colorQuantization: false,
          colorBits: 8,
          dithering: false,
          ditherStrength: 0.0,
          crtEffects: false,
          scanlineIntensity: 0.0,
          curvature: 0.0,
          vignette: 0.0,
          brightness: 1.0,
          chromaticAberration: false,
          chromaticOffset: 0.0,
          contrast: 1.0,
          saturation: 1.0,
          gamma: 1.0,
          exposure: 1.0,
        };
    }
  }

  public applyConsolePreset(console: 'ps1' | 'n64' | 'dreamcast' | 'xbox' | 'modern'): void {
    const presetConfig = PSXSettings.getConsolePreset(console);
    this.config = { ...this.config, ...presetConfig };
    this.save();
  }

  public getResolution(): { width: number; height: number } {
    if (this.config.customWidth && this.config.customHeight) {
      return { width: this.config.customWidth, height: this.config.customHeight };
    }

    const aspect = window.innerWidth / window.innerHeight;

    switch (this.config.resolutionPreset) {
      case 'ps1':
        return { width: Math.floor(240 * aspect), height: 240 };

      case 'ps1-high':
        return { width: Math.floor(480 * aspect), height: 480 };

      case 'native':
        return { width: window.innerWidth, height: window.innerHeight };
    }
  }

  public applyPreset(preset: 'authentic' | 'lite' | 'modern'): void {
    const presetConfig = PSXSettings.getPreset(preset);
    this.config = { ...this.config, ...presetConfig };
    this.save();
  }

  public update(partial: Partial<PSXSettingsConfig>): void {
    this.config = { ...this.config, ...partial };
    this.save();
  }

  public save(): void {
    localStorage.setItem('psx-settings', JSON.stringify(this.config));
  }

  public reset(): void {
    this.config = PSXSettings.getDefaultConfig();
    this.save();
  }
}

// Export singleton instance
export const psxSettings = PSXSettings.getInstance();
