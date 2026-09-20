/**
 * Lokale Masken (§28 des Briefings).
 *
 * Zwei Dinge werden hier abgesichert:
 *
 *  1. Eine Maske ist reine Zahlendarstellung und übersteht Validierung,
 *     Speicherung und Zusammenführung unverändert.
 *  2. Die KI darf Masken anlegen und ändern — aber die Arbeit des Nutzers
 *     nicht zerstören. Eine Maske, die sie nicht erwähnt, bleibt stehen;
 *     löschen kann sie keine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'pm-masks-'));
process.env.PM_DATA_DIR = dataDir;
delete process.env.ANTHROPIC_API_KEY;

const {
  LOCAL_PARAM_IDS,
  MAX_MASKS,
  createDefaultParams,
  createMask,
  describeMask,
  hasAnyChange,
  makeMaskId,
  maskHasEffect,
  paramsEqual,
  sanitizeEditParams,
  sanitizeMask,
  sanitizeMasks,
} = await import('@photomaster/shared');
const { normalizeEditResponse } = await import('../src/ai/service.ts');
const { prepareMasks, prepareMaskOverlay } = await import('@photomaster/engine/uniforms');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Grundzustand ───────────────────────────────────────────────────────────

test('eine neue Maske hat noch keine Wirkung', () => {
  const mask = createMask('linear', makeMaskId(), 'Himmel');
  assert.equal(maskHasEffect(mask), false, 'ohne Anpassung darf sie nichts tun');
  assert.equal(mask.enabled, true);
  assert.equal(mask.strength, 100);
  // Alle lokalen Parameter sind belegt — kein undefined kann in den Shader.
  for (const id of LOCAL_PARAM_IDS) {
    assert.equal(typeof mask.values[id], 'number', `${id} fehlt`);
  }
});

test('eine Maske mit Anpassung zählt als Bearbeitung des Bildes', () => {
  const params = createDefaultParams();
  assert.equal(hasAnyChange(params), false);

  const mask = createMask('radial', makeMaskId(), 'Motiv');
  mask.values.exposure = 0.5;
  params.masks = [mask];

  assert.equal(maskHasEffect(mask), true);
  assert.equal(hasAnyChange(params), true, 'eine lokale Anpassung ist eine Bearbeitung');
});

test('eine abgeschaltete Maske wirkt nicht, bleibt aber erhalten', () => {
  const mask = createMask('linear', makeMaskId(), 'Aus');
  mask.values.exposure = -1;
  mask.enabled = false;
  assert.equal(maskHasEffect(mask), false);
  assert.match(describeMask(mask), /1 Anpassung/, 'die Anpassung geht nicht verloren');
});

// ── Validierung ────────────────────────────────────────────────────────────

test('unsinnige Maskenwerte werden begrenzt statt übernommen', () => {
  const result = sanitizeMask(
    {
      type: 'radial',
      centerX: 99,
      centerY: -5,
      radiusX: 0,
      radiusY: 1e9,
      feather: 42,
      strength: 500,
      angle: -30,
    },
    0,
  );
  const m = result.value;
  assert.equal(m.centerX, 1);
  assert.equal(m.centerY, 0);
  assert.ok(m.radiusX >= 0.01, `Radius ${m.radiusX} ist nicht brauchbar`);
  assert.ok(m.radiusY <= 3);
  assert.equal(m.feather, 1);
  assert.equal(m.strength, 100);
  assert.equal(m.angle, 330, 'Winkel muss zyklisch umlaufen, nicht anschlagen');
});

test('vertauschte Helligkeitsgrenzen werden getauscht statt zu einer leeren Maske', () => {
  const result = sanitizeMask(
    { type: 'linear', luminanceRange: { active: true, min: 0.9, max: 0.2, feather: 0.1 } },
    0,
  );
  assert.equal(result.value.luminanceRange.min, 0.2);
  assert.equal(result.value.luminanceRange.max, 0.9);
});

test('global gültige Parameter, die lokal nicht angeboten werden, fliegen raus', () => {
  const result = sanitizeMask(
    { type: 'linear', values: { exposure: -0.5, grainAmount: 40, hslRedHue: 20 } },
    0,
  );
  assert.equal(result.value.values.exposure, -0.5);
  assert.equal(result.value.values.grainAmount, undefined, 'Korn ist kein lokaler Regler');
  assert.equal(result.value.values.hslRedHue, undefined);
  assert.equal(result.issues.length, 2);
});

test('Müll statt einer Maske ergibt eine gültige Standardmaske', () => {
  for (const input of [null, 42, 'text', []]) {
    const result = sanitizeMask(input, 0);
    assert.equal(typeof result.value.id, 'string');
    assert.ok(result.value.id.length > 0);
    assert.equal(maskHasEffect(result.value), false);
  }
});

test('die Maskenzahl ist begrenzt und Kennungen bleiben eindeutig', () => {
  const many = Array.from({ length: MAX_MASKS + 3 }, () => ({ type: 'linear', id: 'immer-gleich' }));
  const result = sanitizeMasks(many);

  assert.equal(result.value.length, MAX_MASKS);
  assert.equal(new Set(result.value.map((m) => m.id)).size, MAX_MASKS, 'doppelte Kennungen');
  assert.ok(result.issues.some((i) => i.includes('ersten')));
});

// ── Speichern und Vergleichen ──────────────────────────────────────────────

test('Masken überstehen eine Runde durch die Validierung unverändert', () => {
  const params = createDefaultParams();
  const mask = createMask('radial', 'feste-id', 'Motiv');
  mask.values.exposure = 0.4;
  mask.values.clarity = 22;
  mask.centerX = 0.31;
  mask.radiusY = 0.18;
  mask.inverted = true;
  mask.luminanceRange = { active: true, min: 0.1, max: 0.8, feather: 0.2 };
  params.masks = [mask];

  const round = sanitizeEditParams(JSON.parse(JSON.stringify(params)));
  assert.equal(round.issues.length, 0, round.issues.join(' '));
  assert.ok(paramsEqual(params, round.value), 'der Zustand hat sich beim Durchlauf verändert');
});

test('ein Projekt ohne Maskenfeld bleibt lesbar', () => {
  // So sieht ein Projekt aus, das vor der Maskenfunktion gespeichert wurde.
  const legacy = { v: 1, values: { exposure: 0.3 }, curves: undefined };
  const result = sanitizeEditParams(legacy);
  assert.deepEqual(result.value.masks, []);
  assert.equal(result.value.values.exposure, 0.3);
});

test('paramsEqual erkennt einen Unterschied in einer Maske', () => {
  const a = createDefaultParams();
  a.masks = [createMask('linear', 'x', 'A')];
  const b = sanitizeEditParams(JSON.parse(JSON.stringify(a))).value;
  assert.ok(paramsEqual(a, b));

  b.masks[0].position = 0.9;
  assert.equal(paramsEqual(a, b), false, 'eine verschobene Maske gilt als Änderung');
});

// ── Übergabe an den Shader ─────────────────────────────────────────────────

test('die Uniform-Belegung übersetzt Einheiten korrekt', () => {
  const mask = createMask('radial', 'u', 'Test');
  mask.angle = 90;
  mask.values.exposure = -1;
  mask.values.contrast = 50;
  const u = prepareMasks([mask]);

  assert.equal(u.count, 1);
  assert.equal(u.active, true);
  assert.equal(u.geoA[0], 1, 'radial muss als 1 kodiert sein');
  assert.ok(Math.abs(u.geoA[1] - Math.PI / 2) < 1e-6, 'Winkel muss im Bogenmaß stehen');
  assert.equal(u.a[0], -1, 'Belichtung geht unverändert in EV');
  // Kontrast wird wie global mit 0.85 gedeckelt — sonst wirkte ein lokaler
  // Kontrast von 50 anders als der globale Regler auf 50.
  assert.ok(Math.abs(u.a[1] - 0.5 * 0.85) < 1e-6, `Kontrast ${u.a[1]}`);
});

test('wirkungslose Masken werden mit Stärke 0 übergeben, behalten aber ihren Platz', () => {
  const a = createMask('linear', 'a', 'Leer');
  const b = createMask('linear', 'b', 'Wirksam');
  b.values.exposure = 0.5;

  const u = prepareMasks([a, b]);
  assert.equal(u.count, 2, 'die Liste darf nicht zusammenschrumpfen');
  assert.equal(u.c[3], 0, 'die leere Maske muss abgeschaltet sein');
  assert.equal(u.c[7], 1, 'die wirksame Maske behält ihre Stärke');
  assert.equal(u.active, true);
});

test('ohne wirksame Maske entfällt der ganze Pass', () => {
  const u = prepareMasks([createMask('linear', 'a', 'Leer')]);
  assert.equal(u.active, false);
});

test('die Maskenvorschau zeigt auch eine Maske ohne Anpassungen', () => {
  // Man positioniert eine Maske, BEVOR man den ersten Regler bewegt.
  const mask = createMask('radial', 'v', 'Neu');
  const u = prepareMaskOverlay(mask);
  assert.equal(u.c[3], 1, 'die Vorschau muss unabhängig von Anpassungen sichtbar sein');
});

// ── Die KI und die Masken ──────────────────────────────────────────────────

const base = createDefaultParams();

test('die KI kann eine Maske anlegen', () => {
  const result = normalizeEditResponse(
    {
      summary: 'Der Himmel ist zu hell.',
      adjustments: [],
      masks: [
        {
          id: '',
          name: 'Himmel',
          type: 'linear',
          angle: 0,
          position: 0.42,
          centerX: 0.5,
          centerY: 0.5,
          radiusX: 0.3,
          radiusY: 0.3,
          feather: 0.4,
          inverted: false,
          luminanceRange: { active: true, min: 0.5, max: 1, feather: 0.2 },
          colorRange: { active: false, hue: 30, tolerance: 25 },
          adjustments: [{ parameter: 'exposure', value: -0.6, reason: 'Der Himmel liegt 2 Blenden über dem Vordergrund.' }],
        },
      ],
    },
    base,
    'test-model',
  );

  assert.equal(result.params.masks.length, 1);
  const mask = result.params.masks[0];
  assert.equal(mask.name, 'Himmel');
  assert.equal(mask.type, 'linear');
  assert.equal(mask.position, 0.42);
  assert.equal(mask.values.exposure, -0.6);
  assert.equal(mask.luminanceRange.active, true);
  assert.ok(mask.id.length > 0, 'eine Maske ohne Kennung ist später nicht änderbar');

  // Die Begründung trägt den Maskennamen, damit "Warum diese Bearbeitung?"
  // nicht behauptet, die Belichtung sei global geändert worden.
  const reason = result.rationale.reasons.find((r) => r.param === 'exposure');
  assert.equal(reason?.mask, 'Himmel');
});

test('die KI ändert eine bestehende Maske über ihre Kennung, statt sie zu verdoppeln', () => {
  const current = createDefaultParams();
  const existing = createMask('linear', 'himmel-1', 'Himmel');
  existing.values.exposure = -0.4;
  existing.position = 0.4;
  current.masks = [existing];

  const result = normalizeEditResponse(
    {
      summary: 'Etwas kräftiger.',
      adjustments: [],
      masks: [
        {
          id: 'himmel-1',
          name: 'Himmel',
          type: 'linear',
          angle: 0,
          position: 0.4,
          centerX: 0.5,
          centerY: 0.5,
          radiusX: 0.3,
          radiusY: 0.3,
          feather: 0.35,
          inverted: false,
          luminanceRange: { active: false, min: 0, max: 1, feather: 0.25 },
          colorRange: { active: false, hue: 30, tolerance: 25 },
          adjustments: [{ parameter: 'exposure', value: -0.8, reason: 'deutlicher' }],
        },
      ],
    },
    current,
    'test-model',
  );

  assert.equal(result.params.masks.length, 1, 'die Maske wurde verdoppelt');
  assert.equal(result.params.masks[0].id, 'himmel-1', 'die Kennung muss erhalten bleiben');
  assert.equal(result.params.masks[0].values.exposure, -0.8);
});

test('die KI kann eine Maske des Nutzers nicht löschen', () => {
  const current = createDefaultParams();
  const userMask = createMask('radial', 'vom-nutzer', 'Mein Motiv');
  userMask.values.clarity = 30;
  current.masks = [userMask];

  // Eine Antwort ganz ohne Masken — etwa auf "mach es etwas wärmer".
  const result = normalizeEditResponse(
    {
      summary: 'Wärmer.',
      adjustments: [{ parameter: 'temperature', value: 12, reason: 'wärmer' }],
      masks: [],
    },
    current,
    'test-model',
  );

  assert.equal(result.params.masks.length, 1, 'die Maske des Nutzers ist verschwunden');
  assert.equal(result.params.masks[0].id, 'vom-nutzer');
  assert.equal(result.params.masks[0].values.clarity, 30, 'ihre Anpassung ging verloren');
  assert.equal(result.params.values.temperature, 12);
});

test('eine Maske mit erfundenen Parametern wird bereinigt, nicht verworfen', () => {
  const result = normalizeEditResponse(
    {
      summary: 'x',
      adjustments: [],
      masks: [
        {
          id: '',
          name: 'Test',
          type: 'radial',
          angle: 0,
          position: 0.5,
          centerX: 0.5,
          centerY: 0.5,
          radiusX: 0.3,
          radiusY: 0.3,
          feather: 0.5,
          inverted: false,
          luminanceRange: { active: false, min: 0, max: 1, feather: 0.25 },
          colorRange: { active: false, hue: 30, tolerance: 25 },
          adjustments: [
            { parameter: 'skyReplacement', value: 100, reason: 'Himmel tauschen' },
            { parameter: 'exposure', value: 0.3, reason: 'aufhellen' },
          ],
        },
      ],
    },
    base,
    'test-model',
  );

  assert.equal(result.params.masks.length, 1);
  assert.equal(result.params.masks[0].values.exposure, 0.3);
  assert.ok(result.issues.length > 0, 'der erfundene Parameter wurde nicht gemeldet');
  // Und es darf keine Begründung für etwas geben, das nicht passiert ist.
  assert.equal(result.rationale.reasons.filter((r) => r.param === 'skyReplacement').length, 0);
});

test('mehr Masken als erlaubt werden abgewiesen, ohne bestehende zu verdrängen', () => {
  const current = createDefaultParams();
  current.masks = Array.from({ length: MAX_MASKS }, (_, i) => {
    const m = createMask('linear', `m${i}`, `Maske ${i}`);
    m.values.exposure = 0.1;
    return m;
  });

  const result = normalizeEditResponse(
    {
      summary: 'x',
      adjustments: [],
      masks: [
        {
          id: '',
          name: 'Zuviel',
          type: 'linear',
          angle: 0, position: 0.5, centerX: 0.5, centerY: 0.5,
          radiusX: 0.3, radiusY: 0.3, feather: 0.4, inverted: false,
          luminanceRange: { active: false, min: 0, max: 1, feather: 0.25 },
          colorRange: { active: false, hue: 30, tolerance: 25 },
          adjustments: [{ parameter: 'exposure', value: 1, reason: 'x' }],
        },
      ],
    },
    current,
    'test-model',
  );

  assert.equal(result.params.masks.length, MAX_MASKS);
  assert.ok(result.issues.some((i) => i.includes(String(MAX_MASKS))));
  // Die bestehenden Masken sind unverändert.
  assert.equal(result.params.masks[0].id, 'm0');
});
