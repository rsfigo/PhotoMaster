/**
 * Der Netzwerkweg zur KI (§29, §32).
 *
 * `ai.test.ts` prüft, was NACH der Antwort passiert. Hier geht es um alles
 * davor und darum herum: Wird die Anfrage so gestellt, wie sie gemeint ist?
 * Wird eine echte Antwort richtig ausgepackt? Und — praktisch am wichtigsten —
 * bekommt der Nutzer bei jedem Fehlschlag einen Satz, mit dem er etwas
 * anfangen kann, statt eines Statuscodes?
 *
 * Statt den SDK-Client durch eine Attrappe zu ersetzen, läuft hier ein echter
 * HTTP-Server auf localhost, und die App spricht über `ANTHROPIC_BASE_URL` mit
 * ihm. Dadurch ist alles echt außer dem Modell selbst: die Serialisierung der
 * Anfrage, die HTTP-Schicht, das Auspacken der Antwort und die Fehlerklassen
 * des SDK. Ohne diesen Weg wäre der gesamte Aufruf ungetestet — und die
 * Fehlerbehandlung ausgerechnet dort, wo sie am sichtbarsten ist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

const dataDir = await mkdtemp(join(tmpdir(), 'pm-aitransport-'));
process.env.PM_DATA_DIR = dataDir;

// ── Gegenstelle ────────────────────────────────────────────────────────────

interface Recorded {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, any>;
}

let recorded: Recorded[] = [];
let respond: (res: ServerResponse, call: number) => void = () => {};

const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    recorded.push({
      path: req.url ?? '',
      headers: req.headers,
      body: text ? JSON.parse(text) : {},
    });
    respond(res, recorded.length - 1);
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

process.env.ANTHROPIC_API_KEY = 'sk-ant-test-schluessel';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
delete process.env.PM_AI_MODEL;
// Kurz genug, damit der Hänger-Test in Sekunden statt Minuten läuft, und
// weit genug über jeder normalen Antwort hier (Millisekunden).
process.env.PM_AI_TIMEOUT_MS = '1200';

const { analyzeScene, coachReport, proposeEdit, aiStatus } = await import('../src/ai/service.ts');
const { createDefaultParams } = await import('@photomaster/shared');

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Antwort im Format, das die Messages-API liefert — samt Denkblock. */
function messageWith(payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_01Test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: 'Der Himmel clippt bei 4 %.', signature: 'sig' },
      { type: 'text', text: JSON.stringify(payload) },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 180 },
    ...extra,
  };
}

/**
 * Antwortet wie die Messages-API: Fehler als JSON, Nachrichten als Stream.
 *
 * Die App streamt (siehe `callStructured`), also muss die Gegenstelle das
 * auch — sonst prüfte der Test einen Weg, den die App nicht mehr nimmt. Der
 * Text wird absichtlich in zwei Stücken geschickt: Das SDK muss ihn wieder
 * zusammensetzen, genau wie bei einer echten Antwort.
 */
function reply(res: ServerResponse, status: number, body: unknown): void {
  if (status !== 200) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of sseEvents(body as Record<string, any>)) res.write(event);
  res.end();
}

function sseEvents(message: Record<string, any>): string[] {
  const out: string[] = [];
  const send = (type: string, data: Record<string, unknown>) =>
    out.push(`event: ${type}
data: ${JSON.stringify({ type, ...data })}

`);

  send('message_start', {
    message: { ...message, content: [], stop_reason: null, stop_details: null },
  });
  (message.content as Record<string, any>[]).forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      const half = Math.floor(block.text.length / 2);
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text.slice(0, half) } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text.slice(half) } });
    } else if (block.type === 'thinking') {
      send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      send('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
    } else {
      send('content_block_start', { index, content_block: block });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', {
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
      stop_details: message.stop_details ?? null,
    },
    usage: { output_tokens: message.usage?.output_tokens ?? 1 },
  });
  send('message_stop', {});
  return out;
}

function serve(body: unknown, status = 200) {
  respond = (res) => reply(res, status, body);
}

test.beforeEach(() => {
  recorded = [];
  respond = (res) => reply(res, 200, messageWith({}));
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const analysisImagePath = join(dataDir, 'analysis.jpg');
await sharp(Buffer.alloc(64 * 48 * 3, 120), { raw: { width: 64, height: 48, channels: 3 } })
  .jpeg()
  .toFile(analysisImagePath);

const photo = {
  id: 'p1',
  hash: 'h1',
  originalName: 'DSC_4021.JPG',
  format: 'jpeg',
  storageExt: 'jpg',
  mimeType: 'image/jpeg',
  bytes: 11_800_000,
  width: 6000,
  height: 4000,
  megapixels: 24,
  orientation: 1,
  hasExif: true,
  hasIcc: false,
  camera: { make: 'NIKON CORPORATION', model: 'NIKON D3200', iso: 400 },
  source: { kind: 'direct' as const, width: 6000, height: 4000 },
  previewWidth: 2560,
  previewHeight: 1707,
  createdAt: new Date().toISOString(),
};

const stats = {
  histogram: { r: Array(256).fill(0), g: Array(256).fill(0), b: Array(256).fill(0), luma: Array(256).fill(0) },
  meanLuma: 0.42,
  medianLuma: 0.4,
  clippedShadows: 0.004,
  clippedHighlights: 0.041,
  p01: 0.02,
  p05: 0.06,
  p50: 0.4,
  p95: 0.93,
  p99: 0.99,
  contrast: 0.21,
  meanSaturation: 0.18,
  meanR: 0.45,
  meanG: 0.42,
  meanB: 0.38,
  temperatureBias: 0.07,
  tintBias: -0.01,
  sharpness: 0.32,
  noise: 0.012,
  dominantColors: [{ hex: '#8a94a6', share: 0.31 }],
  regionLuma: [0.8, 0.82, 0.79, 0.45, 0.44, 0.43, 0.2, 0.21, 0.19],
};

const editRequest = {
  photo,
  stats,
  scene: null,
  currentParams: createDefaultParams(),
  intent: { kind: 'auto' as const },
  history: [],
  analysisImagePath,
};

// ── Die Anfrage ────────────────────────────────────────────────────────────

test('die Anfrage enthält Bild, Messwerte und das bindende Antwortschema', async () => {
  serve(
    messageWith({
      summary: 'Lichter zurückgenommen.',
      adjustments: [{ parameter: 'highlights', value: -30, reason: 'Der Himmel clippt.' }],
    }),
  );

  await proposeEdit(editRequest);

  assert.equal(recorded.length, 1, 'es ging nicht genau eine Anfrage raus');
  const call = recorded[0];
  assert.match(call.path, /\/v1\/messages/);
  assert.equal(call.headers['x-api-key'], 'sk-ant-test-schluessel');
  assert.equal(call.body.model, 'claude-opus-5-5');

  // Das Antwortformat ist an das Schema gebunden — das ist der Grund, warum
  // das Modell keinen Regler erfinden kann (§3).
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.ok(
    call.body.output_config.format.schema.properties.adjustments.items.properties.parameter.enum.includes(
      'highlights',
    ),
  );

  // Der lange Systemtext wird zwischengespeichert, sonst kostet jede weitere
  // Anfrage im selben Gespräch den vollen Eingabepreis.
  assert.equal(call.body.system[0].cache_control.type, 'ephemeral');

  const blocks = call.body.messages.at(-1).content;
  assert.equal(blocks[0].type, 'image', 'das Ansichtsbild fehlt');
  assert.equal(blocks[0].source.media_type, 'image/jpeg');
  const text = blocks.map((b: any) => b.text ?? '').join('\n');
  assert.match(text, /4[,.]1\s*%|0\.041/, 'die gemessenen Werte fehlen im Prompt');
});

test('ein Folgewunsch nimmt die bisherige Unterhaltung mit', async () => {
  // §27: Die KI soll nicht bei jedem Satz von vorne anfangen.
  serve(messageWith({ summary: 'Etwas heller.', adjustments: [] }));

  await proposeEdit({
    ...editRequest,
    intent: { kind: 'vibe', text: 'Mach es etwas heller.' },
    history: [
      { role: 'user', content: 'Cinematic, dunkel und kalt.' },
      { role: 'assistant', content: 'Belichtung -0.15, Temperatur -5.' },
    ],
  });

  const messages = recorded[0].body.messages;
  assert.equal(messages.length, 3, 'der Verlauf wurde nicht mitgeschickt');
  assert.equal(messages[0].content, 'Cinematic, dunkel und kalt.');
  assert.equal(messages[1].role, 'assistant');
});

test('nur das kleine Ansichtsbild geht raus, nie das Original (§30)', async () => {
  serve(messageWith({ adjustments: [] }));
  await proposeEdit(editRequest);

  const body = JSON.stringify(recorded[0].body);
  // Das Original ist 11,8 MB groß; base64 davon wäre ein Vielfaches dessen,
  // was hier durchgeht.
  assert.ok(body.length < 200_000, `Anfrage ist ${body.length} Bytes groß`);
  assert.doesNotMatch(body, /originals/, 'ein Pfad zur Originaldatei ist mitgegangen');
});

// ── Die Antwort ────────────────────────────────────────────────────────────

test('eine echte Antwort wird aus den Blöcken ausgepackt und angewendet', async () => {
  serve(
    messageWith({
      summary: 'Der Himmel war deutlich zu hell.',
      adjustments: [
        { parameter: 'highlights', value: -35, reason: 'Der Himmel liegt bei 4 % Clipping.' },
        { parameter: 'exposure', value: 0.2, reason: 'Der Vordergrund war zu dunkel.' },
      ],
    }),
  );

  const result = await proposeEdit(editRequest);

  // Der Denkblock steht VOR dem Textblock — wer nur content[0] liest, bekommt
  // Gedanken statt Ergebnis.
  assert.equal(result.params.values.highlights, -35);
  assert.equal(result.params.values.exposure, 0.2);
  assert.equal(result.rationale.summary, 'Der Himmel war deutlich zu hell.');
  assert.equal(result.rationale.reasons.length, 2);
  assert.equal(result.issues.length, 0);
  assert.equal(result.model, 'claude-opus-5-5');
});

test('die Szenenanalyse kommt als saubere Struktur zurück', async () => {
  serve(
    messageWith({
      subject: 'Motorrad vor Bergpanorama',
      categories: ['Motorrad', 'Landschaft', 'Berge'],
      lighting: 'Gegenlicht am späten Nachmittag',
      timeOfDay: 'Goldene Stunde',
      mood: 'ruhig',
      composition: 'Drittelregel, Motiv links',
      observations: ['Der Himmel ist deutlich heller als der Vordergrund.'],
    }),
  );

  const scene = await analyzeScene(analysisImagePath, stats, photo);
  assert.equal(scene.subject, 'Motorrad vor Bergpanorama');
  assert.deepEqual(scene.categories, ['Motorrad', 'Landschaft', 'Berge']);
  assert.equal(scene.observations.length, 1);
});

test('die Coach-Bewertung kommt mit Bewertungen und Tipps zurück', async () => {
  serve(
    messageWith({
      overall: 'Das Foto funktioniert gut.',
      ratings: [
        { label: 'Belichtung', score: 78, comment: 'Der Himmel ist etwas hell.' },
        { label: 'Schärfe', score: 85, comment: 'Sauber getroffen.' },
      ],
      tips: ['Beim nächsten Mal eine Drittelblende knapper belichten.'],
    }),
  );

  const report = await coachReport(analysisImagePath, stats, photo, null);
  assert.equal(report.ratings.length, 2);
  assert.equal(report.ratings[0].score, 78);
  assert.equal(report.tips.length, 1);
  assert.ok(report.createdAt, 'der Zeitstempel fehlt');
});

test('abgeschnittenes JSON stürzt nicht ab, sondern bittet um einen neuen Versuch', async () => {
  respond = (res) =>
    reply(res, 200, {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: '{"adjustments":[{"parameter":"exposu' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 16000 },
    });

  await assert.rejects(() => proposeEdit(editRequest), (err: Error) => {
    assert.match(err.message, /unvollständig/);
    assert.doesNotMatch(err.message, /JSON|parse|token/i, 'technischer Jargon in der Meldung');
    return true;
  });
});

test('eine Antwort ganz ohne Text wird als solche gemeldet', async () => {
  respond = (res) =>
    reply(res, 200, {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: 'Hm.', signature: 'sig' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

  await assert.rejects(() => proposeEdit(editRequest), (err: Error) => {
    assert.match(err.message, /keine verwertbare Antwort/);
    return true;
  });
});

test('eine Ablehnung des Modells wird als Ablehnung erklärt', async () => {
  respond = (res) =>
    reply(res, 200, {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'policy' },
      usage: { input_tokens: 10, output_tokens: 1 },
    });

  await assert.rejects(() => proposeEdit(editRequest), (err: Error) => {
    assert.match(err.message, /abgelehnt/);
    // Und der Weg nach vorne wird genannt.
    assert.match(err.message, /manuell/);
    return true;
  });
});

// ── Fehlerfälle (§29) ──────────────────────────────────────────────────────

test('ein abgelehnter Schlüssel nennt die Datei, in der er steht', async () => {
  serve({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);

  await assert.rejects(() => proposeEdit(editRequest), (err: Error) => {
    assert.match(err.message, /API-Schlüssel/);
    assert.match(err.message, /\.env/);
    return true;
  });
  // 401 ist kein vorübergehender Fehler — ein Wiederholungsversuch wäre sinnlos.
  assert.equal(recorded.length, 1, 'ein aussichtsloser Aufruf wurde wiederholt');
});

test('ein Ratenlimit bittet um einen Moment Geduld und sichert die Arbeit zu', async () => {
  respond = (res) => {
    res.setHeader('retry-after', '0');
    reply(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
  };

  await assert.rejects(() => proposeEdit(editRequest), (err: Error) => {
    assert.match(err.message, /Warte einen Moment|Zu viele Anfragen/);
    assert.match(err.message, /bleib/, 'die Zusicherung zur bisherigen Arbeit fehlt');
    return true;
  });
  // Einmal nachgefasst, dann aufgegeben — nicht endlos im Stillen probiert.
  assert.equal(recorded.length, 2, `es gab ${recorded.length} Versuche`);
});

test('eine Überlastung der Gegenstelle lässt die Bearbeitung unangetastet', async () => {
  serve({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }, 529);

  await assert.rejects(() => proposeEdit(editRequest), (err: Error) => {
    assert.match(err.message, /bisherigen Bearbeitungen bleiben erhalten/);
    assert.doesNotMatch(err.message, /529|overloaded/i);
    return true;
  });
});

test('eine abreißende Verbindung meldet sich als Erreichbarkeitsproblem', async () => {
  // Die Verbindung wird ohne Antwort geschlossen — genau das, was bei einem
  // Netzausfall mitten im Aufruf passiert.
  respond = (res) => res.destroy();

  await assert.rejects(() => proposeEdit(editRequest), (err: Error) => {
    assert.match(err.message, /nicht erreichbar/);
    assert.match(err.message, /bleiben erhalten/);
    return true;
  });
});

test('eine hängende Verbindung läuft in die Zeitgrenze statt ins Unendliche', async () => {
  // Ohne Zeitgrenze bliebe die Oberfläche für immer im Wartezustand. Die
  // Gegenstelle nimmt hier an und antwortet nie — der häufigste Fall bei
  // einem halb offenen Netz.
  respond = () => {};

  await assert.rejects(() => proposeEdit(editRequest), (err: Error) => {
    assert.match(err.message, /nicht erreichbar/);
    return true;
  });
});

test('der Statusbericht und der tatsächliche Aufruf sagen dasselbe', () => {
  // Eine Oberfläche, die „eingerichtet" meldet und dann scheitert, wäre
  // schlimmer als eine, die gleich sagt, dass nichts eingerichtet ist.
  assert.equal(aiStatus().available, true);
  assert.equal(aiStatus().model, 'claude-opus-5-5');
  assert.equal(aiStatus().reason, null);
});

// ── Streaming, Ausweichmodell, Verlauf ─────────────────────────────────────

test('eine lange Antwort wird nicht von der Zeitgrenze abgeschnitten', async () => {
  // Die Zeitgrenze steht hier auf 1,2 s. Die Antwort beginnt sofort, braucht
  // aber 2 s bis zum Ende — wie eine Bearbeitung mit ausführlichem
  // Nachdenken. Ohne Streaming hätte die Grenze die gesamte Rechenzeit
  // gemessen und diese legitime Antwort abgebrochen.
  respond = (res) => {
    const events = sseEvents(
      messageWith({
        summary: 'Nach langem Nachdenken.',
        adjustments: [{ parameter: 'shadows', value: 20, reason: 'Vordergrund zu dunkel.' }],
      }),
    );
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(events[0]);
    setTimeout(() => {
      for (const event of events.slice(1)) res.write(event);
      res.end();
    }, 2000);
  };

  const result = await proposeEdit(editRequest);
  assert.equal(result.params.values.shadows, 20, 'die lange Antwort wurde abgeschnitten');
  assert.equal(recorded.length, 1, 'eine erfolgreiche Antwort wurde wiederholt');
});

test('eine abgelehnte Anfrage darf auf ein Ausweichmodell wechseln', async () => {
  serve(messageWith({ adjustments: [] }));
  await proposeEdit(editRequest);

  const call = recorded[0];
  assert.equal(call.body.stream, true, 'die Anfrage wird nicht gestreamt');
  assert.equal(call.body.fallbacks, 'default');
  assert.match(String(call.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
});

test('nach einem Wechsel zählt die Antwort des Ausweichmodells', async () => {
  // Der fallback-Block markiert den Wechsel. Gelesen wird der LETZTE
  // Textblock, und gemeldet wird das Modell, das wirklich geantwortet hat.
  serve({
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
      { type: 'text', text: JSON.stringify({ summary: 'Vom Ausweichmodell.', adjustments: [{ parameter: 'clarity', value: 12, reason: 'Mehr Struktur.' }] }) },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  });

  const result = await proposeEdit(editRequest);
  assert.equal(result.params.values.clarity, 12);
  assert.equal(result.model, 'claude-opus-5', 'das antwortende Modell wurde nicht gemeldet');
});

test('Felder in falscher Form führen nicht zum Absturz', async () => {
  // Das Schema legt die Form fest, aber eine abgeschnittene oder abweichende
  // Antwort darf keinen TypeError auslösen (§32).
  serve(messageWith({ overall: 7, ratings: 'gut', tips: { a: 1 } }));
  const report = await coachReport(analysisImagePath, stats, photo, null);
  assert.deepEqual(report.ratings, []);
  assert.deepEqual(report.tips, []);
  assert.equal(report.overall, '');

  serve(messageWith({ subject: 'Motorrad', categories: 'Landschaft', observations: null }));
  const scene = await analyzeScene(analysisImagePath, stats, photo);
  assert.deepEqual(scene.categories, [], 'ein String wurde als Liste behandelt');
  assert.deepEqual(scene.observations, []);

  serve(messageWith({ summary: 'x', adjustments: 42, masks: 'keine' }));
  const edit = await proposeEdit(editRequest);
  assert.ok(edit.params, 'eine Antwort mit falschen Feldern ließ die Bearbeitung scheitern');
});
