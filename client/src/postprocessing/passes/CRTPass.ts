import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export interface CRTPassParameters {
  scanlineIntensity?: number;
  curvature?: number;
  vignette?: number;
  brightness?: number;
}

export class CRTPass extends Pass {
  private fsQuad: FullScreenQuad;
  private uniforms: {
    tDiffuse: { value: THREE.Texture | null };
    scanlineIntensity: { value: number };
    curvature: { value: number };
    vignette: { value: number };
    brightness: { value: number };
    resolution: { value: THREE.Vector2 };
  };

  constructor(params: CRTPassParameters = {}) {
    super();

    // Create shader material
    const shader = {
      uniforms: {
        tDiffuse: { value: null },
        scanlineIntensity: {
          value: params.scanlineIntensity !== undefined ? params.scanlineIntensity : 0.3,
        },
        curvature: { value: params.curvature !== undefined ? params.curvature : 0.1 },
        vignette: { value: params.vignette !== undefined ? params.vignette : 0.4 },
        brightness: { value: params.brightness !== undefined ? params.brightness : 1.1 },
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
        uniform float scanlineIntensity;
        uniform float curvature;
        uniform float vignette;
        uniform float brightness;
        uniform vec2 resolution;
        varying vec2 vUv;

        // CRT barrel distortion
        vec2 barrelDistortion(vec2 uv, float strength) {
          vec2 centered = uv * 2.0 - 1.0;
          float r2 = dot(centered, centered);
          float distortion = 1.0 + r2 * strength;
          return (centered * distortion) * 0.5 + 0.5;
        }

        // Scanlines
        float scanline(vec2 uv, float intensity) {
          float line = sin(uv.y * resolution.y * 3.14159);
          return 1.0 - intensity + intensity * line;
        }

        // Vignette
        float vignetteEffect(vec2 uv, float strength) {
          vec2 centered = uv * 2.0 - 1.0;
          float dist = length(centered);
          return 1.0 - smoothstep(0.5, 1.5, dist * strength);
        }

        void main() {
          // Apply barrel distortion
          vec2 distortedUv = barrelDistortion(vUv, curvature);

          // Clamp to prevent sampling outside texture
          if (distortedUv.x < 0.0 || distortedUv.x > 1.0 || distortedUv.y < 0.0 || distortedUv.y > 1.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          vec4 color = texture2D(tDiffuse, distortedUv);

          // Apply scanlines
          float scan = scanline(distortedUv, scanlineIntensity);
          color.rgb *= scan;

          // Apply vignette
          float vig = vignetteEffect(vUv, vignette);
          color.rgb *= vig;

          // Brightness adjustment
          color.rgb *= brightness;

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

  setScanlineIntensity(intensity: number): void {
    this.uniforms.scanlineIntensity.value = intensity;
  }

  setCurvature(curvature: number): void {
    this.uniforms.curvature.value = curvature;
  }

  setVignette(vignette: number): void {
    this.uniforms.vignette.value = vignette;
  }

  setBrightness(brightness: number): void {
    this.uniforms.brightness.value = brightness;
  }

  setSize(width: number, height: number): void {
    this.uniforms.resolution.value.set(width, height);
  }

  dispose(): void {
    this.fsQuad.dispose();
  }
}
