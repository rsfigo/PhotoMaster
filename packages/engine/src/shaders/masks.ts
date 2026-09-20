import { MAX_MASKS } from '@photomaster/shared';
import { GLSL_HEADER, GLSL_REGION } from './common.ts';

/**
 * Pass 2b — lokale Anpassungen (§28).
 *
 * Läuft direkt NACH dem Lokalkontrast-Pass und VOR Rauschreduzierung,
 * Schärfung und Farbe. Diese Position ist mit Bedacht gewählt:
 *
 *  - Die Unschärfe-Texturen für lokale Struktur/Klarheit/Dunst liegen an
 *    dieser Stelle bereits vor und müssen nicht ein zweites Mal berechnet
 *    werden.
 *  - Rauschreduzierung und Schärfung sollen GLOBAL bleiben. Beide je Maske
 *    unterschiedlich anzuwenden ergäbe an den Maskengrenzen sichtbare Sprünge
 *    in der Kornstruktur — ein Fehler, den man nicht mehr wegbekommt.
 *  - Der Farb-Pass (HSL, Grading) läuft danach über das Gesamtergebnis, so wie
 *    ein Fotograf den Look zuletzt über das fertige Bild legt.
 *
 * Die Masken werden nacheinander angewendet und überlagern sich dabei. Jede
 * berechnet ihr Gewicht aus BILDKOORDINATEN (`imageUv()`), nicht aus der
 * Kachel — ohne das würde sich beim Export jede Maske pro Kachel wiederholen.
 *
 * Die Bearbeitungsformeln selbst stehen im gemeinsamen Header. Es sind exakt
 * dieselben, die auch global verwendet werden; eine lokale Belichtung von
 * +0.5 EV tut hier dasselbe wie der globale Regler auf +0.5 EV.
 */
export const MASK_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

#define MAX_MASKS ${MAX_MASKS}

uniform sampler2D uSrc;
uniform sampler2D uBlurFine;     // kachel-lokal, feiner Radius
uniform sampler2D uClarityBlur;  // global, niedrig aufgelöst
uniform sampler2D uVeil;         // global, niedrig aufgelöst (Dunkelkanal)
uniform sampler2D uBrushMasks;   // bis zu vier Pinselmasken, eine je Farbkanal

uniform float uAirlight;
uniform float uAspect;           // Bildbreite / Bildhöhe
uniform int   uMaskCount;

// Geometrie
uniform vec4 uMaskGeoA[MAX_MASKS];  // (istRadial, Winkel[rad], Position, Weichheit)
uniform vec4 uMaskGeoB[MAX_MASKS];  // (Mitte x, Mitte y, Radius x, Radius y)
// Bereichsverfeinerung
uniform vec4 uMaskLum[MAX_MASKS];   // (aktiv, min, max, Weichheit)
uniform vec4 uMaskCol[MAX_MASKS];   // (aktiv, Farbton 0-1, Toleranz 0-1, —)
// Anpassungen
uniform vec4 uMaskA[MAX_MASKS];     // (Belichtung, Kontrast, Lichter, Schatten)
uniform vec4 uMaskB[MAX_MASKS];     // (Weiß, Schwarz, Sättigung, Dynamik)
uniform vec4 uMaskC[MAX_MASKS];     // (Klarheit, Struktur, Dunst, Stärke)
uniform vec4 uMaskD[MAX_MASKS];     // (WB-Gain r, g, b, invertiert)

/**
 * Geometrisches Gewicht einer Maske an dieser Bildposition.
 *
 * Beide Formen liefern 1 im vollen Bereich und laufen über die Weichheit auf 0
 * aus. Ein harter Übergang (Weichheit 0) wäre in einem Foto immer sichtbar,
 * deshalb ist selbst das Minimum noch leicht verschliffen.
 */
float maskGeometry(int i, vec2 iu, vec4 brush) {
  vec4 a = uMaskGeoA[i];

  // Pinsel: Das Gewicht steht bereits fertig gerastert in einem Farbkanal.
  // Der Index wird dynamisch gelesen — bei einer vec4-Komponente ist das in
  // GLSL ES 3.0 erlaubt, bei einem Sampler-Array wäre es das nicht.
  if (a.x > 1.5) {
    return brush[int(uMaskGeoB[i].x + 0.5)];
  }

  if (a.x > 0.5) {
    // Ellipse. Für die Drehung wird zuerst in ein seitenverhältnis-korrigiertes
    // Koordinatensystem gewechselt — sonst würde eine gedrehte Ellipse im
    // Querformat verzerrt erscheinen.
    vec4 b = uMaskGeoB[i];
    vec2 q = (iu - b.xy) * vec2(uAspect, 1.0);
    float cs = cos(-a.y);
    float sn = sin(-a.y);
    q = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
    q /= vec2(max(b.z, 1e-4) * uAspect, max(b.w, 1e-4));

    float d = length(q);
    float f = clamp(a.w, 0.02, 1.0);
    return 1.0 - smoothstep(1.0 - f, 1.0, d);
  }

  // Verlauf. Winkel 0 zeigt die Achse nach unten, die Maske wirkt also oben —
  // der mit Abstand häufigste Fall (Himmel abdunkeln).
  //
  // Gerechnet wird in seitenverhältnis-korrigierten Koordinaten. Ohne das
  // würde ein eingestellter 45°-Verlauf im Querformat flacher aussehen als
  // 45°, weil eine normalisierte Bildkoordinate horizontal eine andere
  // Strecke bedeutet als vertikal.
  vec2 dir = vec2(sin(a.y), cos(a.y));
  vec2 p = (iu - vec2(0.5)) * vec2(uAspect, 1.0);
  // Halbe Ausdehnung des Bildes entlang der Achse — damit deckt die Position
  // 0…1 unabhängig vom Winkel immer genau das ganze Bild ab.
  float halfExtent = abs(dir.x) * uAspect * 0.5 + abs(dir.y) * 0.5;
  float t = dot(p, dir) / (2.0 * halfExtent) + 0.5;
  float f = max(a.w, 0.02);
  return 1.0 - smoothstep(a.z - f * 0.5, a.z + f * 0.5, t);
}

/** Verfeinerung nach Helligkeit — trennt den Himmel vom Baum davor. */
float maskLuminance(int i, float l) {
  vec4 r = uMaskLum[i];
  if (r.x < 0.5) return 1.0;
  float f = max(r.w, 0.01);
  return smoothstep(r.y - f, r.y, l) * (1.0 - smoothstep(r.z, r.z + f, l));
}

/** Verfeinerung nach Farbton — trifft z. B. nur den roten Lack. */
float maskColor(int i, vec3 c) {
  vec4 r = uMaskCol[i];
  if (r.x < 0.5) return 1.0;

  vec3 hsv = rgb2hsv(c);
  // In nahezu grauen Pixeln ist der Farbton numerisches Rauschen. Ohne dieses
  // Tor würde eine Farbbereichsmaske in Grautönen zufällig flackern.
  float satGate = smoothstep(0.04, 0.16, hsv.y);

  float d = abs(hsv.x - r.y);
  d = min(d, 1.0 - d);  // Farbton ist zyklisch
  float tol = max(r.z, 0.005);
  return satGate * (1.0 - smoothstep(tol * 0.6, tol, d));
}

/**
 * Die Anpassungen einer Maske auf eine Farbe anwenden — als wäre sie global.
 * Das Ergebnis wird anschließend über das Maskengewicht eingeblendet.
 */
vec3 applyMask(int i, vec3 c, float fineLuma, float clarityLuma, float veil) {
  vec4 A = uMaskA[i];
  vec4 B = uMaskB[i];
  vec4 C = uMaskC[i];
  vec4 D = uMaskD[i];

  c = whiteBalanceExposure(c, D.rgb, A.x);
  c = toneRegions3(c, A.z, A.w, B.x, B.y);
  c = contrastCurve3(c, A.y);

  if (C.x != 0.0 || C.y != 0.0) {
    float lum = luma(c);
    float newLum = lum;
    if (C.y != 0.0) {
      newLum += softLimit((lum - fineLuma) * C.y * 1.8, 0.22);
    }
    if (C.x != 0.0) {
      float mid = 1.0 - pow(abs(2.0 * clamp(lum, 0.0, 1.0) - 1.0), 2.0);
      newLum += softLimit((lum - clarityLuma) * C.x * 1.3 * mid, 0.28);
    }
    c = rescaleToLuma(c, lum, newLum);
  }

  if (C.z != 0.0) {
    c = applyDehaze(c, veil, uAirlight, C.z);
  }

  return vibranceSaturation(clamp(c, 0.0, 1.0), B.w, B.z);
}

void main() {
  vec2 su = srcUv();
  vec2 iu = imageUv();
  vec3 c = texture(uSrc, su).rgb;

  // Die Unschärfe-Werte hängen nicht von der Maske ab und werden deshalb
  // einmal vor der Schleife geholt statt bis zu achtmal darin.
  float fineLuma = luma(texture(uBlurFine, su).rgb);
  float clarityLuma = luma(texture(uClarityBlur, iu).rgb);
  float veil = texture(uVeil, iu).r;
  // Die Pinseltextur wurde für genau diesen Ausschnitt in genau dieser Größe
  // gerastert — sie liegt also deckungsgleich über dem Zwischenergebnis.
  vec4 brush = texture(uBrushMasks, su);

  for (int i = 0; i < MAX_MASKS; i++) {
    if (i >= uMaskCount) break;

    float w = maskGeometry(i, iu, brush);
    if (uMaskD[i].w > 0.5) w = 1.0 - w;

    // Die Bereichsverfeinerungen greifen NACH der Umkehrung: "alles außer dem
    // Himmel, aber nur die hellen Töne" wäre sonst nicht ausdrückbar.
    if (w > 0.001) {
      w *= maskLuminance(i, luma(c));
      w *= maskColor(i, c);
    }
    w *= uMaskC[i].w;

    // Der weitaus größte Teil des Bildes liegt außerhalb einer Maske. Dieser
    // Ausstieg spart dort die gesamte Bearbeitungsmathematik.
    if (w <= 0.002) continue;

    c = mix(c, applyMask(i, c, fineLuma, clarityLuma, veil), min(w, 1.0));
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/**
 * Darstellung der Maske als roter Schleier, während sie bearbeitet wird.
 *
 * Ohne diese Ansicht ist eine weiche Maske praktisch nicht einzustellen: Man
 * sieht die Wirkung, aber nicht die Form — und weiß bei einem schwachen
 * Ergebnis nicht, ob die Anpassung zu klein oder die Maske am falschen Ort ist.
 */
export const MASK_OVERLAY_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

#define MAX_MASKS ${MAX_MASKS}

uniform sampler2D uSrc;
uniform sampler2D uBrushMasks;
uniform float uAspect;
uniform int   uMaskIndex;

uniform vec4 uMaskGeoA[MAX_MASKS];
uniform vec4 uMaskGeoB[MAX_MASKS];
uniform vec4 uMaskLum[MAX_MASKS];
uniform vec4 uMaskCol[MAX_MASKS];
uniform vec4 uMaskC[MAX_MASKS];
uniform vec4 uMaskD[MAX_MASKS];

uniform float uFlipY;

float maskGeometry(int i, vec2 iu, vec4 brush) {
  vec4 a = uMaskGeoA[i];
  if (a.x > 1.5) {
    return brush[int(uMaskGeoB[i].x + 0.5)];
  }
  if (a.x > 0.5) {
    vec4 b = uMaskGeoB[i];
    vec2 q = (iu - b.xy) * vec2(uAspect, 1.0);
    float cs = cos(-a.y);
    float sn = sin(-a.y);
    q = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
    q /= vec2(max(b.z, 1e-4) * uAspect, max(b.w, 1e-4));
    return 1.0 - smoothstep(1.0 - clamp(a.w, 0.02, 1.0), 1.0, length(q));
  }
  vec2 dir = vec2(sin(a.y), cos(a.y));
  vec2 p = (iu - vec2(0.5)) * vec2(uAspect, 1.0);
  float halfExtent = abs(dir.x) * uAspect * 0.5 + abs(dir.y) * 0.5;
  float t = dot(p, dir) / (2.0 * halfExtent) + 0.5;
  float f = max(a.w, 0.02);
  return 1.0 - smoothstep(a.z - f * 0.5, a.z + f * 0.5, t);
}

void main() {
  vec2 uv = vUv;
  if (uFlipY > 0.5) uv.y = 1.0 - uv.y;

  vec2 su = uSrcRect.xy + uv * uSrcRect.zw;
  vec2 iu = uRegionOrigin + uv * uRegionSize;
  vec3 c = texture(uSrc, su).rgb;

  int i = uMaskIndex;
  float w = maskGeometry(i, iu, texture(uBrushMasks, su));
  if (uMaskD[i].w > 0.5) w = 1.0 - w;

  if (w > 0.001) {
    vec4 lr = uMaskLum[i];
    if (lr.x > 0.5) {
      float l = luma(c);
      float f = max(lr.w, 0.01);
      w *= smoothstep(lr.y - f, lr.y, l) * (1.0 - smoothstep(lr.z, lr.z + f, l));
    }
    vec4 cr = uMaskCol[i];
    if (cr.x > 0.5) {
      vec3 hsv = rgb2hsv(c);
      float d = abs(hsv.x - cr.y);
      d = min(d, 1.0 - d);
      float tol = max(cr.z, 0.005);
      w *= smoothstep(0.04, 0.16, hsv.y) * (1.0 - smoothstep(tol * 0.6, tol, d));
    }
  }
  w *= uMaskC[i].w;

  // Rot über einem entsättigten Bild: Die Maske bleibt auch über roten
  // Motiven erkennbar, und die Deckkraft bildet das Gewicht linear ab, sodass
  // der weiche Rand als Verlauf sichtbar wird.
  vec3 grey = vec3(luma(c));
  vec3 tinted = mix(mix(c, grey, 0.55), vec3(0.85, 0.16, 0.12), 0.55);
  c = mix(c, tinted, clamp(w, 0.0, 1.0) * 0.8);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
