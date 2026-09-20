import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { LocalMask } from '@photomaster/shared';
import type { Region } from '@photomaster/engine';
import { useEditor } from '../../state/editorStore.ts';
import './BrushSurface.css';

interface BrushSurfaceProps {
  mask: LocalMask;
  region: Region;
  boxWidth: number;
  boxHeight: number;
  aspect: number;
}

/**
 * Malfläche für eine Pinselmaske (§28).
 *
 * Liegt als durchsichtige Ebene über dem Bild und wandelt Zeigerbewegungen in
 * Stützpunkte um. Zwei Dinge sind hier wichtiger, als sie aussehen:
 *
 * **Punktabstand.** Ein Zeiger meldet bis zu 120 Ereignisse pro Sekunde. Jedes
 * davon zu speichern ergäbe für einen einzigen Strich über das Bild tausende
 * Punkte — und damit ein Projekt, das mit jedem Strich spürbar wächst, und
 * eine Rasterung, die tausende Rechtecke zeichnet. Ein neuer Punkt entsteht
 * deshalb erst ab einem Viertel Pinselradius Abstand. Weil zwischen zwei
 * Punkten eine STRECKE gezeichnet wird und nicht zwei Kreise, bleibt der
 * Strich trotzdem lückenlos.
 *
 * **Der Zeiger selbst.** Ein Pinsel ohne sichtbaren Umriss ist unbenutzbar —
 * man weiß nicht, wie groß er ist und wo genau er ansetzt. Deshalb folgt ein
 * Kreis in der tatsächlichen Pinselgröße dem Zeiger.
 */
export function BrushSurface({ mask, region, boxWidth, boxHeight, aspect }: BrushSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const painting = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [altPressed, setAltPressed] = useState(false);

  const brush = useEditor((s) => s.brush);
  const beginStroke = useEditor((s) => s.beginStroke);
  const extendStroke = useEditor((s) => s.extendStroke);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);

  // Alt kehrt die Betriebsart vorübergehend um — der übliche Griff, um
  // schnell eine Ecke wegzunehmen, ohne das Werkzeug zu wechseln.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltPressed(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltPressed(false);
    };
    const blur = () => setAltPressed(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const erasing = brush.erase !== altPressed;

  /** Pinselradius in Bildschirmpixeln — dieselbe Rechnung wie im Shader. */
  const screenRadius =
    brush.radius * Math.max(aspect, 1) * (boxHeight / Math.max(region.h, 1e-6));

  const toImage = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const rect = surfaceRef.current!.getBoundingClientRect();
      return {
        x: region.x + ((event.clientX - rect.left) / rect.width) * region.w,
        y: region.y + ((event.clientY - rect.top) / rect.height) * region.h,
      };
    },
    [region],
  );

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Nur die primäre Taste malt; die rechte bleibt für das Kontextmenü frei.
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const point = toImage(event);
    painting.current = true;
    lastPoint.current = point;

    // Ein Strich ist EIN Verlaufsschritt, egal wie lang er wird.
    beginGesture(`${mask.name}: ${erasing ? 'radiert' : 'gemalt'}`);
    beginStroke(mask.id, round(point), erasing);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    setCursor(localPoint(event));
    if (!painting.current) return;

    const point = toImage(event);
    const previous = lastPoint.current;
    if (previous) {
      // Abstand im seitenverhältnis-korrigierten Raum messen, damit der
      // Schwellwert waagerecht und senkrecht gleich groß ist.
      const dx = (point.x - previous.x) * aspect;
      const dy = point.y - previous.y;
      const minStep = brush.radius * Math.max(aspect, 1) * 0.25;
      if (Math.hypot(dx, dy) < minStep) return;
    }

    lastPoint.current = point;
    extendStroke(mask.id, round(point));
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!painting.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    painting.current = false;
    lastPoint.current = null;
    endGesture();
  };

  return (
    <div
      ref={surfaceRef}
      className="brush-surface"
      style={{ width: boxWidth, height: boxHeight }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={(e) => {
        setCursor(null);
        finish(e);
      }}
    >
      {cursor && (
        <span
          className={`brush-cursor ${erasing ? 'is-erasing' : ''}`}
          style={{
            left: cursor.x,
            top: cursor.y,
            width: screenRadius * 2,
            height: screenRadius * 2,
          }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/**
 * Koordinaten auf vier Nachkommastellen runden.
 *
 * Bei 6000 px Bildbreite entspricht die vierte Stelle 0,6 Pixel — feiner als
 * jeder Pinsel je aufgelöst wird. Ungerundet schleppte jeder Punkt siebzehn
 * Stellen mit, und ein Strich mit 300 Punkten würde in der Projektdatei
 * mehrere Kilobyte belegen statt weniger hundert Byte.
 */
function round(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 };
}
