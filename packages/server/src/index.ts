/**
 * Server-Einstiegspunkt.
 *
 * Hier steht nur, was zum Starten und Beenden des Prozesses gehört. Wie der
 * Server aufgebaut ist, steht in `app.ts` — getrennt, damit die komplette API
 * im Test aufgebaut werden kann, ohne einen Port zu belegen.
 */

import { config } from './config.ts';
import { buildApp } from './app.ts';
import { closeDatabase, openDatabase } from './db.ts';
import { clearTempFiles, ensureDirectories } from './storage.ts';
import { aiStatus } from './ai/service.ts';
import { diagnoseEnvFile } from './envcheck.ts';

const app = await buildApp();

async function start(): Promise<void> {
  await ensureDirectories();
  const leftovers = await clearTempFiles();
  if (leftovers > 0) {
    app.log.info(`${leftovers} Zwischendatei(en) eines unterbrochenen Vorgangs entfernt`);
  }
  openDatabase();

  await app.listen({ port: config.port, host: config.host });

  const ai = aiStatus();
  app.log.info(
    `PhotoMaster bereit · Daten: ${config.dataDir} · KI: ${ai.available ? ai.model : 'nicht eingerichtet'}`,
  );

  // Eine .env, aus der der Schlüssel nicht angekommen ist, gehört gleich beim
  // Start gemeldet — nicht erst, wenn jemand die KI-Schaltfläche sucht.
  const envProblem = ai.available ? null : diagnoseEnvFile(config.rootDir);
  if (envProblem) app.log.warn(envProblem);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info('Beende …');
    void app.close().then(() => {
      closeDatabase();
      process.exit(0);
    });
  });
}

try {
  await start();
} catch (err) {
  app.log.error(err, 'Der Server konnte nicht gestartet werden.');
  process.exit(1);
}
