import { GLSL_HEADER, GLSL_REGION } from './common.ts';

/**
 * Pass 2 — Lokalkontrast: Struktur, Klarheit, Dunstentfernung.
 *
 * Struktur und Klarheit sind dieselbe Operation mit unterschiedlichem Radius:
 * Das Bild wird gegen eine unscharfe Version von sich selbst verrechnet
 * (Unschärfemaskierung). Struktur nutzt einen feinen Radius und wirkt auf
 * Materialoberflächen; Klarheit einen groben und wirkt auf die Bildpräsenz.
 *
 * Zwei Designentscheidungen sind hier wichtig:
 *
 * 1. Die grobe Unschärfe (`uClarityBlur`) und der Dunstschleier (`uVeil`)
 *    werden EINMAL FÜR DAS GANZE BILD in niedriger Auflösung vorberechnet und
 *    hier über `imageUv()` abgetastet. Beim kachelweisen Export sieht jede
 *    Kachel damit dasselbe globale Tiefpass-Signal — ohne diesen Trick bräuchte
 *    jede Kachel einen Überlappungsrand in der Größe des Unschärferadius
 *    (mehrere hundert Pixel bei 24 MP).
 *
 * 2. Struktur und Klarheit verändern nur die LUMINANZ. Die Farbe wird
 *    anschließend proportional nachgezogen. Sonst verschieben sich bei starker
 *    Klarheit die Farbtöne in Richtung des dominanten Kanals.
 */
export const LOCAL_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;
uniform sampler2D uBlurFine;     // kachel-lokal, feiner Radius
uniform sampler2D uClarityBlur;  // global, niedrig aufgelöst
uniform sampler2D uVeil;         // global, niedrig aufgelöst (Dunkelkanal)

uniform float uTexture;   // -1 .. 1
uniform float uClarity;   // -1 .. 1
uniform float uDehaze;    // -1 .. 1
uniform float uAirlight;  // aus der Bildanalyse, 0 .. 1

void main() {
  vec2 su = srcUv();
  vec2 iu = imageUv();
  vec3 c = texture(uSrc, su).rgb;

  float lum = luma(c);
  float newLum = lum;

  if (uTexture != 0.0) {
    float detail = lum - luma(texture(uBlurFine, su).rgb);
    // softLimit deckelt die Differenz: ohne ihn entstehen an harten Kanten
    // helle Säume, weil dort die Differenz zur Unschärfe beliebig groß wird.
    newLum += softLimit(detail * uTexture * 1.8, 0.22);
  }

  if (uClarity != 0.0) {
    float detail = lum - luma(texture(uClarityBlur, iu).rgb);
    // Klarheit soll Mitteltöne formen und Lichter/Schatten in Ruhe lassen.
    float mid = 1.0 - pow(abs(2.0 * clamp(lum, 0.0, 1.0) - 1.0), 2.0);
    newLum += softLimit(detail * uClarity * 1.3 * mid, 0.28);
  }

  c = rescaleToLuma(c, lum, newLum);

  if (uDehaze != 0.0) {
    c = applyDehaze(c, texture(uVeil, iu).r, uAirlight, uDehaze);
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
