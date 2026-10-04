/**
 * Zustand des Editors: Parameter, Verlauf, Speichern.
 *
 * Der Verlauf (§18) verlangt eine Unterscheidung, die nicht offensichtlich ist:
 * Das Ziehen an einem Regler erzeugt Dutzende Werteänderungen pro Sekunde, ist
 * für den Nutzer aber EIN Schritt. Deshalb gibt es zwei Wege, Werte zu setzen:
 *
 *   - `setValue`  ändert nur den aktuellen Stand (während des Ziehens)
 *   - `beginInteraction` / `endInteraction` klammern die Geste und legen
 *     genau einen Verlaufseintrag an
 *
 * Alles, was in einem Rutsch passiert (Preset, KI-Ergebnis, Zurücksetzen),
 * geht über `applyParams` und ist damit ebenfalls ein einzelner Schritt.
 */

import { create } from 'zustand';
import {
  DEFAULT_BRUSH,
  MASK_TYPE_LABELS,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_MASK,
  cloneMask,
  cloneParams,
  createDefaultParams,
  createMask,
  defaultCurve,
  makeMaskId,
  MAX_MASKS,
  paramsEqual,
  snapParam,
  type BrushPoint,
  type BrushStroke,
  type CurveChannel,
  type CurvePoint,
  type EditParams,
  type LocalMask,
  type MaskType,
  type ParamGroup,
  type Project,
  paramsInGroup,
  PARAM_BY_ID,
} from '@photomaster/shared';

/** Obergrenze des Verlaufs. 120 Schritte sind mehr, als je zurückgegangen wird. */
const HISTORY_LIMIT = 120;

interface HistoryEntry {
  params: EditParams;
  label: string;
}

interface EditorState {
  project: Project | null;
  params: EditParams;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Snapshot zu Beginn einer Reglergeste. */
  gestureBase: EditParams | null;
  gestureLabel: string;
  /** Es gibt ungespeicherte Änderungen. */
  dirty: boolean;
  /**
   * Aktuell bearbeitete Maske (§28). Reiner Oberflächenzustand — sie gehört
   * NICHT in die gespeicherten Parameter, sonst stünde in jeder Version, was
   * beim Speichern gerade angeklickt war.
   */
  selectedMaskId: string | null;
  /**
   * Pinseleinstellungen. Sie gehören zum WERKZEUG, nicht zur Maske: Wer die
   * Größe einstellt, erwartet sie beim nächsten Strich wieder — auch in einer
   * anderen Maske. Gespeichert wird beim Strich, was zum Zeitpunkt des Malens
   * eingestellt war.
   */
  brush: { radius: number; hardness: number; opacity: number; erase: boolean };

  loadProject: (project: Project) => void;
  updateProject: (project: Project) => void;
  clear: () => void;

  setValue: (id: string, value: number) => void;
  beginGesture: (label: string) => void;
  endGesture: () => void;

  setValueCommitted: (id: string, value: number) => void;
  applyParams: (params: EditParams, label: string) => void;
  setCurve: (channel: CurveChannel, points: CurvePoint[], commit: boolean) => void;

  resetParam: (id: string) => void;
  resetGroup: (group: ParamGroup) => void;
  resetAll: () => void;

  selectMask: (id: string | null) => void;
  addMask: (type: MaskType) => void;
  removeMask: (id: string) => void;
  duplicateMask: (id: string) => void;
  /** Ohne Verlaufseintrag — für laufende Gesten (Ziehen am Bild, Regler). */
  updateMask: (id: string, patch: Partial<LocalMask>) => void;
  /** Mit Verlaufseintrag — für einzelne Klicks (umkehren, ein/aus, umbenennen). */
  updateMaskCommitted: (id: string, patch: Partial<LocalMask>, label: string) => void;
  setMaskValue: (id: string, paramId: string, value: number) => void;

  setBrush: (patch: Partial<EditorState['brush']>) => void;
  /** Beginnt einen neuen Strich mit den aktuellen Pinseleinstellungen. */
  beginStroke: (maskId: string, point: BrushPoint, erase: boolean) => void;
  /** Hängt einen Punkt an den laufenden Strich an. */
  extendStroke: (maskId: string, point: BrushPoint) => void;
  clearStrokes: (maskId: string) => void;

  undo: () => void;
  redo: () => void;
  /**
   * Meldet den Stand als gespeichert.
   *
   * Mit `saved` gilt das nur, wenn seitdem nichts mehr geändert wurde. Das
   * braucht jeder Aufrufer, der zwischen Absenden und Antwort wartet: Ein
   * Regler, der während der laufenden Anfrage bewegt wurde, wäre sonst als
   * gespeichert markiert — sein Wert käme nie beim Server an, und beim
   * Schließen gäbe es nicht einmal eine Warnung.
   */
  markSaved: (saved?: EditParams) => void;
}

/** Ersetzt eine Maske in der Liste, ohne die übrigen anzufassen. */
function replaceMask(
  masks: LocalMask[],
  id: string,
  change: (mask: LocalMask) => LocalMask,
): LocalMask[] {
  return masks.map((m) => (m.id === id ? change(m) : m));
}

function pushHistory(state: EditorState, snapshot: EditParams, label: string): Partial<EditorState> {
  const past = [...state.past, { params: snapshot, label }];
  if (past.length > HISTORY_LIMIT) past.shift();
  // Ein neuer Schritt verwirft den Vorwärts-Zweig — wie in jedem Editor.
  return { past, future: [] };
}

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  params: createDefaultParams(),
  past: [],
  future: [],
  gestureBase: null,
  gestureLabel: '',
  dirty: false,
  selectedMaskId: null,
  brush: { ...DEFAULT_BRUSH, erase: false },

  loadProject: (project) =>
    set({
      project,
      params: cloneParams(project.params),
      past: [],
      future: [],
      gestureBase: null,
      dirty: false,
      selectedMaskId: null,
    }),

  /** Projektdaten aktualisieren, ohne den Bearbeitungsstand anzufassen. */
  updateProject: (project) => set({ project }),

  clear: () =>
    set({
      project: null,
      params: createDefaultParams(),
      past: [],
      future: [],
      dirty: false,
      selectedMaskId: null,
    }),

  setValue: (id, value) => {
    const def = PARAM_BY_ID.get(id);
    if (!def) return;
    const next = snapParam(id, value);
    const state = get();
    if (state.params.values[id] === next) return;
    set({
      params: { ...state.params, values: { ...state.params.values, [id]: next } },
      dirty: true,
    });
  },

  beginGesture: (label) => set({ gestureBase: cloneParams(get().params), gestureLabel: label }),

  endGesture: () => {
    const state = get();
    if (!state.gestureBase) return;
    // Hat die Geste am Ende nichts verändert (Klick ohne Bewegung, oder hin
    // und wieder zurück), entsteht kein Verlaufseintrag.
    if (paramsEqual(state.gestureBase, state.params)) {
      set({ gestureBase: null });
      return;
    }
    set({ ...pushHistory(state, state.gestureBase, state.gestureLabel), gestureBase: null });
  },

  setValueCommitted: (id, value) => {
    const state = get();
    const def = PARAM_BY_ID.get(id);
    if (!def) return;
    const next = snapParam(id, value);
    if (state.params.values[id] === next) return;
    const snapshot = cloneParams(state.params);
    set({
      ...pushHistory(state, snapshot, def.label),
      params: { ...state.params, values: { ...state.params.values, [id]: next } },
      dirty: true,
    });
  },

  applyParams: (params, label) => {
    const state = get();
    if (paramsEqual(state.params, params)) return;
    set({
      ...pushHistory(state, cloneParams(state.params), label),
      params: cloneParams(params),
      dirty: true,
    });
  },

  setCurve: (channel, points, commit) => {
    const state = get();
    const next: EditParams = {
      ...state.params,
      curves: { ...state.params.curves, [channel]: points.map((p) => ({ ...p })) },
    };
    if (commit) {
      set({
        ...pushHistory(state, cloneParams(state.params), 'Gradationskurve'),
        params: next,
        dirty: true,
      });
    } else {
      set({ params: next, dirty: true });
    }
  },

  resetParam: (id) => {
    const def = PARAM_BY_ID.get(id);
    if (!def) return;
    get().setValueCommitted(id, def.default);
  },

  resetGroup: (group) => {
    const state = get();
    const values = { ...state.params.values };
    for (const p of paramsInGroup(group)) values[p.id] = p.default;

    const next: EditParams = { ...state.params, values };
    // Die Kurven gehören zur Gruppe "Licht" und werden mit zurückgesetzt.
    if (group === 'basic') {
      next.curves = { rgb: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve() };
    }
    get().applyParams(next, `${group} zurückgesetzt`);
  },

  resetAll: () => get().applyParams(createDefaultParams(), 'Alles zurückgesetzt'),

  // ── Lokale Masken (§28) ──────────────────────────────────────────────────

  selectMask: (id) => set({ selectedMaskId: id }),

  addMask: (type) => {
    const state = get();
    if (state.params.masks.length >= MAX_MASKS) return;

    const label = MASK_TYPE_LABELS[type];
    // Fortlaufend nummeriert nach Typ, damit zwei Verläufe nicht beide
    // "Maske 2" heißen, nur weil dazwischen eine Ellipse gelöscht wurde.
    const sameType = state.params.masks.filter((m) => m.type === type).length;
    const mask = createMask(type, makeMaskId(), `${label} ${sameType + 1}`);

    set({
      ...pushHistory(state, cloneParams(state.params), `${label} hinzugefügt`),
      params: { ...state.params, masks: [...state.params.masks, mask] },
      selectedMaskId: mask.id,
      dirty: true,
    });
  },

  removeMask: (id) => {
    const state = get();
    const mask = state.params.masks.find((m) => m.id === id);
    if (!mask) return;
    set({
      ...pushHistory(state, cloneParams(state.params), `${mask.name} gelöscht`),
      params: { ...state.params, masks: state.params.masks.filter((m) => m.id !== id) },
      selectedMaskId: state.selectedMaskId === id ? null : state.selectedMaskId,
      dirty: true,
    });
  },

  duplicateMask: (id) => {
    const state = get();
    const mask = state.params.masks.find((m) => m.id === id);
    if (!mask || state.params.masks.length >= MAX_MASKS) return;

    const copy = cloneMask(mask);
    copy.id = makeMaskId();
    copy.name = `${mask.name} (Kopie)`;
    // Leicht versetzt einfügen, sonst liegt die Kopie exakt unter dem Original
    // und man hält sie für einen ausgebliebenen Klick.
    if (copy.type === 'radial') {
      copy.centerX = Math.min(1, copy.centerX + 0.05);
      copy.centerY = Math.min(1, copy.centerY + 0.05);
    } else {
      copy.position = Math.min(1, copy.position + 0.05);
    }

    const index = state.params.masks.findIndex((m) => m.id === id);
    const masks = [...state.params.masks];
    masks.splice(index + 1, 0, copy);

    set({
      ...pushHistory(state, cloneParams(state.params), `${mask.name} dupliziert`),
      params: { ...state.params, masks },
      selectedMaskId: copy.id,
      dirty: true,
    });
  },

  updateMask: (id, patch) => {
    const state = get();
    set({
      params: {
        ...state.params,
        masks: replaceMask(state.params.masks, id, (m) => ({ ...m, ...patch })),
      },
      dirty: true,
    });
  },

  updateMaskCommitted: (id, patch, label) => {
    const state = get();
    set({
      ...pushHistory(state, cloneParams(state.params), label),
      params: {
        ...state.params,
        masks: replaceMask(state.params.masks, id, (m) => ({ ...m, ...patch })),
      },
      dirty: true,
    });
  },

  setMaskValue: (id, paramId, value) => {
    const def = PARAM_BY_ID.get(paramId);
    if (!def) return;
    const next = snapParam(paramId, value);
    const state = get();

    const mask = state.params.masks.find((m) => m.id === id);
    if (!mask || mask.values[paramId] === next) return;

    set({
      params: {
        ...state.params,
        masks: replaceMask(state.params.masks, id, (m) => ({
          ...m,
          values: { ...m.values, [paramId]: next },
        })),
      },
      dirty: true,
    });
  },

  setBrush: (patch) => set({ brush: { ...get().brush, ...patch } }),

  beginStroke: (maskId, point, erase) => {
    const state = get();
    const mask = state.params.masks.find((m) => m.id === maskId);
    if (!mask || mask.type !== 'brush') return;
    if (mask.strokes.length >= MAX_STROKES_PER_MASK) return;

    const stroke: BrushStroke = {
      points: [point],
      radius: state.brush.radius,
      hardness: state.brush.hardness,
      opacity: state.brush.opacity,
      erase,
    };

    set({
      params: {
        ...state.params,
        masks: replaceMask(state.params.masks, maskId, (m) => ({
          ...m,
          strokes: [...m.strokes, stroke],
        })),
      },
      dirty: true,
    });
  },

  extendStroke: (maskId, point) => {
    const state = get();
    const mask = state.params.masks.find((m) => m.id === maskId);
    if (!mask || mask.strokes.length === 0) return;

    const last = mask.strokes[mask.strokes.length - 1];
    if (last.points.length >= MAX_POINTS_PER_STROKE) return;

    set({
      params: {
        ...state.params,
        masks: replaceMask(state.params.masks, maskId, (m) => {
          const strokes = m.strokes.slice();
          const current = strokes[strokes.length - 1];
          strokes[strokes.length - 1] = { ...current, points: [...current.points, point] };
          return { ...m, strokes };
        }),
      },
      dirty: true,
    });
  },

  clearStrokes: (maskId) => {
    const state = get();
    const mask = state.params.masks.find((m) => m.id === maskId);
    if (!mask || mask.strokes.length === 0) return;
    set({
      ...pushHistory(state, cloneParams(state.params), `${mask.name} geleert`),
      params: {
        ...state.params,
        masks: replaceMask(state.params.masks, maskId, (m) => ({ ...m, strokes: [] })),
      },
      dirty: true,
    });
  },

  undo: () => {
    const state = get();
    const previous = state.past[state.past.length - 1];
    if (!previous) return;
    set({
      past: state.past.slice(0, -1),
      future: [{ params: cloneParams(state.params), label: previous.label }, ...state.future],
      params: previous.params,
      dirty: true,
    });
  },

  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) return;
    set({
      past: [...state.past, { params: cloneParams(state.params), label: next.label }],
      future: state.future.slice(1),
      params: next.params,
      dirty: true,
    });
  },

  // Jede Änderung erzeugt ein neues `params`-Objekt (der Zustand wird nie an
  // Ort und Stelle verändert). Ist es noch dasselbe Objekt, das gespeichert
  // wurde, hat sich seitdem nichts getan.
  markSaved: (saved) => {
    if (saved && get().params !== saved) return;
    set({ dirty: false });
  },
}));

/** Beschriftung für die Rückgängig-Schaltfläche. */
export function undoLabel(state: EditorState): string | null {
  return state.past[state.past.length - 1]?.label ?? null;
}

export function redoLabel(state: EditorState): string | null {
  return state.future[0]?.label ?? null;
}
