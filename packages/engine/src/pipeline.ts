/**
 * Der Render-Graph.
 *
 * Genau dieser Code läuft für die Bildschirmvorschau, für die 100-%-Ansicht und
 * für jede einzelne Kachel des Exports. Es gibt keine zweite Implementierung
 * der Bildmathematik — deshalb kann der Export nicht anders aussehen als die
 * Vorschau (siehe ARCHITECTURE.md §2).
 *
 * Aufbau:
 *
 *   [Quelle] → Tone → (Local) → (Masks) → (Denoise) → (Sharpen) → (Color) → Output
 *                ↑         ↑
 *      global vorberechnet: Clarity-Tiefpass + Dunstschleier
 *
 * Passes in Klammern entfallen, wenn ihre Parameter auf dem Default stehen.
 * Ein unbearbeitetes Bild kostet damit zwei Passes statt sieben.
 */

import { assignBrushChannels, type EditParams } from '@photomaster/shared';
import {
  Program,
  TargetPool,
  drawTo,
  uploadCurveTexture,
  type GlCapabilities,
  type RenderTarget,
} from './gl/core.ts';
import { BLUR_SHADER, DARK_CHANNEL_SHADER, DOWNSAMPLE_SHADER } from './shaders/blur.ts';
import { COLOR_SHADER, OUTPUT_SHADER } from './shaders/color.ts';
import { DENOISE_SHADER, SHARPEN_SHADER } from './shaders/detail.ts';
import { LOCAL_SHADER } from './shaders/local.ts';
import { MASK_OVERLAY_SHADER, MASK_SHADER } from './shaders/masks.ts';
import { BrushRasterizer } from './brush.ts';
import { TONE_SHADER } from './shaders/tone.ts';
import {
  CURVE_LUT_SIZE,
  buildCurveTextureData,
  lowFrequencyKey,
  prepareMasks,
  prepareUniforms,
  type MaskUniforms,
  type PreparedUniforms,
} from './uniforms.ts';

/** Radien als Anteil der langen Bildkante — siehe ARCHITECTURE.md §2. */
const FINE_DETAIL_SIGMA = 0.0008; // Struktur
const CLARITY_SIGMA = 0.0085; // Klarheit (auf dem Tiefpass-Bild)
const VEIL_SIGMA = 0.016; // Dunstschleier
/** Kantenlänge des global vorberechneten Tiefpass-Bildes. */
const LOW_FREQ_EDGE = 768;

const MAX_TAPS = 32;

export interface Region {
  /** Ursprung und Größe im Gesamtbild, normalisiert auf 0…1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_REGION: Region = { x: 0, y: 0, w: 1, h: 1 };

export interface LowFrequency {
  clarity: RenderTarget;
  veil: RenderTarget;
  key: string;
}

export interface RenderRequest {
  /** Textur, die das gesamte Bild abdeckt (Vorschau- oder volle Auflösung). */
  sourceTexture: WebGLTexture;
  sourceWidth: number;
  sourceHeight: number;
  /** Auszugebender Bildausschnitt. */
  region: Region;
  outWidth: number;
  outHeight: number;
  params: EditParams;
  lowFrequency: LowFrequency;
  /** Airlight-Schätzung aus der Bildanalyse (0…1). */
  airlight: number;
  /** Ziel; `null` rendert auf den sichtbaren Canvas. */
  target: RenderTarget | null;
  /** Beim Zeichnen auf den Canvas nötig (Framebuffer-Zeile 0 liegt unten). */
  flipY: boolean;
  /**
   * Versatz im Zielpuffer für den LETZTEN Pass. Wird für den
   * Vorher/Nachher-Vergleich benutzt: Beide Hälften laufen als eigenständiger
   * Durchlauf durch den Graphen und landen nebeneinander auf demselben Canvas.
   * Die Zwischenziele bleiben davon unberührt — sie sind so groß wie die
   * jeweilige Hälfte und werden vollständig beschrieben.
   */
  targetOffsetX?: number;
  targetOffsetY?: number;
  /**
   * Zeigt eine Maske als roten Schleier über dem fertigen Bild (§28).
   * Reine Anzeigehilfe — sie läuft nach der Ausgabe und verändert nichts am
   * Ergebnis, das exportiert wird.
   */
  maskOverlay?: MaskUniforms | null;
}

export class Pipeline {
  private readonly tone: Program;
  private readonly blur: Program;
  private readonly downsample: Program;
  private readonly darkChannel: Program;
  private readonly local: Program;
  private readonly masks: Program;
  private readonly maskOverlay: Program;
  private readonly denoise: Program;
  private readonly sharpen: Program;
  private readonly color: Program;
  private readonly output: Program;

  private readonly brush: BrushRasterizer;

  private curveTexture: WebGLTexture | null = null;
  private curveKey = '';

  private readonly gl: WebGL2RenderingContext;
  readonly caps: GlCapabilities;
  private readonly pool: TargetPool;

  constructor(gl: WebGL2RenderingContext, caps: GlCapabilities, pool: TargetPool) {
    this.gl = gl;
    this.caps = caps;
    this.pool = pool;
    this.tone = new Program(gl, TONE_SHADER, 'tone');
    this.blur = new Program(gl, BLUR_SHADER, 'blur');
    this.downsample = new Program(gl, DOWNSAMPLE_SHADER, 'downsample');
    this.darkChannel = new Program(gl, DARK_CHANNEL_SHADER, 'darkChannel');
    this.local = new Program(gl, LOCAL_SHADER, 'local');
    this.masks = new Program(gl, MASK_SHADER, 'masks');
    this.maskOverlay = new Program(gl, MASK_OVERLAY_SHADER, 'maskOverlay');
    this.denoise = new Program(gl, DENOISE_SHADER, 'denoise');
    this.sharpen = new Program(gl, SHARPEN_SHADER, 'sharpen');
    this.color = new Program(gl, COLOR_SHADER, 'color');
    this.output = new Program(gl, OUTPUT_SHADER, 'output');
    this.brush = new BrushRasterizer(gl, pool);
  }

  /** Setzt die Region-Uniforms, die jeder Pass gemeinsam hat. */
  private setRegion(p: Program, srcRect: Region, region: Region): void {
    p.v4('uSrcRect', srcRect.x, srcRect.y, srcRect.w, srcRect.h);
    p.v2('uRegionOrigin', region.x, region.y);
    p.v2('uRegionSize', region.w, region.h);
  }

  private ensureCurveTexture(params: EditParams): WebGLTexture {
    const key = JSON.stringify(params.curves);
    if (this.curveTexture && key === this.curveKey) return this.curveTexture;
    const data = buildCurveTextureData(params.curves);
    this.curveTexture = uploadCurveTexture(this.gl, data, CURVE_LUT_SIZE, this.curveTexture);
    this.curveKey = key;
    return this.curveTexture;
  }

  // ── Einzelne Passes ──────────────────────────────────────────────────────

  private runTone(
    srcTexture: WebGLTexture,
    srcRect: Region,
    region: Region,
    u: PreparedUniforms,
    params: EditParams,
    out: RenderTarget | null,
    outW: number,
    outH: number,
  ): void {
    const p = this.tone;
    p.use();
    this.setRegion(p, srcRect, region);
    p.tex('uSrc', 0, srcTexture);
    p.tex('uCurves', 1, this.ensureCurveTexture(params));
    p.v3('uWbGain', u.tone.wbGain[0], u.tone.wbGain[1], u.tone.wbGain[2]);
    p.f('uExposure', u.tone.exposure);
    p.f('uContrast', u.tone.contrast);
    p.f('uHighlights', u.tone.highlights);
    p.f('uShadows', u.tone.shadows);
    p.f('uWhites', u.tone.whites);
    p.f('uBlacks', u.tone.blacks);
    p.f('uCurveActive', u.tone.curveActive ? 1 : 0);
    drawTo(this.gl, out, outW, outH);
  }

  /**
   * Separabler Gauß in zwei Durchgängen.
   *
   * Reicht die feste Obergrenze von 32 Abtastungen je Richtung für das
   * gewünschte σ nicht aus, wird der Abtastabstand vergrößert statt das σ zu
   * beschneiden. Ein zu kleiner Radius wäre ein sichtbarer Fehler (Klarheit
   * würde plötzlich wie Struktur wirken); eine gröbere Abtastung eines
   * Tiefpass-Signals ist dagegen praktisch unsichtbar.
   */
  private runBlur(src: RenderTarget, sigmaPx: number): RenderTarget {
    const gl = this.gl;
    const stride = Math.max(1, Math.ceil((3 * sigmaPx) / MAX_TAPS));
    const taps = Math.min(MAX_TAPS, Math.max(1, Math.ceil((3 * sigmaPx) / stride)));
    const falloff = (stride * stride) / (2 * sigmaPx * sigmaPx);

    const pass = (input: RenderTarget, dx: number, dy: number): RenderTarget => {
      const out = this.pool.acquire(input.width, input.height);
      const p = this.blur;
      p.use();
      this.setRegion(p, FULL_REGION, FULL_REGION);
      p.tex('uSrc', 0, input.texture);
      p.v2('uStep', (dx * stride) / input.width, (dy * stride) / input.height);
      p.f('uFalloff', falloff);
      p.i('uTaps', taps);
      drawTo(gl, out, out.width, out.height);
      return out;
    };

    const h = pass(src, 1, 0);
    const v = pass(h, 0, 1);
    this.pool.release(h);
    return v;
  }

  private halve(texture: WebGLTexture, width: number, height: number): RenderTarget {
    const out = this.pool.acquire(Math.max(1, width >> 1), Math.max(1, height >> 1));
    const p = this.downsample;
    p.use();
    this.setRegion(p, FULL_REGION, FULL_REGION);
    p.tex('uSrc', 0, texture);
    p.v2('uTexel', 1 / width, 1 / height);
    drawTo(this.gl, out, out.width, out.height);
    return out;
  }

  /**
   * Verkleinert eine Textur durch wiederholte Halbierung auf höchstens
   * `maxEdge` Kantenlänge.
   *
   * Die Halbierung mit 2×2-Mittelwert ist hier nicht Kosmetik: Würde man
   * stattdessen in einem Schritt mit bilinearer Filterung verkleinern, würde
   * jedes Zielpixel nur vier Quellpixel sehen und den Rest ignorieren. Das
   * daraus berechnete Histogramm wäre eine Stichprobe von wenigen Prozent der
   * Pixel — und die Statistik, auf der die KI arbeitet, entsprechend falsch.
   */
  reduce(texture: WebGLTexture, width: number, height: number, maxEdge: number): RenderTarget {
    let current: RenderTarget | null = null;
    let w = width;
    let h = height;

    while (Math.max(w, h) > maxEdge * 2 && w > 2 && h > 2) {
      const next = this.halve(current ? current.texture : texture, w, h);
      this.pool.release(current);
      current = next;
      w = next.width;
      h = next.height;
    }

    // Letzter Schritt auf die exakte Zielgröße.
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    const out = this.pool.acquire(outW, outH, 'byte');
    const p = this.downsample;
    p.use();
    this.setRegion(p, FULL_REGION, FULL_REGION);
    p.tex('uSrc', 0, current ? current.texture : texture);
    p.v2('uTexel', 1 / w, 1 / h);
    drawTo(this.gl, out, outW, outH);
    this.pool.release(current);
    return out;
  }

  releaseTarget(t: RenderTarget | null): void {
    this.pool.release(t);
  }

  // ── Global vorberechnetes Tiefpass-Signal ────────────────────────────────

  /**
   * Berechnet den Klarheits-Tiefpass und den Dunstschleier EINMAL für das
   * ganze Bild in niedriger Auflösung.
   *
   * Beides sind per Definition tieffrequente Signale, deshalb ist ein 768-px-
   * Bild davon genauso gut wie ein 6000-px-Bild — und es macht den
   * kachelweisen Export überhaupt erst praktikabel: Ohne diese Vorberechnung
   * bräuchte jede Kachel einen Überlappungsrand in der Größe des
   * Unschärferadius (mehrere hundert Pixel bei 24 MP).
   */
  buildLowFrequency(
    previewTexture: WebGLTexture,
    previewWidth: number,
    previewHeight: number,
    params: EditParams,
    previous?: LowFrequency | null,
  ): LowFrequency {
    const key = lowFrequencyKey(params);
    if (previous && previous.key === key) return previous;
    if (previous) {
      this.pool.release(previous.clarity);
      this.pool.release(previous.veil);
    }

    const scale = LOW_FREQ_EDGE / Math.max(previewWidth, previewHeight);
    const w = Math.max(16, Math.round(previewWidth * Math.min(1, scale)));
    const h = Math.max(16, Math.round(previewHeight * Math.min(1, scale)));
    const longEdge = Math.max(w, h);

    const u = prepareUniforms(params);
    const base = this.pool.acquire(w, h);
    this.runTone(previewTexture, FULL_REGION, FULL_REGION, u, params, base, w, h);

    const clarity = this.runBlur(base, Math.max(1, longEdge * CLARITY_SIGMA));

    const dark = this.pool.acquire(w, h);
    const dc = this.darkChannel;
    dc.use();
    this.setRegion(dc, FULL_REGION, FULL_REGION);
    dc.tex('uSrc', 0, base.texture);
    dc.v2('uTexel', 1 / w, 1 / h);
    drawTo(this.gl, dark, w, h);

    const veil = this.runBlur(dark, Math.max(1, longEdge * VEIL_SIGMA));

    this.pool.release(base);
    this.pool.release(dark);

    return { clarity, veil, key };
  }

  releaseLowFrequency(lf: LowFrequency | null | undefined): void {
    if (!lf) return;
    this.pool.release(lf.clarity);
    this.pool.release(lf.veil);
  }

  /**
   * Belegt die acht vec4-Arrays einer Maskengruppe. Wird vom Masken-Pass und
   * von der Maskenvorschau gleichermaßen benutzt, damit beide zwangsläufig
   * dieselbe Geometrie sehen — eine Vorschau, die etwas anderes zeigt als die
   * Wirkung, wäre schlimmer als gar keine.
   */
  private setMaskUniforms(p: Program, m: MaskUniforms, full: boolean): void {
    p.v4v('uMaskGeoA', m.geoA);
    p.v4v('uMaskGeoB', m.geoB);
    p.v4v('uMaskLum', m.lum);
    p.v4v('uMaskCol', m.col);
    p.v4v('uMaskC', m.c);
    p.v4v('uMaskD', m.d);
    if (full) {
      p.v4v('uMaskA', m.a);
      p.v4v('uMaskB', m.b);
    }
  }

  // ── Hauptdurchlauf ───────────────────────────────────────────────────────

  render(req: RenderRequest): void {
    const gl = this.gl;
    const u = prepareUniforms(req.params);
    const { outWidth: w, outHeight: h, region } = req;

    // Die Quelle wird über `region` abgetastet; ab hier arbeiten alle Passes
    // auf Zwischentexturen der Zielgröße und tasten diese 1:1 ab.
    const srcRectOfSource: Region = region;
    const identity = FULL_REGION;

    let current = this.pool.acquire(w, h);
    this.runTone(req.sourceTexture, srcRectOfSource, region, u, req.params, current, w, h);

    const longEdge = Math.max(req.sourceWidth, req.sourceHeight);

    // Wie viele Quellpixel fallen auf ein gerendertes Pixel? Bei der
    // Vollbildvorschau > 1 (das Bild ist verkleinert), bei einer Exportkachel
    // und in der 100-%-Ansicht genau 1.
    const srcPerOut = (region.w * req.sourceWidth) / w;

    if (u.local.active) {
      // "Struktur" ist als Anteil der langen Bildkante definiert. Durch die
      // Umrechnung in Zielpixel wirkt der Regler in der 2560-px-Vorschau auf
      // exakt dieselbe relative Detailgröße wie im 6000-px-Export.
      let fine: RenderTarget | null = null;
      if (u.local.texture !== 0) {
        const sigmaSrc = longEdge * FINE_DETAIL_SIGMA;
        fine = this.runBlur(current, Math.max(0.7, sigmaSrc / srcPerOut));
      }

      const out = this.pool.acquire(w, h);
      const p = this.local;
      p.use();
      this.setRegion(p, identity, region);
      p.tex('uSrc', 0, current.texture);
      p.tex('uBlurFine', 1, (fine ?? current).texture);
      p.tex('uClarityBlur', 2, req.lowFrequency.clarity.texture);
      p.tex('uVeil', 3, req.lowFrequency.veil.texture);
      p.f('uTexture', u.local.texture);
      p.f('uClarity', u.local.clarity);
      p.f('uDehaze', u.local.dehaze);
      p.f('uAirlight', req.airlight);
      drawTo(gl, out, w, h);

      this.pool.release(fine);
      this.pool.release(current);
      current = out;
    }

    // Lokale Masken (§28). Läuft vor Rauschreduzierung, Schärfung und Farbe —
    // die Begründung für diese Reihenfolge steht im Masken-Shader.
    // Pinselmasken werden für genau diesen Ausschnitt in genau dieser Größe
    // gerastert. Bei der Vorschau ist das die Bildschirmgröße, beim Export die
    // Kachel in voller Auflösung — der Strich ist dadurch immer so scharf wie
    // das Bild selbst.
    const brushChannels = assignBrushChannels(req.params.masks);
    const aspect = req.sourceWidth / Math.max(1, req.sourceHeight);
    const brushTexture =
      brushChannels.size > 0
        ? this.brush.rasterize(req.params.masks, brushChannels, region, w, h, aspect)
        : null;

    const masks = prepareMasks(req.params.masks, brushChannels);
    if (masks.active) {
      // Die feine Unschärfe wird aus dem AKTUELLEN Stand berechnet, nicht aus
      // dem des Lokalkontrast-Passes: Hätte dieser das Bild bereits verändert,
      // würde die Differenz "Bild minus Unschärfe" ein Detail beschreiben, das
      // so nicht mehr existiert.
      let fine: RenderTarget | null = null;
      if (masks.needsFineBlur) {
        const sigmaSrc = longEdge * FINE_DETAIL_SIGMA;
        fine = this.runBlur(current, Math.max(0.7, sigmaSrc / srcPerOut));
      }

      const out = this.pool.acquire(w, h);
      const p = this.masks;
      p.use();
      this.setRegion(p, identity, region);
      p.tex('uSrc', 0, current.texture);
      p.tex('uBlurFine', 1, (fine ?? current).texture);
      p.tex('uClarityBlur', 2, req.lowFrequency.clarity.texture);
      p.tex('uVeil', 3, req.lowFrequency.veil.texture);
      // Ohne Pinselmaske wird eine beliebige Textur gebunden; der Shader liest
      // sie nur, wenn eine Maske vom Typ Pinsel vorkommt. Eine nicht gebundene
      // Sampler-Uniform wäre in WebGL dagegen ein Fehler.
      p.tex('uBrushMasks', 4, (brushTexture ?? current).texture);
      p.f('uAirlight', req.airlight);
      p.f('uAspect', aspect);
      p.i('uMaskCount', masks.count);
      this.setMaskUniforms(p, masks, true);
      drawTo(gl, out, w, h);

      this.pool.release(fine);
      this.pool.release(current);
      current = out;
    }

    if (u.denoise.active) {
      const out = this.pool.acquire(w, h);
      const p = this.denoise;
      p.use();
      this.setRegion(p, identity, region);
      p.tex('uSrc', 0, current.texture);
      p.v2('uTexel', 1 / w, 1 / h);
      p.f('uLumStrength', u.denoise.lumStrength);
      p.f('uColorStrength', u.denoise.colorStrength);
      p.f('uLumRadius', u.denoise.lumRadius);
      p.f('uColorRadius', u.denoise.colorRadius);
      drawTo(gl, out, w, h);
      this.pool.release(current);
      current = out;
    }

    if (u.sharpen.active) {
      const blurred = this.runBlur(current, Math.max(0.4, u.sharpen.radius));
      const out = this.pool.acquire(w, h);
      const p = this.sharpen;
      p.use();
      this.setRegion(p, identity, region);
      p.tex('uSrc', 0, current.texture);
      p.tex('uBlur', 1, blurred.texture);
      p.v2('uTexel', 1 / w, 1 / h);
      p.f('uAmount', u.sharpen.amount);
      p.f('uDetail', u.sharpen.detail);
      p.f('uMasking', u.sharpen.masking);
      drawTo(gl, out, w, h);
      this.pool.release(blurred);
      this.pool.release(current);
      current = out;
    }

    if (u.color.active) {
      const out = this.pool.acquire(w, h);
      const p = this.color;
      p.use();
      this.setRegion(p, identity, region);
      p.tex('uSrc', 0, current.texture);
      p.fv('uHslHue', u.color.hslHue);
      p.fv('uHslSat', u.color.hslSat);
      p.fv('uHslLum', u.color.hslLum);
      p.f('uHslActive', u.color.hslActive ? 1 : 0);
      p.f('uVibrance', u.color.vibrance);
      p.f('uSaturation', u.color.saturation);
      p.v3('uGradeShadow', ...u.color.gradeShadow);
      p.v3('uGradeMid', ...u.color.gradeMid);
      p.v3('uGradeHigh', ...u.color.gradeHigh);
      p.f('uGradeBlending', u.color.gradeBlending);
      p.f('uGradeBalance', u.color.gradeBalance);
      p.f('uGradeActive', u.color.gradeActive ? 1 : 0);
      drawTo(gl, out, w, h);
      this.pool.release(current);
      current = out;
    }

    // Ausgabe: Korn, Vignette, Spiegelung. Läuft immer — sie ist zugleich der
    // Übergang vom 16-Bit-Zwischenformat in das Ausgabeziel.
    //
    // Ist eine Maskenvorschau gewünscht, geht die Ausgabe zuerst in ein
    // Zwischenziel; der rote Schleier wird danach darübergelegt. Dadurch
    // bleibt die Vorschau strikt eine Anzeigeschicht über dem fertigen Bild
    // und kann das Ergebnis nicht beeinflussen.
    const overlay = req.maskOverlay ?? null;
    const outputTarget = overlay ? this.pool.acquire(w, h, 'byte') : req.target;

    {
      const p = this.output;
      p.use();
      this.setRegion(p, identity, region);
      p.tex('uSrc', 0, current.texture);
      p.v2('uImageSizePx', req.sourceWidth, req.sourceHeight);
      p.f('uGrainAmount', u.effects.grainAmount);
      p.f('uGrainCell', Math.max(0.5, u.effects.grainCellFraction * longEdge));
      p.f('uGrainRoughness', u.effects.grainRoughness);
      p.f('uVigAmount', u.effects.vigAmount);
      p.f('uVigMidpoint', u.effects.vigMidpoint);
      p.f('uVigFeather', u.effects.vigFeather);
      p.f('uVigRoundness', u.effects.vigRoundness);
      // Beim Zwischenziel darf noch nicht gespiegelt werden — sonst spiegelte
      // die Überlagerung ein zweites Mal zurück.
      p.f('uFlipY', overlay ? 0 : req.flipY ? 1 : 0);
      drawTo(
        gl,
        outputTarget,
        w,
        h,
        overlay ? 0 : (req.targetOffsetX ?? 0),
        overlay ? 0 : (req.targetOffsetY ?? 0),
      );
    }

    if (overlay && outputTarget) {
      const p = this.maskOverlay;
      p.use();
      this.setRegion(p, identity, region);
      p.tex('uSrc', 0, outputTarget.texture);
      p.tex('uBrushMasks', 1, (brushTexture ?? outputTarget).texture);
      p.f('uAspect', aspect);
      p.i('uMaskIndex', 0);
      this.setMaskUniforms(p, overlay, false);
      p.f('uFlipY', req.flipY ? 1 : 0);
      drawTo(gl, req.target, w, h, req.targetOffsetX ?? 0, req.targetOffsetY ?? 0);
      this.pool.release(outputTarget);
    }

    this.pool.release(current);
  }

  dispose(): void {
    for (const p of [
      this.tone,
      this.blur,
      this.downsample,
      this.darkChannel,
      this.local,
      this.masks,
      this.maskOverlay,
      this.denoise,
      this.sharpen,
      this.color,
      this.output,
    ]) {
      p.dispose();
    }
    this.brush.dispose();
    if (this.curveTexture) this.gl.deleteTexture(this.curveTexture);
  }
}
