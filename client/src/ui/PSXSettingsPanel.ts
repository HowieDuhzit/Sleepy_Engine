/**
 * PSX Settings Panel - Global settings UI for PS1 aesthetic
 * Can be used in main menu, game, and editor
 */

import { psxSettings } from '../settings/PSXSettings';

export class PSXSettingsPanel {
  private panel: HTMLElement;
  private onSettingsChange?: () => void;

  constructor(onSettingsChange?: () => void) {
    this.onSettingsChange = onSettingsChange;
    this.panel = this.createPanel();
    this.setupEventListeners();
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'psx-settings-panel';
    panel.className = 'psx-settings-panel';
    panel.style.cssText = `
      background: rgba(10, 10, 20, 0.95);
      color: #0ff;
      padding: 20px;
      border: 2px solid #0ff;
      font-family: monospace;
      font-size: 14px;
      min-width: 300px;
    `;

    panel.innerHTML = `
      <h3 style="margin: 0 0 15px 0; color: #0ff; text-transform: uppercase;">
        🎮 Retro Console Graphics
      </h3>

      <label style="display: block; margin: 10px 0; cursor: pointer;">
        <input type="checkbox" id="psx-global-enabled" ${psxSettings.config.enabled ? 'checked' : ''}>
        <span style="margin-left: 8px;">Enable Retro Mode</span>
      </label>

      <div style="margin: 15px 0;">
        <label style="display: block; margin-bottom: 5px;">Console Preset:</label>
        <select id="psx-global-console" style="width: 100%; padding: 8px; background: #000; color: #0ff; border: 1px solid #0ff; font-family: monospace;">
          <option value="ps1">PlayStation 1 (1994)</option>
          <option value="n64">Nintendo 64 (1996)</option>
          <option value="dreamcast">Sega Dreamcast (1998)</option>
          <option value="xbox">Xbox (2001)</option>
          <option value="modern">Modern (No Effects)</option>
        </select>
      </div>

      <div style="margin: 15px 0;">
        <label style="display: block; margin-bottom: 5px;">Quality Preset:</label>
        <select id="psx-global-preset" style="width: 100%; padding: 8px; background: #000; color: #0ff; border: 1px solid #0ff; font-family: monospace;">
          <option value="authentic">Authentic</option>
          <option value="lite">Enhanced</option>
          <option value="modern">Disabled</option>
        </select>
      </div>

      <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #0ff;">
        <label style="display: block; margin: 8px 0; cursor: pointer;">
          <input type="checkbox" id="psx-global-affine" ${psxSettings.config.affineMapping ? 'checked' : ''}>
          <span style="margin-left: 8px;">Affine Texture Mapping</span>
        </label>

        <label style="display: block; margin: 8px 0; cursor: pointer;">
          <input type="checkbox" id="psx-global-quantization" ${psxSettings.config.colorQuantization ? 'checked' : ''}>
          <span style="margin-left: 8px;">15-bit Color (Color Banding)</span>
        </label>

        <label style="display: block; margin: 8px 0; cursor: pointer;">
          <input type="checkbox" id="psx-global-dither" ${psxSettings.config.dithering ? 'checked' : ''}>
          <span style="margin-left: 8px;">Dithering</span>
        </label>

        <label style="display: block; margin: 8px 0; cursor: pointer;">
          <input type="checkbox" id="psx-global-crt" ${psxSettings.config.crtEffects ? 'checked' : ''}>
          <span style="margin-left: 8px;">CRT Effects</span>
        </label>

        <label style="display: block; margin: 8px 0; cursor: pointer;">
          <input type="checkbox" id="psx-global-chromatic" ${psxSettings.config.chromaticAberration ? 'checked' : ''}>
          <span style="margin-left: 8px;">Chromatic Aberration</span>
        </label>
      </div>

      <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #0ff;">
        <h4 style="margin: 0 0 10px 0; color: #0ff;">Color & Lighting</h4>

        <label style="display: block; margin: 10px 0;">
          <span>Brightness: <span id="psx-global-brightness-value">${psxSettings.config.brightness.toFixed(1)}</span></span>
          <input type="range" id="psx-global-brightness" min="0.5" max="2.0" step="0.1" value="${psxSettings.config.brightness}" style="width: 100%;">
        </label>

        <label style="display: block; margin: 10px 0;">
          <span>Contrast: <span id="psx-global-contrast-value">${psxSettings.config.contrast.toFixed(1)}</span></span>
          <input type="range" id="psx-global-contrast" min="0.5" max="2.0" step="0.1" value="${psxSettings.config.contrast}" style="width: 100%;">
        </label>

        <label style="display: block; margin: 10px 0;">
          <span>Saturation: <span id="psx-global-saturation-value">${psxSettings.config.saturation.toFixed(1)}</span></span>
          <input type="range" id="psx-global-saturation" min="0.0" max="2.0" step="0.1" value="${psxSettings.config.saturation}" style="width: 100%;">
        </label>

        <label style="display: block; margin: 10px 0;">
          <span>Gamma: <span id="psx-global-gamma-value">${psxSettings.config.gamma.toFixed(1)}</span></span>
          <input type="range" id="psx-global-gamma" min="0.5" max="2.0" step="0.1" value="${psxSettings.config.gamma}" style="width: 100%;">
        </label>

        <label style="display: block; margin: 10px 0;">
          <span>Exposure: <span id="psx-global-exposure-value">${psxSettings.config.exposure.toFixed(1)}</span></span>
          <input type="range" id="psx-global-exposure" min="0.5" max="2.0" step="0.1" value="${psxSettings.config.exposure}" style="width: 100%;">
        </label>
      </div>

      <div style="margin: 15px 0; padding: 15px; background: rgba(0, 255, 255, 0.1); border-left: 3px solid #0ff;">
        <small style="display: block; line-height: 1.5;">
          <strong>Retro Console Mode</strong> recreates authentic classic console graphics.<br><br>
          <strong>PS1:</strong> Wobbly textures, vertex jitter, 15-bit color<br>
          <strong>N64:</strong> Blurry bilinear filtering, fog, 21-bit color<br>
          <strong>Dreamcast:</strong> Clean VGA output, hardware AA<br>
          <strong>Xbox:</strong> HD-era graphics, advanced effects
        </small>
      </div>
    `;

    return panel;
  }

  private setupEventListeners(): void {
    const enabled = this.panel.querySelector('#psx-global-enabled') as HTMLInputElement;
    const consolePreset = this.panel.querySelector('#psx-global-console') as HTMLSelectElement;
    const preset = this.panel.querySelector('#psx-global-preset') as HTMLSelectElement;
    const affine = this.panel.querySelector('#psx-global-affine') as HTMLInputElement;
    const quantization = this.panel.querySelector('#psx-global-quantization') as HTMLInputElement;
    const dither = this.panel.querySelector('#psx-global-dither') as HTMLInputElement;
    const crt = this.panel.querySelector('#psx-global-crt') as HTMLInputElement;
    const chromatic = this.panel.querySelector('#psx-global-chromatic') as HTMLInputElement;

    enabled.addEventListener('change', () => {
      psxSettings.update({ enabled: enabled.checked });
      this.notifyChange();
    });

    consolePreset.addEventListener('change', () => {
      psxSettings.applyConsolePreset(consolePreset.value as 'ps1' | 'n64' | 'dreamcast' | 'xbox' | 'modern');
      this.updateUI();
      this.notifyChange();
    });

    preset.addEventListener('change', () => {
      psxSettings.applyPreset(preset.value as 'authentic' | 'lite' | 'modern');
      this.updateUI();
      this.notifyChange();
    });

    affine.addEventListener('change', () => {
      psxSettings.update({ affineMapping: affine.checked });
      this.notifyChange();
    });

    quantization.addEventListener('change', () => {
      psxSettings.update({ colorQuantization: quantization.checked });
      this.notifyChange();
    });

    dither.addEventListener('change', () => {
      psxSettings.update({ dithering: dither.checked });
      this.notifyChange();
    });

    crt.addEventListener('change', () => {
      psxSettings.update({ crtEffects: crt.checked });
      this.notifyChange();
    });

    chromatic.addEventListener('change', () => {
      psxSettings.update({ chromaticAberration: chromatic.checked });
      this.notifyChange();
    });

    // Color/Lighting adjustments
    const brightness = this.panel.querySelector('#psx-global-brightness') as HTMLInputElement;
    const brightnessValue = this.panel.querySelector('#psx-global-brightness-value') as HTMLElement;
    const contrast = this.panel.querySelector('#psx-global-contrast') as HTMLInputElement;
    const contrastValue = this.panel.querySelector('#psx-global-contrast-value') as HTMLElement;
    const saturation = this.panel.querySelector('#psx-global-saturation') as HTMLInputElement;
    const saturationValue = this.panel.querySelector('#psx-global-saturation-value') as HTMLElement;
    const gamma = this.panel.querySelector('#psx-global-gamma') as HTMLInputElement;
    const gammaValue = this.panel.querySelector('#psx-global-gamma-value') as HTMLElement;
    const exposure = this.panel.querySelector('#psx-global-exposure') as HTMLInputElement;
    const exposureValue = this.panel.querySelector('#psx-global-exposure-value') as HTMLElement;

    brightness.addEventListener('input', () => {
      const value = parseFloat(brightness.value);
      brightnessValue.textContent = value.toFixed(1);
      psxSettings.update({ brightness: value });
      this.notifyChange();
    });

    contrast.addEventListener('input', () => {
      const value = parseFloat(contrast.value);
      contrastValue.textContent = value.toFixed(1);
      psxSettings.update({ contrast: value });
      this.notifyChange();
    });

    saturation.addEventListener('input', () => {
      const value = parseFloat(saturation.value);
      saturationValue.textContent = value.toFixed(1);
      psxSettings.update({ saturation: value });
      this.notifyChange();
    });

    gamma.addEventListener('input', () => {
      const value = parseFloat(gamma.value);
      gammaValue.textContent = value.toFixed(1);
      psxSettings.update({ gamma: value });
      this.notifyChange();
    });

    exposure.addEventListener('input', () => {
      const value = parseFloat(exposure.value);
      exposureValue.textContent = value.toFixed(1);
      psxSettings.update({ exposure: value });
      this.notifyChange();
    });
  }

  private updateUI(): void {
    // Update checkboxes to match current settings
    const enabled = this.panel.querySelector('#psx-global-enabled') as HTMLInputElement;
    const affine = this.panel.querySelector('#psx-global-affine') as HTMLInputElement;
    const quantization = this.panel.querySelector('#psx-global-quantization') as HTMLInputElement;
    const dither = this.panel.querySelector('#psx-global-dither') as HTMLInputElement;
    const crt = this.panel.querySelector('#psx-global-crt') as HTMLInputElement;
    const chromatic = this.panel.querySelector('#psx-global-chromatic') as HTMLInputElement;

    enabled.checked = psxSettings.config.enabled;
    affine.checked = psxSettings.config.affineMapping;
    quantization.checked = psxSettings.config.colorQuantization;
    dither.checked = psxSettings.config.dithering;
    crt.checked = psxSettings.config.crtEffects;
    chromatic.checked = psxSettings.config.chromaticAberration;

    // Update sliders
    const brightness = this.panel.querySelector('#psx-global-brightness') as HTMLInputElement;
    const brightnessValue = this.panel.querySelector('#psx-global-brightness-value') as HTMLElement;
    const contrast = this.panel.querySelector('#psx-global-contrast') as HTMLInputElement;
    const contrastValue = this.panel.querySelector('#psx-global-contrast-value') as HTMLElement;
    const saturation = this.panel.querySelector('#psx-global-saturation') as HTMLInputElement;
    const saturationValue = this.panel.querySelector('#psx-global-saturation-value') as HTMLElement;
    const gamma = this.panel.querySelector('#psx-global-gamma') as HTMLInputElement;
    const gammaValue = this.panel.querySelector('#psx-global-gamma-value') as HTMLElement;
    const exposure = this.panel.querySelector('#psx-global-exposure') as HTMLInputElement;
    const exposureValue = this.panel.querySelector('#psx-global-exposure-value') as HTMLElement;

    if (brightness) {
      brightness.value = psxSettings.config.brightness.toString();
      brightnessValue.textContent = psxSettings.config.brightness.toFixed(1);
    }
    if (contrast) {
      contrast.value = psxSettings.config.contrast.toString();
      contrastValue.textContent = psxSettings.config.contrast.toFixed(1);
    }
    if (saturation) {
      saturation.value = psxSettings.config.saturation.toString();
      saturationValue.textContent = psxSettings.config.saturation.toFixed(1);
    }
    if (gamma) {
      gamma.value = psxSettings.config.gamma.toString();
      gammaValue.textContent = psxSettings.config.gamma.toFixed(1);
    }
    if (exposure) {
      exposure.value = psxSettings.config.exposure.toString();
      exposureValue.textContent = psxSettings.config.exposure.toFixed(1);
    }
  }

  private notifyChange(): void {
    if (this.onSettingsChange) {
      this.onSettingsChange();
    }
    // Dispatch global event so all apps can react
    window.dispatchEvent(new CustomEvent('psx-settings-changed'));
  }

  public getElement(): HTMLElement {
    return this.panel;
  }

  public updateFromSettings(): void {
    this.updateUI();
  }
}

/**
 * Create a floating PSX settings button that can be added anywhere
 */
export function createPSXToggleButton(): HTMLElement {
  const button = document.createElement('button');
  button.id = 'psx-toggle-button';
  button.textContent = 'PS1';
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 10px 20px;
    background: ${psxSettings.config.enabled ? '#0ff' : 'rgba(0, 255, 255, 0.3)'};
    color: ${psxSettings.config.enabled ? '#000' : '#0ff'};
    border: 2px solid #0ff;
    border-radius: 5px;
    font-family: monospace;
    font-weight: bold;
    font-size: 14px;
    cursor: pointer;
    z-index: 9999;
    transition: all 0.2s;
  `;

  button.addEventListener('click', () => {
    const newState = !psxSettings.config.enabled;
    psxSettings.update({ enabled: newState });
    button.style.background = newState ? '#0ff' : 'rgba(0, 255, 255, 0.3)';
    button.style.color = newState ? '#000' : '#0ff';

    // Dispatch custom event for apps to listen to
    window.dispatchEvent(new CustomEvent('psx-settings-changed'));
  });

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'scale(1.05)';
  });

  button.addEventListener('mouseleave', () => {
    button.style.transform = 'scale(1)';
  });

  return button;
}
