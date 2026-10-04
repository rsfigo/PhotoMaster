/**
 * Validierung und Normalisierung von Bearbeitungsparametern (§32 des Briefings).
 *
 * Jeder Parametersatz, der von außen kommt — KI-Antwort, gespeichertes Projekt,
 * importiertes Preset, HTTP-Body — läuft durch diese Funktionen. Sie werfen
 * niemals: sie reparieren, clampen und melden, was korrigiert wurde. Die App
 * darf durch eine kaputte KI-Antwort nicht in einen ungültigen Zustand geraten.
 */

import {
  DEFAULT_BRUSH,
  LOCAL_PARAM_IDS,
  MAX_MASKS,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_MASK,
  cloneMask,
  createMask,
  isLocalParam,
  makeMaskId,
  maskHasEffect,
  type BrushStroke,
  type ColorRange,
  type LocalMask,
  type LuminanceRange,
  type MaskType,
} from './masks.ts';
import {
  CURVE_CHANNELS,
  MAX_CURVE_POINTS,
  PARAM_BY_ID,
  PARAM_IDS,
  changedParamIds,
  clampParam,
  createDefaultParams,
  defaultCurve,
  defaultCurves,
  isIdentityCurve,
  snapParam,
  type CurvePoint,
  type Curves,
  type EditParams,
  type ParamValues,
} from './params.ts';

export interface SanitizeResult<T> {
  value: T;
  /** Menschenlesbare Meldungen über jede vorgenommene Korrektur. */
  issues: string[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Liest eine Zahl aus einem unbekannten Wert — streng.
 *
 * `Number()` allein ist dafür zu großzügig: `Number(null)`, `Number("")` und
 * `Number([])` ergeben 0, `Number(true)` ergibt 1. Ein fehlender Wert würde so
 * zu "Regler auf 0", ein fehlender Pinselpunkt zu einem Punkt am linken
 * Bildrand — statt aufzufallen. Akzeptiert werden deshalb nur echte Zahlen und
 * nicht-leere Zeichenketten, die vollständig eine Zahl darstellen (manche
 * Modelle liefern "+12").
 */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalisiert eine Teilmenge von Parameterwerten (z. B. eine KI-Antwort).
 * Unbekannte Schlüssel und ungültige Zahlen werden verworfen, gültige Werte
 * auf den erlaubten Bereich geclampt und auf die Schrittweite gerundet.
 */
export function sanitizeValuePatch(input: unknown): SanitizeResult<Partial<ParamValues>> {
  const issues: string[] = [];
  const out: Partial<ParamValues> = {};

  if (!isRecord(input)) {
    return { value: out, issues: ['Parameterobjekt erwartet, anderer Datentyp erhalten.'] };
  }

  for (const [key, raw] of Object.entries(input)) {
    const def = PARAM_BY_ID.get(key);
    if (!def) {
      issues.push(`Unbekannter Parameter "${key}" ignoriert.`);
      continue;
    }
    // Manche Modelle liefern Zahlen als String ("+12") — das ist reparierbar.
    // Ein leerer String oder null dagegen ist kein Wert, auch wenn `Number()`
    // daraus eine 0 machen würde.
    const num = toFiniteNumber(raw);
    if (num === null) {
      issues.push(`Parameter "${key}" war kein gültiger Zahlenwert und wurde ignoriert.`);
      continue;
    }
    const clamped = clampParam(key, num);
    if (Math.abs(clamped - num) > def.step / 2) {
      issues.push(
        `Parameter "${key}" lag mit ${num} außerhalb von ${def.min}…${def.max} und wurde auf ${clamped} begrenzt.`,
      );
    }
    out[key] = snapParam(key, clamped);
  }

  return { value: out, issues };
}

/** Normalisiert eine einzelne Kurve: sortiert, geclampt, entdoppelt, begrenzt. */
export function sanitizeCurve(input: unknown, channelLabel: string): SanitizeResult<CurvePoint[]> {
  const issues: string[] = [];
  if (!Array.isArray(input)) {
    return { value: defaultCurve(), issues: [`Kurve "${channelLabel}" war kein Array — Standardkurve verwendet.`] };
  }

  const pts: CurvePoint[] = [];
  for (const p of input) {
    if (!isRecord(p)) continue;
    const x = toFiniteNumber(p.x);
    const y = toFiniteNumber(p.y);
    if (x === null || y === null) continue;
    pts.push({
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    });
  }

  if (pts.length !== input.length) {
    issues.push(`Kurve "${channelLabel}": ${input.length - pts.length} ungültige Punkte entfernt.`);
  }

  pts.sort((a, b) => a.x - b.x);

  // Zwei Punkte auf derselben x-Position machen die Interpolation mehrdeutig.
  const unique: CurvePoint[] = [];
  for (const p of pts) {
    const prev = unique[unique.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 1e-4) {
      unique[unique.length - 1] = p;
      continue;
    }
    unique.push(p);
  }

  if (unique.length < 2) {
    return { value: defaultCurve(), issues: [...issues, `Kurve "${channelLabel}" hatte zu wenige Punkte — Standardkurve verwendet.`] };
  }

  if (unique.length > MAX_CURVE_POINTS) {
    issues.push(`Kurve "${channelLabel}" auf ${MAX_CURVE_POINTS} Punkte ausgedünnt.`);
    return { value: thinCurve(unique, MAX_CURVE_POINTS), issues };
  }

  return { value: unique, issues };
}

/**
 * Dünnt eine zu lange Kurve gleichmäßig aus.
 *
 * Die Endpunkte bleiben immer erhalten: Sie tragen Schwarz- und Weißpunkt.
 * Einfach die ersten N Punkte zu behalten hieße, das obere Ende der Kurve
 * abzuschneiden — und damit sämtliche Lichter anders abzubilden.
 */
function thinCurve(points: CurvePoint[], max: number): CurvePoint[] {
  const inner = max - 2;
  const out: CurvePoint[] = [points[0]];
  for (let i = 1; i <= inner; i++) {
    out.push(points[Math.round((i * (points.length - 1)) / (inner + 1))]);
  }
  out.push(points[points.length - 1]);
  return out;
}

function sanitizeCurves(input: unknown): SanitizeResult<Curves> {
  if (!isRecord(input)) return { value: defaultCurves(), issues: [] };
  const issues: string[] = [];
  const out = defaultCurves();
  for (const ch of CURVE_CHANNELS) {
    if (input[ch] === undefined) continue;
    const res = sanitizeCurve(input[ch], ch);
    out[ch] = res.value;
    issues.push(...res.issues);
  }
  return { value: out, issues };
}

// ── Lokale Masken (§28) ────────────────────────────────────────────────────

const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = toFiniteNumber(v);
  if (n === null) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Winkel zyklisch auf 0…360 bringen, damit aus −30 die 330 wird und nicht die 0. */
const wrapAngle = (v: unknown, fallback: number): number => {
  const n = toFiniteNumber(v);
  if (n === null) return fallback;
  return ((n % 360) + 360) % 360;
};

function sanitizeLuminanceRange(input: unknown, fallback: LuminanceRange): LuminanceRange {
  if (!isRecord(input)) return { ...fallback };
  const min = num(input.min, 0, 1, fallback.min);
  const max = num(input.max, 0, 1, fallback.max);
  return {
    active: bool(input.active, fallback.active),
    // Vertauschte Grenzen sind ein naheliegender Fehler und leicht zu
    // reparieren; unrepariert wäre die Maske schlicht überall leer.
    min: Math.min(min, max),
    max: Math.max(min, max),
    feather: num(input.feather, 0, 1, fallback.feather),
  };
}

function sanitizeColorRange(input: unknown, fallback: ColorRange): ColorRange {
  if (!isRecord(input)) return { ...fallback };
  return {
    active: bool(input.active, fallback.active),
    hue: wrapAngle(input.hue, fallback.hue),
    tolerance: num(input.tolerance, 1, 100, fallback.tolerance),
  };
}


/**
 * Prüft die Striche einer Pinselmaske.
 *
 * Striche kommen aus der Oberfläche, aus einer gespeicherten Projektdatei oder
 * theoretisch aus einer manipulierten Anfrage. Ein einzelner Punkt mit NaN
 * würde im Vertex-Puffer landen und die gesamte Maske unbrauchbar machen —
 * deshalb fliegt hier alles raus, was keine endliche Zahl ist.
 */
function sanitizeStrokes(input: unknown): SanitizeResult<BrushStroke[]> {
  if (!Array.isArray(input)) return { value: [], issues: [] };

  const issues: string[] = [];
  const strokes: BrushStroke[] = [];
  let droppedPoints = 0;

  for (const raw of input.slice(0, MAX_STROKES_PER_MASK)) {
    if (!isRecord(raw) || !Array.isArray(raw.points)) continue;

    const points: { x: number; y: number }[] = [];
    for (const p of raw.points) {
      if (!isRecord(p)) {
        droppedPoints++;
        continue;
      }
      const x = toFiniteNumber(p.x);
      const y = toFiniteNumber(p.y);
      if (x === null || y === null) {
        droppedPoints++;
        continue;
      }
      // Striche dürfen über den Bildrand hinauslaufen — man setzt den Pinsel
      // oft außerhalb an und zieht ins Bild. Ein Spielraum von einer halben
      // Bildbreite reicht dafür und verhindert zugleich absurde Koordinaten.
      points.push({
        x: Math.min(1.5, Math.max(-0.5, x)),
        y: Math.min(1.5, Math.max(-0.5, y)),
      });
      if (points.length >= MAX_POINTS_PER_STROKE) break;
    }

    if (points.length === 0) continue;

    strokes.push({
      points,
      radius: num(raw.radius, 0.002, 0.8, DEFAULT_BRUSH.radius),
      hardness: num(raw.hardness, 0, 1, DEFAULT_BRUSH.hardness),
      opacity: num(raw.opacity, 0.02, 1, DEFAULT_BRUSH.opacity),
      erase: bool(raw.erase, false),
    });
  }

  if (droppedPoints > 0) {
    issues.push(`${droppedPoints} ungültige Pinselpunkte entfernt.`);
  }
  if (input.length > MAX_STROKES_PER_MASK) {
    issues.push(`Die Pinselmaske hatte ${input.length} Striche; verwendet werden die ersten ${MAX_STROKES_PER_MASK}.`);
  }

  return { value: strokes, issues };
}

/**
 * Prüft eine einzelne Maske. Jedes Feld hat einen sinnvollen Rückfallwert —
 * eine unvollständige Maske aus einer KI-Antwort oder einem älteren Projekt
 * wird dadurch zu einer gültigen Maske statt zu einem Fehler.
 */
export function sanitizeMask(input: unknown, index: number): SanitizeResult<LocalMask> {
  const issues: string[] = [];
  const rawType = isRecord(input) ? input.type : undefined;
  const type: MaskType =
    rawType === 'radial' ? 'radial' : rawType === 'brush' ? 'brush' : 'linear';
  const base = createMask(type, makeMaskId(), `Maske ${index + 1}`);

  if (!isRecord(input)) {
    return {
      value: base,
      issues: ['Eine Maske war kein Objekt und wurde durch eine Standardmaske ersetzt.'],
    };
  }

  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
  const values: Record<string, number> = { ...base.values } as Record<string, number>;

  const strokes = sanitizeStrokes(input.strokes);
  issues.push(...strokes.issues);

  if (isRecord(input.values)) {
    const patch = sanitizeValuePatch(input.values);
    for (const [id, value] of Object.entries(patch.value)) {
      // Global gültige Regler, die lokal nicht angeboten werden, gehören hier
      // nicht hinein — sonst stünden Werte im Zustand, die kein Shader liest.
      if (!isLocalParam(id)) {
        issues.push(`Parameter "${id}" ist lokal nicht verfügbar und wurde verworfen.`);
        continue;
      }
      if (typeof value === 'number') values[id] = value;
    }
    issues.push(...patch.issues);
  }

  return {
    value: {
      id: typeof input.id === 'string' && input.id.length > 0 ? input.id.slice(0, 64) : base.id,
      name: name || base.name,
      type,
      enabled: bool(input.enabled, true),
      inverted: bool(input.inverted, false),
      strength: num(input.strength, 0, 100, 100),
      angle: wrapAngle(input.angle, base.angle),
      position: num(input.position, 0, 1, base.position),
      centerX: num(input.centerX, 0, 1, base.centerX),
      centerY: num(input.centerY, 0, 1, base.centerY),
      // Radien dürfen über die Bildkante hinausreichen — eine Ellipse, die
      // größer als das Bild ist, ist eine legitime weiche Abdunklung.
      radiusX: num(input.radiusX, 0.01, 3, base.radiusX),
      radiusY: num(input.radiusY, 0.01, 3, base.radiusY),
      feather: num(input.feather, 0, 1, base.feather),
      luminanceRange: sanitizeLuminanceRange(input.luminanceRange, base.luminanceRange),
      colorRange: sanitizeColorRange(input.colorRange, base.colorRange),
      // Striche gehören nur zum Pinsel. Bei den anderen Formen werden sie
      // verworfen, statt unsichtbar im Projekt mitzureisen.
      strokes: type === 'brush' ? strokes.value : [],
      values,
    },
    issues,
  };
}

export function sanitizeMasks(input: unknown): SanitizeResult<LocalMask[]> {
  if (!Array.isArray(input)) return { value: [], issues: [] };

  const issues: string[] = [];
  const masks: LocalMask[] = [];
  const seenIds = new Set<string>();

  for (const raw of input.slice(0, MAX_MASKS)) {
    const result = sanitizeMask(raw, masks.length);
    issues.push(...result.issues);
    // Doppelte Kennungen würden die Auswahl in der Oberfläche mehrdeutig machen.
    if (seenIds.has(result.value.id)) result.value.id = makeMaskId();
    seenIds.add(result.value.id);
    masks.push(result.value);
  }

  if (input.length > MAX_MASKS) {
    issues.push(
      `Es wurden ${input.length} Masken übergeben; verwendet werden die ersten ${MAX_MASKS}.`,
    );
  }

  return { value: masks, issues };
}

function masksEqual(a: LocalMask[], b: LocalMask[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((mask, i) => {
    const other = b[i];
    if (
      mask.id !== other.id ||
      mask.type !== other.type ||
      mask.enabled !== other.enabled ||
      mask.inverted !== other.inverted ||
      mask.name !== other.name
    ) {
      return false;
    }

    const geometry = [
      'strength', 'angle', 'position', 'centerX', 'centerY', 'radiusX', 'radiusY', 'feather',
    ] as const;
    if (geometry.some((k) => Math.abs(mask[k] - other[k]) > 1e-6)) return false;

    const lr = mask.luminanceRange;
    const lo = other.luminanceRange;
    if (lr.active !== lo.active || lr.min !== lo.min || lr.max !== lo.max || lr.feather !== lo.feather) {
      return false;
    }

    const cr = mask.colorRange;
    const co = other.colorRange;
    if (cr.active !== co.active || cr.hue !== co.hue || cr.tolerance !== co.tolerance) return false;

    if (!strokesEqual(mask.strokes, other.strokes)) return false;

    return LOCAL_PARAM_IDS.every((id) => (mask.values[id] ?? 0) === (other.values[id] ?? 0));
  });
}

function strokesEqual(a: BrushStroke[], b: BrushStroke[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((stroke, i) => {
    const other = b[i];
    if (
      stroke.points.length !== other.points.length ||
      stroke.radius !== other.radius ||
      stroke.hardness !== other.hardness ||
      stroke.opacity !== other.opacity ||
      stroke.erase !== other.erase
    ) {
      return false;
    }
    // Ein wachsender Strich ändert nur den letzten Punkt — der Vergleich muss
    // deshalb wirklich jeden Punkt ansehen, sonst bliebe die Vorschau stehen.
    return stroke.points.every(
      (p, j) => p.x === other.points[j].x && p.y === other.points[j].y,
    );
  });
}

/**
 * Normalisiert einen vollständigen Bearbeitungszustand. Fehlende Parameter
 * erhalten ihren Default — dadurch bleiben ältere gespeicherte Projekte lesbar,
 * wenn später neue Parameter hinzukommen.
 */
export function sanitizeEditParams(input: unknown): SanitizeResult<EditParams> {
  const issues: string[] = [];
  const result = createDefaultParams();

  if (!isRecord(input)) {
    return { value: result, issues: ['Kein gültiger Bearbeitungszustand — Standardwerte verwendet.'] };
  }

  // Sowohl { values, curves } als auch ein flaches Wertobjekt akzeptieren.
  const rawValues = isRecord(input.values) ? input.values : input;
  const patch = sanitizeValuePatch(rawValues);
  issues.push(...patch.issues);
  Object.assign(result.values, patch.value);

  if (input.curves !== undefined) {
    const curves = sanitizeCurves(input.curves);
    result.curves = curves.value;
    issues.push(...curves.issues);
  }

  // Fehlt das Feld ganz, stammt das Projekt aus der Zeit vor den Masken —
  // das ist kein Fehler, sondern einfach ein Bild ohne lokale Anpassungen.
  if (input.masks !== undefined) {
    const masks = sanitizeMasks(input.masks);
    result.masks = masks.value;
    issues.push(...masks.issues);
  }

  return { value: result, issues };
}

/**
 * Tiefe Kopie eines Bearbeitungszustands.
 *
 * Liegt hier und nicht in `params.ts`, weil das Klonen die Masken zur Laufzeit
 * anfassen muss — `params.ts` kennt sie nur als Typ. Damit bleibt die
 * Abhängigkeit zwischen den beiden Modulen einseitig.
 */
export function cloneParams(p: EditParams): EditParams {
  return {
    v: 1,
    values: { ...p.values },
    curves: {
      rgb: p.curves.rgb.map((q) => ({ ...q })),
      r: p.curves.r.map((q) => ({ ...q })),
      g: p.curves.g.map((q) => ({ ...q })),
      b: p.curves.b.map((q) => ({ ...q })),
    },
    masks: p.masks.map(cloneMask),
  };
}

/** Weicht irgendetwas vom unbearbeiteten Ausgangszustand ab? */
export function hasAnyChange(params: EditParams): boolean {
  if (changedParamIds(params).length > 0) return true;
  if (params.masks.some(maskHasEffect)) return true;
  return CURVE_CHANNELS.some((c) => !isIdentityCurve(params.curves[c]));
}

/** Wendet einen validierten Patch auf einen bestehenden Zustand an (immutable). */
export function applyValuePatch(base: EditParams, patch: Partial<ParamValues>): EditParams {
  const values: ParamValues = { ...base.values };
  // Explizit statt per Spread: ein Patch mit ausdrücklichem `undefined` würde
  // den bestehenden Wert sonst mit undefined überschreiben.
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number') values[k] = v;
  }
  return {
    v: 1,
    values,
    curves: {
      rgb: base.curves.rgb.map((p) => ({ ...p })),
      r: base.curves.r.map((p) => ({ ...p })),
      g: base.curves.g.map((p) => ({ ...p })),
      b: base.curves.b.map((p) => ({ ...p })),
    },
    masks: base.masks.map(cloneMask),
  };
}

/** Alle Parameter, die sich zwischen zwei Zuständen unterscheiden. */
function diffParams(a: EditParams, b: EditParams): { id: string; from: number; to: number }[] {
  const out: { id: string; from: number; to: number }[] = [];
  for (const id of PARAM_IDS) {
    const from = a.values[id] ?? 0;
    const to = b.values[id] ?? 0;
    const def = PARAM_BY_ID.get(id)!;
    if (Math.abs(from - to) >= def.step / 2) out.push({ id, from, to });
  }
  return out;
}

function curvesEqual(a: Curves, b: Curves): boolean {
  return CURVE_CHANNELS.every((ch) => {
    const pa = a[ch];
    const pb = b[ch];
    if (pa.length !== pb.length) return false;
    return pa.every((p, i) => Math.abs(p.x - pb[i].x) < 1e-6 && Math.abs(p.y - pb[i].y) < 1e-6);
  });
}

export function paramsEqual(a: EditParams, b: EditParams): boolean {
  return (
    diffParams(a, b).length === 0 &&
    curvesEqual(a.curves, b.curves) &&
    masksEqual(a.masks, b.masks)
  );
}
