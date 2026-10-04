/**
 * Anbindung an Claude.
 *
 * Grenze zur Bildverarbeitung (§3, §31 des Briefings): Diese Datei kennt keine
 * Pixel. Sie sendet Messwerte und ein Ansichtsbild, sie empfängt Zahlen. Es
 * gibt hier keinen Rückgabewert, der ein Bild sein könnte — generative
 * Bildbearbeitung ist damit nicht verboten, sondern schlicht nicht vorgesehen.
 *
 * Jede Modellantwort läuft anschließend durch `sanitizeValuePatch` (§32).
 * Ein Wert von 999999 für die Belichtung wird dort auf +5 EV begrenzt und
 * protokolliert; die Anwendung kann durch eine fehlerhafte Antwort weder
 * abstürzen noch in einen ungültigen Zustand geraten.
 */

import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import {
  MAX_MASKS,
  PARAM_BY_ID,
  applyValuePatch,
  isLocalParam,
  sanitizeMask,
  sanitizeValuePatch,
  type AiEditResult,
  type AiStatus,
  type ChatTurn,
  type CoachReport,
  type EditParams,
  type ImageStats,
  type LocalMask,
  type PhotoMeta,
  type Preset,
  type SceneAnalysis,
} from '@photomaster/shared';
import { config } from '../config.ts';
import { diagnoseEnvFile } from '../envcheck.ts';
import { AppError } from '../errors.ts';
import {
  COACH_SYSTEM_PROMPT,
  EDIT_SYSTEM_PROMPT,
  SCENE_SYSTEM_PROMPT,
  buildCurrentParamsBlock,
  buildStatsBlock,
} from './prompts.ts';
import { COACH_RESPONSE_SCHEMA, EDIT_RESPONSE_SCHEMA, SCENE_RESPONSE_SCHEMA } from './schema.ts';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!config.ai.apiKey) {
    throw new AppError(
      'AI_UNAVAILABLE',
      'Die KI-Bearbeitung ist nicht eingerichtet. Deine bisherigen Bearbeitungen bleiben erhalten.',
      'ANTHROPIC_API_KEY ist nicht gesetzt.',
    );
  }
  client ??= new Anthropic({
    apiKey: config.ai.apiKey,
    baseURL: config.ai.baseUrl ?? undefined,
    timeout: config.ai.timeoutMs,
    /**
     * Ein Bearbeitungsvorschlag ist interaktiv — der Nutzer sitzt davor und
     * wartet. Die Voreinstellung von zwei stillen Wiederholungen mit Backoff
     * kann daraus eine halbe Minute ohne jede Rückmeldung machen. Einmal
     * nachfassen deckt den typischen kurzen Überlastungsfall ab; danach ist
     * eine ehrliche Meldung besser als weiteres Warten.
     */
    maxRetries: 1,
  });
  return client;
}

export function aiStatus(): AiStatus {
  if (!config.ai.apiKey) {
    return {
      available: false,
      model: null,
      // Liegt eine .env vor, aus der der Schlüssel nicht angekommen ist, sagt
      // die Meldung, woran es liegt — statt in jedem Fall dasselbe.
      reason:
        diagnoseEnvFile(config.rootDir) ??
        'Kein API-Schlüssel hinterlegt. Trage ANTHROPIC_API_KEY in die Datei .env ein, um die KI-Funktionen zu nutzen. Die manuelle Bearbeitung und der Export funktionieren auch ohne.',
    };
  }
  return { available: true, model: config.ai.model, reason: null };
}

type JsonSchema = Record<string, unknown>;

/**
 * Modelle, die eine abgelehnte Anfrage serverseitig auf einem Ausweichmodell
 * wiederholen können. Bei jedem anderen per PM_AI_MODEL gewählten Modell
 * fehlt der Parameter, statt die Anfrage mit einem 400 scheitern zu lassen.
 */
const FALLBACK_CAPABLE_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-sonnet-5-5',
]);

/**
 * Ein Aufruf mit erzwungenem Antwortformat.
 *
 * `output_config.format` bindet die Antwort an das Schema — das Modell kann
 * keinen Fließtext und keinen Parameternamen zurückgeben, den es nicht gibt.
 * Das ersetzt das fehleranfällige "Antworte nur mit JSON" im Prompt.
 *
 * **Gestreamt, auch wenn niemand mitliest.** Ohne Streaming schickt die API
 * die Kopfzeilen erst, wenn die ganze Antwort fertig ist; eine Zeitgrenze
 * misst dann die gesamte Rechenzeit — und schneidet eine lange, legitime
 * Antwort mit ausführlichem Nachdenken ab. Mit Streaming beginnt die Antwort
 * sofort, die Zeitgrenze erfasst nur noch eine Gegenstelle, die gar nicht
 * antwortet, und `finalMessage()` setzt das Ergebnis wieder zusammen.
 *
 * **Ausweichmodell bei Ablehnung.** Die Sicherheitsfilter können auch eine
 * harmlose Anfrage ablehnen. `fallbacks: "default"` wiederholt sie dann
 * serverseitig auf dem dafür empfohlenen Modell, statt dem Nutzer eine
 * Absage zu zeigen. Zurückgegeben wird deshalb auch, welches Modell
 * tatsächlich geantwortet hat.
 */
async function callStructured<T>(options: {
  system: string;
  content: Anthropic.ContentBlockParam[];
  history?: ChatTurn[];
  schema: JsonSchema;
  effort: 'low' | 'medium' | 'high';
}): Promise<{ data: T; model: string }> {
  const anthropic = getClient();

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of options.history ?? []) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: options.content });

  const fallback = FALLBACK_CAPABLE_MODELS.has(config.ai.model)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
    : {};

  let response: Anthropic.Beta.BetaMessage;
  try {
    const stream = anthropic.beta.messages.stream({
      model: config.ai.model,
      max_tokens: config.ai.maxTokens,
      // Der System-Prompt ist lang und ändert sich nie — zwischenspeichern
      // spart bei jeder weiteren Anfrage den Großteil der Eingabekosten.
      system: [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: options.effort,
        format: { type: 'json_schema', schema: options.schema },
      },
      messages,
      ...fallback,
    });
    response = await stream.finalMessage();
  } catch (err) {
    throw translateAnthropicError(err);
  }

  if (response.stop_reason === 'refusal') {
    throw new AppError(
      'AI_FAILED',
      'Die KI hat diese Anfrage abgelehnt. Formuliere den Wunsch anders oder bearbeite das Foto manuell weiter.',
      `stop_reason=refusal, category=${response.stop_details?.category ?? 'unbekannt'}`,
    );
  }

  // Der LETZTE Textblock ist die Antwort. Nach einem Wechsel auf ein
  // Ausweichmodell steht davor ein `fallback`-Block — und wer den ersten
  // Textblock nimmt, liest unter Umständen die abgebrochene Antwort des
  // ablehnenden Modells.
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .at(-1)?.text;
  if (!text) {
    throw new AppError(
      'AI_FAILED',
      'Die KI hat keine verwertbare Antwort geliefert. Versuche es bitte erneut.',
      `stop_reason=${response.stop_reason}`,
    );
  }

  try {
    return { data: JSON.parse(text) as T, model: response.model };
  } catch {
    throw new AppError(
      'AI_FAILED',
      'Die Antwort der KI war unvollständig. Versuche es bitte erneut.',
      `Antwort war kein gültiges JSON (${text.length} Zeichen, stop_reason=${response.stop_reason}).`,
    );
  }
}

function translateAnthropicError(err: unknown): AppError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new AppError(
      'AI_UNAVAILABLE',
      'Der hinterlegte API-Schlüssel wurde nicht akzeptiert. Bitte prüfe den Eintrag in der Datei .env.',
      err.message,
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError(
      'AI_UNAVAILABLE',
      'Zu viele Anfragen in kurzer Zeit. Warte einen Moment und versuche es erneut — deine Bearbeitung bleibt erhalten.',
      err.message,
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError(
      'AI_UNAVAILABLE',
      'Die KI ist momentan nicht erreichbar. Deine bisherigen Bearbeitungen bleiben erhalten.',
      err.message,
    );
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError(
      'AI_FAILED',
      'Die KI-Bearbeitung ist fehlgeschlagen. Deine bisherigen Bearbeitungen bleiben erhalten.',
      `${err.status}: ${err.message}`,
    );
  }
  return new AppError(
    'AI_FAILED',
    'Die KI-Bearbeitung ist fehlgeschlagen. Deine bisherigen Bearbeitungen bleiben erhalten.',
    err instanceof Error ? err.message : String(err),
  );
}

async function imageBlock(path: string): Promise<Anthropic.ContentBlockParam> {
  const data = await readFile(path);
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') },
  };
}

// ── Antwortfelder auslesen (§32) ───────────────────────────────────────────

/*
 * Das Antwortschema legt die Form fest, aber die Antwort bleibt eine Eingabe
 * von außen: Wird sie abgeschnitten oder weicht ein Modell ab, darf ein Feld,
 * das ein Array sein sollte und keines ist, nicht zu einem TypeError führen.
 */

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Die Zeichenketten eines Arrays, höchstens `max` — alles andere fällt weg. */
const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];

// ── Szenenanalyse (§8) ─────────────────────────────────────────────────────

export async function analyzeScene(
  analysisImagePath: string,
  stats: ImageStats,
  photo: PhotoMeta,
): Promise<SceneAnalysis> {
  const { data: result } = await callStructured<Partial<Record<keyof SceneAnalysis, unknown>>>({
    system: SCENE_SYSTEM_PROMPT,
    content: [
      await imageBlock(analysisImagePath),
      { type: 'text', text: buildStatsBlock(stats, photo) },
      { type: 'text', text: 'Analysiere dieses Foto.' },
    ],
    schema: SCENE_RESPONSE_SCHEMA as unknown as JsonSchema,
    effort: 'low',
  });

  return {
    subject: asText(result.subject).slice(0, 200),
    categories: strings(result.categories, 8).map((c) => c.slice(0, 60)),
    lighting: asText(result.lighting),
    timeOfDay: asText(result.timeOfDay),
    mood: asText(result.mood),
    composition: asText(result.composition),
    observations: strings(result.observations, 6),
  };
}

// ── Bearbeitungsvorschlag (§9, §14, §15, §27) ──────────────────────────────

export type EditIntent =
  | { kind: 'auto' }
  | { kind: 'vibe'; text: string }
  | { kind: 'preset'; preset: Preset };

export interface EditRequest {
  photo: PhotoMeta;
  stats: ImageStats;
  scene: SceneAnalysis | null;
  currentParams: EditParams;
  intent: EditIntent;
  history: ChatTurn[];
  analysisImagePath: string;
}

export interface RawEditResponse {
  summary?: unknown;
  adjustments?: { parameter?: unknown; value?: unknown; reason?: unknown }[];
  masks?: RawMask[];
}

interface RawMask {
  id?: unknown;
  name?: unknown;
  adjustments?: { parameter?: unknown; value?: unknown; reason?: unknown }[];
  [key: string]: unknown;
}

/**
 * Führt die von der KI beschriebenen Masken mit den vorhandenen zusammen (§28).
 *
 * Zusammenführen statt Ersetzen, und niemals Löschen — das ist eine bewusste
 * Entscheidung zugunsten der Arbeit des Nutzers: Wer eine Maske von Hand auf
 * ein Motiv geschoben hat, soll sie nicht verlieren, weil er danach "etwas
 * wärmer" in das Textfeld tippt. Nennt das Modell die Kennung einer
 * bestehenden Maske, wird diese geändert; nennt es keine, kommt eine neue
 * hinzu. Was es gar nicht erwähnt, bleibt unangetastet.
 */
function mergeMasks(
  current: LocalMask[],
  incoming: RawMask[] | undefined,
): { masks: LocalMask[]; reasons: { param: string; text: string; mask: string }[]; issues: string[] } {
  const masks = current.map((m) => ({ ...m }));
  const reasons: { param: string; text: string; mask: string }[] = [];
  const issues: string[] = [];

  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (typeof raw !== 'object' || raw === null) continue;

    const id = typeof raw.id === 'string' ? raw.id : '';
    const index = id ? masks.findIndex((m) => m.id === id) : -1;
    const existing = index >= 0 ? masks[index] : null;

    if (!existing && masks.length >= MAX_MASKS) {
      issues.push(`Die Maske "${String(raw.name ?? 'ohne Namen')}" wurde verworfen — mehr als ${MAX_MASKS} Masken sind nicht möglich.`);
      continue;
    }

    // Die Anpassungsliste des Modells in das Wertobjekt der Maske übersetzen.
    const values: Record<string, unknown> = { ...(existing?.values ?? {}) };
    const pending: { param: string; text: string }[] = [];

    for (const adj of Array.isArray(raw.adjustments) ? raw.adjustments : []) {
      const param = typeof adj?.parameter === 'string' ? adj.parameter : '';
      if (!isLocalParam(param)) {
        issues.push(`Parameter "${param}" ist lokal nicht verfügbar und wurde verworfen.`);
        continue;
      }
      values[param] = adj.value;
      if (typeof adj.reason === 'string' && adj.reason.trim()) {
        pending.push({ param, text: adj.reason.trim() });
      }
    }

    // Bestehende Geometrie als Grundlage, damit ein Modell, das nur die
    // Anpassungen ändern will, die Maske nicht versehentlich verschiebt.
    const merged: Record<string, unknown> = { ...(existing ?? {}), ...raw, values };
    delete merged.adjustments;

    // Eine Pinselmaske behält Typ und Striche, egal was das Modell schickt.
    // Es kennt den Typ "brush" gar nicht und würde jede Maske, die es über
    // ihre Kennung anspricht, zu einem Verlauf machen — die gemalten Striche
    // wären damit weg. Die ANPASSUNGEN darf es sehr wohl ändern; genau dafür
    // sagt der Prompt, dass gemalte Bereiche existieren.
    if (existing?.type === 'brush') {
      merged.type = 'brush';
      merged.strokes = existing.strokes;
    }

    const result = sanitizeMask(merged, index >= 0 ? index : masks.length);
    issues.push(...result.issues);

    // Die Kennung einer bestehenden Maske muss erhalten bleiben, sonst gilt
    // sie beim nächsten Durchgang als neu.
    if (existing) result.value.id = existing.id;

    for (const r of pending) reasons.push({ ...r, mask: result.value.name });

    if (index >= 0) masks[index] = result.value;
    else masks.push(result.value);
  }

  return { masks, reasons, issues };
}

export async function proposeEdit(req: EditRequest): Promise<AiEditResult> {
  const instruction = buildInstruction(req);

  const content: Anthropic.ContentBlockParam[] = [
    await imageBlock(req.analysisImagePath),
    { type: 'text', text: buildStatsBlock(req.stats, req.photo) },
  ];

  if (req.scene) {
    content.push({
      type: 'text',
      text: `# Bildinhalt\nMotiv: ${req.scene.subject}\nLicht: ${req.scene.lighting}\nStimmung: ${req.scene.mood}\nAufbau: ${req.scene.composition}`,
    });
  }

  content.push({ type: 'text', text: buildCurrentParamsBlock(req.currentParams) });
  content.push({ type: 'text', text: instruction });

  const { data: raw, model } = await callStructured<RawEditResponse>({
    system: EDIT_SYSTEM_PROMPT,
    content,
    history: req.history,
    schema: EDIT_RESPONSE_SCHEMA as unknown as JsonSchema,
    effort: 'high',
  });

  return normalizeEditResponse(raw, req.currentParams, model);
}

/**
 * Macht aus einer Modellantwort einen gültigen Bearbeitungszustand (§32).
 *
 * Ab hier gilt die Antwort als UNVERTRAUENSWÜRDIGE EINGABE — nicht weil das
 * Modell böswillig wäre, sondern weil ein einziger Ausreißer sonst direkt auf
 * einem Regler landen würde. Die Funktion ist bewusst vom Netzwerkaufruf
 * getrennt, damit sie ohne API-Schlüssel testbar bleibt.
 */
export function normalizeEditResponse(
  raw: RawEditResponse,
  currentParams: EditParams,
  model: string,
): AiEditResult {
  // Die Werte werden hier NICHT selbst in Zahlen umgewandelt, sondern
  // unverändert an `sanitizeValuePatch` weitergereicht. Eine eigene Umwandlung
  // wäre eine zweite, leicht abweichende Kopie derselben Regeln — und genau
  // dort entstehen Lücken: `Number(null)` ist 0, `Number([])` ebenfalls. Ein
  // `null` würde so als "Regler auf 0" durchgehen, statt aufzufallen.
  const patch: Record<string, unknown> = {};
  const reasons: { param: string; text: string }[] = [];
  const issues: string[] = [];

  for (const adj of Array.isArray(raw.adjustments) ? raw.adjustments : []) {
    const id = typeof adj.parameter === 'string' ? adj.parameter : '';
    if (!PARAM_BY_ID.has(id)) {
      issues.push(`Unbekannter Parameter "${id}" verworfen.`);
      continue;
    }
    patch[id] = adj.value;
    if (typeof adj.reason === 'string' && adj.reason.trim()) {
      reasons.push({ param: id, text: adj.reason.trim() });
    }
  }

  const sanitized = sanitizeValuePatch(patch);
  issues.push(...sanitized.issues);

  // Begründungen zu Parametern, die die Validierung verworfen hat, entfernen —
  // sonst erklärt die UI eine Änderung, die gar nicht stattgefunden hat.
  const applied = new Set(Object.keys(sanitized.value));

  const masks = mergeMasks(currentParams.masks, raw.masks);
  issues.push(...masks.issues);

  const next = applyValuePatch(currentParams, sanitized.value);
  next.masks = masks.masks;

  return {
    params: next,
    rationale: {
      summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
      reasons: [...reasons.filter((r) => applied.has(r.param)), ...masks.reasons],
    },
    issues,
    model,
  };
}

function buildInstruction(req: EditRequest): string {
  switch (req.intent.kind) {
    case 'auto':
      return `# Auftrag
Erstelle eine professionelle, natürliche Grundbearbeitung für dieses Foto — so, wie ein Fotograf sie nach dem Import anlegen würde, bevor er über einen Stil nachdenkt.

Ziel ist eine korrekte, saubere Umsetzung des Motivs: richtige Belichtung, offene aber nicht flaue Schatten, Lichter mit Zeichnung, glaubwürdige Farben, angemessene Schärfe. KEIN Effekt, kein erkennbarer Stil, keine Vignette, kein Korn, kein Color Grading — es sei denn, das Bild braucht es technisch.

Halte dich bei allem zurück, was am Bild bereits stimmt.`;

    case 'vibe':
      return `# Auftrag
Der Nutzer möchte diesen Look:

"${req.intent.text}"

Übersetze das in Reglerwerte für DIESES Foto. Berücksichtige dabei den gemessenen Ist-Zustand: Was der Look verlangt und was das Bild schon mitbringt, kann sich decken oder widersprechen. Wenn das Bild bereits kühl ist und "kalt" gewünscht wird, brauchst du die Temperatur kaum zu senken.

Falls bereits eine Bearbeitung besteht, verändere sie in die gewünschte Richtung, statt sie zu ersetzen.`;

    case 'preset': {
      const p = req.intent.preset;
      const values = Object.entries(p.values)
        .map(([k, v]) => `${k} = ${v}`)
        .join(', ');
      return `# Auftrag
Wende das Preset "${p.name}" an — aber angepasst an dieses konkrete Foto.

Charakter des Looks: ${p.vibe}

Ausgangswerte des Presets: ${values}

Diese Werte sind ein STARTPUNKT, kein Ergebnis. Verschiebe sie dorthin, wo sie für dieses Bild richtig sind: Ein Preset mit \`highlights: -35\` ist für einen ausgebrannten Himmel gedacht — ist der Himmel hier unauffällig, nimm weniger. Ist das Bild ohnehin schon dunkel, übernimm die Belichtungsabsenkung nicht unbesehen.

Gib die angepassten Werte für alle Parameter zurück, die zu diesem Look gehören — auch die, die du unverändert vom Preset übernimmst.`;
    }
  }
}

// ── Photo Coach (§17) ──────────────────────────────────────────────────────

interface RawCoachResponse {
  overall?: unknown;
  ratings?: { label?: unknown; score?: unknown; comment?: unknown }[];
  tips?: unknown[];
}

export async function coachReport(
  analysisImagePath: string,
  stats: ImageStats,
  photo: PhotoMeta,
  scene: SceneAnalysis | null,
): Promise<CoachReport> {
  const content: Anthropic.ContentBlockParam[] = [
    await imageBlock(analysisImagePath),
    { type: 'text', text: buildStatsBlock(stats, photo) },
  ];

  if (scene) {
    content.push({
      type: 'text',
      text: `# Bildinhalt\nMotiv: ${scene.subject}\nLicht: ${scene.lighting}\nAufbau: ${scene.composition}`,
    });
  }

  content.push({
    type: 'text',
    text: 'Beurteile diese AUFNAHME und gib Hinweise für das nächste Mal.',
  });

  const { data: raw } = await callStructured<RawCoachResponse>({
    system: COACH_SYSTEM_PROMPT,
    content,
    schema: COACH_RESPONSE_SCHEMA as unknown as JsonSchema,
    effort: 'medium',
  });

  return {
    overall: asText(raw.overall),
    ratings: (Array.isArray(raw.ratings) ? raw.ratings : [])
      .filter((r) => typeof r === 'object' && r !== null && typeof r.label === 'string')
      .map((r) => ({
        label: String(r.label),
        score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
        comment: typeof r.comment === 'string' ? r.comment : '',
      }))
      .slice(0, 6),
    tips: strings(raw.tips, 5),
    createdAt: new Date().toISOString(),
  };
}
