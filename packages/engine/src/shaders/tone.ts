import { GLSL_HEADER, GLSL_REGION } from './common.ts';

/**
 * Pass 1 — Tonwert und Weißabgleich.
 *
 * Reihenfolge: Weißabgleich → Belichtung (beides linear) → Lichter/Schatten →
 * Weiß-/Schwarzpunkt → Kontrast → Kurven.
 *
 * Die eigentlichen Formeln stehen im gemeinsamen Header — dieselben, die auch
 * jede lokale Maske benutzt. Dieser Pass reicht nur die Uniforms hinein.
 *
 * Alle vier Kurven (Master, R, G, B) liegen in EINER RGBA-Textur:
 * Kanal x = Master, y = Rot, z = Grün, w = Blau. Drei Texturzugriffe an den
 * Positionen r, g und b liefern damit alle sechs benötigten Werte.
 */
export const TONE_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;
uniform sampler2D uCurves;

uniform vec3  uWbGain;       // luminanzneutrale Kanalfaktoren (auf der CPU berechnet)
uniform float uExposure;     // Blendenstufen
uniform float uContrast;     // -1 .. 1
uniform float uHighlights;   // -1 .. 1
uniform float uShadows;      // -1 .. 1
uniform float uWhites;       // -1 .. 1
uniform float uBlacks;       // -1 .. 1
uniform float uCurveActive;  // 0 = Kurven überspringen

void main() {
  vec3 c = texture(uSrc, srcUv()).rgb;

  c = whiteBalanceExposure(c, uWbGain, uExposure);
  c = toneRegions3(c, uHighlights, uShadows, uWhites, uBlacks);
  c = contrastCurve3(c, uContrast);

  if (uCurveActive > 0.5) {
    c = clamp(c, 0.0, 1.0);
    vec4 lr = texture(uCurves, vec2(c.r, 0.5));
    vec4 lg = texture(uCurves, vec2(c.g, 0.5));
    vec4 lb = texture(uCurves, vec2(c.b, 0.5));
    // Erst die Kanalkurven, dann die Masterkurve auf das Ergebnis.
    vec3 perChannel = vec3(lr.y, lg.z, lb.w);
    vec4 mr = texture(uCurves, vec2(perChannel.r, 0.5));
    vec4 mg = texture(uCurves, vec2(perChannel.g, 0.5));
    vec4 mb = texture(uCurves, vec2(perChannel.b, 0.5));
    c = vec3(mr.x, mg.x, mb.x);
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
