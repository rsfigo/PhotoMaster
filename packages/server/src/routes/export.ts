/**
 * Export-Endpunkt.
 *
 * Der Client schickt die fertig gerechneten Pixel als rohes RGBA — bei 24 MP
 * sind das 96 MB im Anfrage-Körper. Das ist Absicht: Der Alternativweg wäre,
 * das Bild im Browser zu kodieren, und der Browser-Encoder halbiert die
 * Farbauflösung (4:2:0) und wirft EXIF weg. Ein einmaliger lokaler Transfer
 * unkomprimierter Daten ist der Preis für eine kompromisslose Ausgabedatei
 * (ARCHITECTURE.md §3).
 *
 * Die Einstellungen stehen in der Query, damit der Körper reine Binärdaten
 * bleiben kann und nicht durch Base64 um ein Drittel wächst.
 */

import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { DEFAULT_EXPORT_SETTINGS, type ExportFormat, type ExportSettings } from '@photomaster/shared';
import { getProject } from '../db.ts';
import { AppError, toAppError } from '../errors.ts';
import { encodeExport } from '../export.ts';
import { exists, exportPath } from '../storage.ts';
import { metadataSource } from './photos.ts';

interface ExportQuery {
  width?: string;
  height?: string;
  format?: string;
  quality?: string;
  resizeWidth?: string;
  resizeHeight?: string;
  keepMetadata?: string;
  chromaSubsampling?: string;
  fileName?: string;
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Querystring: ExportQuery; Body: Buffer }>(
    '/api/projects/:id/export',
    async (request) => {
      const project = getProject(request.params.id);
      const q = request.query;

      const width = int(q.width, 0);
      const height = int(q.height, 0);
      if (width <= 0 || height <= 0) {
        throw new AppError('BAD_REQUEST', 'Es wurden keine gültigen Bildmaße übergeben.');
      }

      const pixels = request.body;
      if (!Buffer.isBuffer(pixels)) {
        throw new AppError('BAD_REQUEST', 'Es wurden keine Bilddaten übertragen.');
      }

      const settings = parseSettings(q);
      const fileName = buildFileName(q.fileName, project.name, settings.format);

      try {
        const report = await encodeExport({
          pixels,
          width,
          height,
          settings,
          photo: project.photo,
          metadataSourcePath: settings.keepMetadata ? metadataSource(project.photo) : null,
          fileName,
        });

        return {
          report,
          // Der Vergleich Original ↔ Export ist Teil der Zusage aus §21 und
          // wird in der Oberfläche vollständig angezeigt.
          original: {
            width: project.photo.width,
            height: project.photo.height,
            megapixels: project.photo.megapixels,
            bytes: project.photo.bytes,
            format: project.photo.format,
          },
        };
      } catch (err) {
        throw toAppError(
          err,
          'Der Export konnte nicht abgeschlossen werden. Dein Originalfoto wurde nicht verändert.',
        );
      }
    },
  );

  app.get<{ Params: { name: string } }>('/api/exports/:name', async (request, reply) => {
    const path = exportPath(request.params.name);
    if (!(await exists(path))) {
      throw new AppError('NOT_FOUND', 'Diese Exportdatei ist nicht mehr vorhanden.');
    }
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(request.params.name)}"`);
    reply.type('application/octet-stream');
    return reply.send(createReadStream(path));
  });
}

function parseSettings(q: ExportQuery): ExportSettings {
  const format = (['jpeg', 'png', 'tiff'] as const).includes(q.format as ExportFormat)
    ? (q.format as ExportFormat)
    : DEFAULT_EXPORT_SETTINGS.format;

  return {
    format,
    quality: clamp(int(q.quality, DEFAULT_EXPORT_SETTINGS.quality), 1, 100),
    resizeWidth: Math.max(0, int(q.resizeWidth, 0)),
    resizeHeight: Math.max(0, int(q.resizeHeight, 0)),
    keepMetadata: q.keepMetadata !== 'false',
    chromaSubsampling: q.chromaSubsampling === '4:2:0' ? '4:2:0' : '4:4:4',
  };
}

/**
 * Macht aus einem Wunschnamen einen Dateinamen.
 *
 * Der Name muss so sauber sein, dass `exportPath` ihn nicht mehr anfassen
 * muss. Sonst hieße die Datei auf der Platte anders als im Bericht an die
 * Oberfläche — der Nutzer bekäme einen Namen genannt, den er im Ordner nicht
 * wiederfindet. Punktfolgen fallen deshalb schon hier weg und nicht erst in
 * der Ablage: ".." ist der Baustein, aus dem ein Verzeichniswechsel besteht.
 */
function buildFileName(requested: string | undefined, projectName: string, format: ExportFormat): string {
  const ext = format === 'jpeg' ? 'jpg' : format;
  const base = (requested ?? projectName)
    // Eine vorhandene Endung entfernen — aber nur eine echte, nicht den Rest
    // eines Pfades wie "../bild".
    .replace(/\.[^./\\]*$/, '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 80)
    // Erst nach dem Kürzen säubern, sonst kann das Abschneiden einen Punkt
    // ans Ende setzen — und ein Dateiname mit Schlusspunkt ist unter Windows
    // nicht zuverlässig zu öffnen.
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '');
  const safe = base.length > 0 ? base : 'export';
  // Zeitstempel im Namen: Ein zweiter Export darf den ersten nicht ersetzen.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${safe}_${stamp}.${ext}`;
}

const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
