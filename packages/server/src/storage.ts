/**
 * Ablage auf der Festplatte.
 *
 * Der zentrale Punkt dieses Moduls ist der Schutz des Originals (§4, §22):
 *
 *  1. Originale liegen unter ihrem SHA-256-Hash. Der Dateiname ergibt sich aus
 *     dem INHALT — eine geänderte Datei bekommt zwangsläufig einen anderen
 *     Namen und kann die alte nicht ersetzen.
 *  2. Geschrieben wird mit `COPYFILE_EXCL`. Existiert der Zielname bereits,
 *     schlägt der Aufruf fehl, statt zu überschreiben. Ein identisches Foto
 *     zweimal zu importieren ist damit ein No-Op, kein Datenverlust.
 *  3. Nach dem Ablegen wird die Datei schreibgeschützt gesetzt.
 *  4. Es gibt in der gesamten Anwendung genau eine Funktion, die nach
 *     `originals/` schreibt — diese hier.
 */

import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { paths } from './config.ts';
import { AppError } from './errors.ts';

export async function ensureDirectories(): Promise<void> {
  for (const dir of [paths.originals, paths.working, paths.previews, paths.exports, paths.tmp]) {
    await mkdir(dir, { recursive: true });
  }
}

export function tempFilePath(suffix = ''): string {
  return join(paths.tmp, `${randomUUID()}${suffix}`);
}

/** Schreibt einen Stream in eine temporäre Datei und liefert Hash und Größe. */
export async function writeTempFromStream(
  source: NodeJS.ReadableStream,
  suffix: string,
): Promise<{ path: string; hash: string; bytes: number }> {
  const path = tempFilePath(suffix);
  const hash = createHash('sha256');
  let bytes = 0;

  const sink = createWriteStream(path);
  await pipeline(
    source,
    async function* (chunks) {
      for await (const chunk of chunks) {
        const buf = chunk as Buffer;
        hash.update(buf);
        bytes += buf.length;
        yield buf;
      }
    },
    sink,
  );

  return { path, hash: hash.digest('hex'), bytes };
}

export function originalPath(hash: string, ext: string): string {
  return join(paths.originals, `${hash}.${normalizeExt(ext)}`);
}

export function previewDir(hash: string): string {
  return join(paths.previews, hash);
}

export function previewPath(hash: string): string {
  return join(previewDir(hash), 'preview.jpg');
}

export function analysisPath(hash: string): string {
  return join(previewDir(hash), 'analysis.jpg');
}

export function thumbPath(hash: string): string {
  return join(previewDir(hash), 'thumb.jpg');
}

export function exportPath(fileName: string): string {
  // Der Dateiname kommt aus einer Nutzereingabe — Pfadtrenner und
  // Verzeichniswechsel werden entfernt, bevor er zu einem Pfad wird.
  const safe = fileName.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
  const full = resolve(paths.exports, safe);
  if (!full.startsWith(resolve(paths.exports))) {
    throw new AppError('BAD_REQUEST', 'Ungültiger Dateiname für den Export.');
  }
  return full;
}

/**
 * Legt eine temporäre Datei als unveränderliches Original ab.
 * Existiert der Hash bereits, bleibt die vorhandene Datei unangetastet.
 */
export async function commitOriginal(
  tempPath: string,
  hash: string,
  ext: string,
): Promise<{ path: string; alreadyExisted: boolean }> {
  const target = originalPath(hash, ext);
  try {
    await copyFile(tempPath, target, constants.COPYFILE_EXCL);
    // Schreibschutz als zweite Sicherung: Selbst ein fehlerhafter
    // Schreibzugriff irgendwo im Code würde hier auf ein EPERM laufen.
    await chmod(target, 0o444).catch(() => {});
    return { path: target, alreadyExisted: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { path: target, alreadyExisted: true };
    }
    throw err;
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function fileSize(path: string): Promise<number> {
  const s = await stat(path);
  return s.size;
}

/**
 * Summiert den Platzbedarf eines Verzeichnisses (§30).
 *
 * Ein fehlendes Verzeichnis ist kein Fehler, sondern schlicht 0 Byte — die
 * Auskunft darf nicht daran scheitern, dass noch nie exportiert wurde.
 */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else {
      total += await stat(full)
        .then((s) => s.size)
        .catch(() => 0);
    }
  }
  return total;
}

/**
 * Leert das Exportverzeichnis.
 *
 * Bewusst die EINZIGE Aufräumfunktion der Anwendung, und bewusst auf
 * `paths.exports` festverdrahtet: Sie bekommt kein Verzeichnis übergeben, das
 * jemand versehentlich auf `originals/` zeigen lassen könnte. Exporte sind
 * jederzeit neu erzeugbar — Originale nicht.
 */
export async function clearExports(): Promise<{ removed: number; freedBytes: number }> {
  let entries: Dirent[];
  try {
    entries = await readdir(paths.exports, { withFileTypes: true });
  } catch {
    return { removed: 0, freedBytes: 0 };
  }

  let removed = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(paths.exports, entry.name);
    const size = await stat(full)
      .then((s) => s.size)
      .catch(() => 0);
    try {
      await rm(full, { force: true });
      removed += 1;
      freedBytes += size;
    } catch {
      // Eine Datei, die das Betriebssystem gerade festhält, bleibt eben liegen.
    }
  }
  return { removed, freedBytes };
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function removeFile(path: string): Promise<void> {
  // Der Schreibschutz aus commitOriginal verhindert auch das Löschen —
  // beim ausdrücklichen Entfernen eines Fotos muss er zurückgenommen werden.
  await chmod(path, 0o644).catch(() => {});
  await rm(path, { force: true });
}

const EXT_ALIASES: Record<string, string> = {
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  heic: 'heic',
  heif: 'heif',
  avif: 'avif',
  tif: 'tif',
  tiff: 'tif',
  nef: 'nef',
  cr2: 'cr2',
  cr3: 'cr3',
  arw: 'arw',
  dng: 'dng',
  raf: 'raf',
  rw2: 'rw2',
  orf: 'orf',
  pef: 'pef',
  srw: 'srw',
};

function normalizeExt(ext: string): string {
  const clean = ext.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return EXT_ALIASES[clean] ?? 'bin';
}

export function extensionOf(fileName: string): string {
  const m = /\.([^.]+)$/.exec(fileName);
  return m ? normalizeExt(m[1]) : 'bin';
}

export const RAW_EXTENSIONS = new Set(['nef', 'cr2', 'cr3', 'arw', 'dng', 'raf', 'rw2', 'orf', 'pef', 'srw']);
