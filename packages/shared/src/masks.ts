/**
 * Lokale Masken (§28 des Briefings).
 *
 * Eine Maske beschreibt einen Bildbereich — und zwar PARAMETRISCH, nicht als
 * Pixelbild. Das ist die entscheidende Entwurfsentscheidung:
 *
 *  - Eine Maske ist ein paar Dutzend Zahlen. Sie passt damit in dasselbe
 *    non-destruktive Modell wie alles andere: Sie wird versioniert, kann
 *    rückgängig gemacht werden und kostet im Projekt keine Bilddaten.
 *  - Sie lässt sich auf der GPU zur Laufzeit in jeder Auflösung auswerten.
 *    Dieselbe Maske ergibt in der 2560-px-Vorschau und im 6000-px-Export
 *    exakt dieselbe Form — es gibt keine hochskalierte Maskendatei.
 *  - Und sie ist etwas, das die KI ausgeben KANN, ohne die Grenze aus §3 zu
 *    verletzen: Sie nennt Koordinaten und Radien, keine Pixel. Ein Modell,
 *    das eine Maske als Bild liefern würde, würde Bildinhalt erzeugen.
 *
 * Zwei Grundformen decken die Beispiele aus §28 ab:
 *
 *  - `linear`  Verlauf über eine Achse — Himmel abdunkeln, Vordergrund öffnen
 *  - `radial`  Ellipse — Motiv hervorheben, Hintergrund zurücknehmen
 *
 * Beide lassen sich zusätzlich über einen Luminanz- und einen Farbbereich
 * verfeinern. Erst diese Kombination trifft reale Motive: Ein Verlauf von oben
 * PLUS "nur die hellen Töne" trifft den Himmel und lässt den Baum davor stehen.
 */

import { PARAM_BY_ID, type ParamDef, type ParamValues } from './params.ts';

export type MaskType = 'linear' | 'radial' | 'brush';

/**
 * Wie viele Pinselmasken gleichzeitig möglich sind.
 *
 * Die Grenze ist technisch begründet: Alle Pinselmasken werden in die vier
 * Kanäle EINER Textur gerastert. Der Grund dafür ist eine Eigenheit von
 * GLSL ES 3.0 — ein Array von Samplern lässt sich dort nicht mit einem
 * laufenden Index ansprechen, eine vec4-Komponente dagegen schon. Vier
 * Pinselmasken sind in der Praxis reichlich; wer mehr braucht, arbeitet
 * ohnehin mit Ebenen und nicht mit einem Foto.
 */
export const MAX_BRUSH_MASKS = 4;

/** Obergrenzen je Pinselmaske, damit ein Projekt nicht unbegrenzt wächst. */
export const MAX_STROKES_PER_MASK = 240;
export const MAX_POINTS_PER_STROKE = 600;

export interface BrushPoint {
  x: number;
  y: number;
}

/**
 * Ein Pinselstrich.
 *
 * Gespeichert wird der WEG, nicht das Ergebnis. Das ist der entscheidende
 * Punkt: Ein Strich sind ein paar hundert Koordinaten (wenige Kilobyte), keine
 * Pixelmaske. Daraus folgt alles Weitere —
 *
 *  - Er wird zur Laufzeit in der jeweils benötigten Auflösung gerastert und
 *    ist im 6000-px-Export deshalb genauso scharf wie in der Vorschau. Eine
 *    gespeicherte Pixelmaske müsste man hochskalieren und bekäme weiche,
 *    ausgefranste Kanten.
 *  - Er passt in dieselbe Versionierung und denselben Verlauf wie jeder Regler.
 *  - Er lässt sich in einer Projektdatei ablegen, ohne sie aufzublähen.
 */
export interface BrushStroke {
  /** Stützpunkte in Bildkoordinaten (0…1), Ursprung oben links. */
  points: BrushPoint[];
  /** Radius als Anteil der langen Bildkante. */
  radius: number;
  /** 0 = weicher Verlauf bis zum Rand, 1 = harte Kante. */
  hardness: number;
  /** Deckkraft des Strichs, 0…1. */
  opacity: number;
  /** true = dieser Strich nimmt Maskenfläche weg, statt sie hinzuzufügen. */
  erase: boolean;
}

/** Mehr als acht Masken sind praktisch nie sinnvoll und kosten je Pixel Rechenzeit. */
export const MAX_MASKS = 8;

/**
 * Regler, die lokal wirken.
 *
 * Bewusst eine Teilmenge der globalen Parameter — und zwar genau die, bei
 * denen eine örtlich begrenzte Anwendung fotografisch sinnvoll ist. Nicht
 * dabei sind Rauschreduzierung und Schärfung (die gehören aus technischen
 * Gründen global vor die Maskenstufe), Korn und Vignette (ortsabhängige
 * Effekte, die sich mit Masken beißen) sowie Kurven und HSL (die als
 * Werkzeug bereits selektiv arbeiten).
 *
 * Die Definitionen werden aus der globalen Registry ÜBERNOMMEN, nicht
 * kopiert: Label, Bereich und Schrittweite bleiben dadurch zwangsläufig
 * identisch mit dem entsprechenden globalen Regler.
 */
export const LOCAL_PARAM_IDS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'saturation',
  'vibrance',
  'clarity',
  'texture',
  'dehaze',
] as const;

export type LocalParamId = (typeof LOCAL_PARAM_IDS)[number];

const LOCAL_PARAM_SET: ReadonlySet<string> = new Set<string>(LOCAL_PARAM_IDS);

export function isLocalParam(id: string): id is LocalParamId {
  return LOCAL_PARAM_SET.has(id);
}

export function localParamDefs(): ParamDef[] {
  return LOCAL_PARAM_IDS.map((id) => PARAM_BY_ID.get(id)!);
}

/** Verfeinerung nach Helligkeit — trennt Himmel von Bäumen, Lack von Asphalt. */
export interface LuminanceRange {
  active: boolean;
  /** Untere und obere Grenze des erfassten Helligkeitsbereichs (0…1). */
  min: number;
  max: number;
  /** Weichheit der Grenzen; 0 ergäbe harte, sichtbare Kanten. */
  feather: number;
}

/** Verfeinerung nach Farbton — trifft z. B. nur den roten Lack. */
export interface ColorRange {
  active: boolean;
  /** Ziel-Farbton in Grad (0 = Rot, 120 = Grün, 240 = Blau). */
  hue: number;
  /** Wie weit um den Zielfarbton herum noch erfasst wird (0…100). */
  tolerance: number;
}

export interface LocalMask {
  id: string;
  name: string;
  type: MaskType;
  enabled: boolean;
  /** Kehrt die Maske um — aus "der Himmel" wird "alles außer dem Himmel". */
  inverted: boolean;
  /** Gesamtstärke in Prozent; skaliert alle Anpassungen dieser Maske. */
  strength: number;

  /** Nur `linear`: Richtung der Achse in Grad. 0 = wirkt oben im Bild. */
  angle: number;
  /** Nur `linear`: Lage des Übergangs entlang der Achse (0…1). */
  position: number;

  /** Nur `radial`: Mittelpunkt, normalisiert auf die Bildfläche. */
  centerX: number;
  centerY: number;
  /** Nur `radial`: Halbachsen als Anteil von Bildbreite bzw. -höhe. */
  radiusX: number;
  radiusY: number;

  /** Breite des weichen Übergangs, für beide Formen (0…1). */
  feather: number;

  luminanceRange: LuminanceRange;
  colorRange: ColorRange;

  /** Nur bei `brush`: die gemalten Striche, in der Reihenfolge des Malens. */
  strokes: BrushStroke[];

  /** Nur Schlüssel aus LOCAL_PARAM_IDS. */
  values: Partial<ParamValues>;
}

/** Ausgangswerte eines neuen Pinsels. */
export const DEFAULT_BRUSH = {
  radius: 0.06,
  hardness: 0.5,
  opacity: 1,
} as const;

/**
 * Eindeutige Kennung für eine neue Maske. `crypto.randomUUID` gibt es sowohl
 * im Browser als auch in Node; der Rückfallweg greift nur in sehr alten
 * Umgebungen und muss lediglich innerhalb eines Projekts eindeutig sein.
 */
export function makeMaskId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `mask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultLuminanceRange(): LuminanceRange {
  return { active: false, min: 0, max: 1, feather: 0.25 };
}

function defaultColorRange(): ColorRange {
  return { active: false, hue: 30, tolerance: 25 };
}

export function createMask(type: MaskType, id: string, name: string): LocalMask {
  const values: Partial<ParamValues> = {};
  for (const paramId of LOCAL_PARAM_IDS) values[paramId] = PARAM_BY_ID.get(paramId)!.default;

  return {
    id,
    name,
    type,
    enabled: true,
    inverted: false,
    strength: 100,
    // Standardwerte, die sofort etwas Sichtbares ergeben: der Verlauf deckt
    // die obere Bildhälfte ab, die Ellipse sitzt mittig auf einem Drittel
    // der Bildfläche. Eine neue Maske, die man erst mühsam positionieren
    // muss, bevor man überhaupt sieht, wo sie liegt, ist unbrauchbar.
    angle: 0,
    position: 0.45,
    centerX: 0.5,
    centerY: 0.5,
    radiusX: 0.3,
    radiusY: 0.3,
    feather: type === 'linear' ? 0.35 : 0.5,
    luminanceRange: defaultLuminanceRange(),
    colorRange: defaultColorRange(),
    strokes: [],
    values,
  };
}

export function cloneMask(mask: LocalMask): LocalMask {
  return {
    ...mask,
    luminanceRange: { ...mask.luminanceRange },
    colorRange: { ...mask.colorRange },
    strokes: mask.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((p) => ({ ...p })),
    })),
    values: { ...mask.values },
  };
}

/** Hat die Maske überhaupt eine Wirkung? Steuert das Überspringen im Shader. */
export function maskHasEffect(mask: LocalMask): boolean {
  if (!mask.enabled || mask.strength === 0) return false;
  // Ein Pinsel ohne Striche umfasst keine Fläche — er kann nichts verändern,
  // egal wie die Regler stehen.
  if (mask.type === 'brush' && mask.strokes.length === 0) return false;
  return LOCAL_PARAM_IDS.some((id) => {
    const def = PARAM_BY_ID.get(id)!;
    return Math.abs((mask.values[id] ?? def.default) - def.default) >= def.step / 2;
  });
}

export function changedMaskParams(mask: LocalMask): LocalParamId[] {
  return LOCAL_PARAM_IDS.filter((id) => {
    const def = PARAM_BY_ID.get(id)!;
    return Math.abs((mask.values[id] ?? def.default) - def.default) >= def.step / 2;
  });
}

export const MASK_TYPE_LABELS: Record<MaskType, string> = {
  linear: 'Verlauf',
  radial: 'Radial',
  brush: 'Pinsel',
};

/** Zählt die Stützpunkte einer Pinselmaske — Grundlage für die Größengrenzen. */
export function countStrokePoints(mask: LocalMask): number {
  return mask.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
}

/** Kurzbeschreibung für die Maskenliste, z. B. "Verlauf · 3 Anpassungen". */
export function describeMask(mask: LocalMask): string {
  const parts: string[] = [MASK_TYPE_LABELS[mask.type]];
  if (mask.type === 'brush') {
    parts.push(mask.strokes.length === 1 ? '1 Strich' : `${mask.strokes.length} Striche`);
  }
  if (mask.inverted) parts.push('umgekehrt');
  if (mask.luminanceRange.active) parts.push('Luminanz');
  if (mask.colorRange.active) parts.push('Farbe');
  const count = changedMaskParams(mask).length;
  parts.push(count === 1 ? '1 Anpassung' : `${count} Anpassungen`);
  return parts.join(' · ');
}

// ── Zuarbeit für die Rasterung ─────────────────────────────────────────────
//
// Beide Funktionen sind reine Modelllogik ohne Grafikbezug. Sie stehen hier
// und nicht bei der Rasterung, damit sie auch außerhalb des Browsers laufen —
// die Testsuite prüft sie unter Node.

/**
 * Zuordnung Maske → Farbkanal. Pinselmasken jenseits der vierten bekommen
 * keinen Kanal mehr und damit auch keine Wirkung; die Oberfläche verhindert,
 * dass es überhaupt so weit kommt.
 */
export function assignBrushChannels(masks: LocalMask[]): Map<string, number> {
  const channels = new Map<string, number>();
  for (const mask of masks) {
    if (mask.type !== 'brush') continue;
    if (channels.size >= MAX_BRUSH_MASKS) break;
    channels.set(mask.id, channels.size);
  }
  return channels;
}

/**
 * Kurzkennung des Pinselzustands.
 *
 * Wird benutzt, um die gerasterte Textur wiederzuverwenden, solange sich
 * nichts geändert hat. Bewusst NICHT über alle Stützpunkte gerechnet: Beim
 * Malen entsteht 60-mal pro Sekunde eine neue Kennung, und die darf nicht
 * teurer sein als das Rastern selbst. Die Zahl der Punkte je Strich reicht
 * aus, weil Punkte nur angehängt und nie verschoben werden.
 */
export function brushSignature(masks: LocalMask[]): string {
  const parts: string[] = [];
  for (const mask of masks) {
    if (mask.type !== 'brush') continue;
    parts.push(mask.id, String(mask.strokes.length));
    for (const stroke of mask.strokes) {
      parts.push(
        String(stroke.points.length),
        stroke.radius.toFixed(4),
        stroke.hardness.toFixed(2),
        stroke.opacity.toFixed(2),
        stroke.erase ? 'e' : 'p',
      );
    }
  }
  return parts.join('|');
}
