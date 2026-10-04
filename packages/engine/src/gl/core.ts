/**
 * WebGL2-Grundbausteine: Kontext, Shader-Programme, Texturen, Framebuffer-Pool.
 *
 * Bewusst klein gehalten — die Engine braucht nur Fullscreen-Passes, kein
 * Geometrie-, Tiefen- oder Blending-System.
 */

export class GlError extends Error {
  /** Technische Ursache — fürs Log, nicht für den Nutzer. */
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'GlError';
    this.detail = detail;
  }
}

export interface GlCapabilities {
  /** Renderziele mit 16 Bit Gleitkomma pro Kanal möglich? */
  floatRenderTargets: boolean;
  maxTextureSize: number;
  renderer: string;
  vendor: string;
}

export function createContext(canvas: HTMLCanvasElement | OffscreenCanvas): {
  gl: WebGL2RenderingContext;
  caps: GlCapabilities;
} {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    // Ohne dieses Flag verwirft der Browser den Kontext bei Speicherdruck
    // kommentarlos; mit Flag bekommen wir ein contextlost-Event und können
    // den Nutzer informieren, statt einen schwarzen Canvas zu zeigen.
    failIfMajorPerformanceCaveat: false,
  });

  if (!gl) {
    throw new GlError(
      'Dieser Browser oder diese Grafikkarte unterstützt WebGL2 nicht.',
      'PhotoMaster benötigt WebGL2 für die Bildverarbeitung.',
    );
  }

  // Float-Renderziele sind für 16-Bit-Zwischenergebnisse nötig. Ohne sie
  // rechnen wir in 8 Bit weiter — sichtbar als Banding in weichen Verläufen.
  const floatRenderTargets =
    !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');

  return {
    gl,
    caps: {
      floatRenderTargets,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      renderer: dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : 'unbekannt',
      vendor: dbg ? (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) as string) : 'unbekannt',
    },
  };
}

// ── Shader-Programme ───────────────────────────────────────────────────────

/**
 * Vollflächiges Dreieck statt eines Quads: ein Dreieck, das über den Viewport
 * hinausragt, deckt die Fläche mit drei statt sechs Vertices ab und vermeidet
 * die Diagonale, an der zwei Dreiecke sonst doppelt schattiert werden.
 */
const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new GlError('Shader konnte nicht erstellt werden.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new GlError(`Shader "${label}" konnte nicht übersetzt werden.`, annotate(source, log));
  }
  return shader;
}

/** Hängt die fehlerhaften Quellzeilen an das Compiler-Log — sonst ist es unlesbar. */
function annotate(source: string, log: string): string {
  const lines = source.split('\n');
  const out = [log];
  for (const m of log.matchAll(/ERROR:\s*\d+:(\d+)/g)) {
    const n = Number(m[1]);
    for (let i = Math.max(1, n - 2); i <= Math.min(lines.length, n + 2); i++) {
      out.push(`${i === n ? '>' : ' '} ${i}: ${lines[i - 1]}`);
    }
  }
  return out.join('\n');
}

export class Program {
  readonly program: WebGLProgram;
  readonly label: string;
  private readonly gl: WebGL2RenderingContext;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    gl: WebGL2RenderingContext,
    fragmentSource: string,
    label: string,
    /**
     * Eigener Vertex-Shader. Ohne Angabe wird das vollflächige Dreieck
     * benutzt — das gilt für jeden Pass außer dem Pinsel, der echte Geometrie
     * je Strichsegment zeichnet.
     */
    vertexSource: string = VERTEX_SHADER,
  ) {
    this.gl = gl;
    this.label = label;
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, `${label}:vertex`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}:fragment`);
    const program = gl.createProgram();
    if (!program) throw new GlError('Programm konnte nicht erstellt werden.');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new GlError(`Programm "${label}" konnte nicht gelinkt werden.`, log);
    }
    this.program = program;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.locations.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, l);
    }
    return l;
  }

  /** Nicht vorhandene Uniforms werden still ignoriert — der Treiber entfernt
   *  ungenutzte Uniforms beim Optimieren, das ist kein Fehler. */
  f(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
  }
  i(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }
  v2(name: string, x: number, y: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }
  v3(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }
  v4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }
  fv(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1fv(l, v);
  }
  /** Array aus vec4 — die Maskendaten werden so übertragen. */
  v4v(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4fv(l, v);
  }
  /** Ort eines Vertex-Attributs; -1, wenn der Compiler es wegoptimiert hat. */
  attrib(name: string): number {
    return this.gl.getAttribLocation(this.program, name);
  }

  /** Bindet eine Textur an eine Sampler-Uniform und die zugehörige Texture-Unit. */
  tex(name: string, unit: number, texture: WebGLTexture): void {
    const l = this.loc(name);
    if (!l) return;
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.uniform1i(l, unit);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}

// ── Render-Targets ─────────────────────────────────────────────────────────

export interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  /** Interne Formatkennung, damit der Pool kompatible Ziele wiederverwendet. */
  formatKey: string;
  /** Belegter Grafikspeicher — Grundlage dafür, wann der Pool aufräumt. */
  bytes: number;
}

/**
 * So viel Grafikspeicher dürfen Ziele belegen, die gerade niemand benutzt.
 *
 * Genug, um den Arbeitssatz eines Vorschau-Frames auch auf einem großen
 * Bildschirm zwischen zwei Frames zu halten — und wenig genug, dass alte
 * Fenstergrößen und Exportkacheln nicht dauerhaft Speicher binden, den eine
 * integrierte Grafikeinheit mit dem ganzen System teilt.
 */
const IDLE_BUDGET_BYTES = 192 * 1024 * 1024;

/**
 * Die so vielen zuletzt angeforderten Formate gelten als in Gebrauch und
 * werden nie verdrängt — auch dann nicht, wenn das Budget überschritten ist.
 * Ein Vorschau-Frame benutzt drei bis fünf Formate (Bildschirmgröße in 16 und
 * 8 Bit, die Tiefpass-Größe, die Pinselmaske). Ohne diesen Schutz würde ein
 * Arbeitssatz, der allein größer ist als das Budget — ein großer Bildschirm —,
 * sich in jedem Frame selbst wegwerfen und neu anlegen. Gezählt wird nach
 * Formaten, nicht nach Anforderungen: Beim Ziehen am Fensterrand bringt jeder
 * Frame eine neue Größe mit, und die vorige soll dann rasch abgegeben werden.
 */
const PROTECTED_FORMATS = 8;

export type TargetPrecision = 'float' | 'byte';

/**
 * Hält Render-Targets vor und gibt sie wieder frei. 24-MP-Verarbeitung erzeugt
 * pro Pass ein Ziel von bis zu 190 MB; ohne Wiederverwendung würde die GPU
 * innerhalb weniger Frames den Speicher verlieren.
 *
 * Wiederverwendet wird nur ein Ziel derselben Größe. Daraus folgt die zweite
 * Aufgabe des Pools: Ziele einer Größe, die niemand mehr anfordert, wieder
 * abzugeben. Jede Fenstergröße beim Ziehen am Rand und jede Kachelgröße eines
 * Exports bliebe sonst bis zum Schließen des Editors im Grafikspeicher —
 * beim Ziehen am Fensterrand wüchse er mit jeder Zwischengröße. Freigegeben
 * wird deshalb, sobald die ruhenden Ziele das Budget überschreiten, und zwar
 * das am längsten nicht mehr angeforderte Format zuerst.
 */
export class TargetPool {
  private readonly free: RenderTarget[] = [];
  private readonly live = new Set<RenderTarget>();
  /** Formatkennung → Zeitpunkt der letzten Anforderung (fortlaufender Zähler). */
  private readonly lastUse = new Map<string, number>();
  private tick = 0;
  private freeBytes = 0;
  private readonly gl: WebGL2RenderingContext;
  private readonly caps: GlCapabilities;

  constructor(gl: WebGL2RenderingContext, caps: GlCapabilities) {
    this.gl = gl;
    this.caps = caps;
  }

  acquire(width: number, height: number, precision: TargetPrecision = 'float'): RenderTarget {
    const usableFloat = precision === 'float' && this.caps.floatRenderTargets;
    const formatKey = `${usableFloat ? 'f16' : 'u8'}:${width}x${height}`;
    this.lastUse.set(formatKey, ++this.tick);

    const idx = this.free.findIndex((t) => t.formatKey === formatKey);
    if (idx >= 0) {
      const t = this.free.splice(idx, 1)[0];
      this.freeBytes -= t.bytes;
      this.live.add(t);
      return t;
    }

    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new GlError('Textur konnte nicht angelegt werden (Grafikspeicher erschöpft?).');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, usableFloat ? gl.RGBA16F : gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new GlError('Framebuffer konnte nicht angelegt werden.');
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      throw new GlError(
        `Render-Ziel ${width}×${height} konnte nicht erstellt werden.`,
        `Framebuffer-Status 0x${status.toString(16)}`,
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const bytes = width * height * (usableFloat ? 8 : 4);
    const target: RenderTarget = { texture, framebuffer, width, height, formatKey, bytes };
    this.live.add(target);
    return target;
  }

  release(target: RenderTarget | null | undefined): void {
    if (!target) return;
    if (!this.live.delete(target)) return;
    this.free.push(target);
    this.freeBytes += target.bytes;
    this.evictIdle();
  }

  /** Gibt ruhende Ziele ab, bis das Budget wieder eingehalten ist. */
  private evictIdle(): void {
    while (this.freeBytes > IDLE_BUDGET_BYTES) {
      let oldest = -1;
      let oldestUse = Infinity;
      for (let i = 0; i < this.free.length; i++) {
        const use = this.lastUse.get(this.free[i].formatKey) ?? 0;
        if (use < oldestUse) {
          oldestUse = use;
          oldest = i;
        }
      }
      if (oldest < 0) return;

      // Ist selbst das älteste ruhende Format noch unter den zuletzt
      // benutzten, ist alles Übrige gerade in Gebrauch — dann lieber über dem
      // Budget bleiben, als den laufenden Frame neu anlegen zu lassen.
      let newer = 0;
      for (const use of this.lastUse.values()) if (use > oldestUse) newer++;
      if (newer < PROTECTED_FORMATS) return;

      const [target] = this.free.splice(oldest, 1);
      this.freeBytes -= target.bytes;
      this.destroyTarget(target);
      this.forgetIfUnused(target.formatKey);
    }
  }

  /** Vergisst ein Format, von dem kein Ziel mehr existiert. */
  private forgetIfUnused(formatKey: string): void {
    if (this.free.some((t) => t.formatKey === formatKey)) return;
    for (const t of this.live) if (t.formatKey === formatKey) return;
    this.lastUse.delete(formatKey);
  }

  private destroyTarget(t: RenderTarget): void {
    this.gl.deleteTexture(t.texture);
    this.gl.deleteFramebuffer(t.framebuffer);
  }

  dispose(): void {
    for (const t of this.free) this.destroyTarget(t);
    for (const t of this.live) this.destroyTarget(t);
    this.free.length = 0;
    this.live.clear();
    this.lastUse.clear();
    this.freeBytes = 0;
  }

  get stats(): { free: number; live: number; freeBytes: number } {
    return { free: this.free.length, live: this.live.size, freeBytes: this.freeBytes };
  }
}

// ── Hilfsfunktionen ────────────────────────────────────────────────────────

export function drawTo(
  gl: WebGL2RenderingContext,
  target: RenderTarget | null,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
  gl.viewport(offsetX, offsetY, width, height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Lädt ein dekodiertes Bild als 8-Bit-Textur hoch. */
export function uploadImage(
  gl: WebGL2RenderingContext,
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement | ImageData,
): { texture: WebGLTexture; width: number; height: number } {
  const width = 'width' in source ? source.width : 0;
  const height = 'height' in source ? source.height : 0;

  const texture = gl.createTexture();
  if (!texture) throw new GlError('Bildtextur konnte nicht angelegt werden.');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const err = gl.getError();
  if (err !== gl.NO_ERROR) {
    gl.deleteTexture(texture);
    throw new GlError(
      `Das Bild (${width}×${height}) passt nicht in den Grafikspeicher.`,
      `GL-Fehler 0x${err.toString(16)}`,
    );
  }

  return { texture, width, height };
}

/**
 * Lädt die vier Tonwertkurven als eine RGBA-Textur der Größe N×1 hoch
 * (x = Master, y = Rot, z = Grün, w = Blau). Wird bei jeder Kurvenänderung
 * aktualisiert, deshalb per texSubImage2D ohne Neuanlage.
 */
export function uploadCurveTexture(
  gl: WebGL2RenderingContext,
  data: Float32Array,
  size: number,
  existing?: WebGLTexture | null,
): WebGLTexture {
  if (existing) {
    gl.bindTexture(gl.TEXTURE_2D, existing);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, 1, gl.RGBA, gl.FLOAT, data);
    return existing;
  }

  const texture = gl.createTexture();
  if (!texture) throw new GlError('Kurventextur konnte nicht angelegt werden.');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // RGBA16F statt RGBA32F: 32-Bit-Float-Texturen sind in WebGL2 ohne die
  // Erweiterung OES_texture_float_linear NICHT linear filterbar, halbe
  // Genauigkeit dagegen immer. Für eine Kurve auf 8-Bit-Ausgabe sind die
  // ~2048 unterscheidbaren Stufen von RGBA16F weit mehr als nötig.
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, size, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, 1, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}
