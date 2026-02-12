import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ColorQuantPass } from './passes/ColorQuantPass'
import { DitherPass } from './passes/DitherPass'
import { CRTPass } from './passes/CRTPass'
import { ChromaticAberrationPass } from './passes/ChromaticAberrationPass'
import { ColorAdjustmentPass } from './passes/ColorAdjustmentPass'
import { BlurPass } from './passes/BlurPass'

export interface PSXPostProcessorSettings {
  enabled: boolean

  // Color quantization
  colorQuantization: boolean
  colorBits: number

  // Dithering
  dithering: boolean
  ditherStrength: number

  // CRT effects
  crtEffects: boolean
  scanlineIntensity: number
  curvature: number
  vignette: number
  brightness: number

  // Chromatic aberration
  chromaticAberration: boolean
  chromaticOffset: number

  // Color/Lighting adjustments
  contrast: number
  saturation: number
  gamma: number
  exposure: number

  // Blur (for N64 look)
  blur: boolean
  blurStrength: number
}

export class PSXPostProcessor {
  private composer: EffectComposer
  private renderPass: RenderPass
  private colorQuantPass: ColorQuantPass
  private ditherPass: DitherPass
  private crtPass: CRTPass
  private chromaticAberrationPass: ChromaticAberrationPass
  private colorAdjustmentPass: ColorAdjustmentPass
  private blurPass: BlurPass

  public settings: PSXPostProcessorSettings

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    settings: Partial<PSXPostProcessorSettings> = {}
  ) {
    // Default settings
    this.settings = {
      enabled: true,
      colorQuantization: true,
      colorBits: 5, // 15-bit color (RGB555)
      dithering: true,
      ditherStrength: 0.8,
      crtEffects: true,
      scanlineIntensity: 0.3,
      curvature: 0.1,
      vignette: 0.4,
      brightness: 1.3, // Increased default
      chromaticAberration: true,
      chromaticOffset: 0.002,
      contrast: 1.1,
      saturation: 1.0,
      gamma: 1.0,
      exposure: 1.0,
      blur: false,
      blurStrength: 1.0,
      ...settings,
    }

    // Create composer
    this.composer = new EffectComposer(renderer)

    // Create passes
    this.renderPass = new RenderPass(scene, camera)
    this.colorQuantPass = new ColorQuantPass({ bits: this.settings.colorBits })
    this.ditherPass = new DitherPass({ strength: this.settings.ditherStrength })
    this.crtPass = new CRTPass({
      scanlineIntensity: this.settings.scanlineIntensity,
      curvature: this.settings.curvature,
      vignette: this.settings.vignette,
      brightness: this.settings.brightness,
    })
    this.chromaticAberrationPass = new ChromaticAberrationPass({
      offset: this.settings.chromaticOffset,
    })
    this.colorAdjustmentPass = new ColorAdjustmentPass({
      brightness: this.settings.brightness,
      contrast: this.settings.contrast,
      saturation: this.settings.saturation,
      gamma: this.settings.gamma,
      exposure: this.settings.exposure,
    })
    this.blurPass = new BlurPass({
      strength: this.settings.blurStrength,
    })

    // Add passes to composer
    this.setupPasses()
  }

  private setupPasses(): void {
    // Clear existing passes
    while (this.composer.passes.length > 0) {
      this.composer.removePass(this.composer.passes[0])
    }

    // Always start with render pass
    this.composer.addPass(this.renderPass)

    // Blur pass (N64 bilinear look)
    if (this.settings.blur) {
      this.composer.addPass(this.blurPass)
    }

    // Add passes based on settings
    if (this.settings.colorQuantization) {
      this.composer.addPass(this.colorQuantPass)
    }

    if (this.settings.dithering) {
      this.composer.addPass(this.ditherPass)
    }

    if (this.settings.crtEffects) {
      this.composer.addPass(this.crtPass)
    }

    if (this.settings.chromaticAberration) {
      this.composer.addPass(this.chromaticAberrationPass)
    }

    // Always add color adjustment pass (for brightness, contrast, etc.)
    this.composer.addPass(this.colorAdjustmentPass)

    // Last pass should render to screen
    if (this.composer.passes.length > 0) {
      this.composer.passes[this.composer.passes.length - 1].renderToScreen = true
    }
  }

  render(deltaTime?: number): void {
    if (!this.settings.enabled) {
      // Render directly without post-processing
      this.renderPass.render(
        this.composer.renderer,
        this.composer.writeBuffer,
        this.composer.readBuffer,
        deltaTime
      )
      return
    }

    this.composer.render(deltaTime)
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height)
    this.ditherPass.setSize(width, height)
    this.crtPass.setSize(width, height)
    this.blurPass.setSize(width, height)
  }

  // Settings updates
  setEnabled(enabled: boolean): void {
    this.settings.enabled = enabled
  }

  setColorQuantization(enabled: boolean, bits?: number): void {
    this.settings.colorQuantization = enabled
    if (bits !== undefined) {
      this.settings.colorBits = bits
      this.colorQuantPass.setBits(bits)
    }
    this.setupPasses()
  }

  setDithering(enabled: boolean, strength?: number): void {
    this.settings.dithering = enabled
    if (strength !== undefined) {
      this.settings.ditherStrength = strength
      this.ditherPass.setStrength(strength)
    }
    this.setupPasses()
  }

  setCRTEffects(enabled: boolean): void {
    this.settings.crtEffects = enabled
    this.setupPasses()
  }

  setScanlineIntensity(intensity: number): void {
    this.settings.scanlineIntensity = intensity
    this.crtPass.setScanlineIntensity(intensity)
  }

  setCurvature(curvature: number): void {
    this.settings.curvature = curvature
    this.crtPass.setCurvature(curvature)
  }

  setVignette(vignette: number): void {
    this.settings.vignette = vignette
    this.crtPass.setVignette(vignette)
  }

  setBrightness(brightness: number): void {
    this.settings.brightness = brightness
    this.crtPass.setBrightness(brightness)
    this.colorAdjustmentPass.setBrightness(brightness)
  }

  setContrast(contrast: number): void {
    this.settings.contrast = contrast
    this.colorAdjustmentPass.setContrast(contrast)
  }

  setSaturation(saturation: number): void {
    this.settings.saturation = saturation
    this.colorAdjustmentPass.setSaturation(saturation)
  }

  setGamma(gamma: number): void {
    this.settings.gamma = gamma
    this.colorAdjustmentPass.setGamma(gamma)
  }

  setExposure(exposure: number): void {
    this.settings.exposure = exposure
    this.colorAdjustmentPass.setExposure(exposure)
  }

  setBlur(enabled: boolean, strength?: number): void {
    this.settings.blur = enabled
    if (strength !== undefined) {
      this.settings.blurStrength = strength
      this.blurPass.setStrength(strength)
    }
    this.setupPasses()
  }

  setChromaticAberration(enabled: boolean, offset?: number): void {
    this.settings.chromaticAberration = enabled
    if (offset !== undefined) {
      this.settings.chromaticOffset = offset
      this.chromaticAberrationPass.setOffset(offset)
    }
    this.setupPasses()
  }

  // Preset configurations
  applyPreset(preset: 'authentic' | 'lite' | 'off'): void {
    switch (preset) {
      case 'authentic':
        this.settings.enabled = true
        this.settings.colorQuantization = true
        this.settings.colorBits = 5
        this.settings.dithering = true
        this.settings.ditherStrength = 0.8
        this.settings.crtEffects = true
        this.settings.scanlineIntensity = 0.3
        this.settings.curvature = 0.1
        this.settings.vignette = 0.4
        this.settings.chromaticAberration = true
        break

      case 'lite':
        this.settings.enabled = true
        this.settings.colorQuantization = true
        this.settings.colorBits = 6
        this.settings.dithering = true
        this.settings.ditherStrength = 0.4
        this.settings.crtEffects = false
        this.settings.chromaticAberration = false
        break

      case 'off':
        this.settings.enabled = false
        break
    }

    this.updateAllPasses()
    this.setupPasses()
  }

  private updateAllPasses(): void {
    this.colorQuantPass.setBits(this.settings.colorBits)
    this.ditherPass.setStrength(this.settings.ditherStrength)
    this.crtPass.setScanlineIntensity(this.settings.scanlineIntensity)
    this.crtPass.setCurvature(this.settings.curvature)
    this.crtPass.setVignette(this.settings.vignette)
    this.crtPass.setBrightness(this.settings.brightness)
    this.chromaticAberrationPass.setOffset(this.settings.chromaticOffset)
    this.colorAdjustmentPass.setBrightness(this.settings.brightness)
    this.colorAdjustmentPass.setContrast(this.settings.contrast)
    this.colorAdjustmentPass.setSaturation(this.settings.saturation)
    this.colorAdjustmentPass.setGamma(this.settings.gamma)
    this.colorAdjustmentPass.setExposure(this.settings.exposure)
    this.blurPass.setStrength(this.settings.blurStrength)
  }

  dispose(): void {
    this.composer.dispose()
    this.colorQuantPass.dispose()
    this.ditherPass.dispose()
    this.colorAdjustmentPass.dispose()
    this.blurPass.dispose()
    this.crtPass.dispose()
    this.chromaticAberrationPass.dispose()
  }
}
