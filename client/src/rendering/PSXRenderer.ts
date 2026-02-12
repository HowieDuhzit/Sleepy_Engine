import * as THREE from 'three'

export interface PSXRendererSettings {
  baseWidth: number
  baseHeight: number
  enabled: boolean
  pixelated: boolean // Use nearest-neighbor filtering
}

export class PSXRenderer {
  private renderer: THREE.WebGLRenderer
  private lowResTarget: THREE.WebGLRenderTarget
  private blitScene: THREE.Scene
  private blitCamera: THREE.OrthographicCamera
  private blitQuad: THREE.Mesh
  private blitMaterial: THREE.ShaderMaterial

  public settings: PSXRendererSettings
  private uniform<T>(key: string) {
    return this.blitMaterial.uniforms[key] as THREE.IUniform<T>
  }

  constructor(renderer: THREE.WebGLRenderer, settings: Partial<PSXRendererSettings> = {}) {
    this.renderer = renderer

    // Default settings
    this.settings = {
      baseWidth: 320,
      baseHeight: 240,
      enabled: true,
      pixelated: true,
      ...settings,
    }

    // Create low-res render target
    this.lowResTarget = new THREE.WebGLRenderTarget(
      this.settings.baseWidth,
      this.settings.baseHeight,
      {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
      }
    )

    // Create blit scene for upscaling
    this.blitScene = new THREE.Scene()
    this.blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    // Create blit material (simple texture copy with optional pixelation)
    this.blitMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.lowResTarget.texture },
        resolution: { value: new THREE.Vector2(this.settings.baseWidth, this.settings.baseHeight) },
        pixelated: { value: this.settings.pixelated },
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
        uniform vec2 resolution;
        uniform bool pixelated;
        varying vec2 vUv;

        void main() {
          vec2 uv = vUv;

          if (pixelated) {
            // Snap to pixel grid for sharp pixels
            uv = floor(uv * resolution) / resolution;
          }

          gl_FragColor = texture2D(tDiffuse, uv);
        }
      `,
    })

    // Create fullscreen quad
    const geometry = new THREE.PlaneGeometry(2, 2)
    this.blitQuad = new THREE.Mesh(geometry, this.blitMaterial)
    this.blitScene.add(this.blitQuad)
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.settings.enabled) {
      // Render directly to screen at native resolution
      this.renderer.setRenderTarget(null)
      this.renderer.render(scene, camera)
      return
    }

    // Render scene to low-res target
    this.renderer.setRenderTarget(this.lowResTarget)
    this.renderer.clear()
    this.renderer.render(scene, camera)

    // Blit to screen with upscaling
    this.renderer.setRenderTarget(null)
    this.renderer.clear()
    this.renderer.render(this.blitScene, this.blitCamera)
  }

  setResolution(width: number, height: number): void {
    this.settings.baseWidth = width
    this.settings.baseHeight = height

    // Recreate render target with new resolution
    this.lowResTarget.dispose()
    this.lowResTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    })

    // Update blit material
    this.uniform<THREE.Texture>('tDiffuse').value = this.lowResTarget.texture
    this.uniform<THREE.Vector2>('resolution').value.set(width, height)
  }

  setPixelated(pixelated: boolean): void {
    this.settings.pixelated = pixelated
    this.uniform<boolean>('pixelated').value = pixelated
  }

  setEnabled(enabled: boolean): void {
    this.settings.enabled = enabled
  }

  getResolution(): { width: number; height: number } {
    return {
      width: this.settings.baseWidth,
      height: this.settings.baseHeight,
    }
  }

  dispose(): void {
    this.lowResTarget.dispose()
    this.blitQuad.geometry.dispose()
    this.blitMaterial.dispose()
  }
}
