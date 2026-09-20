/** Domänentypen, die Client und Server gemeinsam verwenden. */

import type { EditParams } from './params.ts';

// ── Foto und Metadaten ─────────────────────────────────────────────────────

export type SourceKind = 'direct' | 'converted' | 'raw-preview';

/**
 * Wie das Bild für die Bearbeitung bereitgestellt wurde:
 *  - `direct`       Der Browser dekodiert das Original selbst (JPEG/PNG/WebP).
 *  - `converted`    Serverseitig verlustfrei zu PNG konvertiert (HEIC/TIFF/AVIF).
 *  - `raw-preview`  Aus einer RAW-Datei extrahiertes eingebettetes JPEG.
 *                   Das ist KEINE RAW-Entwicklung — wird der UI klar kommuniziert.
 */
export interface PhotoSource {
  kind: SourceKind;
  /** Auflösung der tatsächlich bearbeitbaren Bilddaten. */
  width: number;
  height: number;
  /** Nur bei `raw-preview` gesetzt: Auflösung der RAW-Sensordaten laut Metadaten. */
  rawWidth?: number;
  rawHeight?: number;
  note?: string;
}

export interface CameraInfo {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  fNumber?: number;
  exposureTime?: number;
  focalLength?: number;
  takenAt?: string;
}

export interface PhotoMeta {
  id: string;
  /** SHA-256 der Originaldatei — zugleich ihr Speicherort. */
  hash: string;
  originalName: string;
  /** Format der Originaldatei, z. B. "jpeg", "heif", "nef". */
  format: string;
  /** Endung, unter der die Originaldatei tatsächlich abgelegt ist. */
  storageExt: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  megapixels: number;
  orientation: number;
  hasExif: boolean;
  hasIcc: boolean;
  iccProfile?: string;
  camera: CameraInfo;
  source: PhotoSource;
  previewWidth: number;
  previewHeight: number;
  createdAt: string;
}

// ── Projekte und Versionen ─────────────────────────────────────────────────

export interface Version {
  id: string;
  projectId: string;
  name: string;
  params: EditParams;
  /** Optionale Begründung der KI, die zu diesem Stand geführt hat. */
  rationale?: EditRationale | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  photo: PhotoMeta;
  /** Der aktuelle Arbeitsstand — unabhängig von den gespeicherten Versionen. */
  params: EditParams;
  activeVersionId: string | null;
  versions: Version[];
  analysis: ImageAnalysis | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  photoId: string;
  /** Für die Bild-URLs der Übersicht (Vorschau und Miniatur). */
  photoHash: string;
  width: number;
  height: number;
  megapixels: number;
  versionCount: number;
  updatedAt: string;
  createdAt: string;
}

// ── Bildanalyse ────────────────────────────────────────────────────────────

/**
 * Objektive, messbare Eigenschaften des Bildes. Wird auf der GPU aus dem
 * unbearbeiteten Bild berechnet und ist die Faktenbasis für die KI —
 * damit sie nicht "blind" editiert (§10 des Briefings).
 */
export interface ImageStats {
  /** 256 Bins je Kanal, normalisiert auf [0,1] Anteil der Pixel. */
  histogram: { r: number[]; g: number[]; b: number[]; luma: number[] };
  /** Mittlere Luminanz in [0,1], in Gammakodierung gemessen. */
  meanLuma: number;
  medianLuma: number;
  /** Anteil der Pixel, die in mindestens einem Kanal bei 0 bzw. 255 liegen. */
  clippedShadows: number;
  clippedHighlights: number;
  /** Luminanz-Perzentile — robuster als Min/Max gegen einzelne Ausreißer. */
  p01: number;
  p05: number;
  p50: number;
  p95: number;
  p99: number;
  /** Standardabweichung der Luminanz — ein Maß für den globalen Kontrast. */
  contrast: number;
  /** Mittlere Sättigung in [0,1]. */
  meanSaturation: number;
  /** Kanalmittelwerte — Grundlage der Weißabgleich-Schätzung. */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Geschätzter Farbstich: positiv = warm/gelb bzw. magenta. */
  temperatureBias: number;
  tintBias: number;
  /** Varianz des Laplace-Operators — hoher Wert bedeutet scharfes Bild. */
  sharpness: number;
  /** Rauschschätzung aus den glattesten Bildbereichen. */
  noise: number;
  /** Die häufigsten Farben mit ihrem Flächenanteil. */
  dominantColors: { hex: string; share: number }[];
  /** Mittlere Luminanz in einem 3×3-Raster — grobe Kompositionsinformation. */
  regionLuma: number[];
}

export interface ImageAnalysis {
  stats: ImageStats;
  /** Von der KI erkannte Bildinhalte und Bewertung — optional. */
  scene: SceneAnalysis | null;
  createdAt: string;
}

export interface SceneAnalysis {
  subject: string;
  categories: string[];
  lighting: string;
  timeOfDay: string;
  mood: string;
  composition: string;
  observations: string[];
}

// ── KI ─────────────────────────────────────────────────────────────────────

export interface EditRationale {
  /** Ein bis zwei Sätze zum Gesamtergebnis. */
  summary: string;
  /** Begründung je geändertem Parameter (§16 "Why this edit?"). */
  reasons: {
    param: string;
    text: string;
    /** Name der Maske, falls die Begründung zu einer lokalen Anpassung gehört. */
    mask?: string;
  }[];
}

export interface AiEditResult {
  params: EditParams;
  rationale: EditRationale;
  /** Korrekturen, die die Validierung an der Modellantwort vorgenommen hat. */
  issues: string[];
  model: string;
}

export interface CoachRating {
  label: string;
  /** 0–100. */
  score: number;
  comment: string;
}

export interface CoachReport {
  overall: string;
  ratings: CoachRating[];
  tips: string[];
  createdAt: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ── Export ─────────────────────────────────────────────────────────────────

export type ExportFormat = 'jpeg' | 'png' | 'tiff';

export interface ExportSettings {
  format: ExportFormat;
  /** JPEG-Qualität 1–100. Wird bei PNG/TIFF ignoriert. */
  quality: number;
  /** Zielbreite in Pixeln; 0 bedeutet Originalauflösung. */
  resizeWidth: number;
  resizeHeight: number;
  keepMetadata: boolean;
  chromaSubsampling: '4:4:4' | '4:2:0';
}

export interface ExportReport {
  fileName: string;
  url: string;
  format: ExportFormat;
  width: number;
  height: number;
  megapixels: number;
  bytes: number;
  quality: number | null;
  chromaSubsampling: string | null;
  metadataPreserved: boolean;
  metadataNote: string;
  /** Wie oft die exportierte Datei JPEG-komprimiert wurde (Original mitgezählt). */
  compressionGenerations: number;
  durationMs: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'jpeg',
  quality: 100,
  resizeWidth: 0,
  resizeHeight: 0,
  keepMetadata: true,
  chromaSubsampling: '4:4:4',
};

// ── API-Hilfstypen ─────────────────────────────────────────────────────────

export interface AiStatus {
  available: boolean;
  model: string | null;
  reason: string | null;
}

export interface ServerCapabilities {
  ai: AiStatus;
  /** Formate, die dieser Rechner tatsächlich dekodieren kann. */
  inputFormats: string[];
  /**
   * Ob HEIF-Dateien überhaupt geöffnet werden können — beim Start einmal
   * wirklich ausprobiert, nicht aus einer Formatliste abgelesen. Sagt nichts
   * über HEVC-komprimiertes HEIC vom iPhone aus; das entscheidet sich erst
   * beim Import.
   */
  heifDecodable: boolean;
  rawPreviewSupported: boolean;
  maxUploadBytes: number;
}

/** Belegter Platz und Umfang der Ablage (§30). */
export interface StorageReport {
  dataDir: string;
  counts: { photos: number; projects: number; versions: number };
  sizes: {
    originals: number;
    working: number;
    previews: number;
    exports: number;
    database: number;
    total: number;
  };
}
