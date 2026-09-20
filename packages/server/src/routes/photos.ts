/**
 * Import und Auslieferung von Bilddateien.
 */

import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.ts';
import { AppError, toAppError } from '../errors.ts';
import { createProject, findPhotoByHash, getPhoto, insertPhoto } from '../db.ts';
import { ingest, mimeFor, workingFilePath } from '../ingest.ts';
import { readMetadata } from '../metadata.ts';
import {
  analysisPath,
  commitOriginal,
  exists,
  extensionOf,
  originalPath,
  previewPath,
  removeFile,
  thumbPath,
  writeTempFromStream,
} from '../storage.ts';
import type { PhotoMeta } from '@photomaster/shared';

/**
 * Pfad zu den Bilddaten in voller Auflösung.
 *
 * Bei JPEG/PNG/WebP ist das die Originaldatei selbst — der Browser dekodiert
 * sie direkt, ohne dass sie je durch einen zweiten Encoder läuft. Nur wo der
 * Browser das Format nicht lesen kann, wird die verlustfreie Arbeitskopie
 * ausgeliefert.
 */
function fullResolutionSource(photo: PhotoMeta): { path: string; mime: string } {
  switch (photo.source.kind) {
    case 'converted':
      return { path: workingFilePath(photo.hash, 'png'), mime: 'image/png' };
    case 'raw-preview':
      return { path: workingFilePath(photo.hash, 'jpg'), mime: 'image/jpeg' };
    default:
      return {
        path: originalPath(photo.hash, photo.storageExt),
        mime: mimeFor(photo.format),
      };
  }
}

/** Datei, aus der die EXIF-Daten für den Export übernommen werden. */
export function metadataSource(photo: PhotoMeta): string | null {
  if (photo.source.kind === 'raw-preview') return workingFilePath(photo.hash, 'jpg');
  if (photo.format === 'jpeg') return originalPath(photo.hash, photo.storageExt);
  return null;
}

export async function photoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Import eines Fotos. Legt Original, Vorschauen und ein Projekt an.
   *
   * Ablauf mit Blick auf den Originalschutz:
   *   1. Upload landet zuerst in einer temporären Datei; dabei wird der
   *      SHA-256 im Durchlauf berechnet.
   *   2. Ist der Hash bereits bekannt, wird nichts geschrieben — es entsteht
   *      nur ein zweites Projekt auf demselben Original.
   *   3. Andernfalls wird die Datei mit COPYFILE_EXCL abgelegt und
   *      schreibgeschützt.
   */
  app.post('/api/photos', async (request, reply) => {
    const data = await request.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!data) {
      throw new AppError('BAD_REQUEST', 'Es wurde keine Datei übertragen.');
    }

    const originalName = basename(data.filename || 'foto');
    const ext = extensionOf(originalName);
    if (ext === 'bin') {
      throw new AppError(
        'UNSUPPORTED_FORMAT',
        `Das Format der Datei "${originalName}" wird nicht unterstützt. Unterstützt werden JPEG, PNG, WebP, HEIC, TIFF und die Vorschau aus gängigen RAW-Dateien.`,
      );
    }

    let temp: { path: string; hash: string; bytes: number };
    try {
      temp = await writeTempFromStream(data.file, `.${ext}`);
    } catch (err) {
      throw toAppError(err, 'Die Datei konnte nicht entgegengenommen werden.');
    }

    if (data.file.truncated) {
      await removeFile(temp.path);
      throw new AppError(
        'FILE_TOO_LARGE',
        `Diese Datei ist größer als das erlaubte Maximum von ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`,
      );
    }

    const warnings: string[] = [];
    let photo = findPhotoByHash(temp.hash);

    if (photo) {
      // Identisches Foto — Original nicht erneut schreiben.
      await removeFile(temp.path);
      warnings.push('Dieses Foto ist bereits vorhanden. Es wurde ein weiteres Projekt darauf angelegt.');
    } else {
      const committed = await commitOriginal(temp.path, temp.hash, ext);
      try {
        const meta = await readMetadata(committed.path);
        const result = await ingest(committed.path, ext, {
          width: meta.declaredWidth,
          height: meta.declaredHeight,
        });
        warnings.push(...result.warnings);

        photo = insertPhoto({
          hash: temp.hash,
          originalName,
          format: result.format,
          storageExt: ext,
          mimeType: result.fullResMime,
          bytes: temp.bytes,
          width: result.width,
          height: result.height,
          orientation: meta.orientation,
          hasExif: meta.hasExif,
          hasIcc: result.hasIcc,
          iccProfile: result.iccProfile,
          camera: meta.camera,
          source: result.source,
          previewWidth: result.previewWidth,
          previewHeight: result.previewHeight,
        });
      } catch (err) {
        // Der Import ist gescheitert — die schon abgelegte Originaldatei
        // wieder entfernen, damit kein verwaister Blob zurückbleibt. Das ist
        // der einzige Pfad, der eine Datei aus `originals/` löscht, und er
        // greift nur für eine Datei, die es vor dieser Anfrage nicht gab.
        if (!committed.alreadyExisted) await removeFile(committed.path);
        throw toAppError(err, 'Dieses Bild konnte nicht gelesen werden.');
      }
    }

    const project = createProject(photo.id, stripExtension(originalName));
    reply.code(201);
    return { project, warnings };
  });

  app.get<{ Params: { hash: string } }>('/api/photos/:hash/preview', async (request, reply) => {
    return sendFile(reply, previewPath(request.params.hash), 'image/jpeg', 'Vorschau');
  });

  app.get<{ Params: { hash: string } }>('/api/photos/:hash/thumb', async (request, reply) => {
    return sendFile(reply, thumbPath(request.params.hash), 'image/jpeg', 'Miniatur');
  });

  app.get<{ Params: { hash: string } }>('/api/photos/:hash/analysis', async (request, reply) => {
    return sendFile(reply, analysisPath(request.params.hash), 'image/jpeg', 'Analysebild');
  });

  /** Bilddaten in voller Auflösung — Quelle für 100-%-Ansicht und Export. */
  app.get<{ Params: { id: string } }>('/api/photos/:id/full', async (request, reply) => {
    const photo = getPhoto(request.params.id);
    const source = fullResolutionSource(photo);
    return sendFile(reply, source.path, source.mime, 'Originalbild');
  });
}

async function sendFile(
  reply: import('fastify').FastifyReply,
  path: string,
  mime: string,
  label: string,
): Promise<unknown> {
  if (!(await exists(path))) {
    throw new AppError('NOT_FOUND', `Die ${label} konnte nicht gefunden werden.`);
  }
  // Der Inhalt ist über den Hash bzw. die unveränderliche ID adressiert und
  // kann sich nie ändern — dauerhaftes Caching ist hier korrekt und spart
  // beim erneuten Öffnen eines Projekts das Neuladen von bis zu 100 MB.
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  reply.type(mime);
  return reply.send(createReadStream(path));
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}
