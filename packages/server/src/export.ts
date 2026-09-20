/**
 * Export in voller Qualität (Phase 9, §20/§21 des Briefings).
 *
 * Eingang sind ROHE, UNKOMPRIMIERTE Pixel aus der GPU-Pipeline — der Zustand
 * nach der Bearbeitung, bevor irgendein Encoder sie angefasst hat. Das ist der
 * Kern der Qualitätszusage: Zwischen der Originaldatei und dieser Kodierung
 * liegt keine einzige weitere Kompression. Jeder Regler, jede KI-Bearbeitung,
 * jeder Undo-Schritt hat nur Zahlen verändert, nie Pixel neu komprimiert.
 *
 * Farbraum: Der Browser rechnet beim Dekodieren auf sRGB um (er wendet das
 * eingebettete ICC-Profil an). Die Pixel, die hier ankommen, SIND daher sRGB
 * und werden entsprechend ausgezeichnet. Das Profil des Originals zu kopieren
 * wäre falsch — es würde sRGB-Werte als AdobeRGB oder P3 deklarieren.
 */

import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import piexif from 'piexifjs';
import type { ExportFormat, ExportReport, ExportSettings, PhotoMeta } from '@photomaster/shared';
import { AppError } from './errors.ts';
import { exportPath, fileSize } from './storage.ts';
import { formatExposureTime } from './metadata.ts';

export interface EncodeRequest {
  pixels: Buffer;
  width: number;
  height: number;
  settings: ExportSettings;
  photo: PhotoMeta;
  /** Quelle der Metadaten: das Original bzw. bei RAW die extrahierte Vorschau. */
  metadataSourcePath: string | null;
  fileName: string;
}

export async function encodeExport(req: EncodeRequest): Promise<ExportReport> {
  const started = Date.now();
  const { settings, width, height } = req;

  if (req.pixels.length !== width * height * 4) {
    throw new AppError(
      'EXPORT_FAILED',
      'Der Export konnte nicht abgeschlossen werden. Dein Originalfoto wurde nicht verändert.',
      `Pixelpuffer hat ${req.pixels.length} Bytes, erwartet waren ${width * height * 4}.`,
    );
  }

  let pipeline = sharp(req.pixels, {
    raw: { width, height, channels: 4 },
    limitInputPixels: 0,
  }).removeAlpha();

  let outWidth = width;
  let outHeight = height;

  // Verkleinern ist ausdrücklich Opt-in. Der Default ist immer die
  // Originalauflösung (§20).
  if (settings.resizeWidth > 0 || settings.resizeHeight > 0) {
    const targetW = settings.resizeWidth > 0 ? settings.resizeWidth : null;
    const targetH = settings.resizeHeight > 0 ? settings.resizeHeight : null;
    pipeline = pipeline.resize({
      width: targetW ?? undefined,
      height: targetH ?? undefined,
      fit: 'inside',
      withoutEnlargement: false,
      kernel: 'lanczos3',
    });
    const scale = Math.min(
      targetW ? targetW / width : Infinity,
      targetH ? targetH / height : Infinity,
    );
    outWidth = Math.round(width * scale);
    outHeight = Math.round(height * scale);
  }

  // Der Datenstrom ist sRGB — das wird ausgezeichnet, nicht umgerechnet.
  pipeline = pipeline.withIccProfile('srgb');

  const quality = Math.max(1, Math.min(100, Math.round(settings.quality)));

  switch (settings.format) {
    case 'jpeg':
      pipeline = pipeline.jpeg({
        quality,
        chromaSubsampling: settings.chromaSubsampling,
        // mozjpeg liefert bei gleicher Qualitätsstufe kleinere Dateien bei
        // gleicher oder besserer Bildqualität als der Standard-Encoder.
        mozjpeg: true,
        trellisQuantisation: true,
        overshootDeringing: true,
        optimiseScans: true,
      });
      break;
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 6, effort: 7 });
      break;
    case 'tiff':
      pipeline = pipeline.tiff({ compression: 'deflate', predictor: 'horizontal' });
      break;
    default:
      throw new AppError('BAD_REQUEST', 'Unbekanntes Exportformat.');
  }

  let buffer: Buffer;
  try {
    buffer = await pipeline.toBuffer();
  } catch (err) {
    throw new AppError(
      'EXPORT_FAILED',
      'Der Export konnte nicht abgeschlossen werden. Dein Originalfoto wurde nicht verändert.',
      err instanceof Error ? err.message : String(err),
    );
  }

  let metadataPreserved = false;
  let metadataNote = 'Keine Metadaten übernommen.';

  if (settings.keepMetadata) {
    const result = await attachMetadata(buffer, settings.format, req, outWidth, outHeight);
    buffer = result.buffer;
    metadataPreserved = result.preserved;
    metadataNote = result.note;
  }

  const target = exportPath(req.fileName);
  await writeFile(target, buffer);

  return {
    fileName: req.fileName,
    url: `/api/exports/${encodeURIComponent(req.fileName)}`,
    format: settings.format,
    width: outWidth,
    height: outHeight,
    megapixels: Math.round((outWidth * outHeight) / 1e5) / 10,
    bytes: await fileSize(target),
    quality: settings.format === 'jpeg' ? quality : null,
    chromaSubsampling: settings.format === 'jpeg' ? settings.chromaSubsampling : null,
    metadataPreserved,
    metadataNote,
    compressionGenerations: countGenerations(req.photo.format, settings.format),
    durationMs: Date.now() - started,
  };
}

/**
 * Wie oft wurden diese Bilddaten verlustbehaftet komprimiert — das Original
 * eingerechnet? Ein JPEG aus der Kamera, das als JPEG exportiert wird, kommt
 * auf zwei Generationen; als TIFF exportiert bleibt es bei der einen aus der
 * Kamera. Der Wert macht in der UI sichtbar, was ein Export tatsächlich kostet.
 */
function countGenerations(sourceFormat: string, targetFormat: ExportFormat): number {
  const sourceLossy = ['jpeg', 'jpg', 'heif', 'heic', 'avif', 'webp'].includes(sourceFormat) ||
    ['nef', 'cr2', 'cr3', 'arw', 'dng', 'raf', 'rw2', 'orf', 'pef', 'srw'].includes(sourceFormat);
  const targetLossy = targetFormat === 'jpeg';
  return (sourceLossy ? 1 : 0) + (targetLossy ? 1 : 0);
}

// ── Metadaten ──────────────────────────────────────────────────────────────

interface MetadataResult {
  buffer: Buffer;
  preserved: boolean;
  note: string;
}

async function attachMetadata(
  buffer: Buffer,
  format: ExportFormat,
  req: EncodeRequest,
  outWidth: number,
  outHeight: number,
): Promise<MetadataResult> {
  if (format !== 'jpeg') {
    return {
      buffer,
      preserved: false,
      note:
        format === 'png'
          ? 'PNG trägt keine EXIF-Daten. Die Aufnahmedaten bleiben in der Originaldatei erhalten.'
          : 'Für TIFF werden keine EXIF-Daten geschrieben. Die Aufnahmedaten bleiben in der Originaldatei erhalten.',
    };
  }

  try {
    const exifObj = await buildExifObject(req);
    if (!exifObj) {
      return { buffer, preserved: false, note: 'Die Originaldatei enthält keine EXIF-Daten.' };
    }

    // Die Pixel sind bereits gedreht — eine übernommene Ausrichtung würde die
    // Drehung ein zweites Mal anwenden und das Bild quer legen.
    exifObj['0th'][piexif.ImageIFD.Orientation] = 1;
    exifObj['0th'][piexif.ImageIFD.ImageWidth] = outWidth;
    exifObj['0th'][piexif.ImageIFD.ImageLength] = outHeight;
    // 1 = sRGB.
    exifObj.Exif[piexif.ExifIFD.ColorSpace] = 1;
    exifObj.Exif[piexif.ExifIFD.PixelXDimension] = outWidth;
    exifObj.Exif[piexif.ExifIFD.PixelYDimension] = outHeight;
    exifObj['0th'][piexif.ImageIFD.Software] = 'PhotoMaster';
    // Das eingebettete Miniaturbild zeigt den UNBEARBEITETEN Stand und würde
    // in Dateiverwaltungen ein falsches Vorschaubild erzeugen.
    exifObj.thumbnail = null;
    exifObj['1st'] = {};

    // piexif.dump() liefert NUR die Nutzlast ("Exif\0\0" + TIFF-Block), nicht
    // das fertige JPEG-Segment. Marker und Längenfeld müssen selbst davor —
    // ohne sie steht hinter dem SOI-Marker ein Datenblock ohne Kennzeichnung,
    // und die Datei ist formal defekt (tolerante Decoder zeigen sie trotzdem
    // an, Metadaten-Leser finden aber nichts).
    const payload = Buffer.from(piexif.dump(exifObj), 'binary');

    // Ein APP1-Segment fasst 65533 Byte Nutzlast. Größer wird es praktisch nur
    // durch ein eingebettetes Miniaturbild, das oben bereits entfernt wurde.
    if (payload.length + 2 > 0xffff) {
      return {
        buffer,
        preserved: false,
        note: 'Der EXIF-Block der Originaldatei ist zu groß für ein JPEG-Segment und wurde ausgelassen.',
      };
    }

    const header = Buffer.alloc(4);
    header.writeUInt16BE(0xffe1, 0);
    header.writeUInt16BE(payload.length + 2, 2); // Länge zählt sich selbst mit

    // Das Segment direkt hinter den SOI-Marker setzen. Das vermeidet die
    // Umwandlung der gesamten Bilddatei in einen JS-String, die piexif.insert
    // vornehmen würde — bei 20 MB wären das 40 MB UTF-16 zusätzlich.
    const withExif = Buffer.concat([buffer.subarray(0, 2), header, payload, buffer.subarray(2)]);

    return {
      buffer: withExif,
      preserved: true,
      note: 'Aufnahmedaten, Kamera- und Objektivinformationen wurden übernommen.',
    };
  } catch (err) {
    // Fehlgeschlagene Metadatenübernahme darf den Export nicht scheitern
    // lassen — das Bild selbst ist wichtiger als seine Beschriftung.
    return {
      buffer,
      preserved: false,
      note: `Die Metadaten konnten nicht übernommen werden (${err instanceof Error ? err.message : 'unbekannter Grund'}). Das Bild wurde vollständig exportiert.`,
    };
  }
}

type ExifObject = {
  '0th': Record<number, unknown>;
  Exif: Record<number, unknown>;
  GPS: Record<number, unknown>;
  Interop: Record<number, unknown>;
  '1st': Record<number, unknown>;
  thumbnail: string | null;
};

/**
 * Liefert die EXIF-Struktur für den Export.
 *
 * Bevorzugt wird der vollständige EXIF-Block des Originals — dann bleiben auch
 * Felder erhalten, die PhotoMaster selbst gar nicht kennt (Bildstil,
 * Objektivkorrekturen, Seriennummern). Nur wenn das Quellformat kein JPEG ist
 * und der Block deshalb nicht direkt gelesen werden kann, wird aus den bereits
 * ausgelesenen Aufnahmedaten ein neuer Block aufgebaut.
 */
async function buildExifObject(req: EncodeRequest): Promise<ExifObject | null> {
  if (req.metadataSourcePath) {
    try {
      const head = await readHead(req.metadataSourcePath, 2 * 1024 * 1024);
      if (head[0] === 0xff && head[1] === 0xd8) {
        const loaded = piexif.load(head.toString('binary')) as ExifObject;
        if (Object.keys(loaded['0th']).length > 0 || Object.keys(loaded.Exif).length > 0) {
          return loaded;
        }
      }
    } catch {
      // Fällt unten auf den Neuaufbau zurück.
    }
  }

  return buildExifFromCamera(req.photo);
}

function buildExifFromCamera(photo: PhotoMeta): ExifObject | null {
  const c = photo.camera;
  if (!c.make && !c.model && !c.takenAt && !c.iso) return null;

  const zeroth: Record<number, unknown> = {};
  const exif: Record<number, unknown> = {};

  if (c.make) zeroth[piexif.ImageIFD.Make] = c.make;
  if (c.model) zeroth[piexif.ImageIFD.Model] = c.model;
  if (c.takenAt) {
    const d = new Date(c.takenAt);
    if (!Number.isNaN(d.getTime())) {
      const s = exifDate(d);
      zeroth[piexif.ImageIFD.DateTime] = s;
      exif[piexif.ExifIFD.DateTimeOriginal] = s;
      exif[piexif.ExifIFD.DateTimeDigitized] = s;
    }
  }
  if (c.lens) exif[piexif.ExifIFD.LensModel] = c.lens;
  if (c.iso) exif[piexif.ExifIFD.ISOSpeedRatings] = Math.round(c.iso);
  if (c.fNumber) exif[piexif.ExifIFD.FNumber] = toRational(c.fNumber);
  if (c.exposureTime) exif[piexif.ExifIFD.ExposureTime] = toRational(c.exposureTime);
  if (c.focalLength) exif[piexif.ExifIFD.FocalLength] = toRational(c.focalLength);

  return { '0th': zeroth, Exif: exif, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
}

/** EXIF speichert Brüche als [Zähler, Nenner]. */
function toRational(value: number): [number, number] {
  if (value >= 1) return [Math.round(value * 100), 100];
  return [1, Math.max(1, Math.round(1 / value))];
}

function exifDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Liest nur den Dateianfang — EXIF steht immer am Beginn der Datei. */
async function readHead(path: string, maxBytes: number): Promise<Buffer> {
  const full = await readFile(path);
  return full.length > maxBytes ? full.subarray(0, maxBytes) : full;
}

/** Zusammenfassung der Aufnahmedaten für die Anzeige. */
export function describeCamera(photo: PhotoMeta): string[] {
  const c = photo.camera;
  const parts: string[] = [];
  if (c.make || c.model) parts.push([c.make, c.model].filter(Boolean).join(' '));
  if (c.lens) parts.push(c.lens);
  const shot = [
    c.focalLength ? `${Math.round(c.focalLength)} mm` : null,
    c.fNumber ? `f/${c.fNumber}` : null,
    formatExposureTime(c.exposureTime),
    c.iso ? `ISO ${c.iso}` : null,
  ].filter(Boolean);
  if (shot.length) parts.push(shot.join(' · '));
  return parts;
}
