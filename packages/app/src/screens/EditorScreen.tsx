import { useCallback, useEffect, useRef, useState } from 'react';
import { hasAnyChange, type AiStatus, type ImageStats, type Project } from '@photomaster/shared';
import { api } from '../api/client.ts';
import { redoLabel, undoLabel, useEditor } from '../state/editorStore.ts';
import { toastError } from '../state/toastStore.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import {
  IconBack,
  IconCurve,
  IconDetail,
  IconDroplet,
  IconEffects,
  IconExport,
  IconInfo,
  IconLayers,
  IconPhoto,
  IconRedo,
  IconMask,
  IconSliders,
  IconSparkle,
  IconUndo,
} from '../ui/Icons.tsx';
import { Viewport } from '../features/viewport/Viewport.tsx';
import { useRenderer, type ViewState } from '../features/viewport/useRenderer.ts';
import { AdjustPanel } from '../features/panels/AdjustPanel.tsx';
import { AiPanel } from '../features/panels/AiPanel.tsx';
import { CurvePanel } from '../features/panels/CurvePanel.tsx';
import { Histogram } from '../features/panels/Histogram.tsx';
import { HslPanel } from '../features/panels/HslPanel.tsx';
import { InfoPanel } from '../features/panels/InfoPanel.tsx';
import { MasksPanel } from '../features/panels/MasksPanel.tsx';
import { PresetPanel } from '../features/panels/PresetPanel.tsx';
import { VersionsPanel } from '../features/panels/VersionsPanel.tsx';
import { ExportDialog } from '../features/export/ExportDialog.tsx';
import './EditorScreen.css';

type TabId =
  | 'ai'
  | 'light'
  | 'color'
  | 'hsl'
  | 'detail'
  | 'effects'
  | 'masks'
  | 'presets'
  | 'versions'
  | 'info';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'ai', label: 'KI', icon: <IconSparkle size={17} /> },
  { id: 'light', label: 'Licht', icon: <IconSliders size={17} /> },
  { id: 'color', label: 'Farbe', icon: <IconDroplet size={17} /> },
  { id: 'hsl', label: 'HSL', icon: <IconCurve size={17} /> },
  { id: 'detail', label: 'Details', icon: <IconDetail size={17} /> },
  { id: 'effects', label: 'Effekte', icon: <IconEffects size={17} /> },
  { id: 'masks', label: 'Masken', icon: <IconMask size={17} /> },
  { id: 'presets', label: 'Presets', icon: <IconPhoto size={17} /> },
  { id: 'versions', label: 'Versionen', icon: <IconLayers size={17} /> },
  { id: 'info', label: 'Info', icon: <IconInfo size={17} /> },
];

/** Verzögerung, bevor ungespeicherte Änderungen zum Server gehen. */
const AUTOSAVE_DELAY = 900;

interface EditorScreenProps {
  project: Project;
  aiStatus: AiStatus;
  onBack: () => void;
  onProjectUpdate: (project: Project) => void;
}

export function EditorScreen({ project, aiStatus, onBack, onProjectUpdate }: EditorScreenProps) {
  const [tab, setTab] = useState<TabId>('ai');
  const [exportOpen, setExportOpen] = useState(false);
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [view, setView] = useState<ViewState>({
    region: { x: 0, y: 0, w: 1, h: 1 },
    compare: false,
    splitFraction: 0.5,
    useFullResolution: false,
  });

  const params = useEditor((s) => s.params);
  const dirty = useEditor((s) => s.dirty);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const markSaved = useEditor((s) => s.markSaved);
  const resetAll = useEditor((s) => s.resetAll);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoText = useEditor(undoLabel);
  const redoText = useEditor(redoLabel);

  const statsSaved = useRef(false);

  /**
   * Die Reiterleiste ist auf einem Telefon breiter als der Bildschirm. Ohne
   * Hinweis darauf bleiben die hinteren Reiter — darunter Masken und
   * Versionen — schlicht unentdeckt. Zwei Klassen steuern eine Verblendung
   * an den Rändern: Sie erscheint nur dort, wo tatsächlich etwas weitergeht.
   */
  const tabsRef = useRef<HTMLElement>(null);
  const [tabEdges, setTabEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;

    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setTabEdges({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 });
    };

    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  // Ein Reiterwechsel per Tastatur darf nicht außerhalb des Sichtbaren landen.
  useEffect(() => {
    tabsRef.current
      ?.querySelector('.editor__tab.is-active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  const onStats = useCallback(
    (stats: ImageStats) => {
      // Die Messwerte einmal je Projekt sichern — die KI braucht sie
      // serverseitig, und sie hängen am unbearbeiteten Bild, ändern sich also
      // durch die Bearbeitung nicht.
      if (statsSaved.current) return;
      statsSaved.current = true;
      api.saveStats(project.id, stats).catch(() => {
        statsSaved.current = false;
      });
    },
    [project.id],
  );

  // Die ausgewählte Maske geht in den Renderer, damit sie als roter
  // Schleier über dem Bild liegt, solange man sie bearbeitet.
  const selectedMaskId = useEditor((s) => s.selectedMaskId);
  const masks = useEditor((s) => s.params.masks);
  const overlayMask = masks.find((m) => m.id === selectedMaskId) ?? null;

  const handle = useRenderer(project.photo, params, view, overlayMask, onStats);

  const patchView = useCallback((patch: Partial<ViewState>) => {
    setView((v) => {
      // Objektidentität nur ändern, wenn sich wirklich etwas ändert — sonst
      // löst jede Zuweisung einen weiteren Render aus.
      const next = { ...v, ...patch };
      if (
        next.compare === v.compare &&
        next.splitFraction === v.splitFraction &&
        next.useFullResolution === v.useFullResolution &&
        next.region.x === v.region.x &&
        next.region.y === v.region.y &&
        next.region.w === v.region.w &&
        next.region.h === v.region.h
      ) {
        return v;
      }
      return next;
    });
  }, []);

  // ── Automatisches Speichern ──────────────────────────────────────────────

  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      api
        .saveParams(project.id, params)
        .then(() => markSaved())
        .catch((err) => toastError(err, 'Die Bearbeitung konnte nicht gespeichert werden.'));
    }, AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [params, dirty, project.id, markSaved]);

  // Beim Verlassen der Seite mit offenen Änderungen warnen. Der Verlust wäre
  // klein (höchstens die letzte Sekunde), aber unerwartet.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // ── Tastaturkürzel ───────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // In Text- und Zahlenfeldern hat die Tastatur Vorrang.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      const mod = event.ctrlKey || event.metaKey;

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (!mod && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        patchView({ compare: !view.compare });
        return;
      }
      if (mod && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setExportOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, patchView, view.compare]);

  const edited = hasAnyChange(params);

  return (
    <div className="editor">
      <header className="editor__header">
        <div className="editor__header-left">
          <IconButton label="Zurück zur Übersicht" icon={<IconBack />} onClick={onBack} />
          <div className="editor__title">
            <span className="editor__name">{project.name}</span>
            <span className="editor__meta mono">
              {project.photo.width} × {project.photo.height} · {project.photo.megapixels} MP
            </span>
          </div>
        </div>

        <div className="editor__header-right">
          <span className={`editor__save ${dirty ? 'is-dirty' : ''}`}>
            {dirty ? 'wird gespeichert …' : 'gespeichert'}
          </span>
          <IconButton
            label={undoText ? `Rückgängig: ${undoText}` : 'Rückgängig'}
            icon={<IconUndo />}
            onClick={undo}
            disabled={!canUndo}
          />
          <IconButton
            label={redoText ? `Wiederholen: ${redoText}` : 'Wiederholen'}
            icon={<IconRedo />}
            onClick={redo}
            disabled={!canRedo}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={resetAll}
            disabled={!edited}
            title="Alle Regler auf den Ausgangszustand zurücksetzen"
          >
            Zurücksetzen
          </Button>
          <Button variant="primary" size="sm" icon={<IconExport size={15} />} onClick={() => setExportOpen(true)}>
            Export
          </Button>
        </div>
      </header>

      <div className="editor__body">
        <Viewport
          photo={project.photo}
          handle={handle}
          view={view}
          onViewChange={patchView}
          zoom={zoom}
          onZoomChange={setZoom}
        />

        <aside className="editor__panel">
          <Histogram handle={handle} params={params} />

          <nav
            ref={tabsRef}
            className={`editor__tabs ${tabEdges.start ? 'has-more-start' : ''} ${
              tabEdges.end ? 'has-more-end' : ''
            }`}
            role="tablist"
            aria-label="Bearbeitungsbereiche"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`editor__tab ${tab === t.id ? 'is-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="editor__panel-content">
            {tab === 'ai' && (
              <AiPanel project={project} aiStatus={aiStatus} onProjectUpdate={onProjectUpdate} />
            )}
            {tab === 'light' && (
              <AdjustPanel group="basic">
                <CurvePanel />
              </AdjustPanel>
            )}
            {tab === 'color' && <AdjustPanel group="color" />}
            {tab === 'hsl' && <HslPanel />}
            {tab === 'detail' && <AdjustPanel group="detail" />}
            {tab === 'effects' && (
              <>
                <AdjustPanel group="effects" />
                <AdjustPanel group="grading" />
              </>
            )}
            {tab === 'masks' && <MasksPanel />}
            {tab === 'presets' && (
              <PresetPanel project={project} aiStatus={aiStatus} onProjectUpdate={onProjectUpdate} />
            )}
            {tab === 'versions' && (
              <VersionsPanel project={project} onProjectUpdate={onProjectUpdate} />
            )}
            {tab === 'info' && <InfoPanel project={project} aiStatus={aiStatus} />}
          </div>
        </aside>
      </div>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        project={project}
        handle={handle}
      />
    </div>
  );
}
