/**
 * Maskenpinsel (§28).
 *
 * Der Pinsel speichert den WEG, nicht das Ergebnis. Diese Tests sichern die
 * Eigenschaften ab, die daraus folgen — und die verloren gingen, wenn jemand
 * später doch eine Pixelmaske daraus machte:
 *
 *  - Ein Strich ist eine Liste von Koordinaten und bleibt klein.
 *  - Er übersteht Speichern und Laden unverändert.
 *  - Ein neuer Punkt ist eine Änderung: Der Verlauf muss ihn sehen, und die
 *    Rasterung muss neu laufen.
 *  - Die KI kann eine gemalte Maske nicht in einen Verlauf verwandeln.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'pm-brush-'));
process.env.PM_DATA_DIR = dataDir;
delete process.env.ANTHROPIC_API_KEY;

const {
  DEFAULT_BRUSH,
  MAX_BRUSH_MASKS,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_MASK,
  countStrokePoints,
  createDefaultParams,
  createMask,
  describeMask,
  hasAnyChange,
  makeMaskId,
  maskHasEffect,
  paramsEqual,
  sanitizeEditParams,
  sanitizeMask,
  assignBrushChannels,
  brushSignature,
} = await import('@photomaster/shared');
const { prepareMasks } = await import('@photomaster/engine/uniforms');
const { normalizeEditResponse } = await import('../src/ai/service.ts');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function brushMask(id = 'b1', points = 3) {
  const mask = createMask('brush', id, 'Gemalt');
  mask.strokes = [
    {
      points: Array.from({ length: points }, (_, i) => ({ x: 0.2 + i * 0.1, y: 0.5 })),
      radius: 0.05,
      hardness: 0.6,
      opacity: 0.9,
      erase: false,
    },
  ];
  mask.values.exposure = 0.5;
  return mask;
}

// ── Grundverhalten ─────────────────────────────────────────────────────────

test('ein Pinsel ohne Striche wirkt nicht, egal wie die Regler stehen', () => {
  const mask = createMask('brush', makeMaskId(), 'Leer');
  mask.values.exposure = 2;
  // Keine gemalte Fläche heißt: keine Fläche, auf der etwas passieren könnte.
  assert.equal(maskHasEffect(mask), false);

  mask.strokes = [{ points: [{ x: 0.5, y: 0.5 }], radius: 0.05, hardness: 0.5, opacity: 1, erase: false }];
  assert.equal(maskHasEffect(mask), true);
});

test('ein einzelner Tipp ist ein gültiger Strich', () => {
  // Ein Strich mit nur einem Punkt hat kein Segment — er muss trotzdem als
  // runder Klecks ankommen und nicht durchfallen.
  const result = sanitizeMask(
    { type: 'brush', strokes: [{ points: [{ x: 0.5, y: 0.5 }] }] },
    0,
  );
  assert.equal(result.value.strokes.length, 1);
  assert.equal(result.value.strokes[0].points.length, 1);
});

test('die Beschreibung nennt die Zahl der Striche', () => {
  assert.match(describeMask(brushMask()), /Pinsel · 1 Strich/);
  assert.equal(countStrokePoints(brushMask('x', 7)), 7);
});

test('eine Pinselmaske zählt als Bearbeitung des Bildes', () => {
  const params = createDefaultParams();
  assert.equal(hasAnyChange(params), false);
  params.masks = [brushMask()];
  assert.equal(hasAnyChange(params), true);
});

// ── Validierung ────────────────────────────────────────────────────────────

test('ungültige Punkte fliegen raus, der Rest des Strichs bleibt', () => {
  const result = sanitizeMask(
    {
      type: 'brush',
      strokes: [
        {
          points: [
            { x: 0.2, y: 0.2 },
            { x: Number.NaN, y: 0.3 },
            { x: 0.4, y: Infinity },
            'kein Punkt',
            { x: 0.5, y: 0.5 },
          ],
        },
      ],
    },
    0,
  );

  assert.equal(result.value.strokes[0].points.length, 2);
  assert.ok(result.issues.some((i) => i.includes('Pinselpunkte')));
  // Kein einziger NaN darf durchkommen — er würde den Vertex-Puffer
  // unbrauchbar machen und die ganze Maske verschwinden lassen.
  for (const p of result.value.strokes[0].points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test('Pinselparameter werden begrenzt', () => {
  const result = sanitizeMask(
    {
      type: 'brush',
      strokes: [{ points: [{ x: 0.5, y: 0.5 }], radius: 99, hardness: -5, opacity: 40 }],
    },
    0,
  );
  const stroke = result.value.strokes[0];
  assert.ok(stroke.radius <= 0.8 && stroke.radius > 0, `Radius ${stroke.radius}`);
  assert.equal(stroke.hardness, 0);
  assert.equal(stroke.opacity, 1);
});

test('fehlende Pinselparameter bekommen die Standardwerte', () => {
  const result = sanitizeMask({ type: 'brush', strokes: [{ points: [{ x: 0.5, y: 0.5 }] }] }, 0);
  const stroke = result.value.strokes[0];
  assert.equal(stroke.radius, DEFAULT_BRUSH.radius);
  assert.equal(stroke.hardness, DEFAULT_BRUSH.hardness);
  assert.equal(stroke.opacity, DEFAULT_BRUSH.opacity);
  assert.equal(stroke.erase, false);
});

test('Striche dürfen über den Bildrand hinauslaufen, aber nicht ins Absurde', () => {
  // Man setzt den Pinsel oft außerhalb an und zieht ins Bild.
  const result = sanitizeMask(
    { type: 'brush', strokes: [{ points: [{ x: -0.2, y: 0.5 }, { x: 99, y: -99 }] }] },
    0,
  );
  const pts = result.value.strokes[0].points;
  assert.equal(pts[0].x, -0.2, 'ein Ansatz knapp außerhalb muss erhalten bleiben');
  assert.ok(pts[1].x <= 1.5 && pts[1].y >= -0.5);
});

test('Zahl der Striche und Punkte ist begrenzt', () => {
  const tooMany = Array.from({ length: MAX_STROKES_PER_MASK + 10 }, () => ({
    points: [{ x: 0.5, y: 0.5 }],
  }));
  const result = sanitizeMask({ type: 'brush', strokes: tooMany }, 0);
  assert.equal(result.value.strokes.length, MAX_STROKES_PER_MASK);

  const longStroke = {
    points: Array.from({ length: MAX_POINTS_PER_STROKE + 50 }, (_, i) => ({ x: i / 1000, y: 0.5 })),
  };
  const long = sanitizeMask({ type: 'brush', strokes: [longStroke] }, 0);
  assert.equal(long.value.strokes[0].points.length, MAX_POINTS_PER_STROKE);
});

test('Striche an einer Verlaufs- oder Radialmaske werden verworfen', () => {
  // Sie hätten dort keine Wirkung und würden nur unsichtbar mitreisen.
  const result = sanitizeMask(
    { type: 'linear', strokes: [{ points: [{ x: 0.5, y: 0.5 }] }] },
    0,
  );
  assert.deepEqual(result.value.strokes, []);
});

// ── Speichern und Erkennen von Änderungen ──────────────────────────────────

test('eine Pinselmaske übersteht Speichern und Laden unverändert', () => {
  const params = createDefaultParams();
  params.masks = [brushMask('fest', 12)];

  const round = sanitizeEditParams(JSON.parse(JSON.stringify(params)));
  assert.equal(round.issues.length, 0, round.issues.join(' '));
  assert.ok(paramsEqual(params, round.value), 'der Zustand hat sich verändert');
  assert.equal(round.value.masks[0].strokes[0].points.length, 12);
});

test('ein zusätzlicher Punkt gilt als Änderung', () => {
  // Davon hängt beides ab: dass der Verlauf den Strich als Schritt sieht und
  // dass die Rasterung überhaupt neu läuft.
  const a = createDefaultParams();
  a.masks = [brushMask()];
  const b = sanitizeEditParams(JSON.parse(JSON.stringify(a))).value;
  assert.ok(paramsEqual(a, b));

  b.masks[0].strokes[0].points.push({ x: 0.9, y: 0.5 });
  assert.equal(paramsEqual(a, b), false);
});

test('ein verschobener Punkt gilt als Änderung', () => {
  const a = createDefaultParams();
  a.masks = [brushMask()];
  const b = sanitizeEditParams(JSON.parse(JSON.stringify(a))).value;
  b.masks[0].strokes[0].points[1].x += 0.01;
  assert.equal(paramsEqual(a, b), false);
});

test('ein Strich bleibt klein genug für eine Projektdatei', () => {
  const mask = brushMask('gross', 300);
  const bytes = JSON.stringify(mask.strokes).length;
  // 300 Punkte sind ein sehr langer Strich quer durchs Bild.
  assert.ok(bytes < 20000, `${bytes} Bytes für 300 Punkte ist zu viel`);
});

// ── Übergabe an die GPU ────────────────────────────────────────────────────

test('Pinselmasken bekommen Farbkanäle in ihrer Reihenfolge', () => {
  const masks = [
    createMask('linear', 'l', 'Verlauf'),
    brushMask('b1'),
    createMask('radial', 'r', 'Radial'),
    brushMask('b2'),
  ];
  const channels = assignBrushChannels(masks);

  assert.equal(channels.get('b1'), 0);
  assert.equal(channels.get('b2'), 1);
  assert.equal(channels.get('l'), undefined, 'nur Pinselmasken brauchen einen Kanal');
});

test('mehr Pinselmasken als Kanäle bekommen keinen und bleiben wirkungslos', () => {
  const masks = Array.from({ length: MAX_BRUSH_MASKS + 2 }, (_, i) => brushMask(`b${i}`));
  const channels = assignBrushChannels(masks);
  assert.equal(channels.size, MAX_BRUSH_MASKS);

  const u = prepareMasks(masks, channels);
  // Die überzähligen stehen mit Stärke 0 im Puffer — sie verschieben keine
  // Indizes, wirken aber nicht.
  assert.equal(u.c[4 * MAX_BRUSH_MASKS + 3], 0);
  assert.equal(u.c[3], brushMask().strength / 100);
});

test('der Pinseltyp und sein Kanal landen richtig im Uniform-Puffer', () => {
  const masks = [brushMask('b1'), brushMask('b2')];
  const u = prepareMasks(masks, assignBrushChannels(masks));

  assert.equal(u.geoA[0], 2, 'Pinsel muss als 2 kodiert sein');
  assert.equal(u.geoB[0], 0, 'erste Pinselmaske nutzt Kanal 0');
  assert.equal(u.geoB[4], 1, 'zweite Pinselmaske nutzt Kanal 1');
  assert.equal(u.active, true);
});

test('die Kurzkennung ändert sich, sobald ein Punkt dazukommt', () => {
  // Andernfalls bliebe die zwischengespeicherte Rasterung stehen und der
  // Strich würde beim Malen nicht mitwachsen.
  const mask = brushMask();
  const before = brushSignature([mask]);

  mask.strokes[0].points.push({ x: 0.7, y: 0.5 });
  assert.notEqual(brushSignature([mask]), before);

  // Und sie ändert sich NICHT, wenn nur ein Regler bewegt wird — sonst würde
  // bei jedem Reglerzug unnötig neu gerastert.
  const stable = brushSignature([mask]);
  mask.values.exposure = 1.5;
  assert.equal(brushSignature([mask]), stable);
});

// ── Die KI und der Pinsel ──────────────────────────────────────────────────

test('die KI kann eine gemalte Maske nicht in einen Verlauf verwandeln', () => {
  const current = createDefaultParams();
  current.masks = [brushMask('gemalt')];

  // Das Modell kennt den Typ "brush" nicht und schickt zwangsläufig "linear".
  const result = normalizeEditResponse(
    {
      summary: 'Der markierte Bereich soll heller werden.',
      adjustments: [],
      masks: [
        {
          id: 'gemalt',
          name: 'Gemalt',
          type: 'linear',
          angle: 0, position: 0.5, centerX: 0.5, centerY: 0.5,
          radiusX: 0.3, radiusY: 0.3, feather: 0.4, inverted: false,
          luminanceRange: { active: false, min: 0, max: 1, feather: 0.25 },
          colorRange: { active: false, hue: 30, tolerance: 25 },
          adjustments: [{ parameter: 'exposure', value: 0.9, reason: 'heller' }],
        },
      ],
    },
    current,
    'test-model',
  );

  const mask = result.params.masks[0];
  assert.equal(mask.type, 'brush', 'die Maske wurde zu einem Verlauf gemacht');
  assert.equal(mask.strokes.length, 1, 'die gemalten Striche sind verschwunden');
  assert.equal(mask.strokes[0].points.length, 3);
  // Die Anpassung darf die KI sehr wohl ändern — dafür ist sie da.
  assert.equal(mask.values.exposure, 0.9);
});

test('die KI kann keine Pinselmaske anlegen', () => {
  const result = normalizeEditResponse(
    {
      summary: 'x',
      adjustments: [],
      masks: [
        {
          id: '',
          name: 'Versuch',
          // Selbst wenn das Modell den Typ errät, ist er nicht im Schema und
          // wird zu einem Verlauf normalisiert — ohne Striche.
          type: 'brush',
          angle: 0, position: 0.5, centerX: 0.5, centerY: 0.5,
          radiusX: 0.3, radiusY: 0.3, feather: 0.4, inverted: false,
          luminanceRange: { active: false, min: 0, max: 1, feather: 0.25 },
          colorRange: { active: false, hue: 30, tolerance: 25 },
          adjustments: [{ parameter: 'exposure', value: 0.5, reason: 'x' }],
        },
      ],
    },
    createDefaultParams(),
    'test-model',
  );

  const mask = result.params.masks[0];
  // Der Typ wird übernommen, aber ohne Striche bleibt die Maske wirkungslos —
  // die KI kann also keine gemalte Fläche erfinden.
  assert.deepEqual(mask.strokes, []);
  assert.equal(maskHasEffect(mask), false);
});
