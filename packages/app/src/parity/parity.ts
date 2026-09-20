/**
 * Messung: Sieht die Vorschau wirklich aus wie der Export?
 *
 * Das ist die Anforderung, auf der die ganze Architektur steht (ARCHITECTURE.md
 * §1 C). Sie wird dadurch eingehalten, dass es nur EINE Implementierung der
 * Bildmathematik gibt — aber "es gibt nur eine" ist eine Behauptung über den
 * Code, keine Aussage über das Ergebnis. Gemessen wird deshalb das Ergebnis.
 *
 * Aufbau:
 *
 *   Testbild (3000×2000) ──┬─→ auf 1280 px verkleinert → Vorschau-Textur
 *                          └─→ volle Auflösung          → Export-Textur
 *
 * Beide laufen durch denselben Render-Graphen: der eine in einem Durchgang,
 * der andere kachelweise mit Überlappungsrand. Verglichen werden die Mitten
 * großer einfarbiger Felder — dort ist das Ergebnis auflösungsunabhängig, und
 * jede Abweichung ist echte Drift der Mathematik und kein Skalierungseffekt.
 *
 * Gemittelt wird über ein Fenster, weil die Ausgabe vor der 8-Bit-Quantisierung
 * gedithert wird: Einzelne Pixel schwanken dadurch bauartbedingt um ±1.
 *
 * Aufruf: Dev-Server starten und /parity.html öffnen. Diese Seite ist ein
 * Messwerkzeug und gehört nicht zum Produktions-Build.
 */

import { PhotoRenderer } from '@photomaster/engine';
import {
  applyValuePatch,
  createDefaultParams,
  createMask,
  makeMaskId,
  type EditParams,
} from '@photomaster/shared';

const FULL_WIDTH = 3000;
const FULL_HEIGHT = 2000;
const PREVIEW_EDGE = 1280;

/** Fenstergröße für die Mittelung, in Anteilen der Feldbreite. */
const SAMPLE_FRACTION = 0.4;

/**
 * Ab hier gilt eine Abweichung als Drift. Das Dithering allein erzeugt
 * Abweichungen unter 1; 2 lässt zusätzlich Rundung zwischen den beiden
 * Auflösungen zu, ohne eine sichtbare Differenz durchzulassen.
 */
const TOLERANCE = 2.0;

interface Patch {
  name: string;
  col: number;
  row: number;
  rgb: [number, number, number];
}

const COLS = 4;
const ROWS = 3;

const PATCHES: Patch[] = [
  { name: 'Tiefschwarz', col: 0, row: 0, rgb: [12, 12, 14] },
  { name: 'Schatten', col: 1, row: 0, rgb: [48, 52, 62] },
  { name: 'Mittelgrau', col: 2, row: 0, rgb: [119, 119, 119] },
  { name: 'Lichter', col: 3, row: 0, rgb: [228, 226, 220] },
  { name: 'Himmelblau', col: 0, row: 1, rgb: [96, 136, 196] },
  { name: 'Laubgrün', col: 1, row: 1, rgb: [72, 124, 68] },
  { name: 'Hautton', col: 2, row: 1, rgb: [206, 158, 130] },
  { name: 'Rot', col: 3, row: 1, rgb: [176, 52, 44] },
  { name: 'Orange', col: 0, row: 2, rgb: [212, 128, 40] },
  { name: 'Türkis', col: 1, row: 2, rgb: [56, 156, 156] },
  { name: 'Violett', col: 2, row: 2, rgb: [118, 84, 168] },
  { name: 'Fast weiß', col: 3, row: 2, rgb: [246, 245, 243] },
];

// ── Testbild ───────────────────────────────────────────────────────────────

function buildTestImage(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = FULL_WIDTH;
  canvas.height = FULL_HEIGHT;
  const ctx = canvas.getContext('2d')!;

  const w = FULL_WIDTH / COLS;
  const h = FULL_HEIGHT / ROWS;
  for (const p of PATCHES) {
    ctx.fillStyle = `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`;
    ctx.fillRect(p.col * w, p.row * h, w, h);
  }
  return canvas;
}

function patchCenter(p: Patch): { x: number; y: number } {
  return { x: (p.col + 0.5) / COLS, y: (p.row + 0.5) / ROWS };
}

/** Mittelwert eines Fensters um die relative Position, in RGB. */
function sample(
  data: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
): [number, number, number] {
  const halfW = Math.max(2, Math.round((width / COLS) * SAMPLE_FRACTION * 0.5));
  const halfH = Math.max(2, Math.round((height / ROWS) * SAMPLE_FRACTION * 0.5));
  const x0 = Math.round(cx * width);
  const y0 = Math.round(cy * height);

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0 - halfH; y <= y0 + halfH; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = x0 - halfW; x <= x0 + halfW; x++) {
      if (x < 0 || x >= width) continue;
      const i = (y * width + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

// ── Parametersätze ─────────────────────────────────────────────────────────

function withMask(base: EditParams): EditParams {
  const mask = createMask('linear', makeMaskId(), 'Verlauf');
  mask.angle = 0;
  mask.position = 0.45;
  mask.feather = 0.3;
  mask.values.exposure = -0.6;
  mask.values.temperature = -30;
  mask.values.saturation = 25;
  return { ...base, masks: [mask] };
}

function withRadial(base: EditParams): EditParams {
  const mask = createMask('radial', makeMaskId(), 'Ellipse');
  mask.centerX = 0.38;
  mask.centerY = 0.62;
  mask.radiusX = 0.34;
  mask.radiusY = 0.28;
  mask.feather = 0.5;
  mask.values.exposure = 0.5;
  mask.values.clarity = 30;
  return { ...base, masks: [mask] };
}

const CASES: { name: string; params: EditParams }[] = [
  {
    name: 'Ton',
    params: applyValuePatch(createDefaultParams(), {
      exposure: 0.42,
      contrast: 28,
      highlights: -45,
      shadows: 38,
      whites: -14,
      blacks: -22,
    }),
  },
  {
    name: 'Farbe',
    params: applyValuePatch(createDefaultParams(), {
      temperature: -34,
      tint: 12,
      vibrance: 30,
      saturation: -12,
      hslOrangeHue: -8,
      hslOrangeSat: 22,
      hslBlueLum: -18,
    }),
  },
  {
    name: 'Color Grading',
    params: applyValuePatch(createDefaultParams(), {
      gradeShadowHue: 220,
      gradeShadowSat: 28,
      gradeHighlightHue: 40,
      gradeHighlightSat: 20,
      gradeBalance: -15,
    }),
  },
  {
    name: 'Detail',
    params: applyValuePatch(createDefaultParams(), {
      clarity: 35,
      texture: 25,
      dehaze: 20,
      sharpenAmount: 60,
      noiseReduction: 20,
    }),
  },
  {
    name: 'Effekte (ortsabhängig)',
    params: applyValuePatch(createDefaultParams(), {
      vignetteAmount: -45,
      vignetteMidpoint: 40,
      vignetteFeather: 60,
      grainAmount: 0,
    }),
  },
  { name: 'Verlaufsmaske', params: withMask(createDefaultParams()) },
  { name: 'Radialmaske', params: withRadial(createDefaultParams()) },
  {
    name: 'Alles zusammen',
    params: withMask(
      applyValuePatch(createDefaultParams(), {
        exposure: 0.25,
        contrast: 18,
        highlights: -30,
        shadows: 24,
        temperature: -20,
        vibrance: 22,
        clarity: 28,
        dehaze: 14,
        sharpenAmount: 45,
        vignetteAmount: -32,
        gradeShadowHue: 210,
        gradeShadowSat: 18,
      }),
    ),
  },
];

// ── Messung ────────────────────────────────────────────────────────────────

const out = document.getElementById('out')!;

async function run(): Promise<void> {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const renderer = PhotoRenderer.create(canvas);

  const source = buildTestImage();
  const fullBitmap = await createImageBitmap(source);
  const scale = PREVIEW_EDGE / Math.max(FULL_WIDTH, FULL_HEIGHT);
  const previewBitmap = await createImageBitmap(source, {
    resizeWidth: Math.round(FULL_WIDTH * scale),
    resizeHeight: Math.round(FULL_HEIGHT * scale),
    resizeQuality: 'high',
  });

  renderer.setPreview(previewBitmap);
  renderer.setFullResolution(fullBitmap);

  const sections: string[] = [];
  let worstOverall = 0;
  let failures = 0;

  for (const testCase of CASES) {
    // Vorschauweg: kleine Textur, ein Durchgang.
    const preview = renderer.readProcessedPixels(testCase.params, PREVIEW_EDGE);
    // Exportweg: volle Auflösung, kachelweise mit Überlappungsrand.
    const exported = await renderer.renderFullResolution(testCase.params);

    const rows: string[] = [];
    let worst = 0;

    for (const p of PATCHES) {
      const c = patchCenter(p);
      const a = sample(preview.data, preview.width, preview.height, c.x, c.y);
      const b = sample(exported.data, exported.width, exported.height, c.x, c.y);
      const delta = Math.max(
        Math.abs(a[0] - b[0]),
        Math.abs(a[1] - b[1]),
        Math.abs(a[2] - b[2]),
      );
      worst = Math.max(worst, delta);
      if (delta > TOLERANCE) failures++;

      rows.push(
        `<tr class="${delta > TOLERANCE ? 'fail' : 'pass'}">` +
          `<td>${p.name}</td>` +
          `<td>${a.map((v) => v.toFixed(1)).join(' / ')}</td>` +
          `<td>${b.map((v) => v.toFixed(1)).join(' / ')}</td>` +
          `<td>${delta.toFixed(2)}</td>` +
          `<td class="verdict">${delta > TOLERANCE ? 'DRIFT' : 'ok'}</td>` +
          '</tr>',
      );
    }

    worstOverall = Math.max(worstOverall, worst);
    sections.push(
      `<h2>${testCase.name}</h2>` +
        `<table><tr><th>Feld</th><th>Vorschau R/G/B</th><th>Export R/G/B</th>` +
        `<th>Δ max</th><th>&nbsp;</th></tr>${rows.join('')}</table>`,
    );

    out.innerHTML = `<p class="note">läuft … (${sections.length}/${CASES.length})</p>${sections.join('')}`;
    await new Promise((r) => setTimeout(r, 0));
  }

  const verdict =
    failures === 0
      ? `<strong style="color:#6fae7a">Parität bestätigt.</strong> ${CASES.length} Parametersätze × ` +
        `${PATCHES.length} Felder = ${CASES.length * PATCHES.length} Vergleiche, ` +
        `größte Abweichung ${worstOverall.toFixed(2)} von 255 (Grenze ${TOLERANCE}).`
      : `<strong style="color:#d9614b">${failures} Abweichungen über der Grenze.</strong> ` +
        `Größte Abweichung ${worstOverall.toFixed(2)}.`;

  out.innerHTML =
    `<div id="summary">${verdict}<br /><span class="note">Vorschau ` +
    `${Math.round(FULL_WIDTH * scale)}×${Math.round(FULL_HEIGHT * scale)} in einem Durchgang, ` +
    `Export ${FULL_WIDTH}×${FULL_HEIGHT} in Kacheln zu 1024 px.</span></div>` +
    sections.join('');

  // Für die automatisierte Abfrage von außen.
  (window as unknown as Record<string, unknown>).parityResult = {
    failures,
    worst: worstOverall,
    tolerance: TOLERANCE,
    comparisons: CASES.length * PATCHES.length,
  };
}

run().catch((err) => {
  out.innerHTML = `<p style="color:#d9614b">Messung fehlgeschlagen: ${
    err instanceof Error ? err.message : String(err)
  }</p>`;
  (window as unknown as Record<string, unknown>).parityResult = { error: String(err) };
});
