/**
 * Öffentliche Schnittstelle der Engine.
 *
 * Verwaltet zwei Quelltexturen:
 *  - die VORSCHAU (verkleinert, immer geladen) für die interaktive Ansicht
 *  - das ORIGINAL in voller Auflösung (nur bei Bedarf geladen) für die
 *    100-%-Ansicht und den Export
 *
 * Beide laufen durch denselben Render-Graphen. Der einzige Unterschied ist,
 * welche Textur und welcher Bildausschnitt hineingehen.
 */

import {
  assignBrushChannels,
  createDefaultParams,
  type EditParams,
  type LocalMask,
} from '@photomaster/shared';
import {
  GlError,
  TargetPool,
  createContext,
  uploadImage,
  type GlCapabilities,
} from './gl/core.ts';
import { FULL_REGION, Pipeline, type LowFrequency, type Region } from './pipeline.ts';
import { prepareMaskOverlay } from './uniforms.ts';


export interface SourceTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export interface ExportProgress {
  tilesDone: number;
  tilesTotal: number;
  phase: 'render' | 'readback';
}

export interface FullResRenderResult {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 4;
}

/** Kachelgröße und Überlappungsrand für den Export. */
const TILE_SIZE = 1024;
/**
 * Der Überlappungsrand muss größer sein als die summierte Reichweite aller
 * Faltungskerne (feine Unschärfe ≈ 15 px, Rauschreduzierung ≈ 10 px,
 * Schärfen ≈ 10 px). 64 px lässt reichlich Reserve — dadurch ist das Ergebnis
 * innerhalb der Kachel mathematisch identisch mit einer Berechnung über das
 * ganze Bild, und die Kachelgrenzen sind unsichtbar.
 */
const TILE_APRON = 64;

/**
 * Der unbearbeitete Zustand. Wird einmal angelegt und nie verändert — er ist
 * die Referenz für die "Vorher"-Seite des Vergleichs.
 */
const ORIGINAL_PARAMS: EditParams = createDefaultParams();

export class PhotoRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GlCapabilities;
  private readonly pool: TargetPool;
  private readonly pipeline: Pipeline;

  private preview: SourceTexture | null = null;
  private full: SourceTexture | null = null;
  private lowFreq: LowFrequency | null = null;

  /** Airlight-Schätzung für die Dunstentfernung; kommt aus der Bildanalyse. */
  airlight = 0.9;

  /**
   * Maske, die als roter Schleier eingeblendet wird (§28).
   *
   * Wirkt AUSSCHLIESSLICH auf die Bildschirmdarstellung. Die Export- und
   * Auslesepfade lesen dieses Feld nicht — eine Maskenvorschau kann damit
   * nicht versehentlich in einer exportierten Datei landen.
   */
  private overlayMask: LocalMask | null = null;

  setMaskOverlay(mask: LocalMask | null): void {
    this.overlayMask = mask;
  }

  /**
   * Uniforms für die Maskenvorschau. Bei einem Pinsel muss derselbe Farbkanal
   * herauskommen wie im Haupt-Pass, sonst zeigte die Vorschau die Striche
   * einer anderen Maske.
   */
  private buildOverlay(params: EditParams) {
    if (!this.overlayMask) return null;
    const channels = assignBrushChannels(params.masks);
    return prepareMaskOverlay(this.overlayMask, channels.get(this.overlayMask.id));
  }

  readonly canvas: HTMLCanvasElement;

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    caps: GlCapabilities,
  ) {
    this.canvas = canvas;
    this.gl = gl;
    this.caps = caps;
    this.pool = new TargetPool(gl, caps);
    this.pipeline = new Pipeline(gl, caps, this.pool);
  }

  static create(canvas: HTMLCanvasElement): PhotoRenderer {
    const { gl, caps } = createContext(canvas);
    return new PhotoRenderer(canvas, gl, caps);
  }

  get hasFullResolution(): boolean {
    return this.full !== null;
  }

  get previewSize(): { width: number; height: number } | null {
    return this.preview ? { width: this.preview.width, height: this.preview.height } : null;
  }

  // ── Quellen ──────────────────────────────────────────────────────────────

  setPreview(bitmap: ImageBitmap): void {
    this.disposePreview();
    this.assertFits(bitmap.width, bitmap.height);
    this.preview = uploadImage(this.gl, bitmap);
  }

  setFullResolution(bitmap: ImageBitmap): void {
    this.disposeFull();
    this.assertFits(bitmap.width, bitmap.height);
    this.full = uploadImage(this.gl, bitmap);
  }

  private assertFits(w: number, h: number): void {
    const max = this.caps.maxTextureSize;
    if (w > max || h > max) {
      throw new GlError(
        `Dieses Foto ist mit ${w}×${h} Pixeln größer als die Grafikkarte verarbeiten kann (Grenze: ${max} Pixel je Kante).`,
        'Die Bearbeitung in voller Auflösung ist auf diesem Gerät nicht möglich.',
      );
    }
  }

  /** Gibt das Original wieder frei — es belegt bei 24 MP rund 96 MB Grafikspeicher. */
  releaseFullResolution(): void {
    this.disposeFull();
  }

  // ── Rendern ──────────────────────────────────────────────────────────────

  private ensureLowFrequency(params: EditParams): LowFrequency {
    if (!this.preview) throw new GlError('Es ist kein Bild geladen.');
    this.lowFreq = this.pipeline.buildLowFrequency(
      this.preview.texture,
      this.preview.width,
      this.preview.height,
      params,
      this.lowFreq,
    );
    return this.lowFreq;
  }

  /**
   * Zeichnet auf den sichtbaren Canvas.
   *
   * `region` ist der dargestellte Bildausschnitt (0…1). Bei Zoom 100 % wird
   * automatisch das Original in voller Auflösung als Quelle verwendet, sofern
   * geladen — nur so sind Schärfe und Rauschreduzierung realistisch beurteilbar.
   */
  renderToCanvas(params: EditParams, region: Region = FULL_REGION, preferFullResolution = false): void {
    const source = preferFullResolution && this.full ? this.full : this.preview;
    if (!source) throw new GlError('Es ist kein Bild geladen.');

    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return;

    const lowFrequency = this.ensureLowFrequency(params);

    this.pipeline.render({
      sourceTexture: source.texture,
      sourceWidth: source.width,
      sourceHeight: source.height,
      region,
      outWidth: w,
      outHeight: h,
      params,
      lowFrequency,
      airlight: this.airlight,
      target: null,
      flipY: true,
      maskOverlay: this.buildOverlay(params),
    });
  }

  /**
   * Vorher/Nachher-Vergleich (§11) auf EINEM Canvas.
   *
   * Beide Hälften laufen als eigener Durchlauf durch denselben Graphen — links
   * mit unbearbeiteten Standardwerten, rechts mit den aktuellen. Jede Hälfte
   * rendert dabei nur ihren eigenen Bildausschnitt in ihre eigene Canvas-Hälfte;
   * es wird also nichts doppelt gerechnet und nichts übermalt.
   *
   * Der naheliegende Weg — zwei Canvas übereinander — bräuchte einen zweiten
   * WebGL-Kontext und damit eine zweite Kopie des Bildes im Grafikspeicher.
   * Bei 24 MP wären das 96 MB für einen Schieberegler.
   */
  renderCompare(
    params: EditParams,
    region: Region = FULL_REGION,
    splitFraction = 0.5,
    preferFullResolution = false,
  ): void {
    const source = preferFullResolution && this.full ? this.full : this.preview;
    if (!source) throw new GlError('Es ist kein Bild geladen.');

    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return;

    const split = Math.min(1, Math.max(0, splitFraction));
    const splitPx = Math.round(w * split);
    const lowFrequency = this.ensureLowFrequency(params);

    const common = {
      sourceTexture: source.texture,
      sourceWidth: source.width,
      sourceHeight: source.height,
      lowFrequency,
      airlight: this.airlight,
      target: null,
      flipY: true,
      outHeight: h,
      // Nur die bearbeitete Seite bekommt die Maskenvorschau; links steht
      // das Original, und auf einem Original gibt es nichts zu maskieren.
    } as const;

    if (splitPx > 0) {
      this.pipeline.render({
        ...common,
        region: { x: region.x, y: region.y, w: region.w * split, h: region.h },
        outWidth: splitPx,
        params: ORIGINAL_PARAMS,
        targetOffsetX: 0,
      });
    }

    if (splitPx < w) {
      this.pipeline.render({
        ...common,
        region: {
          x: region.x + region.w * split,
          y: region.y,
          w: region.w * (1 - split),
          h: region.h,
        },
        outWidth: w - splitPx,
        params,
        targetOffsetX: splitPx,
        maskOverlay: this.buildOverlay(params),
      });
    }
  }

  /** Rendert einen Ausschnitt in ein Offscreen-Ziel und liest ihn als RGBA aus. */
  private renderRegionToBytes(
    source: SourceTexture,
    params: EditParams,
    region: Region,
    outW: number,
    outH: number,
  ): Uint8Array {
    const lowFrequency = this.ensureLowFrequency(params);
    const target = this.pool.acquire(outW, outH, 'byte');

    this.pipeline.render({
      sourceTexture: source.texture,
      sourceWidth: source.width,
      sourceHeight: source.height,
      region,
      outWidth: outW,
      outHeight: outH,
      params,
      lowFrequency,
      airlight: this.airlight,
      target,
      flipY: false,
    });

    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    const result = new Uint8Array(outW * outH * 4);
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, result);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pool.release(target);
    return result;
  }

  /**
   * Rendert das Bild in voller Auflösung, kachelweise.
   *
   * Warum Kacheln: Ein einzelnes 6000×4000-Zwischenziel in 16-Bit-Gleitkomma
   * belegt 192 MB, und der Graph braucht mehrere davon gleichzeitig. Mit
   * 1024-px-Kacheln bleibt der Bedarf bei rund 8 MB je Zwischenziel — die
   * Verarbeitung skaliert damit auf beliebige Auflösungen, ohne dass der
   * Grafikspeicher zur Grenze wird.
   */
  async renderFullResolution(
    params: EditParams,
    onProgress?: (p: ExportProgress) => void,
  ): Promise<FullResRenderResult> {
    const source = this.full;
    if (!source) {
      throw new GlError(
        'Das Original ist nicht geladen.',
        'Für den Export muss die Originaldatei in voller Auflösung vorliegen.',
      );
    }

    const { width, height } = source;
    const out = new Uint8Array(width * height * 4);

    const cols = Math.ceil(width / TILE_SIZE);
    const rows = Math.ceil(height / TILE_SIZE);
    const tilesTotal = cols * rows;
    let tilesDone = 0;

    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const x0 = tx * TILE_SIZE;
        const y0 = ty * TILE_SIZE;
        const tw = Math.min(TILE_SIZE, width - x0);
        const th = Math.min(TILE_SIZE, height - y0);

        // Kachel samt Überlappungsrand, an den Bildrändern beschnitten.
        const ax0 = Math.max(0, x0 - TILE_APRON);
        const ay0 = Math.max(0, y0 - TILE_APRON);
        const ax1 = Math.min(width, x0 + tw + TILE_APRON);
        const ay1 = Math.min(height, y0 + th + TILE_APRON);
        const aw = ax1 - ax0;
        const ah = ay1 - ay0;

        const pixels = this.renderRegionToBytes(
          source,
          params,
          { x: ax0 / width, y: ay0 / height, w: aw / width, h: ah / height },
          aw,
          ah,
        );

        // Den Rand wieder wegschneiden und die Kachel an ihre Position im
        // Gesamtbild kopieren.
        const offX = x0 - ax0;
        const offY = y0 - ay0;
        for (let y = 0; y < th; y++) {
          const srcStart = ((offY + y) * aw + offX) * 4;
          const dstStart = ((y0 + y) * width + x0) * 4;
          out.set(pixels.subarray(srcStart, srcStart + tw * 4), dstStart);
        }

        tilesDone++;
        onProgress?.({ tilesDone, tilesTotal, phase: 'render' });

        // Dem Browser zwischen den Kacheln Luft geben, damit die Oberfläche
        // während des Exports bedienbar bleibt (§24).
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return { data: out, width, height, channels: 4 };
  }

  // ── Analyse-Hilfen ───────────────────────────────────────────────────────

  /**
   * Liest das UNBEARBEITETE Vorschaubild als RGBA-Pixel aus, verkleinert auf
   * höchstens `maxEdge`. Grundlage der Bildstatistik (Phase 6).
   */
  readSourcePixels(maxEdge = 1024): { data: Uint8Array; width: number; height: number } {
    if (!this.preview) throw new GlError('Es ist kein Bild geladen.');

    const target = this.pipeline.reduce(
      this.preview.texture,
      this.preview.width,
      this.preview.height,
      maxEdge,
    );
    const { width: w, height: h } = target;

    const data = new Uint8Array(w * h * 4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, data);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.pipeline.releaseTarget(target);

    return { data, width: w, height: h };
  }

  /** Liest das BEARBEITETE Bild in kleiner Auflösung — für das Live-Histogramm. */
  readProcessedPixels(params: EditParams, maxEdge = 512): { data: Uint8Array; width: number; height: number } {
    if (!this.preview) throw new GlError('Es ist kein Bild geladen.');
    const scale = Math.min(1, maxEdge / Math.max(this.preview.width, this.preview.height));
    const w = Math.max(1, Math.round(this.preview.width * scale));
    const h = Math.max(1, Math.round(this.preview.height * scale));
    const data = this.renderRegionToBytes(this.preview, params, FULL_REGION, w, h);
    return { data, width: w, height: h };
  }

  // ── Aufräumen ────────────────────────────────────────────────────────────

  private disposePreview(): void {
    if (this.preview) this.gl.deleteTexture(this.preview.texture);
    this.preview = null;
    this.pipeline.releaseLowFrequency(this.lowFreq);
    this.lowFreq = null;
  }

  private disposeFull(): void {
    if (this.full) this.gl.deleteTexture(this.full.texture);
    this.full = null;
  }

  dispose(): void {
    this.disposePreview();
    this.disposeFull();
    this.pipeline.dispose();
    this.pool.dispose();
  }
}
