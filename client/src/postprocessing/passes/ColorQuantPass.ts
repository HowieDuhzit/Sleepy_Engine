import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

export interface ColorQuantPassParameters {
  bits?: number // Bits per channel (5 for RGB555, 8 for RGB888)
}

export class ColorQuantPass extends Pass {
  private fsQuad: FullScreenQuad
  private uniforms: {
    tDiffuse: { value: THREE.Texture | null }
    bits: { value: number }
  }

  constructor(params: ColorQuantPassParameters = {}) {
    super()

    const bits = params.bits !== undefined ? params.bits : 5 // Default to 15-bit color (RGB555)

    // Create shader material
    const shader = {
      uniforms: {
        tDiffuse: { value: null },
        bits: { value: bits },
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
        uniform float bits;
        varying vec2 vUv;

        vec3 quantizeColor(vec3 color, float depth) {
          float levels = pow(2.0, depth);
          return floor(color * levels) / levels;
        }

        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          vec3 quantized = quantizeColor(color.rgb, bits);
          gl_FragColor = vec4(quantized, color.a);
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

  setBits(bits: number): void {
    this.uniforms.bits.value = bits
  }

  dispose(): void {
    this.fsQuad.dispose()
  }
}
