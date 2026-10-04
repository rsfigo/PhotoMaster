/**
 * Auslesen der Aufnahmedaten (§7 des Briefings).
 *
 * `exifr` liest EXIF aus JPEG, TIFF, HEIC und RAW-Containern, ohne die Datei
 * zu verändern. Fehlschläge sind hier ausdrücklich kein Fehlerfall: Ein Foto
 * ohne EXIF ist völlig normal (Screenshots, exportierte Dateien, bearbeitete
 * Bilder) und darf den Import nicht blockieren.
 */

import exifr from 'exifr';
import type { CameraInfo } from '@photomaster/shared';

export interface RawMetadata {
  camera: CameraInfo;
  orientation: number;
  hasExif: boolean;
  /** Sensorauflösung laut Metadaten — bei RAW größer als die extrahierte Vorschau. */
  declaredWidth?: number;
  declaredHeight?: number;
}

export async function readMetadata(filePath: string): Promise<RawMetadata> {
  try {
    // Standardumfang von exifr (IFD0 + EXIF, zusammengeführt). GPS wird
    // ausdrücklich NICHT gelesen: Standortdaten braucht die Bearbeitung nicht,
    // und was nicht gelesen wird, kann auch nicht versehentlich irgendwo
    // landen (§30).
    const exif = await exifr.parse(filePath, {
      gps: false,
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      mergeOutput: true,
    });

    if (!exif) return { camera: {}, orientation: 1, hasExif: false };

    const camera: CameraInfo = {
      make: str(exif.Make),
      model: str(exif.Model),
      lens: str(exif.LensModel ?? exif.LensID ?? exif.Lens),
      iso: numeric(exif.ISO ?? exif.ISOSpeedRatings ?? exif.PhotographicSensitivity),
      fNumber: numeric(exif.FNumber),
      exposureTime: numeric(exif.ExposureTime),
      focalLength: numeric(exif.FocalLength),
      takenAt: toIso(exif.DateTimeOriginal ?? exif.CreateDate ?? exif.ModifyDate),
    };

    // Leere Felder entfernen, damit die UI nicht "Objektiv: —" anzeigen muss.
    for (const key of Object.keys(camera) as (keyof CameraInfo)[]) {
      if (camera[key] === undefined) delete camera[key];
    }

    const orientation = numeric(exif.Orientation);

    return {
      camera,
      orientation: orientation && orientation >= 1 && orientation <= 8 ? orientation : 1,
      hasExif: Object.keys(camera).length > 0 || orientation !== undefined,
      // Die GRÖSSERE Angabe zählt. In RAW-Dateien beschreibt IFD0 oft nur das
      // Miniaturbild (bei Nikon 160×120), die Sensorgröße steht im EXIF-Block.
      // Mit der kleinen Zahl liefe die Prüfung auf ein zu kleines eingebettetes
      // Vorschaubild ins Leere — sie hielte jedes Bild für groß genug.
      declaredWidth: largest(exif.ImageWidth, exif.ExifImageWidth),
      declaredHeight: largest(exif.ImageHeight, exif.ExifImageHeight),
    };
  } catch {
    return { camera: {}, orientation: 1, hasExif: false };
  }
}

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

const numeric = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Die größte gültige Zahl unter den Angaben, oder undefined. */
const largest = (...values: unknown[]): number | undefined => {
  const nums = values.map(numeric).filter((n): n is number => n !== undefined && n > 0);
  return nums.length > 0 ? Math.max(...nums) : undefined;
};

function toIso(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === 'string') {
    // EXIF-Datumsformat "2024:06:01 18:30:00" ist kein gültiges ISO-Datum.
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(v);
    if (m) {
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}`);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return undefined;
}

/** Belichtungszeit als Bruch, wie sie auf der Kamera steht. */
export function formatExposureTime(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds >= 1) return `${Math.round(seconds * 10) / 10} s`;
  return `1/${Math.round(1 / seconds)} s`;
}
