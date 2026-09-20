/**
 * Datenbank: Projekte, Versionen und die Schema-Migration.
 *
 * Der Migrationstest ist der wichtigste hier: Eine Datenbank aus einer älteren
 * Programmversion darf beim Öffnen nicht mit "no such column" abbrechen —
 * das würde sämtliche Projekte des Nutzers unerreichbar machen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = await mkdtemp(join(tmpdir(), 'pm-db-'));
process.env.PM_DATA_DIR = dataDir;

// Eine Datenbank im Stand einer ÄLTEREN Version anlegen: das Schema von
// damals, ohne die später hinzugekommenen Spalten.
const dbPath = join(dataDir, 'photomaster.db');
{
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
      format TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, orientation INTEGER NOT NULL DEFAULT 1,
      has_exif INTEGER NOT NULL DEFAULT 0, has_icc INTEGER NOT NULL DEFAULT 0, icc_profile TEXT,
      camera_json TEXT NOT NULL DEFAULT '{}', source_json TEXT NOT NULL DEFAULT '{}',
      preview_width INTEGER NOT NULL, preview_height INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO photos VALUES ('p1','hash1','Alt.jpg','jpeg','image/jpeg',1000,
      4000,3000,1,1,0,NULL,'{"model":"D3200"}','{"kind":"direct","width":4000,"height":3000}',
      2560,1920,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');
  `);
  old.close();
}

const db = await import('../src/db.ts');
const { createDefaultParams, applyValuePatch } = await import('@photomaster/shared');

test.after(async () => {
  db.closeDatabase();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('eine Datenbank aus einer älteren Version bleibt lesbar', () => {
  db.openDatabase();

  // Die fehlenden Spalten wurden ergänzt …
  const photo = db.getPhoto('p1');
  assert.equal(photo.originalName, 'Alt.jpg');
  assert.equal(photo.width, 4000);
  assert.equal(photo.storageExt, 'bin', 'neue Spalte hat keinen Default bekommen');
  // … und die bestehenden Daten sind unversehrt.
  assert.equal(photo.megapixels, 12);
});

test('ein zweiter Aufruf der Migration ist folgenlos', () => {
  db.openDatabase();
  db.openDatabase();
  assert.equal(db.getPhoto('p1').originalName, 'Alt.jpg');
});

test('Projekte und Versionen teilen sich ein Original', () => {
  const a = db.createProject('p1', 'Natürlich');
  const b = db.createProject('p1', 'Cinematic');
  assert.notEqual(a.id, b.id);
  assert.equal(a.photo.hash, b.photo.hash, 'unterschiedliche Originale');

  // Eine Version ist ein Parametersatz, kein zweites Bild.
  const params = applyValuePatch(createDefaultParams(), { exposure: -0.4, contrast: 20 });
  const version = db.createVersion(a.id, 'Dunkel', params);
  assert.equal(version.params.values.exposure, -0.4);
  assert.equal(version.params.values.contrast, 20);

  const stored = db.getProject(a.id);
  assert.equal(stored.versions.length, 1);
  assert.equal(stored.versions[0].name, 'Dunkel');
});

test('eine Version umzubenennen verändert ihre Parameter nicht', () => {
  const project = db.createProject('p1', 'Test');
  const params = applyValuePatch(createDefaultParams(), { clarity: 35, vibrance: 18 });
  const version = db.createVersion(project.id, 'Erste', params);

  const renamed = db.updateVersion(version.id, { name: 'Neuer Name' });

  assert.equal(renamed.name, 'Neuer Name');
  assert.equal(renamed.params.values.clarity, 35, 'Parameter gingen beim Umbenennen verloren');
  assert.equal(renamed.params.values.vibrance, 18);
});

test('ein Projekt zu löschen entfernt das Original nicht aus der Datenbank', () => {
  const first = db.createProject('p1', 'Eins');
  const second = db.createProject('p1', 'Zwei');

  const result = db.deleteProject(first.id);
  assert.equal(result.photoStillUsed, true, 'das zweite Projekt nutzt das Foto weiter');
  // Das Foto ist weiterhin da.
  assert.equal(db.getPhoto('p1').id, 'p1');
  assert.equal(db.getProject(second.id).name, 'Zwei');
});

test('unsinnige gespeicherte Parameter werden beim Laden repariert', () => {
  const project = db.createProject('p1', 'Kaputt');
  // Direkter Eingriff in die Datenbank, wie ihn eine fehlerhafte ältere
  // Version oder ein Schreibfehler hinterlassen könnte.
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE projects SET params_json = ? WHERE id = ?').run(
    JSON.stringify({ values: { exposure: 'kaputt', contrast: 500, erfunden: 1 } }),
    project.id,
  );
  raw.close();

  const loaded = db.getProject(project.id);
  assert.equal(loaded.params.values.exposure, 0, 'ungültiger Wert wurde nicht ersetzt');
  assert.equal(loaded.params.values.contrast, 100, 'Wert wurde nicht begrenzt');
  assert.equal(loaded.params.values.erfunden, undefined);
});

test('ein unbekanntes Projekt liefert eine verständliche Fehlermeldung', () => {
  assert.throws(
    () => db.getProject('gibt-es-nicht'),
    (err: Error) => /nicht gefunden/.test(err.message),
  );
});
