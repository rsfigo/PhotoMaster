/** Formatierungen für die Oberfläche. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;

  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;

  // Eine Fotosammlung erreicht schnell mehrere Gigabyte. "13480.2 MB" ist
  // zwar richtig, aber niemand liest daraus eine Größenordnung ab.
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}

export function formatExposure(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds >= 1) return `${Math.round(seconds * 10) / 10} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

/**
 * Relative Zeitangabe. Ein Datum von heute als "vor 3 Stunden" zu lesen ist
 * schneller erfasst als ein Zeitstempel; alles ab einer Woche bekommt wieder
 * ein Datum, weil "vor 23 Tagen" niemandem hilft.
 */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'gerade eben';
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `vor ${m} ${m === 1 ? 'Minute' : 'Minuten'}`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    return `vor ${h} ${h === 1 ? 'Stunde' : 'Stunden'}`;
  }
  if (seconds < 604800) {
    const d = Math.floor(seconds / 86400);
    return `vor ${d} ${d === 1 ? 'Tag' : 'Tagen'}`;
  }
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
}
