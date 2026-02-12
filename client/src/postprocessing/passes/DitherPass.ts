import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

export interface DitherPassParameters {
  strength?: number
  pattern?: 'bayer4x4' | 'bayer8x8'
}

export class DitherPass extends Pass {
  private fsQuad: FullScreenQuad
  private uniforms: {
    tDiffuse: { value: THREE.Texture | null }
    strength: { value: number }
    resolution: { value: THREE.Vector2 }
  }

  constructor(params: DitherPassParameters = {}) {
    super()

    const strength = params.strength !== undefined ? params.strength : 0.8

    // Create shader material
    const shader = {
      uniforms: {
        tDiffuse: { value: null },
        strength: { value: strength },
        resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
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
        uniform float strength;
        uniform vec2 resolution;
        varying vec2 vUv;

        // 4x4 Bayer matrix
        float bayerMatrix[16] = float[](
           0.0,  8.0,  2.0, 10.0,
          12.0,  4.0, 14.0,  6.0,
           3.0, 11.0,  1.0,  9.0,
          15.0,  7.0, 13.0,  5.0
        );

        float getDitherThreshold(vec2 fragCoord) {
          int x = int(mod(fragCoord.x, 4.0));
          int y = int(mod(fragCoord.y, 4.0));
          int index = x + y * 4;
          return bayerMatrix[index] / 16.0;
        }

        void main() {
          vec4 color = texture2D(tDiffuse, vUv);

          vec2 fragCoord = vUv * resolution;
          float threshold = getDitherThreshold(fragCoord);

          // Apply dithering
          vec3 dithered = color.rgb + (threshold - 0.5) * strength * 0.1;

          gl_FragColor = vec4(dithered, color.a);
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

  setStrength(strength: number): void {
    this.uniforms.strength.value = strength
  }

  setSize(width: number, height: number): void {
    this.uniforms.resolution.value.set(width, height)
  }

  dispose(): void {
    this.fsQuad.dispose()
  }
}
