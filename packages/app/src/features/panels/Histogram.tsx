import { useEffect, useRef, useState } from 'react';
import type { EditParams } from '@photomaster/shared';
import type { RendererHandle } from '../viewport/useRenderer.ts';
import './Histogram.css';

interface HistogramProps {
  handle: RendererHandle;
  params: EditParams;
}

interface Channels {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  clippedLow: number;
  clippedHigh: number;
}

/**
 * Live-Histogramm des BEARBEITETEN Bildes.
 *
 * Es zeigt bewusst nicht den Zustand der Originaldatei, sondern das Ergebnis
 * der aktuellen Reglerstellung — nur so sieht man beim Ziehen, wann Lichter
 * oder Schatten anlaufen. Die Warnfelder an den Rändern leuchten auf, sobald
 * mehr als ein Promille der Pixel am Anschlag liegt.
 *
 * Gerechnet wird auf einer 320-px-Fassung und erst, nachdem die Regler zur
 * Ruhe gekommen sind: Ein Auslesen der GPU-Pixel zwingt die Grafikpipeline zum
 * Anhalten, und das würde das Ziehen selbst ruckeln lassen.
 */
export function Histogram({ handle, params }: HistogramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [channels, setChannels] = useState<Channels | null>(null);

  useEffect(() => {
    if (handle.status !== 'ready') return;
    const timer = setTimeout(() => {
      const pixels = handle.readProcessedPixels();
      if (!pixels) return;
      setChannels(computeHistogram(pixels.data));
    }, 140);
    return () => clearTimeout(timer);
  }, [params, handle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !channels) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0) return;
    if (canvas.width !== width * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Gemeinsame Skala für alle drei Kanäle, sonst wären die relativen
    // Verhältnisse zwischen ihnen nicht ablesbar.
    let peak = 0;
    for (const data of [channels.r, channels.g, channels.b]) {
      for (let i = 1; i < 255; i++) peak = Math.max(peak, data[i]);
    }
    if (peak === 0) return;

    ctx.globalCompositeOperation = 'lighter';
    const draw = (data: Float32Array, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let i = 0; i < 256; i++) {
        // Wurzelskala: Ein lineares Histogramm wird von den Mitteltönen
        // erschlagen, und genau die Ränder, auf die es ankommt, verschwinden.
        const v = Math.sqrt(Math.min(1, data[i] / peak));
        ctx.lineTo((i / 255) * width, height - v * height);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    };

    draw(channels.r, 'rgba(224, 87, 79, 0.55)');
    draw(channels.g, 'rgba(98, 181, 102, 0.55)');
    draw(channels.b, 'rgba(91, 143, 214, 0.55)');
    ctx.globalCompositeOperation = 'source-over';
  }, [channels]);

  const clippedHigh = channels ? channels.clippedHigh : 0;
  const clippedLow = channels ? channels.clippedLow : 0;

  return (
    <div className="histogram">
      <div
        className={`histogram__clip histogram__clip--low ${clippedLow > 0.001 ? 'is-on' : ''}`}
        title={`Schatten am Anschlag: ${(clippedLow * 100).toFixed(1)} %`}
      />
      <canvas ref={canvasRef} className="histogram__canvas" aria-label="Histogramm der Bearbeitung" />
      <div
        className={`histogram__clip histogram__clip--high ${clippedHigh > 0.001 ? 'is-on' : ''}`}
        title={`Lichter am Anschlag: ${(clippedHigh * 100).toFixed(1)} %`}
      />
    </div>
  );
}

function computeHistogram(data: Uint8Array): Channels {
  const r = new Float32Array(256);
  const g = new Float32Array(256);
  const b = new Float32Array(256);
  let clippedLow = 0;
  let clippedHigh = 0;
  const total = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    r[data[i]]++;
    g[data[i + 1]]++;
    b[data[i + 2]]++;
    if (data[i] >= 254 || data[i + 1] >= 254 || data[i + 2] >= 254) clippedHigh++;
    if (data[i] <= 1 && data[i + 1] <= 1 && data[i + 2] <= 1) clippedLow++;
  }

  return { r, g, b, clippedLow: clippedLow / total, clippedHigh: clippedHigh / total };
}
