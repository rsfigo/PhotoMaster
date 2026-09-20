/**
 * Fehlerbehandlung (§29 des Briefings).
 *
 * Jeder Fehler, der die Oberfläche erreicht, trägt einen Text, den ein
 * Fotograf verstehen kann — keine Stacktraces, keine libvips-Meldungen, keine
 * HTTP-Codes. Die technische Ursache bleibt in `detail` und landet im
 * Server-Log, nicht im Gesicht des Nutzers.
 */

export type ErrorCode =
  | 'INVALID_IMAGE'
  | 'UNSUPPORTED_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'NOT_FOUND'
  | 'AI_UNAVAILABLE'
  | 'AI_FAILED'
  | 'EXPORT_FAILED'
  | 'STORAGE_FULL'
  | 'BAD_REQUEST'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  INVALID_IMAGE: 400,
  UNSUPPORTED_FORMAT: 415,
  FILE_TOO_LARGE: 413,
  NOT_FOUND: 404,
  AI_UNAVAILABLE: 503,
  AI_FAILED: 502,
  EXPORT_FAILED: 500,
  STORAGE_FULL: 507,
  BAD_REQUEST: 400,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Technische Ursache — nur für das Log, nie für den Nutzer. */
  readonly detail?: string;

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
    this.status = STATUS[code];
  }

  toJSON(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

/**
 * Übersetzt beliebige Ausnahmen in eine verständliche Meldung.
 * Unbekannte Fehler werden bewusst nicht durchgereicht: Eine libvips-Meldung
 * wie "VipsJpeg: Premature end of JPEG file" hilft dem Nutzer nicht.
 */
export function toAppError(err: unknown, fallbackMessage: string): AppError {
  if (err instanceof AppError) return err;

  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const lower = detail.toLowerCase();

  if (lower.includes('enospc')) {
    return new AppError('STORAGE_FULL', 'Auf dem Datenträger ist kein Platz mehr frei.', detail);
  }
  if (lower.includes('unsupported image format') || lower.includes('bad extension')) {
    return new AppError(
      'UNSUPPORTED_FORMAT',
      'Dieses Dateiformat kann nicht gelesen werden.',
      detail,
    );
  }
  if (lower.includes('premature end') || lower.includes('corrupt') || lower.includes('vipsjpeg')) {
    return new AppError(
      'INVALID_IMAGE',
      'Dieses Bild konnte nicht gelesen werden — die Datei scheint beschädigt zu sein.',
      detail,
    );
  }
  if (lower.includes('heap') || lower.includes('out of memory') || lower.includes('enomem')) {
    return new AppError(
      'INTERNAL',
      'Für dieses große Foto ist momentan nicht genug Arbeitsspeicher verfügbar.',
      detail,
    );
  }

  return new AppError('INTERNAL', fallbackMessage, detail);
}
