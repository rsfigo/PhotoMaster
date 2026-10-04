/**
 * Bindet die WebGL-Engine an React.
 *
 * Zwei Dinge sind hier bewusst gelöst:
 *
 * 1. **Der Renderer lebt in einem Ref, nicht im State.** Er hält WebGL-Objekte
 *    und darf nicht bei jedem Rendern neu erzeugt werden. React steuert nur,
 *    WANN gezeichnet wird — nie, WIE.
 *
 * 2. **Gezeichnet wird über `requestAnimationFrame`, gebündelt.** Beim Ziehen
 *    eines Reglers kommen Dutzende Änderungen pro Sekunde an; ohne Bündelung
 *    würde für jede einzelne ein voller Durchlauf durch den Graphen starten.
 *    Der Frame liest den jeweils AKTUELLEN Stand aus einem Ref — es geht also
 *    nie ein veralteter Wert auf den Bildschirm.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PhotoRenderer, analyzePixels, estimateAirlight } from '@photomaster/engine';
import type { EditParams, ImageStats, LocalMask, PhotoMeta } from '@photomaster/shared';
import { api } from '../../api/client.ts';

export interface ViewState {
  /** Dargestellter Bildausschnitt, normalisiert. */
  region: { x: number; y: number; w: number; h: number };
  compare: boolean;
  splitFraction: number;
  useFullResolution: boolean;
}

export type RendererStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RendererHandle {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  status: RendererStatus;
  error: string | null;
  stats: ImageStats | null;
  /** Ist das Original in voller Auflösung im Grafikspeicher? */
  fullResolutionReady: boolean;
  loadingFullResolution: boolean;
  /** Lädt das Original nach — für 100-%-Ansicht und Export nötig. */
  ensureFullResolution: () => Promise<void>;
  renderer: PhotoRenderer | null;
  /** Fordert einen Frame an. */
  requestFrame: () => void;
  /** Aktueller Bearbeitungsstand des Histogramms (bearbeitetes Bild). */
  readProcessedPixels: () => { data: Uint8Array; width: number; height: number } | null;
}

export function useRenderer(
  photo: PhotoMeta | null,
  params: EditParams,
  view: ViewState,
  /** Maske, die als roter Schleier eingeblendet wird — reine Anzeige (§28). */
  overlayMask: LocalMask | null,
  onStats?: (stats: ImageStats) => void,
): RendererHandle {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PhotoRenderer | null>(null);
  const frameRef = useRef<number | null>(null);

  // Die Zeichen-Eingaben liegen in Refs, damit der Frame-Callback stabil bleibt
  // und trotzdem immer den neuesten Stand sieht.
  const paramsRef = useRef(params);
  const viewRef = useRef(view);
  const overlayRef = useRef(overlayMask);
  paramsRef.current = params;
  viewRef.current = view;
  overlayRef.current = overlayMask;

  const [status, setStatus] = useState<RendererStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ImageStats | null>(null);
  const [fullResolutionReady, setFullResolutionReady] = useState(false);
  const [loadingFullResolution, setLoadingFullResolution] = useState(false);

  const draw = useCallback(() => {
    frameRef.current = null;
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas || canvas.width === 0) return;

    const v = viewRef.current;
    try {
      renderer.setMaskOverlay(overlayRef.current);
      if (v.compare) {
        renderer.renderCompare(paramsRef.current, v.region, v.splitFraction, v.useFullResolution);
      } else {
        renderer.renderToCanvas(paramsRef.current, v.region, v.useFullResolution);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Die Vorschau konnte nicht gezeichnet werden.');
      setStatus('error');
    }
  }, []);

  const requestFrame = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // ── Bild laden ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!photo) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    setStatus('loading');
    setError(null);
    setFullResolutionReady(false);
    // Ein noch laufendes Nachladen gehört zum vorigen Foto und meldet sich
    // nicht mehr zurück — sein Ladezustand darf hier nicht stehen bleiben.
    setLoadingFullResolution(false);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      setStatus('error');
      setError(
        'Die Grafikkarte hat die Verbindung zur Bildvorschau unterbrochen. Lade die Seite neu — deine Bearbeitung ist gespeichert.',
      );
    };
    canvas.addEventListener('webglcontextlost', onContextLost);

    (async () => {
      try {
        const renderer = PhotoRenderer.create(canvas);
        if (cancelled) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;

        const response = await fetch(api.previewUrl(photo.hash));
        if (!response.ok) throw new Error('Die Vorschau konnte nicht geladen werden.');
        const blob = await response.blob();

        // `imageOrientation: 'from-image'` wendet die EXIF-Ausrichtung an,
        // `colorSpaceConversion: 'default'` rechnet ein eingebettetes
        // Farbprofil (AdobeRGB, Display P3) auf sRGB um. Ohne Letzteres würde
        // die Engine fremde Farbzahlen als sRGB interpretieren und ein
        // AdobeRGB-Foto zu kräftig darstellen.
        const bitmap = await createImageBitmap(blob, {
          imageOrientation: 'from-image',
          colorSpaceConversion: 'default',
        });

        if (cancelled) {
          bitmap.close();
          renderer.dispose();
          return;
        }

        renderer.setPreview(bitmap);
        bitmap.close();

        // Messwerte aus dem UNBEARBEITETEN Bild — Grundlage für Histogramm,
        // Dunstentfernung und die KI.
        const pixels = renderer.readSourcePixels(1024);
        const computed = analyzePixels(pixels.data, pixels.width, pixels.height);
        renderer.airlight = estimateAirlight(computed);

        if (cancelled) return;
        setStats(computed);
        onStats?.(computed);
        setStatus('ready');
        requestFrame();
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Das Bild konnte nicht geladen werden.');
      }
    })();

    return () => {
      cancelled = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // `onStats` ist bewusst nicht in den Abhängigkeiten: Der Aufrufer gibt in
    // der Regel eine inline definierte Funktion mit, und das Bild soll nicht
    // bei jedem Rendern der Oberfläche neu geladen werden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.id, requestFrame]);

  /**
   * Laufendes Nachladen des Originals. Wer während des Ladens erneut fragt —
   * 100-%-Ansicht und gleich danach Export —, wartet auf denselben Vorgang,
   * statt die 12–40 MB ein zweites Mal zu laden und zu dekodieren.
   */
  const fullResLoadRef = useRef<{ renderer: PhotoRenderer; promise: Promise<void> } | null>(null);

  const ensureFullResolution = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer || !photo || renderer.hasFullResolution) return;

    const running = fullResLoadRef.current;
    if (running && running.renderer === renderer) return running.promise;

    const load = async () => {
      setLoadingFullResolution(true);
      try {
        const response = await fetch(api.fullResolutionUrl(photo.id));
        if (!response.ok) throw new Error('Das Original konnte nicht geladen werden.');
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob, {
          imageOrientation: 'from-image',
          colorSpaceConversion: 'default',
        });

        // Wurde inzwischen ein anderes Foto geöffnet, ist dieser Renderer
        // bereits freigegeben. Die Textur dort hineinzuladen, hinterließe
        // rund 100 MB Grafikspeicher, die niemand mehr freigibt — und das
        // neue Foto galt fälschlich als in voller Auflösung geladen.
        if (rendererRef.current !== renderer) {
          bitmap.close();
          return;
        }

        renderer.setFullResolution(bitmap);
        bitmap.close();
        setFullResolutionReady(true);
        requestFrame();
      } finally {
        if (fullResLoadRef.current?.renderer === renderer) fullResLoadRef.current = null;
        if (rendererRef.current === renderer) setLoadingFullResolution(false);
      }
    };

    const promise = load();
    fullResLoadRef.current = { renderer, promise };
    return promise;
  }, [photo, requestFrame]);

  const readProcessedPixels = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer || status !== 'ready') return null;
    try {
      return renderer.readProcessedPixels(paramsRef.current, 320);
    } catch {
      return null;
    }
  }, [status]);

  // Jede Änderung an Parametern oder Ansicht fordert genau einen Frame an.
  useEffect(() => {
    if (status === 'ready') requestFrame();
  }, [params, view, overlayMask, status, requestFrame]);

  return {
    canvasRef,
    status,
    error,
    stats,
    fullResolutionReady,
    loadingFullResolution,
    ensureFullResolution,
    renderer: rendererRef.current,
    requestFrame,
    readProcessedPixels,
  };
}
