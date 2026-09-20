import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { LocalMask } from '@photomaster/shared';
import type { Region } from '@photomaster/engine';
import './MaskHandles.css';

interface MaskHandlesProps {
  mask: LocalMask;
  /** Angezeigter Bildausschnitt (normalisiert). */
  region: Region;
  /** Darstellungsgröße des Bildes in CSS-Pixeln. */
  boxWidth: number;
  boxHeight: number;
  /** Seitenverhältnis des Bildes (Breite / Höhe). */
  aspect: number;
  onChange: (patch: Partial<LocalMask>) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
}

type DragKind = 'move' | 'position' | 'rotate' | 'radiusX' | 'radiusY';

/**
 * Anfasser zum Positionieren einer Maske direkt auf dem Bild (§28).
 *
 * Die Geometrie wird hier NICHT ein zweites Mal definiert, sondern aus
 * denselben Werten hergeleitet, die auch der Shader bekommt — und mit
 * derselben Seitenverhältnis-Korrektur. Eine gezeichnete Ellipse, die nicht
 * exakt dort liegt, wo die Maske wirkt, wäre schlimmer als gar keine Anzeige.
 *
 * Herleitung der Abbildung: Der Shader rechnet in Koordinaten, in denen x mit
 * dem Seitenverhältnis gestreckt ist. Weil die Anzeigefläche dasselbe
 * Seitenverhältnis hat wie das Bild, ist der Weg von dort auf den Bildschirm
 * eine GLEICHMÄSSIGE Skalierung. Eine gedrehte Ellipse bleibt deshalb auf dem
 * Bildschirm eine gedrehte Ellipse und lässt sich direkt als SVG zeichnen.
 */
export function MaskHandles({
  mask,
  region,
  boxWidth,
  boxHeight,
  aspect,
  onChange,
  onGestureStart,
  onGestureEnd,
}: MaskHandlesProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: DragKind; startX: number; startY: number; base: LocalMask } | null>(null);

  if (boxWidth === 0 || boxHeight === 0) return null;

  // Bildkoordinate (0…1) → Bildschirmpunkt innerhalb der Anzeigefläche.
  const toScreen = (ix: number, iy: number): [number, number] => [
    ((ix - region.x) / region.w) * boxWidth,
    ((iy - region.y) / region.h) * boxHeight,
  ];
  const toImage = (sx: number, sy: number): [number, number] => [
    region.x + (sx / boxWidth) * region.w,
    region.y + (sy / boxHeight) * region.h,
  ];

  /** Maßstab vom seitenverhältnis-korrigierten Raum auf den Bildschirm. */
  const unit = boxHeight / region.h;

  const pointerPos = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const startDrag = (kind: DragKind) => (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    const [x, y] = pointerPos(event);
    drag.current = { kind, startX: x, startY: y, base: { ...mask } };
    onGestureStart();
  };

  const onMove = (event: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = pointerPos(event);
    const base = d.base;

    switch (d.kind) {
      case 'move': {
        const [ix, iy] = toImage(x, y);
        const [sx, sy] = toImage(d.startX, d.startY);
        onChange({
          centerX: clamp01(base.centerX + (ix - sx)),
          centerY: clamp01(base.centerY + (iy - sy)),
        });
        break;
      }

      case 'position': {
        // Auf die Achsenrichtung projizieren: Seitwärtsbewegungen sollen die
        // Linie nicht verschieben, nur Bewegung entlang der Achse zählt.
        const dir = direction(base.angle);
        const [cx, cy] = toScreen(0.5, 0.5);
        const proj = (x - cx) * dir[0] + (y - cy) * dir[1];
        const halfExtent = (Math.abs(dir[0]) * aspect + Math.abs(dir[1])) * 0.5;
        onChange({ position: clamp01(proj / unit / (2 * halfExtent) + 0.5) });
        break;
      }

      case 'rotate': {
        const [cx, cy] = base.type === 'radial'
          ? toScreen(base.centerX, base.centerY)
          : toScreen(0.5, 0.5);
        // dir = (sin a, cos a) ⇒ a = atan2(dx, dy)
        const deg = (Math.atan2(x - cx, y - cy) * 180) / Math.PI;
        onChange({ angle: (deg + 360) % 360 });
        break;
      }

      case 'radiusX':
      case 'radiusY': {
        const [cx, cy] = toScreen(base.centerX, base.centerY);
        const rad = (base.angle * Math.PI) / 180;
        // In das gedrehte System der Ellipse zurückrechnen, damit das Ziehen
        // auch bei gedrehter Maske die richtige Halbachse trifft.
        const dx = x - cx;
        const dy = y - cy;
        const cs = Math.cos(-rad);
        const sn = Math.sin(-rad);
        const localX = dx * cs - dy * sn;
        const localY = dx * sn + dy * cs;

        if (d.kind === 'radiusX') {
          onChange({ radiusX: clampRadius(Math.abs(localX) / unit / aspect) });
        } else {
          onChange({ radiusY: clampRadius(Math.abs(localY) / unit) });
        }
        break;
      }
    }
  };

  const endDrag = (event: ReactPointerEvent) => {
    if (!drag.current) return;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    drag.current = null;
    onGestureEnd();
  };

  const handleProps = (kind: DragKind) => ({
    onPointerDown: startDrag(kind),
    onPointerMove: onMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  });

  return (
    <svg
      ref={svgRef}
      className="mask-handles"
      width={boxWidth}
      height={boxHeight}
      viewBox={`0 0 ${boxWidth} ${boxHeight}`}
    >
      {mask.type === 'radial' ? (
        <RadialHandles
          mask={mask}
          center={toScreen(mask.centerX, mask.centerY)}
          rx={mask.radiusX * aspect * unit}
          ry={mask.radiusY * unit}
          handleProps={handleProps}
        />
      ) : (
        <LinearHandles
          mask={mask}
          imageCenter={toScreen(0.5, 0.5)}
          unit={unit}
          aspect={aspect}
          boxWidth={boxWidth}
          boxHeight={boxHeight}
          handleProps={handleProps}
        />
      )}
    </svg>
  );
}

// ── Radial ─────────────────────────────────────────────────────────────────

function RadialHandles({
  mask,
  center,
  rx,
  ry,
  handleProps,
}: {
  mask: LocalMask;
  center: [number, number];
  rx: number;
  ry: number;
  handleProps: (kind: DragKind) => Record<string, unknown>;
}) {
  const [cx, cy] = center;
  const rad = (mask.angle * Math.PI) / 180;
  const cs = Math.cos(rad);
  const sn = Math.sin(rad);

  // Punkt auf der Ellipse in ihrem eigenen, gedrehten System.
  const onEllipse = (lx: number, ly: number): [number, number] => [
    cx + lx * cs - ly * sn,
    cy + lx * sn + ly * cs,
  ];

  const xHandle = onEllipse(rx, 0);
  const yHandle = onEllipse(0, ry);
  const rotHandle = onEllipse(rx + 26, 0);
  // Die innere Ellipse zeigt, wo die Maske voll deckt; dazwischen liegt der
  // weiche Übergang.
  const inner = 1 - Math.min(0.98, Math.max(0.02, mask.feather));

  return (
    <>
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        transform={`rotate(${mask.angle} ${cx} ${cy})`}
        className="mh-shape"
      />
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx * inner}
        ry={ry * inner}
        transform={`rotate(${mask.angle} ${cx} ${cy})`}
        className="mh-shape mh-shape--inner"
      />

      {/* Große, unsichtbare Greiffläche: Ziehen im Inneren verschiebt. */}
      <ellipse
        cx={cx}
        cy={cy}
        rx={Math.max(rx, 10)}
        ry={Math.max(ry, 10)}
        transform={`rotate(${mask.angle} ${cx} ${cy})`}
        className="mh-grab"
        {...handleProps('move')}
      />

      <line x1={cx} y1={cy} x2={rotHandle[0]} y2={rotHandle[1]} className="mh-line mh-line--thin" />

      <circle cx={cx} cy={cy} r={6} className="mh-dot" {...handleProps('move')} />
      <circle cx={xHandle[0]} cy={xHandle[1]} r={7} className="mh-dot" {...handleProps('radiusX')} />
      <circle cx={yHandle[0]} cy={yHandle[1]} r={7} className="mh-dot" {...handleProps('radiusY')} />
      <circle
        cx={rotHandle[0]}
        cy={rotHandle[1]}
        r={6}
        className="mh-dot mh-dot--rotate"
        {...handleProps('rotate')}
      />
    </>
  );
}

// ── Verlauf ────────────────────────────────────────────────────────────────

function LinearHandles({
  mask,
  imageCenter,
  unit,
  aspect,
  boxWidth,
  boxHeight,
  handleProps,
}: {
  mask: LocalMask;
  imageCenter: [number, number];
  unit: number;
  aspect: number;
  boxWidth: number;
  boxHeight: number;
  handleProps: (kind: DragKind) => Record<string, unknown>;
}) {
  const [cx, cy] = imageCenter;
  const dir = direction(mask.angle);
  const perp: [number, number] = [dir[1], -dir[0]];
  const halfExtent = (Math.abs(dir[0]) * aspect + Math.abs(dir[1])) * 0.5;

  /** Mittelpunkt einer Linie bei Position t (0…1) entlang der Achse. */
  const lineAt = (t: number): [number, number] => {
    const along = (t - 0.5) * 2 * halfExtent * unit;
    return [cx + dir[0] * along, cy + dir[1] * along];
  };

  // Die Linien werden großzügig über die Anzeigefläche hinaus gezogen und vom
  // SVG beschnitten — so ist bei jedem Winkel die volle Breite abgedeckt.
  const span = Math.hypot(boxWidth, boxHeight);
  const lineCoords = (t: number) => {
    const [mx, my] = lineAt(t);
    return {
      x1: mx - perp[0] * span,
      y1: my - perp[1] * span,
      x2: mx + perp[0] * span,
      y2: my + perp[1] * span,
    };
  };

  const main = lineAt(mask.position);
  const rotHandle: [number, number] = [main[0] + dir[0] * 44, main[1] + dir[1] * 44];
  const half = Math.max(0.02, mask.feather) / 2;

  return (
    <>
      <line {...lineCoords(mask.position - half)} className="mh-line mh-line--dashed" />
      <line {...lineCoords(mask.position + half)} className="mh-line mh-line--dashed" />
      <line {...lineCoords(mask.position)} className="mh-line" />

      {/* Breite Greiffläche auf der Hauptlinie — eine 2-px-Linie zu treffen
          wäre mit der Maus mühsam und mit dem Finger unmöglich. */}
      <line
        {...lineCoords(mask.position)}
        className="mh-grab-line"
        {...handleProps('position')}
      />

      <line x1={main[0]} y1={main[1]} x2={rotHandle[0]} y2={rotHandle[1]} className="mh-line mh-line--thin" />
      <circle cx={main[0]} cy={main[1]} r={7} className="mh-dot" {...handleProps('position')} />
      <circle
        cx={rotHandle[0]}
        cy={rotHandle[1]}
        r={6}
        className="mh-dot mh-dot--rotate"
        {...handleProps('rotate')}
      />
    </>
  );
}

/** Achsenrichtung aus dem Winkel: 0° zeigt nach unten (wirkt oben). */
function direction(angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [Math.sin(rad), Math.cos(rad)];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampRadius = (v: number): number => Math.min(1.5, Math.max(0.02, v));
