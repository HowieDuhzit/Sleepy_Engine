// PS1-style vertex shader with vertex jitter and affine texture mapping setup
uniform vec2 uResolution;
uniform float uJitterIntensity;

varying vec2 vUv;
varying vec3 vColor;
varying float vDepth;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  // Pass through vertex color and UV
  vUv = uv;
  vColor = color;
  vNormal = normalize(normalMatrix * normal);

  // Transform to view space
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = mvPosition.xyz;
  vDepth = -mvPosition.z;

  // Transform to clip space
  vec4 clipPos = projectionMatrix * mvPosition;

  // Apply vertex jitter (PS1-style vertex snapping)
  if (uJitterIntensity > 0.0) {
    // Convert to normalized device coordinates
    vec3 ndc = clipPos.xyz / clipPos.w;

    // Convert to screen space
    vec2 screenPos = (ndc.xy * 0.5 + 0.5) * uResolution;

    // Snap to pixel grid
    screenPos = floor(screenPos * uJitterIntensity) / uJitterIntensity;

    // Convert back to NDC
    ndc.xy = (screenPos / uResolution) * 2.0 - 1.0;

    // Convert back to clip space
    clipPos.xyz = ndc * clipPos.w;
  }

  gl_Position = clipPos;
}
