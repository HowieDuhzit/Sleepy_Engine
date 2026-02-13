import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

export interface ColorAdjustmentPassParameters {
  brightness?: number
  contrast?: number
  saturation?: number
  gamma?: number
  exposure?: number
}

export class ColorAdjustmentPass extends Pass {
  private fsQuad: FullScreenQuad
  private uniforms: {
    tDiffuse: { value: THREE.Texture | null }
    brightness: { value: number }
    contrast: { value: number }
    saturation: { value: number }
    gamma: { value: number }
    exposure: { value: number }
  }

  constructor(params: ColorAdjustmentPassParameters = {}) {
    super()

    // Create shader material
    const shader = {
      uniforms: {
        tDiffuse: { value: null },
        brightness: { value: params.brightness !== undefined ? params.brightness : 1.0 },
        contrast: { value: params.contrast !== undefined ? params.contrast : 1.0 },
        saturation: { value: params.saturation !== undefined ? params.saturation : 1.0 },
        gamma: { value: params.gamma !== undefined ? params.gamma : 1.0 },
        exposure: { value: params.exposure !== undefined ? params.exposure : 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float brightness;
        uniform float contrast;
        uniform float saturation;
        uniform float gamma;
        uniform float exposure;
        varying vec2 vUv;

        // Convert RGB to luminance
        float getLuminance(vec3 color) {
          return dot(color, vec3(0.299, 0.587, 0.114));
        }

        // Apply contrast
        vec3 applyContrast(vec3 color, float contrast) {
          return (color - 0.5) * contrast + 0.5;
        }

        // Apply saturation
        vec3 applySaturation(vec3 color, float saturation) {
          float luma = getLuminance(color);
          return mix(vec3(luma), color, saturation);
        }

        // Apply gamma correction
        vec3 applyGamma(vec3 color, float gamma) {
          return pow(color, vec3(1.0 / gamma));
        }

        // Apply exposure
        vec3 applyExposure(vec3 color, float exposure) {
          return color * exposure;
        }

        void main() {
          vec4 texColor = texture2D(tDiffuse, vUv);
          vec3 color = texColor.rgb;

          // Apply adjustments in order
          color = applyExposure(color, exposure);
          color = color * brightness;
          color = applyContrast(color, contrast);
          color = applySaturation(color, saturation);
          color = applyGamma(color, gamma);

          // Clamp to valid range
          color = clamp(color, 0.0, 1.0);

          gl_FragColor = vec4(color, texColor.a);
        }
      `,
    }

    const material = new THREE.ShaderMaterial(shader)
    this.uniforms = material.uniforms as typeof this.uniforms
    this.fsQuad = new FullScreenQuad(material)
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    this.uniforms.tDiffuse.value = readBuffer.texture

    if (this.renderToScreen) {
      renderer.setRenderTarget(null)
      this.fsQuad.render(renderer)
    } else {
      renderer.setRenderTarget(writeBuffer)
      if (this.clear) renderer.clear()
      this.fsQuad.render(renderer)
    }
  }

  setBrightness(brightness: number): void {
    this.uniforms.brightness.value = brightness
  }

  setContrast(contrast: number): void {
    this.uniforms.contrast.value = contrast
  }

  setSaturation(saturation: number): void {
    this.uniforms.saturation.value = saturation
  }

  setGamma(gamma: number): void {
    this.uniforms.gamma.value = gamma
  }

  setExposure(exposure: number): void {
    this.uniforms.exposure.value = exposure
  }

  dispose(): void {
    this.fsQuad.dispose()
  }
}
