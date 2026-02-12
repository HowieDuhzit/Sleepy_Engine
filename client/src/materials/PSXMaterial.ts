import * as THREE from 'three'
import vertexShader from '../shaders/ps1-basic.vert?raw'
import fragmentShader from '../shaders/ps1-basic.frag?raw'
import unlitFragmentShader from '../shaders/ps1-unlit.frag?raw'

export interface PSXMaterialParameters {
  map?: THREE.Texture
  color?: THREE.Color | number
  opacity?: number
  transparent?: boolean
  unlit?: boolean

  // PS1-specific parameters
  jitterIntensity?: number
  useAffineMapping?: boolean
  useColorQuantization?: boolean
  colorDepth?: number
  useDithering?: boolean

  // Lighting (ignored if unlit)
  ambientLight?: THREE.Color
  directionalLightColor?: THREE.Color
  directionalLightDirection?: THREE.Vector3
}

export class PSXMaterial extends THREE.ShaderMaterial {
  private _resolution: THREE.Vector2

  constructor(parameters: PSXMaterialParameters = {}) {
    const defaultParams = {
      color: new THREE.Color(0xffffff),
      opacity: 1.0,
      transparent: false,
      unlit: false,
      jitterIntensity: 1.0,
      useAffineMapping: true,
      useColorQuantization: true,
      colorDepth: 5.0, // 15-bit color (RGB555)
      useDithering: true,
      ambientLight: new THREE.Color(0x404040),
      directionalLightColor: new THREE.Color(0xffffff),
      directionalLightDirection: new THREE.Vector3(0.5, 1.0, 0.5).normalize(),
    }

    const params = { ...defaultParams, ...parameters }

    // Initialize resolution (will be updated by renderer)
    const resolution = new THREE.Vector2(320, 240)

    // Setup uniforms
    const uniforms = {
      map: { value: params.map || new THREE.Texture() },
      color: { value: params.color instanceof THREE.Color ? params.color : new THREE.Color(params.color) },
      opacity: { value: params.opacity },
      uResolution: { value: resolution },
      uJitterIntensity: { value: params.jitterIntensity },
      useAffineMapping: { value: params.useAffineMapping },
      useColorQuantization: { value: params.useColorQuantization },
      colorDepth: { value: params.colorDepth },
      useDithering: { value: params.useDithering },
      ambientLight: { value: params.ambientLight },
      directionalLightColor: { value: params.directionalLightColor },
      directionalLightDirection: { value: params.directionalLightDirection },
    }

    super({
      uniforms,
      vertexShader,
      fragmentShader: params.unlit ? unlitFragmentShader : fragmentShader,
      transparent: params.transparent,
      vertexColors: true,
    })

    this._resolution = resolution
    this.type = 'PSXMaterial'
  }

  // Getters and setters for convenience
  get map(): THREE.Texture | null {
    return this.uniforms.map.value
  }

  set map(value: THREE.Texture | null) {
    this.uniforms.map.value = value
  }

  get color(): THREE.Color {
    return this.uniforms.color.value
  }

  set color(value: THREE.Color) {
    this.uniforms.color.value = value
  }

  get jitterIntensity(): number {
    return this.uniforms.uJitterIntensity.value
  }

  set jitterIntensity(value: number) {
    this.uniforms.uJitterIntensity.value = value
  }

  get useAffineMapping(): boolean {
    return this.uniforms.useAffineMapping.value
  }

  set useAffineMapping(value: boolean) {
    this.uniforms.useAffineMapping.value = value
  }

  get useColorQuantization(): boolean {
    return this.uniforms.useColorQuantization.value
  }

  set useColorQuantization(value: boolean) {
    this.uniforms.useColorQuantization.value = value
  }

  get colorDepth(): number {
    return this.uniforms.colorDepth.value
  }

  set colorDepth(value: number) {
    this.uniforms.colorDepth.value = value
  }

  get useDithering(): boolean {
    return this.uniforms.useDithering.value
  }

  set useDithering(value: boolean) {
    this.uniforms.useDithering.value = value
  }

  updateResolution(width: number, height: number): void {
    this._resolution.set(width, height)
    this.uniforms.uResolution.value = this._resolution
  }

  setLighting(ambient: THREE.Color, directionalColor: THREE.Color, directionalDirection: THREE.Vector3): void {
    this.uniforms.ambientLight.value = ambient
    this.uniforms.directionalLightColor.value = directionalColor
    this.uniforms.directionalLightDirection.value = directionalDirection.normalize()
  }
}
