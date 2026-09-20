import { GLSL_HEADER, GLSL_REGION } from './common.ts';

/**
 * Pass 5 — Farbe: HSL-Farbmischer, Dynamik/Sättigung, 3-Wege-Color-Grading.
 *
 * Die acht HSL-Bänder verwenden eine Zerlegung der Eins ("partition of unity"):
 * Zwischen zwei benachbarten Bandmittelpunkten wird linear überblendet, sodass
 * die Gewichte an jeder Stelle des Farbkreises exakt 1 ergeben. Ein Farbton
 * genau zwischen Orange und Gelb bekommt also je zur Hälfte beide Korrekturen —
 * nie mehr und nie weniger. Würde man stattdessen pro Band eine unabhängige
 * Glockenkurve verwenden, summierten sich die Gewichte je nach Farbton auf
 * unterschiedliche Werte, und ein einheitlicher Sättigungsschub über alle acht
 * Bänder würde je nach Farbton verschieden stark wirken.
 */
export const COLOR_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;

uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];
uniform float uHslActive;

uniform float uVibrance;     // -1 .. 1
uniform float uSaturation;   // -1 .. 1

uniform vec3  uGradeShadow;  // (Farbton 0-1, Sättigung 0-1, Luminanz -1..1)
uniform vec3  uGradeMid;
uniform vec3  uGradeHigh;
uniform float uGradeBlending; // 0 .. 1
uniform float uGradeBalance;  // -1 .. 1
uniform float uGradeActive;

// Mittelpunkte der acht Bänder auf dem Farbkreis, in Grad.
const float BAND[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0);

/** Reiner Farbanteil eines Farbtons — luminanzneutral, damit das Grading
 *  ausschließlich die Farbe und nicht die Helligkeit verschiebt. */
vec3 gradeOffset(vec3 zone) {
  if (zone.y <= 0.0) return vec3(0.0);
  vec3 tint = hsv2rgb(vec3(zone.x, 1.0, 1.0));
  return (tint - luma(tint)) * zone.y * 0.5;
}

void main() {
  vec3 c = texture(uSrc, srcUv()).rgb;
  vec3 hsv = rgb2hsv(c);
  float hDeg = hsv.x * 360.0;

  if (uHslActive > 0.5) {
    // Segment auf dem Farbkreis suchen; das letzte Band läuft von 320° auf 360°
    // und blendet zurück auf Band 0 (Rot).
    int idx = 7;
    for (int i = 0; i < 7; i++) {
      if (hDeg < BAND[i + 1]) { idx = i; break; }
    }
    float lo = BAND[idx];
    float hi = (idx == 7) ? 360.0 : BAND[idx + 1];
    int nextIdx = (idx == 7) ? 0 : idx + 1;
    float t = (hDeg - lo) / (hi - lo);

    float hueAdj = mix(uHslHue[idx], uHslHue[nextIdx], t);
    float satAdj = mix(uHslSat[idx], uHslSat[nextIdx], t);
    float lumAdj = mix(uHslLum[idx], uHslLum[nextIdx], t);

    // In nahezu grauen Pixeln ist der Farbton numerisches Rauschen — dort darf
    // der Farbmischer nicht greifen, sonst entstehen bunte Flecken im Himmel.
    float sw = smoothstep(0.02, 0.15, hsv.y);

    hsv.x = fract(hsv.x + hueAdj * sw * (30.0 / 360.0));
    hsv.y = clamp(hsv.y * (1.0 + satAdj * sw), 0.0, 1.0);
    hsv.z = clamp(hsv.z + lumAdj * sw * (lumAdj > 0.0 ? (1.0 - hsv.z) : hsv.z) * 0.6, 0.0, 1.0);
  }

  c = hsv2rgb(hsv);

  // Dynamik und Sättigung stehen im gemeinsamen Header — dieselbe Funktion
  // benutzt jede lokale Maske.
  c = vibranceSaturation(c, uVibrance, uSaturation);

  if (uGradeActive > 0.5) {
    float l = luma(c);
    float pivot = clamp(0.5 + uGradeBalance * 0.3, 0.1, 0.9);
    float w = mix(0.05, 0.45, uGradeBlending);

    float shM = 1.0 - smoothstep(pivot - w, pivot + w, l);
    float hiM = smoothstep(pivot - w, pivot + w, l);
    // Mitteltonmaske: 1 am Übergabepunkt, 0 an beiden Enden.
    float midM = 1.0 - abs(hiM - shM);

    c += gradeOffset(uGradeShadow) * shM;
    c += gradeOffset(uGradeMid) * midM;
    c += gradeOffset(uGradeHigh) * hiM;

    c += (uGradeShadow.z * shM + uGradeMid.z * midM + uGradeHigh.z * hiM) * 0.22;
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/**
 * Pass 6 — Effekte und Ausgabe: Korn, Vignette, optionale Spiegelung.
 *
 * Korn und Vignette sind die einzigen ORTSABHÄNGIGEN Effekte der Pipeline.
 * Beide werden deshalb aus `imageUv()` abgeleitet — der absoluten Position im
 * Gesamtbild. Beim kachelweisen Export bekommt jede Kachel damit exakt das
 * Kornmuster und den Vignettenanteil, den sie an ihrer Stelle im Bild haben
 * muss; die Kacheln setzen sich nahtlos zusammen.
 */
export const OUTPUT_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;
uniform vec2  uImageSizePx;

uniform float uGrainAmount;     // 0 .. 1
uniform float uGrainCell;       // Kantenlänge eines Kornpixels, in Bildpixeln
uniform float uGrainRoughness;  // 0 .. 1

uniform float uVigAmount;       // -1 .. 1
uniform float uVigMidpoint;     // 0 .. 1
uniform float uVigFeather;      // 0 .. 1
uniform float uVigRoundness;    // 0 .. 1  (0 = rechteckig, 1 = kreisrund)

uniform float uFlipY;           // 1 beim Zeichnen auf den sichtbaren Canvas

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 uv = vUv;
  if (uFlipY > 0.5) uv.y = 1.0 - uv.y;

  vec2 su = uSrcRect.xy + uv * uSrcRect.zw;
  vec2 iu = uRegionOrigin + uv * uRegionSize;

  vec3 c = texture(uSrc, su).rgb;

  if (uGrainAmount > 0.0) {
    vec2 gp = iu * uImageSizePx / max(uGrainCell, 0.5);
    float n = valueNoise(gp);
    // Eine zweite, feinere Oktave macht das Korn unregelmäßiger.
    n = mix(n, (n + valueNoise(gp * 2.7 + 17.3)) * 0.5, uGrainRoughness);
    n = n * 2.0 - 1.0;

    // Wie bei echtem Film: in den Lichtern kaum sichtbar, im tiefen Schwarz
    // ebenfalls kaum, am stärksten in den Mitteltönen.
    float l = luma(c);
    float weight = smoothstep(0.0, 0.12, l) * (1.0 - smoothstep(0.55, 1.0, l));
    c += n * uGrainAmount * weight * 0.16;
  }

  if (uVigAmount != 0.0) {
    vec2 p = (iu - 0.5) * 2.0;
    float aspect = uImageSizePx.x / max(uImageSizePx.y, 1.0);
    p.x *= aspect;
    // Zwischen Maximumsnorm (rechteckig) und euklidischer Norm (kreisrund).
    float nRect = max(abs(p.x), abs(p.y));
    float nCirc = length(p);
    float d = mix(nRect, nCirc, uVigRoundness) / length(vec2(aspect, 1.0));

    float mid = mix(0.15, 1.05, uVigMidpoint);
    float feather = mix(0.03, 0.95, uVigFeather);
    float v = smoothstep(mid - feather * 0.5, mid + feather * 0.5, d);

    if (uVigAmount < 0.0) {
      c *= 1.0 + uVigAmount * v * 0.9;
    } else {
      c = mix(c, vec3(1.0), uVigAmount * v * 0.65);
    }
  }

  // Dithering vor der Quantisierung auf 8 Bit.
  //
  // Die Pipeline rechnet in 16-Bit-Gleitkomma, die Ausgabe hat 8 Bit. Ohne
  // Dithering entstehen in weichen Verläufen — Himmel, Studiohintergrund,
  // Vignette — sichtbare Stufen, weil viele benachbarte Zwischenwerte auf
  // denselben 8-Bit-Wert fallen. Ein Rauschen von ±1 Stufe mit dreieckiger
  // Verteilung (TPDF) verteilt den Rundungsfehler und löst die Stufen auf;
  // es ist das Standardverfahren aus der Audiotechnik und dort wie hier
  // unterhalb der Wahrnehmungsschwelle.
  //
  // Die Position stammt aus BILDKOORDINATEN, nicht aus gl_FragCoord — dadurch
  // ist das Muster in Vorschau und Export an derselben Bildstelle dasselbe.
  vec2 dp = iu * uImageSizePx;
  float d = (hash21(dp) - hash21(dp + 19.73)) / 255.0;
  c += d;

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
