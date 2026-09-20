import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PhotoMeta } from '@photomaster/shared';
import type { RendererHandle, ViewState } from './useRenderer.ts';
import { IconCompare, IconWarn, IconZoom } from '../../ui/Icons.tsx';
import { IconButton } from '../../ui/Button.tsx';
import { useEditor } from '../../state/editorStore.ts';
import { MaskHandles } from './MaskHandles.tsx';
import { BrushSurface } from './BrushSurface.tsx';
import './Viewport.css';

interface ViewportProps {
  photo: PhotoMeta;
  handle: RendererHandle;
  view: ViewState;
  onViewChange: (patch: Partial<ViewState>) => void;
  zoom: 'fit' | 'actual';
  onZoomChange: (zoom: 'fit' | 'actual') => void;
}

export function Viewport({ photo, handle, view, onViewChange, zoom, onZoomChange }: ViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [draggingSplit, setDraggingSplit] = useState(false);
  const panRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);

  // Die ausgewählte Maske kommt direkt aus dem Zustand statt über Requisiten:
  // Sie wird nur hier und im Masken-Panel gebraucht, und der Umweg über den
  // Editor-Bildschirm brächte nichts außer zwei weiteren Durchreichungen.
  const masks = useEditor((s) => s.params.masks);
  const selectedMaskId = useEditor((s) => s.selectedMaskId);
  const updateMask = useEditor((s) => s.updateMask);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);
  const selectedMask = masks.find((m) => m.id === selectedMaskId) ?? null;

  /** Mittelpunkt des sichtbaren Ausschnitts in Bildkoordinaten (0…1). */
  const [center, setCenter] = useState({ x: 0.5, y: 0.5 });

  // ── Größe berechnen ──────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setContainer({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  useLayoutEffect(() => {
    if (container.width === 0 || container.height === 0) return;

    if (zoom === 'fit') {
      // Bildseitenverhältnis erhalten und in den Rahmen einpassen.
      const scale = Math.min(container.width / photo.width, container.height / photo.height);
      setBox({
        width: Math.max(1, Math.floor(photo.width * scale)),
        height: Math.max(1, Math.floor(photo.height * scale)),
      });
    } else {
      setBox({ width: Math.floor(container.width), height: Math.floor(container.height) });
    }
  }, [container, photo.width, photo.height, zoom]);

  // Canvas-Puffergröße setzen und daraus den sichtbaren Ausschnitt ableiten.
  useLayoutEffect(() => {
    const canvas = handle.canvasRef.current;
    if (!canvas || box.width === 0) return;

    const bufferWidth = Math.max(1, Math.round(box.width * dpr));
    const bufferHeight = Math.max(1, Math.round(box.height * dpr));
    if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
      canvas.width = bufferWidth;
      canvas.height = bufferHeight;
      // Eine Zuweisung an canvas.width LEERT den Zeichenpuffer. Weil die Größe
      // erst feststeht, wenn der ResizeObserver das erste Mal ausgelöst hat —
      // also typischerweise NACH dem Laden des Bildes — muss hier ausdrücklich
      // neu gezeichnet werden. Ohne diese Zeile bliebe die Fläche schwarz, bis
      // der Nutzer zufällig einen Regler bewegt.
      handle.requestFrame();
    }

    if (zoom === 'fit') {
      onViewChange({ region: { x: 0, y: 0, w: 1, h: 1 }, useFullResolution: false });
      return;
    }

    // Bei 100 % entspricht ein Bildpixel einem Gerätepixel. Der Ausschnitt ist
    // also genau so groß, wie der Canvas Pixel hat.
    const w = Math.min(1, bufferWidth / photo.width);
    const h = Math.min(1, bufferHeight / photo.height);
    const x = clamp(center.x - w / 2, 0, 1 - w);
    const y = clamp(center.y - h / 2, 0, 1 - h);
    onViewChange({ region: { x, y, w, h }, useFullResolution: true });
    // `onViewChange` ist beim Aufrufer stabil; es hier aufzunehmen würde eine
    // Endlosschleife erzeugen, weil der Aufruf selbst den View ändert.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, dpr, zoom, center, photo.width, photo.height, handle.canvasRef, handle.requestFrame]);

  // ── Vorher/Nachher ───────────────────────────────────────────────────────

  const updateSplit = useCallback(
    (clientX: number) => {
      const canvas = handle.canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      onViewChange({ splitFraction: clamp((clientX - rect.left) / rect.width, 0, 1) });
    },
    [handle.canvasRef, onViewChange],
  );

  const onSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setDraggingSplit(true);
    updateSplit(event.clientX);
  };

  const onSplitPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingSplit) return;
    updateSplit(event.clientX);
  };

  const endSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingSplit) return;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    setDraggingSplit(false);
  };

  // ── Verschieben bei 100 % ────────────────────────────────────────────────

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (zoom !== 'actual' || view.compare) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    panRef.current = { x: event.clientX, y: event.clientY, originX: center.x, originY: center.y };
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    const dx = (event.clientX - pan.x) * dpr;
    const dy = (event.clientY - pan.y) * dpr;
    setCenter({
      x: clamp(pan.originX - dx / photo.width, 0, 1),
      y: clamp(pan.originY - dy / photo.height, 0, 1),
    });
  };

  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!panRef.current) return;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    panRef.current = null;
  };

  // Für die 100-%-Ansicht muss das Original im Grafikspeicher liegen.
  useEffect(() => {
    if (zoom === 'actual' && !handle.fullResolutionReady && !handle.loadingFullResolution) {
      void handle.ensureFullResolution().catch(() => onZoomChange('fit'));
    }
  }, [zoom, handle, onZoomChange]);

  const showPlaceholder = handle.status !== 'ready';

  return (
    <div className="viewport" ref={containerRef}>
      <div className="viewport__stage" style={{ width: box.width, height: box.height }}>
        <canvas
          ref={handle.canvasRef}
          className={`viewport__canvas ${zoom === 'actual' && !view.compare ? 'is-pannable' : ''}`}
          style={{ width: box.width, height: box.height }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
        />

        {/* Bedienung der Maske direkt am Bild. Beim Vergleich ausgeblendet —
            dort teilt sich die Fläche zwei Bildzustände, und die Maske gilt
            nur für einen. */}
        {selectedMask && handle.status === 'ready' && !view.compare && (
          selectedMask.type === 'brush' ? (
            <BrushSurface
              mask={selectedMask}
              region={view.region}
              boxWidth={box.width}
              boxHeight={box.height}
              aspect={photo.width / photo.height}
            />
          ) : (
            <MaskHandles
              mask={selectedMask}
              region={view.region}
              boxWidth={box.width}
              boxHeight={box.height}
              aspect={photo.width / photo.height}
              onChange={(patch) => updateMask(selectedMask.id, patch)}
              onGestureStart={() => beginGesture(`${selectedMask.name} verschoben`)}
              onGestureEnd={endGesture}
            />
          )
        )}

        {view.compare && handle.status === 'ready' && (
          <div
            className={`compare ${draggingSplit ? 'is-dragging' : ''}`}
            onPointerDown={onSplitPointerDown}
            onPointerMove={onSplitPointerMove}
            onPointerUp={endSplitDrag}
            onPointerCancel={endSplitDrag}
          >
            <span className="compare__tag compare__tag--left">Original</span>
            <span className="compare__tag compare__tag--right">Bearbeitet</span>
            <div className="compare__line" style={{ left: `${view.splitFraction * 100}%` }}>
              <div
                className="compare__handle"
                role="slider"
                tabIndex={0}
                aria-label="Vergleich zwischen Original und Bearbeitung"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(view.splitFraction * 100)}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 0.1 : 0.02;
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    onViewChange({ splitFraction: clamp(view.splitFraction - step, 0, 1) });
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    onViewChange({ splitFraction: clamp(view.splitFraction + step, 0, 1) });
                  }
                }}
              >
                <span />
                <span />
              </div>
            </div>
          </div>
        )}

        {showPlaceholder && (
          <div className="viewport__overlay">
            {handle.status === 'error' ? (
              <div className="viewport__error">
                <IconWarn size={22} />
                <p>{handle.error}</p>
              </div>
            ) : (
              <div className="viewport__loading">
                <span className="viewport__spinner" />
                <p>Bild wird geladen …</p>
              </div>
            )}
          </div>
        )}

        {handle.loadingFullResolution && (
          <div className="viewport__badge">
            <span className="viewport__spinner viewport__spinner--sm" />
            Original wird geladen ({photo.megapixels} MP)
          </div>
        )}
      </div>

      <div className="viewport__tools">
        <IconButton
          label={view.compare ? 'Vergleich ausblenden' : 'Vorher/Nachher vergleichen'}
          icon={<IconCompare />}
          active={view.compare}
          onClick={() => onViewChange({ compare: !view.compare })}
        />
        <IconButton
          label={zoom === 'fit' ? 'Ansicht 100 % (Schärfe beurteilen)' : 'Ganzes Bild anzeigen'}
          icon={<IconZoom />}
          active={zoom === 'actual'}
          onClick={() => onZoomChange(zoom === 'fit' ? 'actual' : 'fit')}
        />
        <span className="viewport__zoom mono">{zoom === 'fit' ? 'Anpassen' : '100 %'}</span>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
