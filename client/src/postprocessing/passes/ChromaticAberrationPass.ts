import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export interface ChromaticAberrationPassParameters {
  offset?: number;
}

export class ChromaticAberrationPass extends Pass {
  private fsQuad: FullScreenQuad;
  private uniforms: {
    tDiffuse: { value: THREE.Texture | null };
    offset: { value: number };
  };

  constructor(params: ChromaticAberrationPassParameters = {}) {
    super();

    const offset = params.offset !== undefined ? params.offset : 0.002;

    // Create shader material
    const shader = {
      uniforms: {
        tDiffuse: { value: null },
        offset: { value: offset },
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
        uniform float offset;
        varying vec2 vUv;

        void main() {
          // Calculate distance from center (0.0 at center, 1.0 at edges)
          vec2 centered = vUv * 2.0 - 1.0;
          float dist = length(centered);

          // Apply chromatic aberration based on distance from center
          vec2 direction = normalize(centered);
          float aberration = offset * dist;

          // Sample RGB channels with offset
          float r = texture2D(tDiffuse, vUv + direction * aberration).r;
          float g = texture2D(tDiffuse, vUv).g;
          float b = texture2D(tDiffuse, vUv - direction * aberration).b;
          float a = texture2D(tDiffuse, vUv).a;

          gl_FragColor = vec4(r, g, b, a);
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

  setOffset(offset: number): void {
    this.uniforms.offset.value = offset;
  }

  dispose(): void {
    this.fsQuad.dispose();
  }
}
