/**
 * Objektive Bildanalyse (Phase 6, erster Teil).
 *
 * Diese Funktion misst — sie interpretiert nicht. Das Ergebnis ist die
 * Faktenbasis, auf der die KI später ihre Entscheidungen trifft: Ohne sie
 * würde das Modell aus einem stark verkleinerten Ansichtsbild raten, ob ein
 * Himmel wirklich ausgefressen ist oder nur hell wirkt (§10 des Briefings).
 *
 * Reines JavaScript über einen RGBA-Puffer — keine WebGL-Abhängigkeit, damit
 * die Berechnung auch im Test unter Node läuft.
 */

import type { ImageStats } from '@photomaster/shared';

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export function analyzePixels(data: Uint8Array | Uint8ClampedArray, width: number, height: number): ImageStats {
  const pixelCount = width * height;
  if (pixelCount === 0 || data.length < pixelCount * 4) {
    throw new Error('Bilddaten passen nicht zur angegebenen Größe.');
  }

  const histR = new Float64Array(256);
  const histG = new Float64Array(256);
  const histB = new Float64Array(256);
  const histL = new Float64Array(256);

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumL = 0;
  let sumSat = 0;
  let clippedHi = 0;
  let clippedLo = 0;

  // Luminanz in einem 3×3-Raster — grobe Information über die Lichtverteilung
  // im Bild (heller Himmel oben, dunkler Vordergrund unten, …).
  const regionSum = new Float64Array(9);
  const regionCount = new Float64Array(9);

  // Grobe Farbhistogramme für die dominanten Farben: 5 Stufen je Kanal.
  const BUCKETS = 5;
  const colorCount = new Float64Array(BUCKETS ** 3);
  const colorSumR = new Float64Array(BUCKETS ** 3);
  const colorSumG = new Float64Array(BUCKETS ** 3);
  const colorSumB = new Float64Array(BUCKETS ** 3);

  const luma = new Float32Array(pixelCount);

  for (let y = 0; y < height; y++) {
    const ry = Math.min(2, Math.floor((y * 3) / height));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      histR[r]++;
      histG[g]++;
      histB[b]++;

      const l = LUMA_R * r + LUMA_G * g + LUMA_B * b;
      const li = Math.min(255, Math.round(l));
      histL[li]++;
      luma[y * width + x] = l;

      sumR += r;
      sumG += g;
      sumB += b;
      sumL += l;

      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      sumSat += max === 0 ? 0 : (max - min) / max;

      // "Clipping" heißt: mindestens ein Kanal liegt am Anschlag. Ein einzelner
      // Kanal genügt — sobald Rot bei 255 steht, ist die Farbinformation dort
      // unwiederbringlich verloren, auch wenn Grün und Blau noch Zeichnung haben.
      if (r >= 254 || g >= 254 || b >= 254) clippedHi++;
      if (r <= 1 && g <= 1 && b <= 1) clippedLo++;

      const rx = Math.min(2, Math.floor((x * 3) / width));
      const region = ry * 3 + rx;
      regionSum[region] += l;
      regionCount[region]++;

      const bucket =
        Math.min(BUCKETS - 1, Math.floor((r * BUCKETS) / 256)) * BUCKETS * BUCKETS +
        Math.min(BUCKETS - 1, Math.floor((g * BUCKETS) / 256)) * BUCKETS +
        Math.min(BUCKETS - 1, Math.floor((b * BUCKETS) / 256));
      colorCount[bucket]++;
      colorSumR[bucket] += r;
      colorSumG[bucket] += g;
      colorSumB[bucket] += b;
    }
  }

  const meanL = sumL / pixelCount / 255;
  const meanR = sumR / pixelCount / 255;
  const meanG = sumG / pixelCount / 255;
  const meanB = sumB / pixelCount / 255;

  // Standardabweichung der Luminanz als Kontrastmaß.
  let varSum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const d = luma[i] / 255 - meanL;
    varSum += d * d;
  }
  const contrast = Math.sqrt(varSum / pixelCount);

  const percentile = (p: number): number => {
    const target = pixelCount * p;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += histL[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };

  const dominantColors = topColors(colorCount, colorSumR, colorSumG, colorSumB, pixelCount);

  return {
    histogram: {
      r: normalizeHistogram(histR, pixelCount),
      g: normalizeHistogram(histG, pixelCount),
      b: normalizeHistogram(histB, pixelCount),
      luma: normalizeHistogram(histL, pixelCount),
    },
    meanLuma: round4(meanL),
    medianLuma: round4(percentile(0.5)),
    clippedShadows: round4(clippedLo / pixelCount),
    clippedHighlights: round4(clippedHi / pixelCount),
    p01: round4(percentile(0.01)),
    p05: round4(percentile(0.05)),
    p50: round4(percentile(0.5)),
    p95: round4(percentile(0.95)),
    p99: round4(percentile(0.99)),
    contrast: round4(contrast),
    meanSaturation: round4(sumSat / pixelCount),
    meanR: round4(meanR),
    meanG: round4(meanG),
    meanB: round4(meanB),
    // Kanaldifferenzen als Farbstich-Schätzung. Bei einem Motiv, das von Natur
    // aus einfarbig ist (Sonnenuntergang), misst das den Bildinhalt und nicht
    // den Weißabgleich — deshalb ist es ausdrücklich eine Schätzung, die die
    // KI zusammen mit dem Bild bewertet, und keine automatische Korrektur.
    temperatureBias: round4(clamp((meanR - meanB) * 250, -100, 100)),
    tintBias: round4(clamp(((meanR + meanB) / 2 - meanG) * 250, -100, 100)),
    sharpness: round4(estimateSharpness(luma, width, height)),
    noise: round4(estimateNoise(luma, width, height)),
    dominantColors,
    regionLuma: Array.from(regionSum, (s, i) => round4(regionCount[i] ? s / regionCount[i] / 255 : 0)),
  };
}

function normalizeHistogram(hist: Float64Array, total: number): number[] {
  const out = new Array<number>(256);
  for (let i = 0; i < 256; i++) out[i] = Math.round((hist[i] / total) * 1e6) / 1e6;
  return out;
}

/**
 * Schärfe als Varianz des Laplace-Operators: Ein scharfes Bild hat viele
 * starke Helligkeitssprünge zwischen benachbarten Pixeln, ein unscharfes kaum.
 */
function estimateSharpness(luma: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap =
        4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  // Auf 0…1 normiert; ~600 entspricht einem gut durchgezeichneten Bild.
  return clamp(Math.sqrt(variance) / 24, 0, 1);
}

/**
 * Rauschschätzung nach Immerkær (1996): Die Faltung mit einer Maske, die auf
 * glatte Verläufe UND auf lineare Kanten null antwortet, lässt nur das Rauschen
 * übrig. Der Mittelwert der Beträge ist damit ein Maß für die Rauschamplitude,
 * das durch Bildinhalt kaum verfälscht wird.
 */
function estimateNoise(luma: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v =
        luma[i - width - 1] - 2 * luma[i - width] + luma[i - width + 1] -
        2 * luma[i - 1] + 4 * luma[i] - 2 * luma[i + 1] +
        luma[i + width - 1] - 2 * luma[i + width] + luma[i + width + 1];
      sum += Math.abs(v);
      n++;
    }
  }
  const sigma = (Math.sqrt(Math.PI / 2) * sum) / (6 * n);
  // σ in 8-Bit-Stufen; 8 Stufen sind bereits deutlich sichtbares Rauschen.
  return clamp(sigma / 8, 0, 1);
}

function topColors(
  count: Float64Array,
  sumR: Float64Array,
  sumG: Float64Array,
  sumB: Float64Array,
  total: number,
): { hex: string; share: number }[] {
  const indices = Array.from(count.keys()).filter((i) => count[i] > 0);
  indices.sort((a, b) => count[b] - count[a]);
  return indices.slice(0, 5).map((i) => {
    const n = count[i];
    const r = Math.round(sumR[i] / n);
    const g = Math.round(sumG[i] / n);
    const b = Math.round(sumB[i] / n);
    return { hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`, share: round4(n / total) };
  });
}

const toHex = (v: number): string => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * Airlight-Schätzung für die Dunstentfernung: die Helligkeit des Dunstes
 * selbst. Das 99. Perzentil ist dafür robuster als das Maximum, das schon eine
 * einzelne Spiegelung oder ein heißes Pixel verfälschen würde.
 */
export function estimateAirlight(stats: ImageStats): number {
  return clamp(stats.p99, 0.35, 1);
}
