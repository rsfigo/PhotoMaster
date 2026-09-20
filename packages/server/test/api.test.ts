/**
 * Die HTTP-Schnittstelle (§33, §34, §40).
 *
 * Bis hierher war jeder Baustein für sich geprüft — die Ablage, die
 * Validierung, der Encoder. Ungetestet blieb die Naht dazwischen: genau der
 * Vertrag, auf den sich die Oberfläche verlässt. Ein Foto importieren,
 * bearbeiten, in Versionen ablegen und exportieren ist EIN Weg, und er muss
 * als Ganzes stimmen.
 *
 * Gebaut wird die echte Anwendung aus `app.ts` und über `inject()` befragt —
 * ohne Port, aber mit derselben Fehlerbehandlung, demselben Multipart-Parser
 * und denselben Routen wie im Betrieb.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';

const dataDir = await mkdtemp(join(tmpdir(), 'pm-api-'));
process.env.PM_DATA_DIR = dataDir;
delete process.env.ANTHROPIC_API_KEY;

const storage = await import('../src/storage.ts');
const db = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');

await storage.ensureDirectories();
db.openDatabase();
const app: FastifyInstance = await buildApp({ logger: false });

test.after(async () => {
  await app.close();
  db.closeDatabase();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Hilfsmittel ────────────────────────────────────────────────────────────

/** Baut einen Multipart-Körper von Hand — ohne zusätzliche Abhängigkeit. */
function multipart(fileName: string, content: Buffer, mime = 'image/jpeg') {
  const boundary = '----PhotoMasterTestBoundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Ein Foto mit hellem Himmel und dunklem Vordergrund, wie in den anderen Tests. */
async function photoBytes(width: number, height: number, seed = 0): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const bright = y < height * 0.5;
      buf[i] = (bright ? 210 : 30) + ((x + seed) % 45);
      buf[i + 1] = bright ? 205 : 28;
      buf[i + 2] = bright ? 230 : 24;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } })
    .withExif({ IFD0: { Make: 'NIKON CORPORATION', Model: 'NIKON D3200' } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

function rgba(width: number, height: number): Buffer {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = (i / 4) % 256;
    px[i + 1] = 140;
    px[i + 2] = 90;
    px[i + 3] = 255;
  }
  return px;
}

const body = (res: { payload: string }) => JSON.parse(res.payload);

// ── Import (§7) ────────────────────────────────────────────────────────────

const imported = await app.inject({
  method: 'POST',
  url: '/api/photos',
  ...multipart('DSC_4711.JPG', await photoBytes(1600, 1200)),
});

const projectId: string = body(imported).project.id;
const photoHash: string = body(imported).project.photo.hash;

test('ein Foto zu importieren legt Original, Vorschauen und ein Projekt an', async () => {
  assert.equal(imported.statusCode, 201);
  const { project } = body(imported);

  assert.equal(project.name, 'DSC_4711', 'die Endung gehört nicht in den Projektnamen');
  assert.equal(project.photo.width, 1600);
  assert.equal(project.photo.height, 1200);
  assert.equal(project.photo.camera.model, 'NIKON D3200');
  assert.equal(project.photo.source.kind, 'direct', 'ein JPEG braucht keine Arbeitskopie');

  // Das Original liegt schreibgeschützt unter seinem Hash.
  const original = storage.originalPath(project.photo.hash, project.photo.storageExt);
  const mode = (await stat(original)).mode & 0o222;
  assert.equal(mode, 0, 'das Original ist beschreibbar geblieben');

  // Vorschau, Analysebild und Miniatur sind da.
  for (const p of [
    storage.previewPath(project.photo.hash),
    storage.analysisPath(project.photo.hash),
    storage.thumbPath(project.photo.hash),
  ]) {
    assert.ok(await storage.exists(p), `${p} fehlt`);
  }
});

test('dasselbe Foto ein zweites Mal legt kein zweites Original an', async () => {
  const before = (await readdir(join(dataDir, 'originals'))).length;

  const again = await app.inject({
    method: 'POST',
    url: '/api/photos',
    ...multipart('DSC_4711_kopie.JPG', await photoBytes(1600, 1200)),
  });

  assert.equal(again.statusCode, 201);
  const { project, warnings } = body(again);
  assert.equal(project.photo.hash, photoHash, 'derselbe Inhalt ergab einen anderen Hash');
  assert.notEqual(project.id, projectId, 'es entstand kein eigenes Projekt');
  assert.ok(
    warnings.some((w: string) => /bereits vorhanden/.test(w)),
    'der Nutzer wurde nicht darauf hingewiesen',
  );
  assert.equal((await readdir(join(dataDir, 'originals'))).length, before);
});

test('eine kaputte Datei wird abgewiesen und hinterlässt kein verwaistes Original', async () => {
  const before = (await readdir(join(dataDir, 'originals'))).length;

  const res = await app.inject({
    method: 'POST',
    url: '/api/photos',
    ...multipart('kaputt.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(9000, 7)])),
  });

  assert.ok(res.statusCode >= 400 && res.statusCode < 500, `Status ${res.statusCode}`);
  const message = body(res).error.message;
  assert.match(message, /konnte nicht gelesen werden/);
  assert.doesNotMatch(message, /vips|jpeg_|premature|Error:/i, 'technischer Jargon in der Meldung');

  // Der Import bricht ab, NACHDEM das Original schon abgelegt wurde — es muss
  // wieder verschwinden, sonst sammeln sich unerreichbare Dateien an.
  assert.equal(
    (await readdir(join(dataDir, 'originals'))).length,
    before,
    'eine unbrauchbare Datei blieb in originals/ liegen',
  );
});

test('eine Datei mit unbekannter Endung wird gar nicht erst gelesen', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/photos',
    ...multipart('notizen.txt', Buffer.from('kein Foto'), 'text/plain'),
  });

  assert.equal(res.statusCode, 415);
  assert.match(body(res).error.message, /wird nicht unterstützt/);
  // Und die Meldung sagt, was stattdessen geht.
  assert.match(body(res).error.message, /JPEG/);
});

test('die Vorschau wird ausgeliefert und darf dauerhaft zwischengespeichert werden', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/photos/${photoHash}/preview` });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  // Der Inhalt ist über den Hash adressiert und kann sich nie ändern.
  assert.match(String(res.headers['cache-control']), /immutable/);
  assert.ok(res.rawPayload.length > 1000);

  const fehlt = await app.inject({ method: 'GET', url: '/api/photos/gibtesnicht/preview' });
  assert.equal(fehlt.statusCode, 404);
  assert.match(body(fehlt).error.message, /Vorschau/);
});

// ── Bearbeiten und Speichern (§5, §22) ─────────────────────────────────────

test('Reglerwerte überstehen den Weg durch die Schnittstelle', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${projectId}`,
    payload: { params: { values: { exposure: 0.35, highlights: -40, vibrance: 18 } } },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res).issues, []);

  const geladen = await app.inject({ method: 'GET', url: `/api/projects/${projectId}` });
  const values = body(geladen).project.params.values;
  assert.equal(values.exposure, 0.35);
  assert.equal(values.highlights, -40);
  assert.equal(values.vibrance, 18);
});

test('unsinnige Werte werden begrenzt und der Client erfährt davon', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${projectId}`,
    payload: { params: { values: { exposure: 999999, contrast: 'ziemlich viel', erfunden: 3 } } },
  });

  assert.equal(res.statusCode, 200, 'eine unsinnige Eingabe darf nicht zum Fehler führen');
  const { project, issues } = body(res);
  assert.equal(project.params.values.exposure, 5, 'der Wert wurde nicht begrenzt');
  assert.equal(project.params.values.erfunden, undefined);
  assert.ok(issues.length > 0, 'die Korrekturen wurden verschwiegen');

  // Zurück auf einen brauchbaren Stand für die folgenden Tests.
  await app.inject({
    method: 'PATCH',
    url: `/api/projects/${projectId}`,
    payload: { params: { values: { exposure: 0.35, highlights: -40 } } },
  });
});

test('ein leerer Projektname wird abgelehnt, statt ein namenloses Projekt zu erzeugen', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${projectId}`,
    payload: { name: '   ' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(body(res).error.message, /1 und 120 Zeichen/);
});

test('ein unbekanntes Projekt und eine unbekannte Adresse antworten verständlich', async () => {
  const projekt = await app.inject({ method: 'GET', url: '/api/projects/gibt-es-nicht' });
  assert.equal(projekt.statusCode, 404);
  assert.match(body(projekt).error.message, /Projekt wurde nicht gefunden/);

  const adresse = await app.inject({ method: 'GET', url: '/api/voellig-falsch' });
  assert.equal(adresse.statusCode, 404);
  assert.match(body(adresse).error.message, /Adresse/);
});

// ── Versionen (§19) ────────────────────────────────────────────────────────

test('Versionen stehen nebeneinander und greifen auf dasselbe Original zurück', async () => {
  const erste = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/versions`,
    payload: { name: 'Cinematic', params: { values: { exposure: -0.3, contrast: 25 } } },
  });
  assert.equal(erste.statusCode, 201);

  const zweite = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/versions`,
    payload: { name: 'Warm', params: { values: { temperature: 40, vibrance: 20 } } },
  });
  assert.equal(zweite.statusCode, 201);

  const { project } = body(zweite);
  assert.equal(project.versions.length, 2);
  assert.equal(project.photo.hash, photoHash, 'eine Version hat ein eigenes Foto bekommen');

  // Eine Version zu aktivieren macht sie zum Arbeitsstand.
  const cinematicId = body(erste).version.id;
  const aktiviert = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/versions/${cinematicId}/activate`,
  });
  assert.equal(aktiviert.statusCode, 200);
  assert.equal(body(aktiviert).project.params.values.exposure, -0.3);
  assert.equal(body(aktiviert).project.activeVersionId, cinematicId);
});

test('eine Version umzubenennen lässt ihre Parameter unberührt', async () => {
  const angelegt = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/versions`,
    payload: { name: 'Erste', params: { values: { clarity: 35 } } },
  });
  const versionId = body(angelegt).version.id;

  const umbenannt = await app.inject({
    method: 'PATCH',
    url: `/api/versions/${versionId}`,
    payload: { name: 'Neuer Name' },
  });

  assert.equal(body(umbenannt).version.name, 'Neuer Name');
  assert.equal(body(umbenannt).version.params.values.clarity, 35, 'die Bearbeitung ging verloren');

  await app.inject({ method: 'DELETE', url: `/api/versions/${versionId}` });
});

// ── Export (§20, §21) ──────────────────────────────────────────────────────

test('der Export liefert die volle Auflösung und einen vollständigen Vergleich', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/export?width=1600&height=1200&format=jpeg&quality=100&fileName=Testbild`,
    payload: rgba(1600, 1200),
    headers: { 'content-type': 'application/octet-stream' },
  });

  assert.equal(res.statusCode, 200);
  const { report, original } = body(res);

  assert.equal(report.width, 1600);
  assert.equal(report.height, 1200);
  assert.equal(report.chromaSubsampling, '4:4:4', 'die Farbauflösung wurde halbiert');
  // §21: Original und Ergebnis müssen nebeneinander stehen können.
  assert.equal(original.width, 1600);
  assert.equal(original.height, 1200);
  assert.ok(original.bytes > 0);

  // Die Datei liegt wirklich da und hat die angegebenen Maße.
  const geschrieben = await sharp(storage.exportPath(report.fileName)).metadata();
  assert.equal(geschrieben.width, 1600);
  assert.equal(geschrieben.height, 1200);

  // Und sie lässt sich herunterladen.
  const download = await app.inject({ method: 'GET', url: `/api/exports/${report.fileName}` });
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers['content-disposition']), /attachment/);
});

test('ein Export ohne Bilddaten oder ohne Maße wird abgewiesen', async () => {
  const ohneMasse = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/export?format=jpeg`,
    payload: rgba(8, 8),
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(ohneMasse.statusCode, 400);
  assert.match(body(ohneMasse).error.message, /Bildmaße/);

  // Zu wenig Pixel für die angegebenen Maße — darf keine Datei aus Datenmüll
  // erzeugen, und muss die Zusage zum Original wiederholen (§29).
  const zuWenig = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/export?width=1600&height=1200&format=jpeg`,
    payload: rgba(10, 10),
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.ok(zuWenig.statusCode >= 400);
  assert.match(body(zuWenig).error.message, /Originalfoto wurde nicht verändert/);
});

test('ein Exportname kann nicht aus dem Exportverzeichnis ausbrechen', async () => {
  const res = await app.inject({
    method: 'POST',
    url:
      `/api/projects/${projectId}/export?width=64&height=64&format=jpeg` +
      `&fileName=${encodeURIComponent('../../../boese')}`,
    payload: rgba(64, 64),
    headers: { 'content-type': 'application/octet-stream' },
  });

  assert.equal(res.statusCode, 200);
  const name: string = body(res).report.fileName;
  assert.doesNotMatch(name, /\.\.|[/\\]/, `Dateiname enthält einen Pfad: ${name}`);

  // Der gemeldete Name muss der Name auf der Platte sein. Die Ablage säubert
  // ihn ein zweites Mal — käme dabei etwas anderes heraus, suchte der Nutzer
  // im Ordner nach einer Datei, die dort anders heißt.
  assert.ok(
    await storage.exists(join(dataDir, 'exports', name)),
    `der gemeldete Name ${name} liegt so nicht in exports/`,
  );

  // Ein Wunschname, von dem nichts Brauchbares übrig bleibt, fällt auf einen
  // Ersatznamen zurück, statt eine Datei ohne Namen zu erzeugen.
  const leer = await app.inject({
    method: 'POST',
    url:
      `/api/projects/${projectId}/export?width=64&height=64&format=png` +
      `&fileName=${encodeURIComponent('....')}`,
    payload: rgba(64, 64),
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.match(body(leer).report.fileName, /^export_[\d\-T]+\.png$/);
});

// ── Analyse, KI und Presets ────────────────────────────────────────────────

test('die Bildstatistik wird abgelegt und beim Laden mitgeliefert', async () => {
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

  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/analysis`,
    payload: { stats },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).analysis.stats.clippedHighlights, 0.041);

  const geladen = await app.inject({ method: 'GET', url: `/api/projects/${projectId}` });
  assert.equal(body(geladen).project.analysis.stats.meanLuma, 0.42);
});

test('ohne API-Schlüssel sagen Status und Aufruf dasselbe — und nichts geht raus', async () => {
  const status = await app.inject({ method: 'GET', url: '/api/ai/status' });
  assert.equal(body(status).available, false);
  assert.match(body(status).reason, /ANTHROPIC_API_KEY/);

  // Der Knopf, den es in der Oberfläche gar nicht gibt, darf auch über die
  // Schnittstelle nicht in einen halben Zustand führen (§39).
  const edit = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/ai/edit`,
    payload: { mode: 'auto' },
  });
  assert.equal(edit.statusCode, 503);
  assert.match(body(edit).error.message, /nicht eingerichtet/);
  assert.match(body(edit).error.message, /bleiben erhalten/);

  // Die gespeicherte Bearbeitung ist unangetastet geblieben.
  const danach = await app.inject({ method: 'GET', url: `/api/projects/${projectId}` });
  assert.equal(body(danach).project.params.values.exposure, -0.3);
});

test('Presets kommen nach Kategorien geordnet', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/presets' });
  assert.equal(res.statusCode, 200);
  const { categories, count } = body(res);
  assert.equal(count, 18, 'die Zahl der Presets hat sich geändert — README prüfen');
  assert.ok(categories.length >= 5);
  assert.ok(categories[0].presets.length > 0);
});

test('die Fähigkeiten nennen nur Formate, die dieser Rechner öffnen kann', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
  const caps = body(res);

  assert.ok(caps.inputFormats.includes('JPEG'));
  assert.equal(
    caps.inputFormats.includes('HEIF'),
    caps.heifDecodable,
    'die Formatliste und die gemessene Fähigkeit widersprechen sich',
  );
  assert.equal(caps.ai.available, false);
  assert.ok(caps.maxUploadBytes > 0);
});

// ── Projekt schließen (§22, §30) ───────────────────────────────────────────

test('ein Projekt zu schließen löscht die Originaldatei nicht', async () => {
  const eigenes = await app.inject({
    method: 'POST',
    url: '/api/photos',
    ...multipart('DSC_0002.JPG', await photoBytes(800, 600, 13)),
  });
  const zuLoeschen = body(eigenes).project;
  const original = storage.originalPath(zuLoeschen.photo.hash, zuLoeschen.photo.storageExt);
  assert.ok(await storage.exists(original));

  const res = await app.inject({ method: 'DELETE', url: `/api/projects/${zuLoeschen.id}` });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).deleted, true);
  assert.equal(body(res).photoStillUsed, false, 'kein anderes Projekt nutzt dieses Foto');

  // Genau das ist die Zusage: Das Projekt ist weg, die Kameradatei nicht.
  assert.ok(
    await storage.exists(original),
    'die Originaldatei wurde beim Schließen des Projekts gelöscht',
  );
});
