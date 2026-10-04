/**
 * Erkennung einer falsch angelegten `.env` (§29).
 *
 * Die Testfälle sind keine ausgedachten Sonderfälle, sondern das, was beim
 * Anlegen der Datei tatsächlich passiert: `echo … > .env` in Windows
 * PowerShell schreibt UTF-16, Notepad bietet „UTF-8 mit BOM“ an, Windows
 * hängt beim Speichern gern „.txt“ an. Welche Schreibweisen Node versteht,
 * ist ausprobiert — für die funktionierenden darf es keine Warnung geben.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { diagnoseEnvContent, diagnoseEnvFile } = await import('../src/envcheck.ts');

const KEY_LINE = 'ANTHROPIC_API_KEY=sk-ant-api03-beispiel';
const utf8 = (text: string) => Buffer.from(text, 'utf8');
const bom = (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(text)]);

// ── Inhalt ─────────────────────────────────────────────────────────────────

test('eine mit PowerShell-echo angelegte Datei wird als UTF-16 erkannt', () => {
  // Genau das schreibt `echo … > .env` in Windows PowerShell 5.1.
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${KEY_LINE}\r\n`, 'utf16le')]);
  assert.match(diagnoseEnvContent(withBom) ?? '', /UTF-16/);
  assert.match(diagnoseEnvContent(withBom) ?? '', /Notepad/, 'es fehlt die Abhilfe');

  // Auch ohne BOM verrät sich UTF-16 an den Nullbytes.
  assert.match(diagnoseEnvContent(Buffer.from(KEY_LINE, 'utf16le')) ?? '', /UTF-16/);
});

test('ein BOM vor dem Schlüssel in Zeile 1 wird benannt', () => {
  const message = diagnoseEnvContent(bom(`${KEY_LINE}\n`));
  assert.match(message ?? '', /UTF-8 mit BOM/);
});

test('ein BOM stört nicht, wenn der Schlüssel weiter unten steht', () => {
  // Dann liest Node ihn — fehlt er trotzdem, liegt es an etwas anderem.
  const message = diagnoseEnvContent(bom(`PM_PORT=5174\n${KEY_LINE}\n`));
  assert.doesNotMatch(message ?? '', /BOM/);
  assert.match(message ?? '', /neu/);
});

test('eine auskommentierte, fehlende oder leere Zeile wird jeweils benannt', () => {
  assert.match(diagnoseEnvContent(utf8(`# ${KEY_LINE}\n`)) ?? '', /auskommentiert/);
  assert.match(diagnoseEnvContent(utf8('PM_PORT=5174\n')) ?? '', /keine Zeile ANTHROPIC_API_KEY/);
  assert.match(diagnoseEnvContent(utf8('')) ?? '', /keine Zeile ANTHROPIC_API_KEY/);

  // Die Vorlage .env.example enthält die Zeile leer — der häufigste Fall.
  assert.match(diagnoseEnvContent(utf8('ANTHROPIC_API_KEY=\n')) ?? '', /noch kein Schlüssel/);
  assert.match(diagnoseEnvContent(utf8('ANTHROPIC_API_KEY=""\n')) ?? '', /noch kein Schlüssel/);
});

test('eine korrekte Datei bedeutet: der Server läuft noch mit dem alten Stand', () => {
  // Alle diese Schreibweisen versteht Node — ausprobiert. Fehlt der Schlüssel
  // trotzdem, wurde er nach dem Start eingetragen.
  for (const content of [
    `${KEY_LINE}\n`,
    `${KEY_LINE}\r\n`,
    `export ${KEY_LINE}\n`,
    'ANTHROPIC_API_KEY = sk-ant-api03-beispiel\n',
    'ANTHROPIC_API_KEY="sk-ant-api03-beispiel"\n',
  ]) {
    const message = diagnoseEnvContent(utf8(content));
    assert.match(message ?? '', /nur beim Start gelesen/, `falsch erklärt: ${JSON.stringify(content)}`);
    assert.match(message ?? '', /Seite in ein paar Sekunden neu/);
  }
});

test('der Schlüssel selbst steht in keiner Meldung', () => {
  // Die Meldung landet in der Oberfläche und im Server-Log.
  for (const content of [`${KEY_LINE}\n`, `# ${KEY_LINE}\n`, `﻿${KEY_LINE}\n`]) {
    const message = diagnoseEnvContent(utf8(content)) ?? '';
    assert.doesNotMatch(message, /sk-ant-api03/, 'der Schlüssel taucht in der Meldung auf');
  }
});

// ── Ort der Datei ──────────────────────────────────────────────────────────

test('eine Datei am falschen Ort oder mit .txt-Endung wird gefunden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-envcheck-'));
  try {
    // Ganz ohne Datei gibt es nichts zu erklären — dann gilt die übliche Meldung.
    assert.equal(diagnoseEnvFile(root), null);

    await writeFile(join(root, '.env.txt'), `${KEY_LINE}\n`);
    assert.match(diagnoseEnvFile(root) ?? '', /\.env\.txt statt \.env/);
    await rm(join(root, '.env.txt'));

    await mkdir(join(root, 'packages', 'server'), { recursive: true });
    await writeFile(join(root, 'packages', 'server', '.env'), `${KEY_LINE}\n`);
    assert.match(diagnoseEnvFile(root) ?? '', /liegt in packages\/server statt im Projektordner/);

    // Liegt sie richtig, wird ihr Inhalt geprüft.
    await writeFile(join(root, '.env'), Buffer.from([0xff, 0xfe, ...Buffer.from(KEY_LINE, 'utf16le')]));
    assert.match(diagnoseEnvFile(root) ?? '', /UTF-16/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
