/**
 * Auswertung der Tonwertkurven.
 *
 * Verwendet monotone kubische Interpolation nach Fritsch–Carlson (PCHIP).
 * Eine gewöhnliche Spline würde zwischen den Kontrollpunkten überschwingen und
 * damit in einer Tonwertkurve sichtbare Artefakte erzeugen: Ein Punkt, der die
 * Mitteltöne anhebt, würde die Schatten mit absenken. PCHIP garantiert, dass
 * die Kurve zwischen zwei Punkten monoton bleibt — sie tut also exakt das, was
 * die Kontrollpunkte vorgeben, und nichts darüber hinaus.
 */

import type { CurvePoint } from './params.ts';

/**
 * Baut die Steigungen für die Hermite-Interpolation.
 * Rückgabe: Tangenten m[i] an jedem Kontrollpunkt.
 */
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  if (n === 2) {
    const d = (ys[1] - ys[0]) / (xs[1] - xs[0]);
    return [d, d];
  }

  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    delta.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }

  const m: number[] = new Array(n).fill(0);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      // Lokales Extremum — Tangente auf 0, sonst entsteht ein Überschwinger.
      m[i] = 0;
    } else {
      // Gewichtetes harmonisches Mittel der Nachbarsteigungen.
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  // Fritsch–Carlson-Begrenzung: hält die Interpolation monoton.
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * delta[i];
      m[i + 1] = t * b * delta[i];
    }
  }

  return m;
}

/**
 * Erzeugt eine Lookup-Tabelle der Kurve. `size` Einträge über x ∈ [0,1].
 * Die Engine lädt diese Tabelle als 1D-Textur in den Shader — pro Pixel wird
 * dann nur noch nachgeschlagen statt gerechnet.
 */
export function buildCurveLut(points: CurvePoint[], size = 256): Float32Array {
  const lut = new Float32Array(size);

  if (points.length < 2) {
    for (let i = 0; i < size; i++) lut[i] = i / (size - 1);
    return lut;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const m = monotoneTangents(xs, ys);

  let seg = 0;
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);

    if (x <= xs[0]) {
      lut[i] = ys[0];
      continue;
    }
    if (x >= xs[xs.length - 1]) {
      lut[i] = ys[ys.length - 1];
      continue;
    }

    // Die Auswertung läuft monoton über x, deshalb genügt ein mitlaufender Index.
    while (seg < xs.length - 2 && x > xs[seg + 1]) seg++;

    const h = xs[seg + 1] - xs[seg];
    const t = (x - xs[seg]) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    // Kubische Hermite-Basisfunktionen.
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    const y = h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1];
    lut[i] = Math.min(1, Math.max(0, y));
  }

  return lut;
}
