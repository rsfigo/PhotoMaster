import { GLSL_HEADER, GLSL_REGION } from './common.ts';

/**
 * Pass 3 — Rauschreduzierung.
 *
 * Das Bild wird in Luminanz und Chrominanz zerlegt und beides getrennt
 * behandelt, weil die beiden Rauscharten unterschiedlich aussehen und
 * unterschiedlich teuer zu entfernen sind:
 *
 *  - Luminanzrauschen sitzt in der Helligkeit und trägt Bilddetails.
 *    Es wird bilateral gefiltert: Nachbarpixel zählen nur dann, wenn sie
 *    ÄHNLICH HELL sind. Dadurch bleiben Kanten stehen, während Flächen glatt
 *    werden — ein gewöhnlicher Weichzeichner würde hier Details vernichten.
 *  - Farbrauschen sitzt in der Chrominanz und trägt fast keine Bildinformation.
 *    Es darf großzügig geglättet werden und kostet dabei kaum Schärfe. Deshalb
 *    ist Farbrauschreduzierung bei hohem ISO praktisch immer unbedenklich.
 */
export const DENOISE_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;
uniform vec2  uTexel;
uniform float uLumStrength;    // 0 .. 1
uniform float uColorStrength;  // 0 .. 1
uniform float uLumRadius;      // Abtastabstand in Pixeln
uniform float uColorRadius;

void main() {
  vec2 su = srcUv();
  vec3 center = texture(uSrc, su).rgb;
  float lc = luma(center);
  vec3 chromaC = center - lc;

  float lumSum = lc;
  float lumW = 1.0;
  vec3 chromaSum = chromaC;
  float chromaW = 1.0;

  // Größere Stärke ⇒ größere Bereichstoleranz ⇒ auch stärker abweichende
  // Nachbarn werden noch gemittelt.
  float rangeSigma = mix(0.012, 0.085, uLumStrength);
  float invRange2 = 1.0 / (2.0 * rangeSigma * rangeSigma);

  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      if (x == 0 && y == 0) continue;
      vec2 o = vec2(float(x), float(y));
      float spatial = exp(-dot(o, o) * 0.25);

      if (uLumStrength > 0.0) {
        vec3 s = texture(uSrc, su + o * uTexel * uLumRadius).rgb;
        float ls = luma(s);
        float d = ls - lc;
        float w = spatial * exp(-d * d * invRange2);
        lumSum += ls * w;
        lumW += w;
      }

      if (uColorStrength > 0.0) {
        vec3 s = texture(uSrc, su + o * uTexel * uColorRadius).rgb;
        vec3 ch = s - luma(s);
        // Milde Bereichsgewichtung, damit Farbe nicht über harte Farbkanten
        // hinwegläuft (z. B. rote Rückleuchte auf dunklem Lack).
        float cd = length(ch - chromaC);
        float w = spatial * exp(-cd * cd * 12.0);
        chromaSum += ch * w;
        chromaW += w;
      }
    }
  }

  float outLum = mix(lc, lumSum / lumW, uLumStrength);
  vec3 outChroma = mix(chromaC, chromaSum / chromaW, uColorStrength);

  fragColor = vec4(clamp(outChroma + outLum, 0.0, 1.0), 1.0);
}
`;

/**
 * Pass 4 — Schärfen (Unschärfemaskierung auf dem Luminanzkanal).
 *
 * `uMasking` ist der entscheidende Regler für ein sauberes Ergebnis: Er leitet
 * aus dem Gradienten der unscharfen Version eine Kantenmaske ab und schärft
 * nur dort. Glatte Flächen — Himmel, Haut, Lack — bleiben unangetastet und
 * bekommen dadurch kein verstärktes Rauschen.
 */
export const SHARPEN_SHADER = `${GLSL_HEADER}
${GLSL_REGION}

uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform vec2  uTexel;
uniform float uAmount;   // 0 .. 1.5
uniform float uDetail;   // 0 .. 1
uniform float uMasking;  // 0 .. 1

void main() {
  vec2 su = srcUv();
  vec3 c = texture(uSrc, su).rgb;
  float lc = luma(c);
  float lb = luma(texture(uBlur, su).rgb);

  float d = lc - lb;

  // "Detail" bestimmt, bis zu welcher Amplitude feine Strukturen als Detail
  // gelten. Niedrige Werte unterdrücken kleine Differenzen (also Rauschen),
  // hohe lassen auch feinste Strukturen durch.
  d = softLimit(d, mix(0.05, 0.40, uDetail));

  float mask = 1.0;
  if (uMasking > 0.001) {
    float gx = luma(texture(uBlur, su + vec2(uTexel.x, 0.0)).rgb)
             - luma(texture(uBlur, su - vec2(uTexel.x, 0.0)).rgb);
    float gy = luma(texture(uBlur, su + vec2(0.0, uTexel.y)).rgb)
             - luma(texture(uBlur, su - vec2(0.0, uTexel.y)).rgb);
    float grad = length(vec2(gx, gy));
    float thr = uMasking * 0.10;
    mask = smoothstep(thr * 0.2, thr + 0.004, grad);
  }

  float newLum = lc + uAmount * d * mask * 1.6;
  c *= newLum / max(lc, 0.02);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
