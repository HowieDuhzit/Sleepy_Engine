import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export interface BlurPassParameters {
  strength?: number;
}

export class BlurPass extends Pass {
  private fsQuad: FullScreenQuad;
  private uniforms: {
    tDiffuse: { value: THREE.Texture | null };
    strength: { value: number };
    resolution: { value: THREE.Vector2 };
  };

  constructor(params: BlurPassParameters = {}) {
    super();

    // Create shader material
    const shader = {
      uniforms: {
        tDiffuse: { value: null },
        strength: { value: params.strength !== undefined ? params.strength : 1.0 },
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

        // Simple box blur for soft retro filtering
        void main() {
          vec2 texelSize = 1.0 / resolution;
          vec4 color = vec4(0.0);

          // 3x3 box blur
          float weightSum = 0.0;
          for (float x = -1.0; x <= 1.0; x += 1.0) {
            for (float y = -1.0; y <= 1.0; y += 1.0) {
              vec2 offset = vec2(x, y) * texelSize * strength;
              float weight = 1.0;
              color += texture2D(tDiffuse, vUv + offset) * weight;
              weightSum += weight;
            }
          }

          color /= weightSum;
          gl_FragColor = color;
        }
      `,
    };

    const material = new THREE.ShaderMaterial(shader);
    this.uniforms = material.uniforms as typeof this.uniforms;
    this.fsQuad = new FullScreenQuad(material);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.fsQuad.render(renderer);
    }
  }

  setStrength(strength: number): void {
    this.uniforms.strength.value = strength;
  }

  setSize(width: number, height: number): void {
    this.uniforms.resolution.value.set(width, height);
  }

  dispose(): void {
    this.fsQuad.dispose();
  }
}
