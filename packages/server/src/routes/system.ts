/**
 * Auskunft über die Ablage (§30).
 *
 * Die Datenschutzzusage der App ist nur so viel wert, wie der Nutzer sie
 * nachprüfen kann. Diese Endpunkte liefern deshalb nicht den Text einer
 * Zusage, sondern den gemessenen Zustand: welches Verzeichnis benutzt wird,
 * wie viele Fotos darin liegen und wie viel Platz welcher Teil belegt.
 *
 * Geschrieben wird hier genau eine Sache — das Leeren des Exportverzeichnisses.
 * Exporte sind jederzeit neu erzeugbar; alles andere bleibt liegen, bis der
 * Nutzer es selbst löscht.
 */

import type { FastifyInstance } from 'fastify';
import type { StorageReport } from '@photomaster/shared';
import { config, paths } from '../config.ts';
import { countEntries } from '../db.ts';
import { clearExports, directorySize, fileSize } from '../storage.ts';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/storage', async (): Promise<StorageReport> => {
    const [originals, working, previews, exports, database] = await Promise.all([
      directorySize(paths.originals),
      directorySize(paths.working),
      directorySize(paths.previews),
      directorySize(paths.exports),
      fileSize(paths.db).catch(() => 0),
    ]);

    return {
      dataDir: config.dataDir,
      counts: countEntries(),
      sizes: {
        originals,
        working,
        previews,
        exports,
        database,
        total: originals + working + previews + exports + database,
      },
    };
  });

  app.delete('/api/storage/exports', async (request) => {
    const result = await clearExports();
    request.log.info(result, 'Exportverzeichnis geleert');
    return result;
  });
}
