/**
 * Aufbau der HTTP-Anwendung.
 *
 * Bewusst getrennt vom Einstiegspunkt: `index.ts` startet den Prozess, diese
 * Datei beschreibt nur, wie der Server aussieht. Dadurch lässt sich die
 * komplette API im Test aufbauen und über `app.inject()` befragen, ohne einen
 * Port zu belegen — und damit ist die Schnittstelle prüfbar, auf die sich die
 * Oberfläche verlässt.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import type { ServerCapabilities } from '@photomaster/shared';
import { config } from './config.ts';
import { AppError, toAppError } from './errors.ts';
import { aiStatus } from './ai/service.ts';
import { photoRoutes } from './routes/photos.ts';
import { projectRoutes } from './routes/projects.ts';
import { aiRoutes } from './routes/ai.ts';
import { exportRoutes } from './routes/export.ts';
import { systemRoutes } from './routes/system.ts';

/**
 * Prüft EINMAL wirklich nach, ob dieser Rechner HEIF-Dateien öffnen kann.
 *
 * `sharp.format.heif.input` meldet nur, dass das Format registriert ist — ob
 * die mitgelieferte libvips auch einen Dekoder dafür hat, zeigt sich erst beim
 * Versuch. Ein winziges Bild zu schreiben und wieder einzulesen beantwortet
 * die Frage in wenigen Millisekunden und ohne Beipackdatei.
 */
async function probeHeifSupport(): Promise<boolean> {
  try {
    const probe = await sharp(Buffer.alloc(16 * 16 * 3, 128), {
      raw: { width: 16, height: 16, channels: 3 },
    })
      .heif({ compression: 'av1', quality: 50 })
      .toBuffer();
    return (await sharp(probe).metadata()).format === 'heif';
  } catch {
    return false;
  }
}

function classify(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const fastifyError = error as { statusCode?: number; message?: string };
  if (fastifyError.statusCode === 413) {
    return new AppError(
      'FILE_TOO_LARGE',
      'Diese Datei ist zu groß für den Upload.',
      fastifyError.message,
    );
  }
  return toAppError(error, 'Es ist ein unerwarteter Fehler aufgetreten.');
}

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Der Export-Körper enthält rohe Pixel; bei 24 MP sind das 96 MB.
    bodyLimit: config.maxUploadBytes,
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.PM_LOG_LEVEL ?? 'info',
            transport:
              process.env.NODE_ENV === 'production'
                ? undefined
                : {
                    target: 'pino-pretty',
                    options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
                  },
          },
  });

  /**
   * Rohe Binärdaten unverändert als Buffer durchreichen. Ohne diesen Parser
   * würde Fastify den Export-Körper als Text behandeln und die Pixel dabei
   * zerstören.
   */
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  /**
   * Zentrale Fehlerbehandlung (§29): Der Nutzer bekommt einen verständlichen
   * Satz, das Log die technische Ursache.
   */
  app.setErrorHandler((error, request, reply) => {
    const appError = classify(error);

    const level = appError.status >= 500 ? 'error' : 'warn';
    request.log[level](
      { code: appError.code, detail: appError.detail, url: request.url },
      appError.message,
    );

    reply.code(appError.status).send(appError.toJSON());
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Diese Adresse gibt es nicht.' } });
  });

  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  const heifDecodable = await probeHeifSupport();

  app.get('/api/capabilities', async (): Promise<ServerCapabilities> => ({
    ai: aiStatus(),
    inputFormats: ['JPEG', 'PNG', 'WebP', 'TIFF', 'AVIF', ...(heifDecodable ? ['HEIF'] : [])],
    heifDecodable,
    rawPreviewSupported: true,
    maxUploadBytes: config.maxUploadBytes,
  }));

  await app.register(photoRoutes);
  await app.register(projectRoutes);
  await app.register(aiRoutes);
  await app.register(exportRoutes);
  await app.register(systemRoutes);

  return app;
}
