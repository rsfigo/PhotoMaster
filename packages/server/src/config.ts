import { resolve } from 'node:path';

/**
 * Zentrale Konfiguration. Alles über Umgebungsvariablen überschreibbar,
 * mit Defaults, die ohne jede Einrichtung lauffähig sind.
 */

const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const rootDir = resolve(import.meta.dirname, '../../..');

export const config = {
  /** Projektordner — dort liegt die `.env`, die die Start-Skripte einlesen. */
  rootDir,
  port: num(process.env.PM_PORT, 5174),
  host: process.env.PM_HOST ?? '127.0.0.1',

  dataDir: process.env.PM_DATA_DIR ? resolve(process.env.PM_DATA_DIR) : resolve(rootDir, 'data'),

  /** Obergrenze für den Upload. 400 MB deckt auch große RAW-Dateien ab. */
  maxUploadBytes: num(process.env.PM_MAX_UPLOAD_MB, 400) * 1024 * 1024,

  /**
   * Kantenlänge der Bearbeitungsvorschau. 2560 px ist ein bewusster
   * Kompromiss: groß genug, um auf einem 4K-Display Details zu beurteilen,
   * klein genug für flüssige Regler (2560×1707 ≈ 4,4 MP je Pass).
   * Der Export benutzt diese Datei nicht — er geht immer vom Original aus.
   */
  previewMaxEdge: num(process.env.PM_PREVIEW_EDGE, 2560),

  /** Kantenlänge des Bildes, das die KI zu sehen bekommt. */
  analysisMaxEdge: num(process.env.PM_ANALYSIS_EDGE, 1024),

  /** Qualität der Vorschau-JPEGs. Betrifft ausschließlich die Anzeige. */
  previewQuality: num(process.env.PM_PREVIEW_QUALITY, 92),

  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
    model: process.env.PM_AI_MODEL?.trim() || 'claude-opus-5-5',
    /**
     * Obergrenze der Antwort einschließlich des Nachdenkens. Kostet nichts,
     * solange sie nicht ausgeschöpft wird — zu knapp bemessen schnitte sie
     * aber das JSON mitten in einem Wert ab. Weil gestreamt wird, setzt die
     * HTTP-Zeitgrenze hier keine Schranke.
     */
    maxTokens: num(process.env.PM_AI_MAX_TOKENS, 32000),

    /**
     * Abweichender Endpunkt — für einen Firmen-Proxy oder ein Gateway, das
     * die Anthropic-API weiterreicht. Leer bedeutet: direkt zu Anthropic.
     */
    baseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || null,

    /**
     * Wie lange auf den BEGINN der Antwort gewartet wird. Weil gestreamt
     * wird, ist das nicht die Rechenzeit — die darf bei ausführlichem
     * Nachdenken Minuten dauern —, sondern die Zeit, bis die Gegenstelle
     * überhaupt antwortet. Ohne Grenze bliebe die Oberfläche bei einer
     * hängenden Verbindung für immer im Wartezustand (§29).
     */
    timeoutMs: num(process.env.PM_AI_TIMEOUT_MS, 90_000),
  },
} as const;

export const paths = {
  originals: resolve(config.dataDir, 'originals'),
  working: resolve(config.dataDir, 'working'),
  previews: resolve(config.dataDir, 'previews'),
  exports: resolve(config.dataDir, 'exports'),
  tmp: resolve(config.dataDir, 'tmp'),
  db: resolve(config.dataDir, 'photomaster.db'),
} as const;
