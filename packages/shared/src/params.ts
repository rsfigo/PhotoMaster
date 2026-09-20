/**
 * Parameter-Registry — Single Source of Truth für alle Bearbeitungsparameter.
 *
 * Jeder Regler ist hier GENAU EINMAL definiert. Daraus werden abgeleitet:
 *   - die Slider-UI (Label, Bereich, Schrittweite, bipolar/unipolar)
 *   - Validierung und Clamping von KI-Antworten (§32 des Briefings)
 *   - das Parameter-Schema, das der KI übergeben wird
 *   - die Belegung der GLSL-Uniforms
 *   - die "gegenüber Default geändert"-Erkennung für Reset-Buttons
 *
 * Ein neuer Parameter wird ausschließlich hier hinzugefügt.
 */

import type { LocalMask } from './masks.ts';

export type ParamGroup = 'basic' | 'color' | 'detail' | 'hsl' | 'grading' | 'effects';

export const GROUP_LABELS: Record<ParamGroup, string> = {
  basic: 'Licht',
  color: 'Farbe',
  detail: 'Details',
  hsl: 'HSL / Farbmischer',
  grading: 'Color Grading',
  effects: 'Effekte',
};

export interface ParamDef {
  /** Eindeutiger Schlüssel — identisch in UI, DB, GLSL-Uniform und KI-Schema. */
  id: string;
  label: string;
  group: ParamGroup;
  /** Untergruppe innerhalb einer Gruppe, z. B. der HSL-Farbkanal. */
  section?: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  /** Slider mit Nullpunkt in der Mitte (Default liegt mittig). */
  bipolar?: boolean;
  /** Wertebereich ist zyklisch (Farbton 0–360). */
  wrap?: boolean;
  /** Darf die KI diesen Parameter setzen? */
  ai: boolean;
  /** Kurzbeschreibung — geht wörtlich in den KI-Prompt und in den UI-Tooltip. */
  hint: string;
}

/** Die acht HSL-Bänder mit ihren Farbton-Mittelpunkten (Grad im HSV-Kreis). */
export const HSL_BANDS = [
  { key: 'Red', label: 'Rot', center: 0 },
  { key: 'Orange', label: 'Orange', center: 30 },
  { key: 'Yellow', label: 'Gelb', center: 60 },
  { key: 'Green', label: 'Grün', center: 120 },
  { key: 'Aqua', label: 'Aqua', center: 180 },
  { key: 'Blue', label: 'Blau', center: 240 },
  { key: 'Purple', label: 'Violett', center: 280 },
  { key: 'Magenta', label: 'Magenta', center: 320 },
] as const;

export type HslBandKey = (typeof HSL_BANDS)[number]['key'];

const pm100 = { min: -100, max: 100, step: 1, default: 0, bipolar: true } as const;

function hslParams(): ParamDef[] {
  const out: ParamDef[] = [];
  for (const band of HSL_BANDS) {
    out.push(
      {
        ...pm100,
        id: `hsl${band.key}Hue`,
        label: 'Farbton',
        group: 'hsl',
        section: band.label,
        ai: true,
        hint: `verschiebt ${band.label.toLowerCase()}e Bildbereiche im Farbkreis`,
      },
      {
        ...pm100,
        id: `hsl${band.key}Sat`,
        label: 'Sättigung',
        group: 'hsl',
        section: band.label,
        ai: true,
        hint: `Sättigung ausschließlich der ${band.label.toLowerCase()}en Bildbereiche`,
      },
      {
        ...pm100,
        id: `hsl${band.key}Lum`,
        label: 'Luminanz',
        group: 'hsl',
        section: band.label,
        ai: true,
        hint: `Helligkeit ausschließlich der ${band.label.toLowerCase()}en Bildbereiche`,
      },
    );
  }
  return out;
}

function gradingZone(prefix: string, label: string): ParamDef[] {
  return [
    {
      id: `${prefix}Hue`,
      label: 'Farbton',
      group: 'grading',
      section: label,
      min: 0,
      max: 360,
      step: 1,
      default: 0,
      unit: '°',
      wrap: true,
      ai: true,
      hint: `Einfärbung der ${label} — Farbwinkel (0 = Rot, 60 = Gelb, 120 = Grün, 180 = Cyan, 240 = Blau, 300 = Magenta). Wirkt nur bei Sättigung > 0.`,
    },
    {
      id: `${prefix}Sat`,
      label: 'Sättigung',
      group: 'grading',
      section: label,
      min: 0,
      max: 100,
      step: 1,
      default: 0,
      ai: true,
      hint: `Stärke der Einfärbung der ${label}`,
    },
    {
      id: `${prefix}Lum`,
      label: 'Luminanz',
      group: 'grading',
      section: label,
      ...pm100,
      ai: true,
      hint: `Helligkeitskorrektur der ${label} nach der Einfärbung`,
    },
  ];
}

export const PARAMS: ParamDef[] = [
  // ── Licht ────────────────────────────────────────────────────────────────
  {
    id: 'exposure',
    label: 'Belichtung',
    group: 'basic',
    min: -5,
    max: 5,
    step: 0.01,
    default: 0,
    unit: 'EV',
    bipolar: true,
    ai: true,
    hint: 'Gesamthelligkeit in Blendenstufen. ±0.25 ist eine feine Korrektur, ±1.0 ist bereits sehr stark.',
  },
  {
    ...pm100,
    id: 'contrast',
    label: 'Kontrast',
    group: 'basic',
    ai: true,
    hint: 'S-Kurve um das Mittelgrau. Positiv spreizt Lichter und Schatten auseinander.',
  },
  {
    ...pm100,
    id: 'highlights',
    label: 'Lichter',
    group: 'basic',
    ai: true,
    hint: 'nur die hellen Bereiche. Negativ holt Zeichnung in einen zu hellen Himmel zurück.',
  },
  {
    ...pm100,
    id: 'shadows',
    label: 'Schatten',
    group: 'basic',
    ai: true,
    hint: 'nur die dunklen Bereiche. Positiv öffnet abgesoffene Schatten.',
  },
  {
    ...pm100,
    id: 'whites',
    label: 'Weiß',
    group: 'basic',
    ai: true,
    hint: 'der Weißpunkt am oberen Ende des Histogramms. Bestimmt, wo Weiß clippt.',
  },
  {
    ...pm100,
    id: 'blacks',
    label: 'Schwarz',
    group: 'basic',
    ai: true,
    hint: 'der Schwarzpunkt am unteren Ende. Negativ erzeugt tiefes Schwarz, positiv einen matten Look.',
  },

  // ── Farbe ────────────────────────────────────────────────────────────────
  {
    ...pm100,
    id: 'temperature',
    label: 'Temperatur',
    group: 'color',
    ai: true,
    hint: 'Weißabgleich blau↔gelb. Negativ = kühler/blauer, positiv = wärmer/gelber.',
  },
  {
    ...pm100,
    id: 'tint',
    label: 'Tonung',
    group: 'color',
    ai: true,
    hint: 'Weißabgleich grün↔magenta. Negativ = grüner, positiv = magentaner.',
  },
  {
    ...pm100,
    id: 'vibrance',
    label: 'Dynamik',
    group: 'color',
    ai: true,
    hint: 'Sättigung nur für blasse Farben, schützt bereits gesättigte Farben und Hauttöne. Meist die bessere Wahl als Sättigung.',
  },
  {
    ...pm100,
    id: 'saturation',
    label: 'Sättigung',
    group: 'color',
    ai: true,
    hint: 'lineare Sättigung aller Farben gleichermaßen. −100 ergibt Schwarzweiß.',
  },

  // ── Details ──────────────────────────────────────────────────────────────
  {
    ...pm100,
    id: 'texture',
    label: 'Struktur',
    group: 'detail',
    ai: true,
    hint: 'feine Mikrokontraste (kleiner Radius) — Stoff, Lack, Rinde. Negativ glättet Haut.',
  },
  {
    ...pm100,
    id: 'clarity',
    label: 'Klarheit',
    group: 'detail',
    ai: true,
    hint: 'Mittelton-Lokalkontrast (großer Radius). Gibt Präsenz und "Punch", über +40 wirkt es schnell hart.',
  },
  {
    ...pm100,
    id: 'dehaze',
    label: 'Dunst entfernen',
    group: 'detail',
    ai: true,
    hint: 'entfernt atmosphärischen Schleier über ein Transmissionsmodell. Negativ fügt weichen Dunst hinzu.',
  },
  {
    id: 'sharpenAmount',
    label: 'Schärfe',
    group: 'detail',
    section: 'Schärfen',
    min: 0,
    max: 150,
    step: 1,
    default: 0,
    ai: true,
    hint: 'Unschärfemaskierung auf dem Luminanzkanal. 40–80 ist ein üblicher Bereich.',
  },
  {
    id: 'sharpenRadius',
    label: 'Radius',
    group: 'detail',
    section: 'Schärfen',
    min: 0.3,
    max: 3,
    step: 0.1,
    default: 1,
    unit: 'px',
    ai: true,
    hint: 'Kantenbreite beim Schärfen. Kleine Werte für feine Details, große für weiche Motive.',
  },
  {
    id: 'sharpenDetail',
    label: 'Detail',
    group: 'detail',
    section: 'Schärfen',
    min: 0,
    max: 100,
    step: 1,
    default: 25,
    ai: true,
    hint: 'wie stark auch feinste Strukturen mitgeschärft werden. Hoch verstärkt auch Rauschen.',
  },
  {
    id: 'sharpenMasking',
    label: 'Maskieren',
    group: 'detail',
    section: 'Schärfen',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    ai: true,
    hint: 'beschränkt die Schärfung auf Kanten und lässt glatte Flächen (Himmel, Haut) unangetastet.',
  },
  {
    id: 'noiseLuminance',
    label: 'Luminanzrauschen',
    group: 'detail',
    section: 'Rauschreduzierung',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    ai: true,
    hint: 'kantenerhaltende Glättung des Helligkeitsrauschens. Zu viel wirkt wachsartig.',
  },
  {
    id: 'noiseColor',
    label: 'Farbrauschen',
    group: 'detail',
    section: 'Rauschreduzierung',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    ai: true,
    hint: 'entfernt bunte Rauschpixel. Kostet fast keine Detailschärfe, bei hohem ISO fast immer sinnvoll.',
  },

  // ── HSL ──────────────────────────────────────────────────────────────────
  ...hslParams(),

  // ── Color Grading ────────────────────────────────────────────────────────
  ...gradingZone('gradeShadow', 'Schatten'),
  ...gradingZone('gradeMid', 'Mitteltöne'),
  ...gradingZone('gradeHigh', 'Lichter'),
  {
    id: 'gradeBlending',
    label: 'Überblendung',
    group: 'grading',
    section: 'Abstimmung',
    min: 0,
    max: 100,
    step: 1,
    default: 50,
    ai: true,
    hint: 'wie weich Schatten-, Mittelton- und Lichter-Einfärbung ineinander übergehen.',
  },
  {
    id: 'gradeBalance',
    label: 'Balance',
    group: 'grading',
    section: 'Abstimmung',
    ...pm100,
    ai: true,
    hint: 'verschiebt den Übergabepunkt zwischen Schatten- und Lichter-Einfärbung.',
  },

  // ── Effekte ──────────────────────────────────────────────────────────────
  {
    ...pm100,
    id: 'vignetteAmount',
    label: 'Vignette',
    group: 'effects',
    section: 'Vignette',
    ai: true,
    hint: 'negativ dunkelt die Ecken ab und lenkt den Blick zur Bildmitte, positiv hellt sie auf.',
  },
  {
    id: 'vignetteMidpoint',
    label: 'Mittelpunkt',
    group: 'effects',
    section: 'Vignette',
    min: 0,
    max: 100,
    step: 1,
    default: 50,
    ai: true,
    hint: 'wie weit die Vignette von den Ecken zur Bildmitte reicht.',
  },
  {
    id: 'vignetteFeather',
    label: 'Weichzeichnen',
    group: 'effects',
    section: 'Vignette',
    min: 0,
    max: 100,
    step: 1,
    default: 50,
    ai: true,
    hint: 'Härte der Vignettenkante. Hoch = sehr weicher Verlauf.',
  },
  {
    id: 'vignetteRoundness',
    label: 'Rundheit',
    group: 'effects',
    section: 'Vignette',
    ...pm100,
    ai: true,
    hint: 'Form der Vignette zwischen rechteckig (−100) und kreisrund (+100).',
  },
  {
    id: 'grainAmount',
    label: 'Korn',
    group: 'effects',
    section: 'Korn',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    ai: true,
    hint: 'Filmkorn. Wird in den Lichtern automatisch zurückgenommen, wie bei echtem Film.',
  },
  {
    id: 'grainSize',
    label: 'Größe',
    group: 'effects',
    section: 'Korn',
    min: 0,
    max: 100,
    step: 1,
    default: 25,
    ai: true,
    hint: 'Korngröße — klein wirkt wie feiner Film, groß wie hochempfindliches Material.',
  },
  {
    id: 'grainRoughness',
    label: 'Rauheit',
    group: 'effects',
    section: 'Korn',
    min: 0,
    max: 100,
    step: 1,
    default: 50,
    ai: true,
    hint: 'Unregelmäßigkeit der Kornstruktur.',
  },
];

export type ParamId = string;

export const PARAM_BY_ID: ReadonlyMap<string, ParamDef> = new Map(PARAMS.map((p) => [p.id, p]));

export const PARAM_IDS: readonly string[] = PARAMS.map((p) => p.id);

export function paramsInGroup(group: ParamGroup): ParamDef[] {
  return PARAMS.filter((p) => p.group === group);
}

/** Parameter einer Gruppe, nach Untergruppe geordnet (Reihenfolge wie in PARAMS). */
export function sectionsInGroup(group: ParamGroup): { section: string | null; params: ParamDef[] }[] {
  const out: { section: string | null; params: ParamDef[] }[] = [];
  for (const p of paramsInGroup(group)) {
    const key = p.section ?? null;
    const last = out[out.length - 1];
    if (last && last.section === key) last.params.push(p);
    else out.push({ section: key, params: [p] });
  }
  return out;
}

// ── Kurven ─────────────────────────────────────────────────────────────────

export interface CurvePoint {
  x: number;
  y: number;
}

export type CurveChannel = 'rgb' | 'r' | 'g' | 'b';
export const CURVE_CHANNELS: CurveChannel[] = ['rgb', 'r', 'g', 'b'];

export type Curves = Record<CurveChannel, CurvePoint[]>;

export const MAX_CURVE_POINTS = 16;

export function defaultCurve(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

export function defaultCurves(): Curves {
  return { rgb: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve() };
}

export function isIdentityCurve(points: CurvePoint[]): boolean {
  if (points.length !== 2) return false;
  return (
    Math.abs(points[0].x) < 1e-6 &&
    Math.abs(points[0].y) < 1e-6 &&
    Math.abs(points[1].x - 1) < 1e-6 &&
    Math.abs(points[1].y - 1) < 1e-6
  );
}

// ── Vollständiger Bearbeitungszustand ──────────────────────────────────────

export type ParamValues = Record<string, number>;

export interface EditParams {
  /** Schema-Version; erlaubt spätere Migration gespeicherter Projekte. */
  v: 1;
  values: ParamValues;
  curves: Curves;
  /** Lokale Masken (§28). Leer, solange nur global bearbeitet wird. */
  masks: LocalMask[];
}

function defaultValues(): ParamValues {
  const out: ParamValues = {};
  for (const p of PARAMS) out[p.id] = p.default;
  return out;
}

export function createDefaultParams(): EditParams {
  return { v: 1, values: defaultValues(), curves: defaultCurves(), masks: [] };
}

export function clampParam(id: string, value: number): number {
  const def = PARAM_BY_ID.get(id);
  if (!def) return value;
  if (!Number.isFinite(value)) return def.default;
  if (def.wrap) {
    const span = def.max - def.min;
    return def.min + (((value - def.min) % span) + span) % span;
  }
  return Math.min(def.max, Math.max(def.min, value));
}

/** Auf die Schrittweite runden — verhindert Fließkomma-Rauschen in der UI und DB. */
export function snapParam(id: string, value: number): number {
  const def = PARAM_BY_ID.get(id);
  if (!def) return value;
  const snapped = Math.round(value / def.step) * def.step;
  // Nachkommastellen aus der Schrittweite ableiten (0.01 → 2 Stellen).
  const decimals = Math.max(0, Math.ceil(-Math.log10(def.step)));
  return clampParam(id, Number(snapped.toFixed(decimals)));
}

export function isDefaultValue(id: string, value: number): boolean {
  const def = PARAM_BY_ID.get(id);
  if (!def) return false;
  return Math.abs(value - def.default) < def.step / 2;
}

export function changedParamIds(params: EditParams): string[] {
  return PARAM_IDS.filter((id) => !isDefaultValue(id, params.values[id] ?? 0));
}

export function formatParamValue(def: ParamDef, value: number): string {
  const decimals = Math.max(0, Math.ceil(-Math.log10(def.step)));
  const sign = def.bipolar && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}${def.unit ? ` ${def.unit}` : ''}`;
}
