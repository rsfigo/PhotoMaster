/**
 * Schutz der Originaldatei (§4, §22 des Briefings).
 *
 * Das ist die Zusage, die am schwersten wiegt: Ein Fotograf muss darauf
 * vertrauen können, dass seine Kameradatei unangetastet bleibt. Diese Tests
 * belegen das nicht durch Zusicherung, sondern durch Versuch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'pm-storage-'));
process.env.PM_DATA_DIR = dataDir;

const storage = await import('../src/storage.ts');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

await storage.ensureDirectories();

test('ein Original liegt unter dem SHA-256 seines Inhalts', async () => {
  const content = Buffer.from('Originalfoto-Inhalt');
  const temp = storage.tempFilePath('.jpg');
  await writeFile(temp, content);

  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(content).digest('hex');

  const result = await storage.commitOriginal(temp, hash, 'jpg');
  assert.equal(result.alreadyExisted, false);
  assert.ok(result.path.includes(hash), 'Dateiname enthält den Hash nicht');
  assert.deepEqual(await readFile(result.path), content);
});

test('ein Original ist nach dem Ablegen schreibgeschützt', async () => {
  const content = Buffer.from('unveraenderlich');
  const temp = storage.tempFilePath('.jpg');
  await writeFile(temp, content);
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(content).digest('hex');

  const { path } = await storage.commitOriginal(temp, hash, 'jpg');

  const info = await stat(path);
  assert.equal(info.mode & 0o200, 0, 'Schreibbit ist noch gesetzt');

  await assert.rejects(
    () => writeFile(path, 'ZERSTOERT'),
    (err: NodeJS.ErrnoException) => err.code === 'EPERM' || err.code === 'EACCES',
    'die Datei ließ sich überschreiben',
  );

  // Der Inhalt ist nach dem Versuch unverändert.
  assert.deepEqual(await readFile(path), content);
});

test('derselbe Inhalt wird kein zweites Mal geschrieben', async () => {
  const content = Buffer.from('zweimal importiert');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(content).digest('hex');

  const first = storage.tempFilePath('.jpg');
  await writeFile(first, content);
  const a = await storage.commitOriginal(first, hash, 'jpg');
  assert.equal(a.alreadyExisted, false);

  const second = storage.tempFilePath('.jpg');
  await writeFile(second, content);
  const b = await storage.commitOriginal(second, hash, 'jpg');
  assert.equal(b.alreadyExisted, true, 'der zweite Import hätte erkannt werden müssen');
  assert.equal(a.path, b.path);
  assert.deepEqual(await readFile(b.path), content, 'der Inhalt wurde verändert');
});

test('ein bestehendes Original wird auch bei abweichendem Inhalt nicht überschrieben', async () => {
  // Der Fall kann durch einen Programmierfehler entstehen: gleicher Hash
  // übergeben, anderer Inhalt. COPYFILE_EXCL muss das abfangen.
  const original = Buffer.from('das echte Foto');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(original).digest('hex');

  const a = storage.tempFilePath('.jpg');
  await writeFile(a, original);
  const committed = await storage.commitOriginal(a, hash, 'jpg');

  const b = storage.tempFilePath('.jpg');
  await writeFile(b, Buffer.from('etwas voellig anderes'));
  const second = await storage.commitOriginal(b, hash, 'jpg');

  assert.equal(second.alreadyExisted, true);
  assert.deepEqual(await readFile(committed.path), original, 'das Original wurde ersetzt');
});

test('die temporäre Datei wird in jedem Fall aufgeräumt', async () => {
  const temp = storage.tempFilePath('.jpg');
  await writeFile(temp, 'x');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update('x').digest('hex');
  await storage.commitOriginal(temp, hash, 'jpg');
  assert.equal(await storage.exists(temp), false, 'temporäre Datei blieb liegen');
});

test('Exportnamen können nicht aus dem Exportverzeichnis ausbrechen', () => {
  // Der Name kommt aus einer Nutzereingabe.
  for (const evil of ['../../geheim.jpg', '..\\..\\geheim.jpg', 'a/b/c.jpg']) {
    const resolved = storage.exportPath(evil);
    assert.ok(
      resolved.startsWith(dataDir),
      `Pfad verlässt das Datenverzeichnis: ${evil} -> ${resolved}`,
    );
  }
});

test('Dateiendungen werden auf bekannte Formate normalisiert', () => {
  assert.equal(storage.extensionOf('DSC_1234.JPG'), 'jpg');
  assert.equal(storage.extensionOf('foto.jpeg'), 'jpg');
  assert.equal(storage.extensionOf('scan.TIFF'), 'tif');
  assert.equal(storage.extensionOf('raw.NEF'), 'nef');
  // Unbekanntes wird nicht durchgereicht.
  assert.equal(storage.extensionOf('schadcode.exe'), 'bin');
  assert.equal(storage.extensionOf('ohne-endung'), 'bin');
});

// ── Auskunft und Aufräumen (§30) ───────────────────────────────────────────

test('der Platzbedarf eines Verzeichnisses wird einschließlich Unterordner gezählt', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { paths } = await import('../src/config.ts');

  // Vorschauen liegen je Foto in einem eigenen Unterordner — eine Zählung nur
  // auf der obersten Ebene würde sie komplett übersehen.
  await mkdir(join(paths.previews, 'abc123'), { recursive: true });
  await writeFile(join(paths.previews, 'abc123', 'preview.jpg'), Buffer.alloc(5000, 1));
  await writeFile(join(paths.previews, 'abc123', 'thumb.jpg'), Buffer.alloc(1200, 1));

  assert.equal(await storage.directorySize(join(paths.previews)), 6200);

  // Ein Verzeichnis, das es nie gab, ist kein Fehler, sondern null Byte.
  assert.equal(await storage.directorySize(join(dataDir, 'gibt-es-nicht')), 0);
});

test('Exporte aufräumen lässt Originale und Vorschauen unangetastet', async () => {
  const { paths } = await import('../src/config.ts');
  const { createHash } = await import('node:crypto');

  // Ein echtes Original ablegen …
  const content = Buffer.from('darf-niemals-verschwinden');
  const temp = storage.tempFilePath('.jpg');
  await writeFile(temp, content);
  const hash = createHash('sha256').update(content).digest('hex');
  const original = await storage.commitOriginal(temp, hash, 'jpg');

  // … und zwei Exporte daneben.
  await writeFile(storage.exportPath('a.jpg'), Buffer.alloc(3000, 2));
  await writeFile(storage.exportPath('b.png'), Buffer.alloc(7000, 2));

  const before = await storage.directorySize(paths.previews);
  const result = await storage.clearExports();

  assert.equal(result.removed, 2);
  assert.equal(result.freedBytes, 10000);
  assert.equal(await storage.directorySize(paths.exports), 0);

  // Der eigentliche Punkt: Was nicht Export ist, ist noch da.
  assert.deepEqual(await readFile(original.path), content, 'das Original wurde angetastet');
  assert.equal(await storage.directorySize(paths.previews), before, 'Vorschauen verschwanden');

  // Ein zweiter Aufruf auf einem leeren Verzeichnis meldet schlicht nichts.
  assert.deepEqual(await storage.clearExports(), { removed: 0, freedBytes: 0 });
});

test('ein abgebrochener Upload hinterlässt keine halbe Datei', async () => {
  const { Readable } = await import('node:stream');
  const { paths } = await import('../src/config.ts');
  const { readdir } = await import('node:fs/promises');

  // Ein Datenstrom, der mitten im Upload abreißt — wie beim Schließen des Tabs.
  const broken = new Readable({
    read() {
      this.push(Buffer.alloc(64 * 1024, 1));
      this.destroy(new Error('Verbindung getrennt'));
    },
  });

  const before = (await readdir(paths.tmp)).length;
  await assert.rejects(() => storage.writeTempFromStream(broken, '.nef'));
  assert.equal((await readdir(paths.tmp)).length, before, 'die halbe Datei blieb in tmp/ liegen');
});

test('Reste eines unterbrochenen Vorgangs verschwinden beim Start', async () => {
  const { paths } = await import('../src/config.ts');
  const { readdir } = await import('node:fs/promises');

  await writeFile(join(paths.tmp, 'abgestuerzt-1.jpg'), Buffer.alloc(1000));
  await writeFile(join(paths.tmp, 'abgestuerzt-2.nef'), Buffer.alloc(2000));

  const removed = await storage.clearTempFiles();
  assert.equal(removed, 2);
  assert.deepEqual(await readdir(paths.tmp), []);
});
