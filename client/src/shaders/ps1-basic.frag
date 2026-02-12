// PS1-style fragment shader with affine texture mapping and color quantization
precision mediump float;

uniform sampler2D map;
uniform vec3 color;
uniform float opacity;
uniform bool useAffineMapping;
uniform bool useColorQuantization;
uniform float colorDepth; // 5.0 for 15-bit color (RGB555)
uniform bool useDithering;
uniform vec3 ambientLight;
uniform vec3 directionalLightColor;
uniform vec3 directionalLightDirection;

varying vec2 vUv;
varying vec3 vColor;
varying float vDepth;
varying vec3 vNormal;
varying vec3 vViewPosition;

// Bayer matrix for ordered dithering (4x4)
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

vec3 quantizeColor(vec3 col, float depth) {
  // Quantize to N bits per channel
  float levels = pow(2.0, depth);
  return floor(col * levels) / levels;
}

void main() {
  // Affine texture mapping (PS1-style warping)
  vec2 uv = vUv;
  if (useAffineMapping) {
    // Divide UV by depth to remove perspective correction
    // This creates the characteristic PS1 texture warping
    uv = vUv * vDepth / (vDepth + 1.0);
  }

  // Sample texture
  vec4 texColor = texture2D(map, uv);

  // Apply base color and vertex color
  vec3 finalColor = texColor.rgb * color * vColor;

  // Simple vertex lighting (PS1-style)
  vec3 normal = normalize(vNormal);
  vec3 lightDir = normalize(directionalLightDirection);
  float diffuse = max(dot(normal, lightDir), 0.0);
  vec3 lighting = ambientLight + directionalLightColor * diffuse;

  finalColor *= lighting;

  // Apply dithering before quantization
  if (useDithering) {
    float threshold = getDitherThreshold(gl_FragCoord.xy);
    finalColor += (threshold - 0.5) * 0.05;
  }

  // Color quantization (15-bit or 24-bit)
  if (useColorQuantization) {
    finalColor = quantizeColor(finalColor, colorDepth);
  }

  gl_FragColor = vec4(finalColor, texColor.a * opacity);
}
