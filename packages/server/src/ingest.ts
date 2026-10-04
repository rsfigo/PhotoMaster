/**
 * Import-Pipeline: Datei prüfen, bearbeitbare Quelle bestimmen, Vorschauen
 * erzeugen (§7 des Briefings).
 *
 * Die Originaldatei wird hier ausschließlich GELESEN. Alles, was entsteht,
 * sind zusätzliche Dateien: eine Arbeitskopie (nur wo nötig) und zwei
 * Vorschauen. Das Original bleibt Byte für Byte, wie es aus der Kamera kam.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import type { PhotoSource } from '@photomaster/shared';
import { config } from './config.ts';
import { AppError } from './errors.ts';
import { RAW_EXTENSIONS, analysisPath, previewDir, previewPath, thumbPath } from './storage.ts';
import { join } from 'node:path';
import { paths } from './config.ts';

// libvips hält dekodierte Bilder im Cache. Bei 24-MP-Dateien führt das schnell
// zu mehreren hundert MB, die nicht mehr freigegeben werden — deshalb aus.
sharp.cache(false);
// Ein Bild gleichzeitig: Parallelität bringt bei diesen Operationen wenig,
// kostet aber ein Vielfaches an Spitzenspeicher.
sharp.concurrency(1);

export interface IngestResult {
  source: PhotoSource;
  /** Datei, aus der der Browser die volle Auflösung dekodiert. */
  fullResPath: string;
  fullResMime: string;
  /** Tatsächliche Bildmaße nach Anwendung der EXIF-Ausrichtung. */
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  format: string;
  hasIcc: boolean;
  iccProfile?: string;
  warnings: string[];
}

export function workingFilePath(hash: string, ext: string): string {
  return join(paths.working, `${hash}.${ext}`);
}

/**
 * Prüft, ob libvips das Format tatsächlich dekodieren kann. `format.heif.input`
 * meldet nur, dass das Format registriert ist — ob der HEVC-Dekoder
 * mitgeliefert wurde, zeigt sich erst beim Versuch.
 */
export async function probe(filePath: string): Promise<sharp.Metadata> {
  try {
    return await sharp(filePath, { failOn: 'error' }).metadata();
  } catch (err) {
    throw new AppError(
      'INVALID_IMAGE',
      'Dieses Bild konnte nicht gelesen werden.',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function ingest(
  originalPath: string,
  ext: string,
  declaredSize: { width?: number; height?: number },
): Promise<IngestResult> {
  const warnings: string[] = [];

  if (RAW_EXTENSIONS.has(ext)) {
    return ingestRaw(originalPath, ext, declaredSize, warnings);
  }

  const meta = await probe(originalPath);
  if (!meta.width || !meta.height) {
    throw new AppError('INVALID_IMAGE', 'Dieses Bild enthält keine lesbaren Bildmaße.');
  }

  // Bei EXIF-Ausrichtung 5–8 ist das Bild um 90° gedreht gespeichert; die
  // angezeigten (und exportierten) Maße sind dann vertauscht.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;

  const format = meta.format ?? ext;
  const browserDecodable = format === 'jpeg' || format === 'png' || format === 'webp';

  let fullResPath = originalPath;
  let fullResMime = mimeFor(format);
  let source: PhotoSource = { kind: 'direct', width, height };

  if (!browserDecodable) {
    // HEIC, TIFF, AVIF und Ähnliches kann der Browser nicht dekodieren.
    // Die Arbeitskopie ist PNG, also VERLUSTFREI — ein JPEG als Arbeitskopie
    // würde eine zusätzliche Kompressionsgeneration einführen und §4 verletzen.
    const target = workingFilePath(basename(originalPath), 'png');
    await mkdir(paths.working, { recursive: true });
    try {
      await sharp(originalPath, { failOn: 'error', limitInputPixels: 0 })
        .rotate()
        .png({ compressionLevel: 6 })
        .toFile(target);
    } catch (err) {
      throw new AppError(
        'UNSUPPORTED_FORMAT',
        decodeFailureMessage(format),
        err instanceof Error ? err.message : String(err),
      );
    }
    fullResPath = target;
    fullResMime = 'image/png';
    source = {
      kind: 'converted',
      width,
      height,
      note: `Verlustfrei aus ${format.toUpperCase()} umgewandelt. Die Originaldatei bleibt unverändert erhalten.`,
    };
  }

  const preview = await makePreviews(originalPath, basename(originalPath));

  return {
    source,
    fullResPath,
    fullResMime,
    width,
    height,
    previewWidth: preview.width,
    previewHeight: preview.height,
    format,
    hasIcc: Boolean(meta.icc),
    iccProfile: meta.icc ? 'eingebettet' : undefined,
    warnings,
  };
}

/**
 * RAW-Dateien (§7).
 *
 * libvips kann RAW-Sensordaten nicht entwickeln, und es gibt keine
 * zuverlässige reine JS-Lösung dafür. Statt RAW-Unterstützung vorzutäuschen,
 * wird das eingebettete JPEG in voller Größe extrahiert — das ist die von der
 * Kamera selbst entwickelte Fassung des Bildes, unverändert aus dem Container
 * herausgeschnitten und NICHT neu komprimiert.
 *
 * Die UI benennt das ausdrücklich so. Wer echte RAW-Entwicklung braucht,
 * bekommt hier keine Attrappe, sondern eine klare Aussage.
 */
async function ingestRaw(
  originalPath: string,
  ext: string,
  declaredSize: { width?: number; height?: number },
  warnings: string[],
): Promise<IngestResult> {
  const buffer = await readFile(originalPath);
  const jpeg = extractLargestJpeg(buffer);

  if (!jpeg) {
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      `In dieser ${ext.toUpperCase()}-Datei wurde keine eingebettete Vorschau gefunden. ` +
        'Echte RAW-Entwicklung unterstützt PhotoMaster nicht — bitte die Datei zuvor ' +
        'in der Kamerasoftware als JPEG oder TIFF exportieren.',
    );
  }

  const hash = basename(originalPath);
  const target = workingFilePath(hash, 'jpg');
  await mkdir(paths.working, { recursive: true });
  // Unverändert schreiben: keine erneute Kompression, kein Qualitätsverlust
  // gegenüber dem, was die Kamera in die RAW-Datei gelegt hat.
  await writeFile(target, jpeg);

  const meta = await probe(target);
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? (meta.height ?? 0) : (meta.width ?? 0);
  const height = rotated ? (meta.width ?? 0) : (meta.height ?? 0);

  const rawWidth = declaredSize.width;
  const rawHeight = declaredSize.height;

  // Verglichen werden die LANGEN Kanten. Die Sensormaße stehen in der Datei
  // immer quer, die Vorschau ist hier aber bereits nach EXIF gedreht — bei
  // einem Hochformat stünde sonst 4000 gegen 6000, und ein vollständiges
  // Bild sähe aus wie eine verkleinerte Vorschau.
  const previewEdge = Math.max(width, height);
  const sensorEdge = rawWidth && rawHeight ? Math.max(rawWidth, rawHeight) : 0;

  // Manche Kameras legen nur ein kleines Vorschaubildchen in die RAW-Datei.
  // Das als "das Foto" zum Bearbeiten anzubieten wäre irreführend: Der Nutzer
  // würde eine 24-MP-Datei importieren und stillschweigend ein Briefmarkenbild
  // bearbeiten. Lieber klar ablehnen (§39).
  if (sensorEdge > 0 && previewEdge < sensorEdge * 0.5) {
    await rm(target, { force: true });
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      `Diese ${ext.toUpperCase()}-Datei enthält nur ein kleines Vorschaubild ` +
        `(${width}×${height} statt ${rawWidth}×${rawHeight} Sensorpixeln). ` +
        'Echte RAW-Entwicklung unterstützt PhotoMaster nicht — bitte die Datei in der ' +
        'Kamerasoftware als JPEG oder TIFF exportieren.',
    );
  }

  if (sensorEdge > previewEdge * 1.05) {
    warnings.push(
      `Die RAW-Datei enthält ${rawWidth}×${rawHeight} Sensorpixel, die eingebettete Vorschau ` +
        `jedoch nur ${width}×${height}. Bearbeitet und exportiert wird die Vorschau.`,
    );
  }

  const preview = await makePreviews(target, hash);

  return {
    source: {
      kind: 'raw-preview',
      width,
      height,
      rawWidth,
      rawHeight,
      note:
        'RAW-Entwicklung wird nicht unterstützt. Bearbeitet wird das in der Datei ' +
        'eingebettete JPEG der Kamera in voller Größe — unverändert extrahiert, nicht neu komprimiert.',
    },
    fullResPath: target,
    fullResMime: 'image/jpeg',
    width,
    height,
    previewWidth: preview.width,
    previewHeight: preview.height,
    format: ext,
    hasIcc: Boolean(meta.icc),
    warnings,
  };
}

/**
 * Sucht das größte vollständige JPEG im Container.
 *
 * RAW-Dateien sind TIFF-Varianten mit mehreren eingebetteten JPEGs: ein
 * Miniaturbild von wenigen hundert Pixeln und eine Vorschau in voller oder
 * halber Sensorgröße. Die Suche über die Marker findet beide; genommen wird
 * das größte. Das kommt ohne herstellerspezifische Tag-Tabellen aus und
 * funktioniert dadurch mit NEF, CR2, ARW, DNG und weiteren gleichermaßen.
 */
export function extractLargestJpeg(buffer: Buffer): Buffer | null {
  let best: Buffer | null = null;
  let offset = 0;

  while (offset < buffer.length - 3) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]), offset);
    if (start < 0) break;

    const end = findJpegEnd(buffer, start);
    if (end > start) {
      const candidate = buffer.subarray(start, end);
      // 4 KB als Untergrenze: Die Bytefolge FFD8FF kann zufällig auch in
      // Sensordaten stehen. Alles darunter ist mit Sicherheit ein Fehltreffer
      // und kein Bild. Ob die gefundene Vorschau GROSS GENUG ist, entscheidet
      // nicht diese Funktion, sondern der Aufrufer — der kennt die
      // Sensorauflösung und kann sie damit vergleichen.
      if (candidate.length > 4096 && (!best || candidate.length > best.length)) {
        best = candidate;
      }
      offset = end;
    } else {
      offset = start + 3;
    }
  }

  return best;
}

function findJpegEnd(buffer: Buffer, start: number): number {
  // Nach dem EOI-Marker suchen. 0xFFD9 kann zufällig auch in den Bilddaten
  // stehen; deshalb wird das LETZTE passende EOI vor dem nächsten SOI benutzt,
  // was in der Praxis den vollständigen Datenstrom liefert.
  const nextStart = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]), start + 3);
  const limit = nextStart < 0 ? buffer.length : nextStart;
  const eoi = buffer.lastIndexOf(Buffer.from([0xff, 0xd9]), limit - 2);
  return eoi > start ? eoi + 2 : -1;
}

/**
 * Erzeugt die beiden Ansichtsbilder:
 *  - `preview.jpg`  Renderquelle der Oberfläche (2560 px)
 *  - `analysis.jpg` das Bild, das die KI zu sehen bekommt (1024 px)
 *
 * Beide sind reine Anzeigedateien. Der Export benutzt sie nie — er geht immer
 * von der vollen Auflösung aus.
 */
async function makePreviews(
  sourcePath: string,
  hash: string,
): Promise<{ width: number; height: number }> {
  await mkdir(previewDir(hash), { recursive: true });

  const pipelineFor = (maxEdge: number) =>
    sharp(sourcePath, { failOn: 'error', limitInputPixels: 0 })
      .rotate() // EXIF-Ausrichtung anwenden
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3',
      })
      // Das eingebettete Farbprofil MUSS erhalten bleiben: Der Browser rechnet
      // beim Dekodieren auf sRGB um. Ohne Profil würde er AdobeRGB- oder
      // P3-Zahlen als sRGB lesen und das Bild zu kräftig darstellen.
      .keepIccProfile();

  const previewInfo = await pipelineFor(config.previewMaxEdge)
    .jpeg({ quality: config.previewQuality, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(previewPath(hash));

  await pipelineFor(config.analysisMaxEdge)
    .jpeg({ quality: 82 })
    .toFile(analysisPath(hash));

  // Miniatur für die Projektübersicht. Ohne sie müsste die Startseite je
  // Kachel die 2560-px-Vorschau laden — bei zwanzig Projekten wären das
  // zweistellige Megabyte für ein paar Fingernagelbilder.
  await pipelineFor(360).jpeg({ quality: 78 }).toFile(thumbPath(hash));

  return { width: previewInfo.width, height: previewInfo.height };
}

function basename(path: string): string {
  const m = /([^/\\]+?)(\.[^.]*)?$/.exec(path);
  return m ? m[1] : path;
}

/**
 * Erklärt verständlich, warum ein erkanntes Format trotzdem nicht geöffnet
 * werden kann (§29).
 *
 * Der praktisch wichtigste Fall ist HEIC vom iPhone: Es ist mit HEVC
 * komprimiert, und die mitgelieferte libvips bringt dafür aus Lizenzgründen
 * keinen Dekoder mit. Die Meldung des Dekoders lautet dann „Unsupported
 * compression" — damit kann niemand etwas anfangen. Der Weg zu einer Datei,
 * die sich öffnen lässt, dagegen schon.
 */
export function decodeFailureMessage(format: string): string {
  if (format === 'heif' || format === 'heic') {
    return (
      'Diese HEIC-Datei ist mit HEVC komprimiert, und dafür ist auf diesem Rechner kein ' +
      'Dekoder vorhanden. Am iPhone erzeugt „Einstellungen › Kamera › Formate › Maximale ' +
      'Kompatibilität“ stattdessen JPEG-Dateien. Eine bereits aufgenommene Aufnahme lässt ' +
      'sich beim Übertragen auf den Rechner automatisch umwandeln.'
    );
  }
  return `Dateien im Format ${format.toUpperCase()} kann dieser Rechner nicht dekodieren.`;
}

export function mimeFor(format: string): string {
  switch (format) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heif':
    case 'heic':
      return 'image/heif';
    case 'tiff':
    case 'tif':
      return 'image/tiff';
    case 'avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}
