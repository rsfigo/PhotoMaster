/**
 * Editor-Zustand: Verlauf, Versionen, Neustart (§18, §19, §34).
 *
 * Der Verlauf ist der Teil der App, bei dem ein Fehler am teuersten ist: Er
 * ist die einzige Sicherung des Nutzers gegen einen Fehlgriff. Getestet wird
 * deshalb nicht nur, DASS rückgängig gemacht wird, sondern auch die
 * Schrittgrenze — ein Reglerzug und ein Pinselstrich müssen jeweils EIN
 * Schritt sein, nicht hundert.
 *
 * Der Zustandsspeicher liegt im Oberflächenpaket, hängt aber an nichts
 * Browserspezifischem. Er lässt sich deshalb hier direkt ausführen, statt ihn
 * ungetestet zu lassen, weil er zufällig in einem React-Projekt wohnt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'pm-editor-'));
process.env.PM_DATA_DIR = dataDir;

const { useEditor, undoLabel, redoLabel } = await import(
  '../../app/src/state/editorStore.ts'
);
const {
  MAX_MASKS,
  applyValuePatch,
  createDefaultParams,
  paramsEqual,
} = await import('@photomaster/shared');
const db = await import('../src/db.ts');

db.openDatabase();
const photo = db.insertPhoto({
  hash: 'editorhash',
  originalName: 'DSC_9001.JPG',
  format: 'jpeg',
  storageExt: 'jpg',
  mimeType: 'image/jpeg',
  bytes: 11_800_000,
  width: 6000,
  height: 4000,
  orientation: 1,
  hasExif: true,
  hasIcc: false,
  camera: { make: 'NIKON CORPORATION', model: 'NIKON D3200' },
  source: { kind: 'direct', width: 6000, height: 4000 },
  previewWidth: 2560,
  previewHeight: 1707,
});

test.after(async () => {
  db.closeDatabase();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Frischer Editor mit echtem Projekt — wie nach dem Öffnen eines Fotos. */
function open(params = createDefaultParams()) {
  const project = db.createProject(photo.id, 'Test', params);
  useEditor.getState().loadProject(project);
  return project;
}

const state = () => useEditor.getState();

// ── Schrittgrenzen des Verlaufs (§18) ──────────────────────────────────────

test('ein Reglerzug ist ein einziger Verlaufsschritt', () => {
  open();
  const s = state();

  // So kommt es aus der Oberfläche: ein Druck, viele Zwischenwerte, ein Loslassen.
  s.beginGesture('Belichtung');
  for (let i = 1; i <= 40; i++) state().setValue('exposure', i * 0.01);
  state().endGesture();

  assert.equal(state().past.length, 1, 'jeder Zwischenwert wurde zum eigenen Schritt');
  assert.equal(state().params.values.exposure, 0.4);

  state().undo();
  assert.equal(state().params.values.exposure, 0, 'ein Rückgängig muss den ganzen Zug aufheben');
});

test('eine Geste ohne Ergebnis erzeugt keinen Schritt', () => {
  open();

  // Angefasst und wieder auf den Ausgangswert gezogen.
  state().beginGesture('Kontrast');
  state().setValue('contrast', 30);
  state().setValue('contrast', 0);
  state().endGesture();

  assert.equal(state().past.length, 0, 'ein Rückgängig ins Nichts');
  assert.equal(undoLabel(state()), null);
});

test('ein Pinselstrich ist ein einziger Verlaufsschritt', () => {
  open();
  state().addMask('brush');
  const maskId = state().params.masks[0].id;
  const afterMask = state().past.length;

  // Ein Strich: aufsetzen, ziehen, absetzen.
  state().beginGesture('Pinselstrich');
  state().beginStroke(maskId, { x: 0.2, y: 0.5 }, false);
  for (let i = 1; i <= 120; i++) {
    state().extendStroke(maskId, { x: 0.2 + i * 0.005, y: 0.5 });
  }
  state().endGesture();

  assert.equal(state().past.length, afterMask + 1, 'jeder Punkt wurde zum eigenen Schritt');
  assert.equal(state().params.masks[0].strokes[0].points.length, 121);

  state().undo();
  assert.equal(state().params.masks[0].strokes.length, 0, 'der Strich blieb teilweise stehen');
  // Die Maske selbst gehört zum vorigen Schritt und muss stehen bleiben.
  assert.equal(state().params.masks.length, 1);
});

test('der Pinsel merkt sich seine Einstellung, der Strich seine eigene', () => {
  open();
  state().addMask('brush');
  const maskId = state().params.masks[0].id;

  state().setBrush({ radius: 0.2, hardness: 0.9, opacity: 0.4 });
  state().beginStroke(maskId, { x: 0.3, y: 0.3 }, false);

  // Werkzeug danach umgestellt — der bereits gemalte Strich darf sich davon
  // nicht nachträglich verändern.
  state().setBrush({ radius: 0.02 });

  const stroke = state().params.masks[0].strokes[0];
  assert.equal(stroke.radius, 0.2, 'der Strich hat sich nachträglich verändert');
  assert.equal(stroke.hardness, 0.9);
  assert.equal(stroke.opacity, 0.4);
  assert.equal(state().brush.radius, 0.02, 'das Werkzeug merkt sich die neue Größe nicht');
});

// ── Rückgängig und Wiederholen (§18) ───────────────────────────────────────

test('Rückgängig und Wiederholen stellen genau denselben Zustand her', () => {
  open();
  state().setValueCommitted('exposure', 0.5);
  state().setValueCommitted('contrast', 20);
  const goal = structuredClone(state().params);

  state().undo();
  state().undo();
  assert.equal(state().params.values.exposure, 0);
  assert.equal(state().params.values.contrast, 0);

  state().redo();
  state().redo();
  assert.ok(paramsEqual(state().params, goal), 'Wiederholen führte woandershin');
});

test('ein neuer Schritt verwirft den Vorwärtszweig', () => {
  open();
  state().setValueCommitted('exposure', 0.5);
  state().undo();
  assert.equal(state().future.length, 1);

  // Ab hier geht es in eine andere Richtung weiter — das Wiederholen einer
  // verworfenen Fassung wäre ein Sprung in einen Zustand, den es nicht gibt.
  state().setValueCommitted('vibrance', 30);
  assert.equal(state().future.length, 0);
  assert.equal(redoLabel(state()), null);
});

test('mehr Rückgängig als Schritte tut nichts', () => {
  open();
  state().setValueCommitted('clarity', 15);
  for (let i = 0; i < 10; i++) state().undo();

  assert.equal(state().params.values.clarity, 0);
  assert.equal(state().past.length, 0);
  // Und der Weg vorwärts ist vollständig erhalten geblieben.
  state().redo();
  assert.equal(state().params.values.clarity, 15);
});

test('die Schaltflächen benennen den Schritt, um den es geht', () => {
  open();
  state().setValueCommitted('exposure', 0.3);
  assert.equal(undoLabel(state()), 'Belichtung');

  state().undo();
  assert.equal(redoLabel(state()), 'Belichtung');
  assert.equal(undoLabel(state()), null);
});

test('der Verlauf ist begrenzt und wirft die ältesten Schritte weg', () => {
  open();
  for (let i = 1; i <= 140; i++) state().setValueCommitted('exposure', i * 0.01);

  assert.ok(state().past.length <= 120, `Verlauf wuchs auf ${state().past.length}`);
  // Der jüngste Schritt muss trotzdem erreichbar sein.
  state().undo();
  assert.equal(state().params.values.exposure, 1.39);
  // Der älteste ist weggefallen — ganz zurück geht es nicht mehr.
  for (let i = 0; i < 200; i++) state().undo();
  assert.ok(state().params.values.exposure > 0, 'der Verlauf wurde gar nicht begrenzt');
});

test('eine Maske anzulegen und zu löschen lässt sich rückgängig machen', () => {
  open();
  state().addMask('linear');
  state().addMask('radial');
  assert.equal(state().params.masks.length, 2);
  assert.equal(state().params.masks[0].name, 'Verlauf 1');
  assert.equal(state().params.masks[1].name, 'Radial 1');

  const removed = state().params.masks[0].id;
  state().removeMask(removed);
  assert.equal(state().params.masks.length, 1);

  state().undo();
  assert.equal(state().params.masks.length, 2, 'die gelöschte Maske kam nicht zurück');
  assert.equal(state().params.masks[0].id, removed);
});

test('mehr Masken als erlaubt lassen sich nicht anlegen', () => {
  open();
  for (let i = 0; i < MAX_MASKS + 4; i++) state().addMask('radial');
  assert.equal(state().params.masks.length, MAX_MASKS);
  // Und die abgewiesenen Versuche haben keine leeren Verlaufsschritte erzeugt.
  assert.equal(state().past.length, MAX_MASKS);
});

test('alles zurückzusetzen ist ein Schritt und keine Einbahnstraße', () => {
  open();
  state().applyParams(
    applyValuePatch(createDefaultParams(), { exposure: 0.8, saturation: -20 }),
    'KI-Bearbeitung',
  );
  state().addMask('linear');

  state().resetAll();
  assert.equal(state().params.values.exposure, 0);
  assert.equal(state().params.masks.length, 0);

  state().undo();
  assert.equal(state().params.values.exposure, 0.8, 'die Bearbeitung war unwiederbringlich weg');
  assert.equal(state().params.masks.length, 1);
});

// ── Speichern, Neustart, Versionen (§19, §34) ──────────────────────────────

test('eine Änderung ist ungespeichert, bis sie gespeichert wurde', () => {
  open();
  assert.equal(state().dirty, false, 'ein frisch geöffnetes Projekt gilt als geändert');

  state().setValueCommitted('exposure', 0.2);
  assert.equal(state().dirty, true, 'eine Änderung wurde nicht als ungespeichert erkannt');

  state().markSaved();
  assert.equal(state().dirty, false);

  // Auch Rückgängig ist eine Änderung gegenüber dem Gespeicherten.
  state().undo();
  assert.equal(state().dirty, true, 'ein Rückgängig ging beim Speichern verloren');
});

test('ein Neustart mitten in der Bearbeitung verliert nichts Gespeichertes', () => {
  const project = open();

  state().beginGesture('Belichtung');
  state().setValue('exposure', 0.35);
  state().endGesture();
  state().setValueCommitted('highlights', -40);
  state().addMask('brush');
  const maskId = state().params.masks[0].id;
  state().beginStroke(maskId, { x: 0.4, y: 0.6 }, false);
  state().extendStroke(maskId, { x: 0.5, y: 0.62 });
  state().setMaskValue(maskId, 'exposure', 0.6);

  // Das tut die Oberfläche nach dem Zeitablauf: Parameter an den Server.
  const saved = structuredClone(state().params);
  db.updateProjectParams(project.id, saved);
  state().markSaved();

  // Neustart: Datenbank zu, Zustand weg, alles neu aufbauen.
  db.closeDatabase();
  useEditor.getState().clear();
  assert.equal(state().project, null);

  db.openDatabase();
  const reopened = db.getProject(project.id);
  useEditor.getState().loadProject(reopened);

  assert.ok(paramsEqual(state().params, saved), 'die Bearbeitung kam anders zurück');
  assert.equal(state().params.masks[0].strokes[0].points.length, 2, 'der Strich ging verloren');
  assert.equal(state().params.masks[0].values.exposure, 0.6);
  assert.equal(state().dirty, false, 'das Wiederherstellen gilt fälschlich als Änderung');
  // Kein Rückgängig in ein anderes Foto hinein.
  assert.equal(state().past.length, 0);
});

test('mehrere Versionen desselben Fotos stehen nebeneinander', () => {
  const project = open();

  state().applyParams(
    applyValuePatch(createDefaultParams(), { exposure: -0.3, contrast: 25, temperature: -40 }),
    'Cinematic',
  );
  const cinematic = structuredClone(state().params);
  db.createVersion(project.id, 'Cinematic', cinematic);

  state().applyParams(
    applyValuePatch(createDefaultParams(), { exposure: 0.15, vibrance: 20, temperature: 50 }),
    'Warm',
  );
  const warm = structuredClone(state().params);
  db.createVersion(project.id, 'Warm', warm);

  const stored = db.getProject(project.id);
  assert.equal(stored.versions.length, 2);
  // Beide greifen auf dasselbe Original zurück — es gibt kein zweites Bild.
  assert.equal(stored.photo.hash, photo.hash);

  // Eine Version zu laden ist ein Verlaufsschritt wie jeder andere.
  state().applyParams(stored.versions[0].params, `Version ${stored.versions[0].name}`);
  assert.equal(state().params.values.exposure, -0.3);
  assert.equal(undoLabel(state()), 'Version Cinematic');

  state().undo();
  assert.ok(paramsEqual(state().params, warm), 'der Stand vor dem Versionswechsel ist weg');
});

test('ein neues Projekt zu öffnen nimmt den Verlauf des alten nicht mit', () => {
  open();
  state().setValueCommitted('exposure', 0.9);
  assert.equal(state().past.length, 1);

  const other = db.createProject(photo.id, 'Zweites Projekt');
  state().loadProject(other);

  assert.equal(state().past.length, 0, 'Rückgängig führte in das vorige Foto');
  assert.equal(state().future.length, 0);
  assert.equal(state().params.values.exposure, 0);
  assert.equal(state().selectedMaskId, null);
});

// ── Robustheit (§32) ───────────────────────────────────────────────────────

test('ein unbekannter Reglername verändert nichts', () => {
  open();
  const before = structuredClone(state().params);

  state().setValue('gibtesnicht', 42);
  state().setValueCommitted('auchnicht', 42);
  state().resetParam('erfunden');

  assert.ok(paramsEqual(state().params, before));
  assert.equal(state().past.length, 0, 'ein Nichts wurde zum Verlaufsschritt');
});

test('Werte außerhalb des Bereichs werden beim Setzen begrenzt', () => {
  open();
  state().setValueCommitted('exposure', 999);
  assert.equal(state().params.values.exposure, 5);

  state().setValueCommitted('contrast', -9999);
  assert.equal(state().params.values.contrast, -100);
});

test('ein Strich in eine Maske, die es nicht gibt, läuft ins Leere', () => {
  open();
  state().addMask('linear');
  const linear = state().params.masks[0].id;

  // Auf einer Verlaufsmaske lässt sich nicht malen …
  state().beginStroke(linear, { x: 0.5, y: 0.5 }, false);
  assert.equal(state().params.masks[0].strokes.length, 0);

  // … und auf einer gelöschten erst recht nicht.
  state().removeMask(linear);
  state().beginStroke(linear, { x: 0.5, y: 0.5 }, false);
  state().extendStroke(linear, { x: 0.6, y: 0.5 });
  assert.equal(state().params.masks.length, 0);
});
