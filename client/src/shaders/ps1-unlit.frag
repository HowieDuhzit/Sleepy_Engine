// PS1-style unlit fragment shader (for UI, effects, etc.)
precision mediump float;

uniform sampler2D map;
uniform vec3 color;
uniform float opacity;
uniform bool useColorQuantization;
uniform float colorDepth;
uniform bool useDithering;

varying vec2 vUv;
varying vec3 vColor;

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
  float levels = pow(2.0, depth);
  return floor(col * levels) / levels;
}

void main() {
  vec4 texColor = texture2D(map, vUv);
  vec3 finalColor = texColor.rgb * color * vColor;

  // Apply dithering
  if (useDithering) {
    float threshold = getDitherThreshold(gl_FragCoord.xy);
    finalColor += (threshold - 0.5) * 0.05;
  }

  // Color quantization
  if (useColorQuantization) {
    finalColor = quantizeColor(finalColor, colorDepth);
  }

  gl_FragColor = vec4(finalColor, texColor.a * opacity);
}
