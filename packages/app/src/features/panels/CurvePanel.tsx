import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CURVE_CHANNELS,
  MAX_CURVE_POINTS,
  buildCurveLut,
  defaultCurve,
  isIdentityCurve,
  type CurveChannel,
  type CurvePoint,
} from '@photomaster/shared';
import { useEditor } from '../../state/editorStore.ts';
import { Button } from '../../ui/Button.tsx';
import { IconReset } from '../../ui/Icons.tsx';
import './CurvePanel.css';

const CHANNEL_LABELS: Record<CurveChannel, string> = {
  rgb: 'RGB',
  r: 'Rot',
  g: 'Grün',
  b: 'Blau',
};

const CHANNEL_COLORS: Record<CurveChannel, string> = {
  rgb: '#e8e6e1',
  r: '#e0574f',
  g: '#62b566',
  b: '#5b8fd6',
};

/** Fangradius in Bildschirmpixeln, um einen vorhandenen Punkt zu greifen. */
const HIT_RADIUS = 11;

/**
 * Gradationskurven-Editor (§12).
 *
 * Die Kurve wird mit derselben monotonen Interpolation gezeichnet, mit der der
 * Shader später rechnet (`buildCurveLut`) — was hier zu sehen ist, ist also
 * exakt das, was auf das Bild angewendet wird, und keine hübschere Näherung.
 */
export function CurvePanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [channel, setChannel] = useState<CurveChannel>('rgb');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const curves = useEditor((s) => s.params.curves);
  const setCurve = useEditor((s) => s.setCurve);

  const points = curves[channel];

  // ── Zeichnen ─────────────────────────────────────────────────────────────

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = canvas.clientWidth;
    if (size === 0) return;
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Raster in Dritteln — genug Orientierung, ohne mit der Kurve zu konkurrieren.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const p = (size * i) / 3;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    // Diagonale als Referenz für "keine Änderung".
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // Die Kurve selbst, aus derselben Lookup-Tabelle wie im Shader.
    const lut = buildCurveLut(points, 256);
    ctx.strokeStyle = CHANNEL_COLORS[channel];
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < lut.length; i++) {
      const x = (i / (lut.length - 1)) * size;
      const y = size - lut[i] * size;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (let i = 0; i < points.length; i++) {
      const x = points[i].x * size;
      const y = size - points[i].y * size;
      ctx.beginPath();
      ctx.arc(x, y, i === dragIndex ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = i === dragIndex ? '#fff' : CHANNEL_COLORS[channel];
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }, [points, channel, dragIndex]);

  useEffect(() => {
    paint();
  }, [paint]);

  useEffect(() => {
    const observer = new ResizeObserver(() => paint());
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [paint]);

  // ── Bedienung ────────────────────────────────────────────────────────────

  const toCurveSpace = (event: { clientX: number; clientY: number }): CurvePoint => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01(1 - (event.clientY - rect.top) / rect.height),
    };
  };

  const findPoint = (event: { clientX: number; clientY: number }): number => {
    const rect = canvasRef.current!.getBoundingClientRect();
    for (let i = 0; i < points.length; i++) {
      const px = rect.left + points[i].x * rect.width;
      const py = rect.top + (1 - points[i].y) * rect.height;
      if (Math.hypot(event.clientX - px, event.clientY - py) <= HIT_RADIUS) return i;
    }
    return -1;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);

    const existing = findPoint(event);

    // Rechtsklick oder Alt+Klick entfernt einen Punkt. Die beiden Endpunkte
    // bleiben erhalten — ohne sie wäre die Kurve nicht mehr definiert.
    if ((event.button === 2 || event.altKey) && existing > 0 && existing < points.length - 1) {
      setCurve(channel, points.filter((_, i) => i !== existing), true);
      return;
    }

    if (existing >= 0) {
      setDragIndex(existing);
      return;
    }

    if (points.length >= MAX_CURVE_POINTS) return;

    const p = toCurveSpace(event);
    const next = [...points, p].sort((a, b) => a.x - b.x);
    setCurve(channel, next, true);
    setDragIndex(next.findIndex((q) => q === p));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragIndex === null) return;
    const p = toCurveSpace(event);
    const next = points.map((q) => ({ ...q }));

    if (dragIndex === 0) {
      // Der erste Punkt bleibt am linken Rand, sonst wäre der Verlauf unter
      // ihm undefiniert. Nur seine Höhe ist verschiebbar (Schwarzpunkt).
      next[0] = { x: 0, y: p.y };
    } else if (dragIndex === points.length - 1) {
      next[dragIndex] = { x: 1, y: p.y };
    } else {
      // Innere Punkte dürfen ihre Nachbarn nicht überholen.
      const min = next[dragIndex - 1].x + 0.012;
      const max = next[dragIndex + 1].x - 0.012;
      next[dragIndex] = { x: clamp(p.x, min, max), y: p.y };
    }

    setCurve(channel, next, false);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragIndex === null) return;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    setDragIndex(null);
    // Ein Verlaufseintrag für die gesamte Ziehbewegung.
    setCurve(channel, points, true);
  };

  const isDefault = isIdentityCurve(points);

  return (
    <div className="curve">
      <div className="curve__head">
        <div className="curve__channels" role="tablist" aria-label="Kurvenkanal">
          {CURVE_CHANNELS.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={c === channel}
              className={`curve__channel ${c === channel ? 'is-active' : ''} ${!isIdentityCurve(curves[c]) ? 'is-changed' : ''}`}
              style={{ '--channel-color': CHANNEL_COLORS[c] } as React.CSSProperties}
              onClick={() => setChannel(c)}
            >
              {CHANNEL_LABELS[c]}
            </button>
          ))}
        </div>
        {!isDefault && (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconReset size={13} />}
            onClick={() => setCurve(channel, defaultCurve(), true)}
          >
            Zurücksetzen
          </Button>
        )}
      </div>

      <canvas
        ref={canvasRef}
        className="curve__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />

      <p className="panel__hint">
        Klicken setzt einen Punkt, Ziehen verschiebt ihn. Alt- oder Rechtsklick
        entfernt ihn wieder.
      </p>
    </div>
  );
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
