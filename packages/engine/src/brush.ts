/**
 * Rastert Pinselmasken in eine Textur (§28).
 *
 * Bis zu vier Pinselmasken teilen sich EINE RGBA-Textur — eine je Farbkanal.
 * Der Grund ist eine Eigenheit von GLSL ES 3.0: Ein Array von Samplern lässt
 * sich dort nicht mit einem laufenden Schleifenindex ansprechen, eine
 * vec4-Komponente dagegen schon. Der Masken-Shader holt sich sein Gewicht
 * also mit `brushSample[kanal]` statt mit `texture(uBrush[i], …)`.
 *
 * Gerastert wird in der Auflösung des GERADE GERENDERTEN Ausschnitts. Bei der
 * Vorschau ist das die Bildschirmgröße, beim Export die Kachelgröße bei voller
 * Auflösung. Dadurch ist ein Pinselstrich im 6000-px-Export exakt so scharf
 * wie das Bild selbst — eine einmal gespeicherte Pixelmaske müsste man
 * hochskalieren und bekäme ausgefranste Ränder.
 */

import { brushSignature, type BrushStroke, type LocalMask } from '@photomaster/shared';
import { Program, type RenderTarget, type TargetPool } from './gl/core.ts';
import { BRUSH_FRAGMENT_SHADER, BRUSH_VERTEX_SHADER } from './shaders/brush.ts';
import type { Region } from './pipeline.ts';

/** Neun Gleitkommazahlen je Eckpunkt: Position, Segment, Pinselparameter. */
const FLOATS_PER_VERTEX = 9;
const VERTICES_PER_SEGMENT = 6;

interface DrawRange {
  first: number;
  count: number;
  erase: boolean;
}

export class BrushRasterizer {
  private readonly program: Program;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private vertices = new Float32Array(0);

  /** Zwischengespeicherte Rasterung samt der Bedingungen, unter denen sie gilt. */
  private cached: RenderTarget | null = null;
  private cacheKey = '';

  private readonly gl: WebGL2RenderingContext;
  private readonly pool: TargetPool;

  constructor(gl: WebGL2RenderingContext, pool: TargetPool) {
    this.gl = gl;
    this.pool = pool;
    this.program = new Program(gl, BRUSH_FRAGMENT_SHADER, 'brush', BRUSH_VERTEX_SHADER);

    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!buffer || !vao) throw new Error('Pinsel-Puffer konnte nicht angelegt werden.');
    this.buffer = buffer;
    this.vao = vao;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

    const stride = FLOATS_PER_VERTEX * 4;
    const bind = (name: string, size: number, offsetFloats: number) => {
      const loc = this.program.attrib(name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offsetFloats * 4);
    };
    bind('aPos', 2, 0);
    bind('aSegA', 2, 2);
    bind('aSegB', 2, 4);
    bind('aBrush', 3, 6);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Rastert alle Pinselmasken und liefert die Textur.
   * `null`, wenn es nichts zu zeichnen gibt — der Aufrufer bindet dann eine
   * beliebige Ersatztextur, deren Werte der Shader ohnehin nicht liest.
   */
  rasterize(
    masks: LocalMask[],
    channels: Map<string, number>,
    region: Region,
    width: number,
    height: number,
    aspect: number,
  ): RenderTarget | null {
    if (channels.size === 0) return null;

    const key = [
      brushSignature(masks),
      width,
      height,
      region.x.toFixed(5),
      region.y.toFixed(5),
      region.w.toFixed(5),
      region.h.toFixed(5),
    ].join('#');

    if (this.cached && this.cacheKey === key) return this.cached;

    const gl = this.gl;
    const target = this.cached ?? this.pool.acquire(width, height, 'byte');

    // Größe passt nicht mehr (Fenster verändert, Exportkachel): neu anfordern.
    if (target.width !== width || target.height !== height) {
      this.pool.release(target);
      this.cached = this.pool.acquire(width, height, 'byte');
    } else {
      this.cached = target;
    }

    const out = this.cached;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.program.use();
    this.program.v4('uRegion', region.x, region.y, region.w, region.h);
    this.program.f('uAspect', aspect);
    // Ein Zielpixel in korrigierten Einheiten — Grundlage der Kantenglättung.
    this.program.f('uTexel', region.h / Math.max(1, height));

    gl.enable(gl.BLEND);
    gl.bindVertexArray(this.vao);

    for (const mask of masks) {
      const channel = channels.get(mask.id);
      if (channel === undefined || mask.strokes.length === 0) continue;

      // Nur in den Kanal dieser Maske schreiben; die anderen drei bleiben,
      // wie sie sind. So teilen sich vier Masken eine Textur.
      gl.colorMask(channel === 0, channel === 1, channel === 2, channel === 3);

      const ranges = this.buildVertices(mask.strokes, aspect);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertices, gl.DYNAMIC_DRAW);

      for (const range of ranges) {
        // Malen nimmt jeweils den höheren Wert, Radieren den niedrigeren.
        // Dadurch bleibt ein Strich in sich gleichmäßig deckend, auch wenn
        // seine Stempel sich überlappen — mit additiver Überblendung gäbe es
        // an jeder Überlappung einen dunkleren Fleck.
        gl.blendEquation(range.erase ? gl.MIN : gl.MAX);
        this.program.f('uErase', range.erase ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, range.first, range.count);
      }
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.cacheKey = key;
    return out;
  }

  /**
   * Baut die Rechtecke für alle Segmente eines Maskenstrichsatzes.
   *
   * Jedes Segment bekommt ein gedrehtes Rechteck, das die Strecke plus den
   * Pinselradius nach allen Seiten umschließt. Aufeinanderfolgende Striche mit
   * gleicher Betriebsart (malen/radieren) werden zu einem Zeichenaufruf
   * zusammengefasst — in der Praxis ist das fast immer genau einer.
   */
  private buildVertices(strokes: BrushStroke[], aspect: number): DrawRange[] {
    let segmentCount = 0;
    for (const stroke of strokes) segmentCount += Math.max(1, stroke.points.length - 1);

    const needed = segmentCount * VERTICES_PER_SEGMENT * FLOATS_PER_VERTEX;
    if (this.vertices.length < needed) {
      // Mit Reserve wachsen, damit nicht bei jedem neuen Punkt neu belegt wird.
      this.vertices = new Float32Array(Math.ceil(needed * 1.5));
    }

    const v = this.vertices;
    const longEdgeCorrected = Math.max(aspect, 1);
    let cursor = 0;
    let vertexIndex = 0;
    const ranges: DrawRange[] = [];
    let current: DrawRange | null = null;

    for (const stroke of strokes) {
      if (!current || current.erase !== stroke.erase) {
        current = { first: vertexIndex, count: 0, erase: stroke.erase };
        ranges.push(current);
      }

      const radius = Math.max(1e-4, stroke.radius * longEdgeCorrected);
      const pts = stroke.points;
      const segments = Math.max(1, pts.length - 1);

      for (let i = 0; i < segments; i++) {
        const a = pts[i];
        // Ein Strich aus nur einem Punkt (kurzer Tipp) ist ein Segment der
        // Länge null — der Abstandstest liefert dafür einen runden Klecks.
        const b = pts[Math.min(i + 1, pts.length - 1)];

        const ax = (a.x - 0.5) * aspect;
        const ay = a.y - 0.5;
        const bx = (b.x - 0.5) * aspect;
        const by = b.y - 0.5;

        let dx = bx - ax;
        let dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) {
          dx = 1;
          dy = 0;
        } else {
          dx /= len;
          dy /= len;
        }
        const px = -dy;
        const py = dx;

        // Vier Ecken des umschließenden Rechtecks, in korrigiertem Raum.
        const corners: [number, number][] = [
          [ax - dx * radius + px * radius, ay - dy * radius + py * radius],
          [ax - dx * radius - px * radius, ay - dy * radius - py * radius],
          [bx + dx * radius + px * radius, by + dy * radius + py * radius],
          [bx + dx * radius - px * radius, by + dy * radius - py * radius],
        ];

        // Zwei Dreiecke: 0-1-2 und 2-1-3.
        for (const index of [0, 1, 2, 2, 1, 3]) {
          const [cx, cy] = corners[index];
          // Zurück in Bildkoordinaten — der Vertex-Shader rechnet von dort
          // in den Ausschnitt um.
          v[cursor++] = cx / aspect + 0.5;
          v[cursor++] = cy + 0.5;
          v[cursor++] = ax;
          v[cursor++] = ay;
          v[cursor++] = bx;
          v[cursor++] = by;
          v[cursor++] = radius;
          v[cursor++] = stroke.hardness;
          v[cursor++] = stroke.opacity;
          vertexIndex++;
          current.count++;
        }
      }
    }

    // Reste aus einem früheren, längeren Strichsatz dürfen nicht mitgezeichnet
    // werden; die Zeichenbereiche begrenzen das bereits, aber der Puffer wird
    // vollständig hochgeladen.
    v.fill(0, cursor);
    return ranges;
  }

  dispose(): void {
    this.pool.release(this.cached);
    this.cached = null;
    this.program.dispose();
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
  }
}
