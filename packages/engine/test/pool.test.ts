/**
 * Grafikspeicher der Engine (§24, §35).
 *
 * Der Pool für Render-Ziele hat freigewordene Ziele früher nie abgegeben:
 * Jede Fenstergröße beim Ziehen am Rand und jede Kachelgröße eines Exports
 * blieb bis zum Schließen des Editors im Grafikspeicher. Auf einer integrierten
 * Grafikeinheit, die ihren Speicher mit dem System teilt, endet das im Verlust
 * des WebGL-Kontexts — die Vorschau wird schwarz.
 *
 * WebGL gibt es unter Node nicht. Der Pool ruft aber nur eine Handvoll
 * Funktionen auf; ein nachgebauter Kontext, der Anlegen und Löschen von
 * Texturen mitzählt, reicht, um die Buchführung zu prüfen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { TargetPool } = await import('../src/gl/core.ts');

const MB = 1024 * 1024;

/** WebGL-Attrappe, die belegten Texturspeicher bilanziert. */
function fakeGl() {
  let bound: unknown = null;
  const bytesOf = new Map<unknown, number>();
  let current = 0;
  let peak = 0;
  let created = 0;

  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        switch (prop) {
          case 'createTexture':
            return () => ({ id: ++created });
          case 'bindTexture':
            return (_t: unknown, texture: unknown) => {
              bound = texture;
            };
          case 'texStorage2D':
            return (_t: unknown, _levels: unknown, format: string, w: number, h: number) => {
              const bytes = w * h * (format === 'RGBA16F' ? 8 : 4);
              bytesOf.set(bound, bytes);
              current += bytes;
              peak = Math.max(peak, current);
            };
          case 'deleteTexture':
            return (texture: unknown) => {
              current -= bytesOf.get(texture) ?? 0;
              bytesOf.delete(texture);
            };
          case 'createFramebuffer':
            return () => ({});
          case 'checkFramebufferStatus':
            return () => 'FRAMEBUFFER_COMPLETE';
          default:
            // Konstanten wie TEXTURE_2D: der eigene Name genügt als Wert.
            if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return prop;
            return () => {};
        }
      },
    },
  ) as unknown as WebGL2RenderingContext;

  return { gl, usage: () => ({ current, peak, created }) };
}

const caps = { floatRenderTargets: true, maxTextureSize: 16384, renderer: 'test', vendor: 'test' };

/**
 * Ein Vorschau-Frame, wie ihn der Render-Graph anfordert: drei 16-Bit-Ziele
 * in Bildschirmgröße, ein 8-Bit-Ziel für die Ausgabe, dazu der Tiefpass in
 * fester Größe.
 */
function frame(pool: InstanceType<typeof TargetPool>, width: number, height: number) {
  const lowFreq = pool.acquire(768, 512);
  const a = pool.acquire(width, height);
  const b = pool.acquire(width, height);
  pool.release(a);
  const c = pool.acquire(width, height);
  const out = pool.acquire(width, height, 'byte');
  for (const t of [b, c, out, lowFreq]) pool.release(t);
}

test('Ziehen am Fensterrand lässt den Grafikspeicher nicht wachsen', () => {
  const { gl, usage } = fakeGl();
  const pool = new TargetPool(gl, caps);

  // 300 Zwischengrößen, wie sie beim Ziehen am Rand entstehen.
  for (let i = 0; i < 300; i++) frame(pool, 1400 + i * 3, 900 + i * 2);

  const { current, peak } = usage();
  // Ohne Abgabe wären es rund 300 × 45 MB ≈ 13 GB gewesen.
  assert.ok(peak < 450 * MB, `Spitze ${Math.round(peak / MB)} MB`);
  assert.ok(current < 450 * MB, `belegt ${Math.round(current / MB)} MB`);
});

test('im Ruhezustand wird nichts weggeworfen und neu angelegt', () => {
  const { gl, usage } = fakeGl();
  const pool = new TargetPool(gl, caps);

  // Ein großer Bildschirm: 5120×2880 in 16 Bit sind 112 MB je Ziel — der
  // Arbeitssatz eines Frames ist allein größer als das Budget.
  frame(pool, 5120, 2880);
  const afterFirst = usage().created;
  for (let i = 0; i < 50; i++) frame(pool, 5120, 2880);

  assert.equal(
    usage().created,
    afterFirst,
    'der laufende Arbeitssatz wurde verdrängt und in jedem Frame neu angelegt',
  );
});

test('nach einem Export werden die Kachelziele wieder abgegeben', () => {
  const { gl, usage } = fakeGl();
  const pool = new TargetPool(gl, caps);
  frame(pool, 1600, 1000);

  // Kachelweiser Export eines 6000×4000-Bildes: neun verschiedene
  // Kachelgrößen mit Überlappungsrand.
  for (const w of [1088, 1152, 1152, 1152, 1152, 944]) {
    for (const h of [1088, 1152, 1152, 992]) {
      const t1 = pool.acquire(w, h);
      const t2 = pool.acquire(w, h);
      const out = pool.acquire(w, h, 'byte');
      for (const t of [t1, t2, out]) pool.release(t);
    }
  }

  // Zurück zur Vorschau: Ein paar Frames später ist der Kachelspeicher frei.
  for (let i = 0; i < 5; i++) frame(pool, 1600, 1000);

  const { current } = usage();
  assert.ok(current <= 192 * MB + 60 * MB, `nach dem Export belegt: ${Math.round(current / MB)} MB`);
  assert.ok(pool.stats.freeBytes <= 192 * MB, 'ruhende Ziele über dem Budget');
});

test('ein freigegebenes Ziel wird bei gleicher Größe wiederverwendet', () => {
  const { gl, usage } = fakeGl();
  const pool = new TargetPool(gl, caps);

  const first = pool.acquire(800, 600);
  pool.release(first);
  const second = pool.acquire(800, 600);

  assert.equal(second, first, 'gleiche Größe, aber neues Ziel');
  assert.equal(usage().created, 1);
});
