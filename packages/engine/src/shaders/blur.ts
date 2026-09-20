import { GLSL_HEADER, GLSL_REGION } from './common.ts';

/**
 * Separabler Gauß-Filter. Zwei Durchgänge (horizontal, vertikal) statt eines
 * 2D-Kernels: O(2n) statt O(n²) Texturzugriffe.
 *
 * `uFalloff` ist (Abtastabstand / σ)² / 2 und damit bereits so normiert, dass
 * der Shader die Gewichte selbst berechnen kann, ohne dass ein Gewichts-Array
 * hochgeladen werden muss. Ein größerer Abtastabstand als 1 Pixel erlaubt sehr
 * große Radien mit wenigen Zugriffen — zulässig, weil diese Radien
 * ausschließlich für Tiefpass-Signale (Clarity, Dunstschleier) benutzt werden,
 * die per Definition keine hohen Frequenzen enthalten.
 */
export const BLUR_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;
uniform vec2  uStep;     // Richtung × Abtastabstand, in UV-Einheiten
uniform float uFalloff;
uniform int   uTaps;

void main() {
  vec2 uv = srcUv();
  vec4 sum = texture(uSrc, uv);
  float wsum = 1.0;
  for (int i = 1; i <= uTaps; i++) {
    float fi = float(i);
    float w = exp(-fi * fi * uFalloff);
    vec2 o = uStep * fi;
    sum += (texture(uSrc, uv + o) + texture(uSrc, uv - o)) * w;
    wsum += 2.0 * w;
  }
  fragColor = sum / wsum;
}
`;

/** Halbiert die Auflösung mit einem 2×2-Mittelwert (kein Aliasing). */
export const DOWNSAMPLE_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;
uniform vec2 uTexel;   // 1 / Größe der Quelltextur

void main() {
  vec2 uv = srcUv();
  vec4 c =
      texture(uSrc, uv + vec2(-0.5, -0.5) * uTexel)
    + texture(uSrc, uv + vec2( 0.5, -0.5) * uTexel)
    + texture(uSrc, uv + vec2(-0.5,  0.5) * uTexel)
    + texture(uSrc, uv + vec2( 0.5,  0.5) * uTexel);
  fragColor = c * 0.25;
}
`;

/**
 * Dunkelkanal nach He et al. (Dark Channel Prior): das Minimum der drei
 * Farbkanäle. In dunstfreien Außenaufnahmen ist dieser Wert lokal nahe null;
 * wo er deutlich über null liegt, streut Dunst Licht ein. Der geglättete
 * Dunkelkanal ist damit eine direkte Schätzung des Dunstschleiers — daraus
 * berechnet der Local-Pass die Transmission.
 */
export const DARK_CHANNEL_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  // 3×3-Minimum: robuster gegen einzelne dunkle Pixel als ein reines
  // Punktminimum und entspricht dem Patch-Minimum des Originalverfahrens.
  float m = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 c = texture(uSrc, srcUv() + vec2(float(x), float(y)) * uTexel).rgb;
      m = min(m, min(c.r, min(c.g, c.b)));
    }
  }
  fragColor = vec4(vec3(m), 1.0);
}
`;
