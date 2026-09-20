/**
 * Übersetzt Regler-Werte in Shader-Werte.
 *
 * Die UI und die Datenbank arbeiten mit vertrauten Bereichen (−100…100, EV,
 * Grad). Die Shader rechnen mit normalisierten Größen (−1…1, Faktoren,
 * Bogenmaß). Diese Umrechnung findet ausschließlich hier statt — dadurch gibt
 * es keine verstreuten Magic Numbers in den Shadern, und die Skalierung eines
 * Reglers lässt sich an einer Stelle nachjustieren.
 */

import {
  HSL_BANDS,
  MAX_MASKS,
  buildCurveLut,
  isIdentityCurve,
  maskHasEffect,
  type Curves,
  type EditParams,
  type LocalMask,
  type ParamValues,
} from '@photomaster/shared';

export const CURVE_LUT_SIZE = 256;

/**
 * Kanalfaktoren für den Weißabgleich, auf konstante Luminanz normiert.
 *
 * Die Normierung ist der Grund, warum sich beim Verschieben der Temperatur die
 * Bildhelligkeit nicht ändert: Ohne sie würde "wärmer" das Bild aufhellen
 * (Rot wird verstärkt, Blau abgeschwächt, und Rot wiegt in der Luminanz mehr
 * als Blau), und der Nutzer müsste die Belichtung nachkorrigieren.
 */
function whiteBalanceGain(temperature: number, tint: number): [number, number, number] {
  const t = temperature / 100;
  const g = tint / 100;

  const r = 1 + t * 0.38 + g * 0.1;
  const gr = 1 - g * 0.28;
  const b = 1 - t * 0.38 + g * 0.1;

  const l = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
  return [r / l, gr / l, b / l];
}

export interface ToneUniforms {
  wbGain: [number, number, number];
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  curveActive: boolean;
}

export interface LocalUniforms {
  texture: number;
  clarity: number;
  dehaze: number;
  active: boolean;
}

export interface DenoiseUniforms {
  lumStrength: number;
  colorStrength: number;
  lumRadius: number;
  colorRadius: number;
  active: boolean;
}

export interface SharpenUniforms {
  amount: number;
  radius: number;
  detail: number;
  masking: number;
  active: boolean;
}

export interface ColorUniforms {
  hslHue: Float32Array;
  hslSat: Float32Array;
  hslLum: Float32Array;
  hslActive: boolean;
  vibrance: number;
  saturation: number;
  gradeShadow: [number, number, number];
  gradeMid: [number, number, number];
  gradeHigh: [number, number, number];
  gradeBlending: number;
  gradeBalance: number;
  gradeActive: boolean;
  active: boolean;
}

export interface EffectUniforms {
  grainAmount: number;
  grainCellFraction: number;
  grainRoughness: number;
  vigAmount: number;
  vigMidpoint: number;
  vigFeather: number;
  vigRoundness: number;
}

export interface PreparedUniforms {
  tone: ToneUniforms;
  local: LocalUniforms;
  denoise: DenoiseUniforms;
  sharpen: SharpenUniforms;
  color: ColorUniforms;
  effects: EffectUniforms;
}

const n100 = (v: number) => (v ?? 0) / 100;

function prepareTone(v: ParamValues, curves: Curves): ToneUniforms {
  return {
    wbGain: whiteBalanceGain(v.temperature ?? 0, v.tint ?? 0),
    exposure: v.exposure ?? 0,
    // Kontrast mit 0.85 gedeckelt: die volle S-Kurve bei 1.0 ist härter als
    // jedes fotografisch sinnvolle Maximum.
    contrast: n100(v.contrast) * 0.85,
    highlights: n100(v.highlights),
    shadows: n100(v.shadows),
    whites: n100(v.whites),
    blacks: n100(v.blacks),
    curveActive: curvesActive(curves),
  };
}

function curvesActive(curves: Curves): boolean {
  return (
    !isIdentityCurve(curves.rgb) ||
    !isIdentityCurve(curves.r) ||
    !isIdentityCurve(curves.g) ||
    !isIdentityCurve(curves.b)
  );
}

/**
 * Packt alle vier Kurven in eine einzige RGBA-Textur:
 * x = Master, y = Rot, z = Grün, w = Blau.
 * Der Tone-Shader braucht dadurch drei statt sechs Texturzugriffe.
 */
export function buildCurveTextureData(curves: Curves): Float32Array {
  const master = buildCurveLut(curves.rgb, CURVE_LUT_SIZE);
  const r = buildCurveLut(curves.r, CURVE_LUT_SIZE);
  const g = buildCurveLut(curves.g, CURVE_LUT_SIZE);
  const b = buildCurveLut(curves.b, CURVE_LUT_SIZE);

  const data = new Float32Array(CURVE_LUT_SIZE * 4);
  for (let i = 0; i < CURVE_LUT_SIZE; i++) {
    data[i * 4 + 0] = master[i];
    data[i * 4 + 1] = r[i];
    data[i * 4 + 2] = g[i];
    data[i * 4 + 3] = b[i];
  }
  return data;
}

function prepareLocal(v: ParamValues): LocalUniforms {
  const texture = n100(v.texture);
  const clarity = n100(v.clarity);
  const dehaze = n100(v.dehaze);
  return { texture, clarity, dehaze, active: texture !== 0 || clarity !== 0 || dehaze !== 0 };
}

function prepareDenoise(v: ParamValues): DenoiseUniforms {
  const lumStrength = (v.noiseLuminance ?? 0) / 100;
  const colorStrength = (v.noiseColor ?? 0) / 100;
  return {
    lumStrength,
    colorStrength,
    // Radius wächst mit der Stärke: schwache Reduzierung bleibt eng am Pixel,
    // starke greift weiter aus.
    lumRadius: 1 + lumStrength * 1.4,
    colorRadius: 1.5 + colorStrength * 3.5,
    active: lumStrength > 0 || colorStrength > 0,
  };
}

function prepareSharpen(v: ParamValues): SharpenUniforms {
  const amount = (v.sharpenAmount ?? 0) / 100;
  return {
    amount,
    radius: v.sharpenRadius ?? 1,
    detail: (v.sharpenDetail ?? 25) / 100,
    masking: (v.sharpenMasking ?? 0) / 100,
    active: amount > 0,
  };
}

function prepareColor(v: ParamValues): ColorUniforms {
  const hslHue = new Float32Array(8);
  const hslSat = new Float32Array(8);
  const hslLum = new Float32Array(8);
  let hslActive = false;

  HSL_BANDS.forEach((band, i) => {
    hslHue[i] = n100(v[`hsl${band.key}Hue`]);
    hslSat[i] = n100(v[`hsl${band.key}Sat`]);
    hslLum[i] = n100(v[`hsl${band.key}Lum`]);
    if (hslHue[i] !== 0 || hslSat[i] !== 0 || hslLum[i] !== 0) hslActive = true;
  });

  const zone = (prefix: string): [number, number, number] => [
    ((v[`${prefix}Hue`] ?? 0) % 360) / 360,
    (v[`${prefix}Sat`] ?? 0) / 100,
    n100(v[`${prefix}Lum`]),
  ];

  const gradeShadow = zone('gradeShadow');
  const gradeMid = zone('gradeMid');
  const gradeHigh = zone('gradeHigh');
  const gradeActive =
    gradeShadow[1] > 0 ||
    gradeMid[1] > 0 ||
    gradeHigh[1] > 0 ||
    gradeShadow[2] !== 0 ||
    gradeMid[2] !== 0 ||
    gradeHigh[2] !== 0;

  const vibrance = n100(v.vibrance);
  const saturation = n100(v.saturation);

  return {
    hslHue,
    hslSat,
    hslLum,
    hslActive,
    vibrance,
    saturation,
    gradeShadow,
    gradeMid,
    gradeHigh,
    gradeBlending: (v.gradeBlending ?? 50) / 100,
    gradeBalance: n100(v.gradeBalance),
    gradeActive,
    active: hslActive || vibrance !== 0 || saturation !== 0 || gradeActive,
  };
}

function prepareEffects(v: ParamValues): EffectUniforms {
  return {
    grainAmount: (v.grainAmount ?? 0) / 100,
    // Korngröße als Anteil der langen Bildkante — dadurch ist die Körnung
    // in der Vorschau und im Export maßstabsgetreu dieselbe.
    grainCellFraction: 0.0004 + ((v.grainSize ?? 25) / 100) * 0.0014,
    grainRoughness: (v.grainRoughness ?? 50) / 100,
    vigAmount: n100(v.vignetteAmount),
    vigMidpoint: (v.vignetteMidpoint ?? 50) / 100,
    vigFeather: (v.vignetteFeather ?? 50) / 100,
    // −100…100 → 0…1 (rechteckig … kreisrund)
    vigRoundness: ((v.vignetteRoundness ?? 0) + 100) / 200,
  };
}

export function prepareUniforms(params: EditParams): PreparedUniforms {
  const v = params.values;
  return {
    tone: prepareTone(v, params.curves),
    local: prepareLocal(v),
    denoise: prepareDenoise(v),
    sharpen: prepareSharpen(v),
    color: prepareColor(v),
    effects: prepareEffects(v),
  };
}

/**
 * Nur die Parameter, die das global vorberechnete Tiefpass-Signal beeinflussen.
 * Ändert sich davon keiner, kann der Cache weiterverwendet werden.
 */
export function lowFrequencyKey(params: EditParams): string {
  const v = params.values;
  const keys = [
    'exposure',
    'contrast',
    'highlights',
    'shadows',
    'whites',
    'blacks',
    'temperature',
    'tint',
  ];
  return keys.map((k) => v[k] ?? 0).join(',') + '|' + JSON.stringify(params.curves);
}

// ── Lokale Masken (§28) ────────────────────────────────────────────────────

/**
 * Maskendaten in der Form, die der Shader erwartet: acht `vec4`-Arrays mit je
 * MAX_MASKS Einträgen.
 *
 * Die Verdichtung auf vec4 ist kein Mikro-Optimieren, sondern nötig: Ein
 * eigenes Uniform je Feld und Maske wären über hundert Uniforms, und die
 * garantierte Untergrenze in WebGL2 liegt bei 224 Vektoren insgesamt.
 */
export interface MaskUniforms {
  count: number;
  geoA: Float32Array;
  geoB: Float32Array;
  lum: Float32Array;
  col: Float32Array;
  a: Float32Array;
  b: Float32Array;
  c: Float32Array;
  d: Float32Array;
  /** Mindestens eine Maske wirkt tatsächlich — sonst entfällt der ganze Pass. */
  active: boolean;
  /** Mindestens eine wirksame Maske benutzt "Struktur". */
  needsFineBlur: boolean;
}

function emptyMaskUniforms(slots: number): MaskUniforms {
  return {
    count: 0,
    geoA: new Float32Array(slots * 4),
    geoB: new Float32Array(slots * 4),
    lum: new Float32Array(slots * 4),
    col: new Float32Array(slots * 4),
    a: new Float32Array(slots * 4),
    b: new Float32Array(slots * 4),
    c: new Float32Array(slots * 4),
    d: new Float32Array(slots * 4),
    active: false,
    needsFineBlur: false,
  };
}

/**
 * Schreibt eine Maske in einen Steckplatz.
 *
 * `strength` ist dabei der Schalter, der eine Maske stilllegt: Ist sie
 * abgeschaltet oder hat sie keine einzige Anpassung, geht sie mit Stärke 0
 * hinein und der Shader überspringt sie beim ersten Test. Sie behält dabei
 * aber ihren Platz im Array — ein Filtern würde die Indizes verschieben, und
 * die Maskenvorschau zeigte plötzlich die falsche Maske.
 */
function writeMask(
  u: MaskUniforms,
  slot: number,
  mask: LocalMask,
  effective: boolean,
  brushChannel: number | undefined,
): void {
  const o = slot * 4;
  const v = mask.values;
  const n100 = (x: number | undefined) => (x ?? 0) / 100;

  // 0 = Verlauf, 1 = Ellipse, 2 = Pinsel.
  u.geoA[o] = mask.type === 'brush' ? 2 : mask.type === 'radial' ? 1 : 0;
  u.geoA[o + 1] = (mask.angle * Math.PI) / 180;
  u.geoA[o + 2] = mask.position;
  u.geoA[o + 3] = mask.feather;

  // Beim Pinsel steht im ersten Feld der Farbkanal der gerasterten Textur
  // statt des Mittelpunkts — die Ellipsenwerte werden dort nicht gelesen.
  if (mask.type === 'brush') {
    u.geoB[o] = brushChannel ?? 0;
    u.geoB[o + 1] = 0;
    u.geoB[o + 2] = 0;
    u.geoB[o + 3] = 0;
  } else {
  u.geoB[o] = mask.centerX;
  u.geoB[o + 1] = mask.centerY;
  u.geoB[o + 2] = mask.radiusX;
  u.geoB[o + 3] = mask.radiusY;
  }

  u.lum[o] = mask.luminanceRange.active ? 1 : 0;
  u.lum[o + 1] = mask.luminanceRange.min;
  u.lum[o + 2] = mask.luminanceRange.max;
  u.lum[o + 3] = mask.luminanceRange.feather;

  u.col[o] = mask.colorRange.active ? 1 : 0;
  u.col[o + 1] = (mask.colorRange.hue % 360) / 360;
  // Toleranz 0…100 auf einen Anteil des Farbkreises abbilden: 100 erfasst
  // eine halbe Umdrehung, also praktisch alles außer der Gegenfarbe.
  u.col[o + 2] = (mask.colorRange.tolerance / 100) * 0.5;
  u.col[o + 3] = 0;

  u.a[o] = v.exposure ?? 0;
  // Dieselbe Deckelung wie global, damit ein lokaler Kontrast von +50 exakt
  // so wirkt wie der globale Regler auf +50.
  u.a[o + 1] = n100(v.contrast) * 0.85;
  u.a[o + 2] = n100(v.highlights);
  u.a[o + 3] = n100(v.shadows);

  u.b[o] = n100(v.whites);
  u.b[o + 1] = n100(v.blacks);
  u.b[o + 2] = n100(v.saturation);
  u.b[o + 3] = n100(v.vibrance);

  u.c[o] = n100(v.clarity);
  u.c[o + 1] = n100(v.texture);
  u.c[o + 2] = n100(v.dehaze);
  u.c[o + 3] = effective ? mask.strength / 100 : 0;

  const gain = whiteBalanceGain(v.temperature ?? 0, v.tint ?? 0);
  u.d[o] = gain[0];
  u.d[o + 1] = gain[1];
  u.d[o + 2] = gain[2];
  u.d[o + 3] = mask.inverted ? 1 : 0;
}

export function prepareMasks(
  masks: LocalMask[],
  brushChannels?: Map<string, number>,
): MaskUniforms {
  const u = emptyMaskUniforms(MAX_MASKS);
  const list = masks.slice(0, MAX_MASKS);
  u.count = list.length;

  list.forEach((mask, i) => {
    const channel = brushChannels?.get(mask.id);
    // Eine Pinselmaske ohne Kanal kann nicht gerastert werden und bleibt
    // deshalb wirkungslos — die Oberfläche lässt es gar nicht so weit kommen.
    const effective = maskHasEffect(mask) && (mask.type !== 'brush' || channel !== undefined);
    writeMask(u, i, mask, effective, channel);
    if (!effective) return;
    u.active = true;
    if ((mask.values.texture ?? 0) !== 0) u.needsFineBlur = true;
  });

  return u;
}

/**
 * Uniforms für die Maskenvorschau (roter Schleier).
 *
 * Die betrachtete Maske liegt immer auf Steckplatz 0, und ihre Stärke geht
 * unabhängig davon ein, ob sie schon Anpassungen hat. Eine frisch angelegte
 * Maske muss sichtbar sein, BEVOR man den ersten Regler bewegt — sonst
 * positioniert man blind.
 */
export function prepareMaskOverlay(mask: LocalMask, brushChannel?: number): MaskUniforms {
  const u = emptyMaskUniforms(1);
  u.count = 1;
  u.active = true;
  writeMask(u, 0, mask, true, brushChannel);
  return u;
}
