/**
 * Erklärt, warum ein API-Schlüssel nicht angekommen ist (§29).
 *
 * Ohne diese Prüfung sagt die App in jedem Fehlerfall dasselbe: „nicht
 * eingerichtet". Wer den Schlüssel gerade eingetragen hat, steht dann ratlos
 * da — die Datei sieht im Editor richtig aus, und trotzdem passiert nichts.
 * Die Ursachen sind fast immer dieselben wenigen, und alle lassen sich an der
 * Datei selbst erkennen:
 *
 *  - falsche Kodierung: UTF-16 (`echo … > .env` in Windows PowerShell) liest
 *    Node gar nicht, UTF-8 mit BOM nur ab der zweiten Zeile
 *  - die Zeile fehlt, ist leer oder auskommentiert
 *  - die Datei heißt `.env.txt` oder liegt im falschen Ordner
 *  - der Schlüssel steht richtig drin, aber der Server läuft noch mit dem
 *    Stand von vorher — er liest die Datei nur beim Start
 *
 * Was Node tatsächlich versteht, ist ausprobiert und nicht angenommen:
 * Windows-Zeilenumbrüche, `export`, Leerzeichen um das Gleichheitszeichen und
 * Anführungszeichen funktionieren — dafür gibt es hier keine Warnung.
 *
 * Geprüft wird nur, wenn der Schlüssel fehlt. Die Funktion liest die Datei
 * und nichts sonst; sie gibt den Schlüssel nie zurück und schreibt ihn nicht
 * ins Log.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = 'ANTHROPIC_API_KEY';

/**
 * Was nach der Korrektur zu tun ist. Mit `npm run dev` beobachtet Node die
 * `.env` und startet beim Speichern von selbst neu — ausprobiert, nicht
 * angenommen. Nur `npm start` braucht einen Neustart von Hand. Neu laden muss
 * man die Seite in beiden Fällen: Die Oberfläche fragt den Stand der KI nur
 * beim Laden ab.
 */
const RESTART =
  'Danach die Seite neu laden. Mit npm run dev startet der Server beim Speichern von selbst neu, mit npm start musst du ihn neu starten.';

/**
 * Untersucht die `.env` im Projektordner. Liefert eine Erklärung samt Abhilfe,
 * oder `null`, wenn es schlicht keine Datei gibt — dann gilt die übliche
 * Meldung, dass kein Schlüssel hinterlegt ist.
 */
export function diagnoseEnvFile(rootDir: string): string | null {
  const envPath = join(rootDir, '.env');
  if (!existsSync(envPath)) return diagnoseMissingFile(rootDir);

  let bytes: Buffer;
  try {
    bytes = readFileSync(envPath);
  } catch {
    return `Die Datei .env lässt sich nicht lesen. Prüfe, ob sie in einem anderen Programm gesperrt ist. ${RESTART}`;
  }
  return diagnoseEnvContent(bytes);
}

/** Wo liegt die Datei, wenn nicht dort, wo der Server sucht? */
function diagnoseMissingFile(rootDir: string): string | null {
  if (existsSync(join(rootDir, '.env.txt'))) {
    return (
      'Die Datei heißt .env.txt statt .env — Windows hat beim Speichern „.txt“ angehängt. ' +
      'Benenne sie in .env um; im Explorer zeigt „Ansicht › Einblenden › Dateinamenerweiterungen“ ' +
      `die vollständige Endung. ${RESTART}`
    );
  }

  for (const sub of ['packages/server', 'packages/app']) {
    if (existsSync(join(rootDir, sub, '.env'))) {
      return (
        `Die Datei .env liegt in ${sub} statt im Projektordner. Verschiebe sie nach ${rootDir} — ` +
        `dorthin, wo auch .env.example liegt. ${RESTART}`
      );
    }
  }

  return null;
}

/** Untersucht den Inhalt einer `.env`, deren Schlüssel nicht angekommen ist. */
export function diagnoseEnvContent(bytes: Buffer): string | null {
  // UTF-16 erkennt man am BOM oder, ohne BOM, an den Nullbytes zwischen den
  // Zeichen. Node liest so eine Datei überhaupt nicht.
  const utf16 =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes.length >= 4 && (bytes[1] === 0 || bytes[0] === 0) && (bytes[3] === 0 || bytes[2] === 0));
  if (utf16) {
    return (
      'Die Datei .env ist als UTF-16 gespeichert, und so kann der Server sie nicht lesen. ' +
      'Das passiert zum Beispiel mit „echo … > .env“ in PowerShell. Öffne sie mit Notepad, ' +
      `wähle „Speichern unter“ und als Codierung „UTF-8“. ${RESTART}`
    );
  }

  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.subarray(hasBom ? 3 : 0).toString('utf8');
  const lines = text.split(/\r?\n/);

  const keyLine = new RegExp(`^\\s*(?:export\\s+)?${KEY}\\s*=(.*)$`);
  const index = lines.findIndex((line) => keyLine.test(line));

  if (index < 0) {
    const commented = new RegExp(`^\\s*#\\s*(?:export\\s+)?${KEY}\\s*=`);
    if (lines.some((line) => commented.test(line))) {
      return (
        `In der Datei .env ist die Zeile mit ${KEY} auskommentiert. ` +
        `Entferne das # am Zeilenanfang. ${RESTART}`
      );
    }
    return (
      `Die Datei .env enthält keine Zeile ${KEY}=… — füge sie hinzu und trage ` +
      `dahinter deinen Schlüssel ein. ${RESTART}`
    );
  }

  const raw = (keyLine.exec(lines[index])?.[1] ?? '').trim();
  const value = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
  if (value === '') {
    return (
      `In der Datei .env steht hinter ${KEY}= noch kein Schlüssel. Füge ihn direkt ` +
      `hinter dem Gleichheitszeichen ein. ${RESTART}`
    );
  }

  // Ein BOM wird zum Teil des ersten Namens — „﻿ANTHROPIC_API_KEY“ ist für
  // Node eine andere Variable. Ab der zweiten Zeile stört es nicht.
  if (hasBom && lines.slice(0, index).every((line) => line.trim() === '')) {
    return (
      'Die Datei .env ist als „UTF-8 mit BOM“ gespeichert. Dadurch erkennt der Server die ' +
      'erste Zeile nicht — und dort steht der Schlüssel. Speichere sie in Notepad über ' +
      `„Speichern unter“ mit der Codierung „UTF-8“ (ohne BOM). ${RESTART}`
    );
  }

  // Die Datei ist in Ordnung, der Schlüssel fehlt trotzdem: Der Server läuft
  // noch mit dem Stand von vor der Änderung. Mit npm run dev ist das nur ein
  // Augenblick; mit npm start bleibt es so bis zum Neustart.
  return (
    'Der Schlüssel steht in der Datei .env, ist im laufenden Server aber noch nicht ' +
    'angekommen — er wird nur beim Start gelesen. Mit npm run dev geschieht das beim Speichern ' +
    'von selbst: Lade die Seite in ein paar Sekunden neu. Läuft der Server mit npm start, starte ihn neu.'
  );
}
