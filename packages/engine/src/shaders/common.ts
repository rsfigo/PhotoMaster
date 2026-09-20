/**
 * Gemeinsamer GLSL-Kopf für alle Fragment-Shader.
 *
 * Konventionen, die in der gesamten Engine gelten:
 *
 *  - `vUv` läuft über das gerenderte Ziel von (0,0) bis (1,1).
 *  - Texturen speichern Zeile 0 = OBERE Bildkante (UNPACK_FLIP_Y ist aus).
 *    Dadurch liefert `readPixels` beim Export die Zeilen bereits in der
 *    richtigen Reihenfolge, und die einzige Stelle, die spiegeln muss, ist die
 *    Ausgabe auf den sichtbaren Canvas (`uFlipY` im Output-Shader).
 *  - Farben liegen zwischen den Passes GAMMA-KODIERT (sRGB) vor, nicht linear.
 *    Lokalkontrast, Sättigung und Grading verhalten sich in Gammakodierung
 *    perzeptuell gleichmäßig; nur Belichtung und Weißabgleich rechnen linear
 *    und konvertieren dafür kurzzeitig.
 *  - Werte dürfen zwischen Tone-Pass und Kurve über 1.0 liegen (Headroom für
 *    Lichterrückgewinnung). Erst die Kurve begrenzt endgültig auf [0,1].
 */

export const GLSL_HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

const float PI = 3.14159265359;

// Rec.709-Luminanz.
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 srgbToLinear(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  // 1e-10 verhindert Division durch Null bei exakt grauen Pixeln.
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

/**
 * Weicher Begrenzer für Lokalkontrast-Differenzen. Ohne ihn erzeugen große
 * Clarity-/Struktur-Werte an harten Kanten helle Säume (Halos). tanh lässt
 * kleine Differenzen unverändert und deckelt große sanft.
 */
float softLimit(float x, float limit) {
  return limit <= 0.0 ? x : limit * tanh(x / limit);
}

// ── Bearbeitungsoperationen ────────────────────────────────────────────────
//
// Diese Funktionen sind PARAMETRISIERT und nicht an Uniforms gebunden. Das ist
// der Grund, warum sie hier stehen und nicht im jeweiligen Pass: Sowohl die
// globale Bearbeitung als auch jede lokale Maske (§28) ruft dieselbe Funktion
// mit anderen Zahlen auf. Gäbe es die Formeln zweimal, würde eine Korrektur an
// der globalen Belichtung irgendwann nicht mehr für Maskenbelichtung gelten —
// und niemand würde es merken, bis ein Bild seltsam aussieht.

/**
 * Lichter/Schatten und Weiß-/Schwarzpunkt als additive Korrekturen mit weicher
 * Bereichsmaske. Erwartet und liefert GAMMA-kodierte Werte.
 *
 * Der Faktor hinter der Maske ist der Grund, warum nichts "umkippt": beim
 * Absenken skaliert die Korrektur mit x (Weiß bewegt sich am meisten, Schwarz
 * gar nicht), beim Anheben mit (1-x) (der Kopfraum wird kleiner, je näher der
 * Wert an Weiß kommt). Ein Regler kann den Wert dadurch nie über seinen
 * eigenen Zielbereich hinaustreiben.
 */
float toneRegions(float x, float highlights, float shadows, float whites, float blacks) {
  float hiMask = smoothstep(0.45, 1.00, x);
  float shMask = 1.0 - smoothstep(0.00, 0.55, x);

  x += highlights * hiMask * (highlights < 0.0 ? x : max(0.0, 1.0 - x)) * 0.35;
  x += shadows    * shMask * (shadows > 0.0 ? max(0.0, 1.0 - x) : x) * 0.35;

  float whMask = smoothstep(0.30, 1.00, x);
  float blMask = 1.0 - smoothstep(0.00, 0.45, x);

  x += whites * whMask * 0.25;
  x += blacks * blMask * 0.25;
  return x;
}

vec3 toneRegions3(vec3 c, float highlights, float shadows, float whites, float blacks) {
  return vec3(
    toneRegions(c.r, highlights, shadows, whites, blacks),
    toneRegions(c.g, highlights, shadows, whites, blacks),
    toneRegions(c.b, highlights, shadows, whites, blacks)
  );
}

/**
 * Kontrast als S-Kurve um das Mittelgrau.
 * Positiv blendet zu smoothstep über (eine echte S-Kurve mit waagerechten
 * Enden — deshalb clippt sie nie), negativ zur analytischen Umkehrfunktion.
 */
float contrastCurve(float x, float amount) {
  float xc = clamp(x, 0.0, 1.0);
  if (amount >= 0.0) {
    return mix(x, smoothstep(0.0, 1.0, xc), amount);
  }
  float inv = 0.5 - sin(asin(clamp(1.0 - 2.0 * xc, -1.0, 1.0)) / 3.0);
  return mix(x, inv, -amount);
}

vec3 contrastCurve3(vec3 c, float amount) {
  return vec3(contrastCurve(c.r, amount), contrastCurve(c.g, amount), contrastCurve(c.b, amount));
}

/**
 * Weißabgleich und Belichtung. Beides gehört physikalisch ins Licht, nicht in
 * die Wahrnehmung — deshalb wird für diesen Schritt und nur für ihn in den
 * linearen Raum gewechselt.
 */
vec3 whiteBalanceExposure(vec3 gammaColor, vec3 gain, float exposureEV) {
  vec3 lin = srgbToLinear(gammaColor) * gain * exp2(exposureEV);
  return linearToSrgb(lin);
}

/**
 * Dynamik und Sättigung.
 *
 * Dynamik gewichtet mit (1 − Sättigung): blasse Farben bekommen viel, bereits
 * kräftige fast nichts. Hauttöne um 32° werden zusätzlich gedämpft, damit
 * Gesichter bei kräftiger Dynamik nicht orange werden.
 */
vec3 vibranceSaturation(vec3 c, float vibrance, float saturation) {
  if (vibrance == 0.0 && saturation == 0.0) return c;
  vec3 hsv = rgb2hsv(c);

  if (vibrance != 0.0) {
    float dh = abs(hsv.x * 360.0 - 32.0);
    dh = min(dh, 360.0 - dh);
    float skin = 1.0 - 0.55 * exp(-pow(dh / 26.0, 2.0));
    hsv.y = clamp(hsv.y * (1.0 + vibrance * (1.0 - hsv.y) * skin * 1.4), 0.0, 1.0);
  }
  if (saturation != 0.0) {
    hsv.y = clamp(hsv.y * (1.0 + saturation), 0.0, 1.0);
  }
  return hsv2rgb(hsv);
}

/**
 * Überträgt eine Luminanzänderung auf die Farbe, ohne den Farbton zu drehen.
 * Der Nenner wird bei 0.02 gedeckelt, sonst explodiert das Verhältnis in
 * nahezu schwarzen Pixeln.
 */
vec3 rescaleToLuma(vec3 c, float oldLuma, float newLuma) {
  return c * (newLuma / max(oldLuma, 0.02));
}

/**
 * Dunstentfernung über ein Transmissionsmodell (Dark Channel Prior).
 * "veil" ist der geglättete Dunkelkanal, "airlight" die geschätzte Helligkeit
 * des Dunstes selbst.
 */
vec3 applyDehaze(vec3 c, float veil, float airlight, float amount) {
  float A = max(airlight, 0.08);
  if (amount > 0.0) {
    // I = J·t + A·(1−t), aufgelöst nach J. t wird bei 0.12 begrenzt, sonst
    // verstärkt die Division in sehr dunstigen Bereichen das Rauschen.
    float t = clamp(1.0 - amount * 0.92 * veil / A, 0.12, 1.0);
    return (c - A) / t + A;
  }
  // Negativ: Dunst hinzufügen — zum Airlight hin überblenden.
  return mix(c, vec3(A), -amount * 0.45);
}
`;

/**
 * Bildraum-Uniforms. Jeder Pass rendert eine Region (bei Kacheln: die Kachel
 * plus Überlappungsrand). Daraus ergeben sich zwei unterschiedliche Koordinaten:
 *
 *  - `srcUv(vUv)`   Position im Eingangstextur-Ausschnitt (zum Sampeln)
 *  - `imageUv(vUv)` Position im GESAMTEN Bild (für Vignette, Korn, Masken und
 *                   die global vorberechneten Tiefpass-Texturen)
 *
 * Die Trennung ist der Grund dafür, dass Kachelgrenzen unsichtbar bleiben:
 * ortsabhängige Effekte kennen ihre absolute Bildposition. Für Masken ist das
 * doppelt wichtig — eine Maske, die sich an der Kachel statt am Bild
 * orientierte, würde im Export 24-mal wiederholt.
 */
export const GLSL_REGION = `
uniform vec4 uSrcRect;      // xy = Ursprung, zw = Größe (normalisiert)
uniform vec2 uRegionOrigin; // Ursprung der Region im Bild (normalisiert)
uniform vec2 uRegionSize;   // Größe der Region im Bild (normalisiert)

vec2 srcUv() { return uSrcRect.xy + vUv * uSrcRect.zw; }
vec2 imageUv() { return uRegionOrigin + vUv * uRegionSize; }
`;
