/**
 * Validierung der Bearbeitungsparameter (§32 des Briefings).
 *
 * Diese Tests prüfen die Zusage, dass eine fehlerhafte KI-Antwort die App
 * weder abstürzen lassen noch in einen ungültigen Zustand bringen kann.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAM_IDS,
  buildCurveLut,
  createDefaultParams,
  hasAnyChange,
  isDefaultValue,
  sanitizeCurve,
  sanitizeEditParams,
  sanitizeValuePatch,
  snapParam,
} from '@photomaster/shared';

test('Standardwerte gelten als unbearbeitet', () => {
  const params = createDefaultParams();
  assert.equal(hasAnyChange(params), false);
  assert.equal(Object.keys(params.values).length, PARAM_IDS.length);
  for (const id of PARAM_IDS) {
    assert.equal(isDefaultValue(id, params.values[id]), true, `${id} weicht vom Default ab`);
  }
});

test('absurde Werte werden auf den erlaubten Bereich begrenzt', () => {
  const result = sanitizeValuePatch({ exposure: 999999, contrast: -1e9, vibrance: 250 });
  assert.equal(result.value.exposure, 5);
  assert.equal(result.value.contrast, -100);
  assert.equal(result.value.vibrance, 100);
  assert.equal(result.issues.length, 3, 'jede Begrenzung wird gemeldet');
});

test('nicht-numerische und unbekannte Werte werden verworfen, nicht übernommen', () => {
  const result = sanitizeValuePatch({
    exposure: Number.NaN,
    contrast: Infinity,
    saturation: null,
    somethingInvented: 42,
    highlights: -20,
  });
  assert.equal(result.value.exposure, undefined);
  assert.equal(result.value.contrast, undefined);
  assert.equal(result.value.saturation, undefined);
  assert.equal(result.value.somethingInvented, undefined);
  // Der gültige Wert im selben Objekt überlebt.
  assert.equal(result.value.highlights, -20);
});

test('Zahlen als Zeichenkette werden repariert', () => {
  // Modelle liefern gelegentlich "+12" statt 12.
  const result = sanitizeValuePatch({ contrast: '+12', exposure: '-0.25' });
  assert.equal(result.value.contrast, 12);
  assert.equal(result.value.exposure, -0.25);
});

test('Werte werden auf die Schrittweite gerundet', () => {
  assert.equal(snapParam('exposure', 0.123456), 0.12);
  assert.equal(snapParam('contrast', 12.7), 13);
  assert.equal(snapParam('sharpenRadius', 1.24), 1.2);
});

test('zyklische Parameter laufen um statt anzuschlagen', () => {
  // Farbton 0–360: 370° ist 10°, nicht 360°.
  assert.equal(snapParam('gradeShadowHue', 370), 10);
  assert.equal(snapParam('gradeShadowHue', -30), 330);
});

test('fehlende Parameter erhalten ihren Default statt undefined', () => {
  const result = sanitizeEditParams({ values: { exposure: 0.5 } });
  assert.equal(result.value.values.exposure, 0.5);
  assert.equal(result.value.values.contrast, 0);
  // Alle Parameter sind belegt — kein undefined kann in einen Shader gelangen.
  for (const id of PARAM_IDS) {
    assert.equal(typeof result.value.values[id], 'number', `${id} ist keine Zahl`);
  }
});

test('Müll statt eines Parameterobjekts ergibt einen gültigen Standardzustand', () => {
  for (const input of [null, undefined, 42, 'text', []]) {
    const result = sanitizeEditParams(input);
    assert.equal(hasAnyChange(result.value), false);
  }
});

test('ein flaches Wertobjekt wird ebenso akzeptiert wie die verschachtelte Form', () => {
  const flat = sanitizeEditParams({ exposure: -1, clarity: 30 });
  assert.equal(flat.value.values.exposure, -1);
  assert.equal(flat.value.values.clarity, 30);
});

// ── Kurven ─────────────────────────────────────────────────────────────────

test('Kurvenpunkte werden sortiert, begrenzt und entdoppelt', () => {
  const result = sanitizeCurve(
    [
      { x: 0.8, y: 0.9 },
      { x: 0.2, y: 5 },
      { x: -1, y: 0.1 },
      { x: 0.2, y: 0.3 },
    ],
    'rgb',
  );
  const points = result.value;
  assert.ok(points.every((p, i) => i === 0 || p.x >= points[i - 1].x), 'nicht sortiert');
  assert.ok(points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), 'nicht begrenzt');
  const xs = points.map((p) => p.x);
  assert.equal(new Set(xs).size, xs.length, 'doppelte x-Positionen übrig');
});

test('eine Kurve mit zu wenigen Punkten fällt auf die Standardkurve zurück', () => {
  const result = sanitizeCurve([{ x: 0.5, y: 0.5 }], 'rgb');
  assert.equal(result.value.length, 2);
  assert.ok(result.issues.length > 0);
});

test('die Kurveninterpolation bleibt monoton — kein Überschwingen', () => {
  // Ein angehobener Mittelton darf die Schatten nicht mit absenken. Genau das
  // würde eine gewöhnliche Spline tun.
  const lut = buildCurveLut(
    [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.2 },
      { x: 0.5, y: 0.75 },
      { x: 1, y: 1 },
    ],
    256,
  );
  for (let i = 1; i < lut.length; i++) {
    assert.ok(lut[i] >= lut[i - 1] - 1e-6, `Kurve fällt bei Index ${i}: ${lut[i - 1]} -> ${lut[i]}`);
    assert.ok(lut[i] >= 0 && lut[i] <= 1, `Kurve verlässt den Wertebereich bei Index ${i}`);
  }
});

test('die Standardkurve ist die Identität', () => {
  const lut = buildCurveLut(
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    256,
  );
  for (let i = 0; i < lut.length; i++) {
    assert.ok(Math.abs(lut[i] - i / 255) < 1e-5, `Identität verletzt bei ${i}`);
  }
});
