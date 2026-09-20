import { useEffect, useState } from 'react';
import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportFormat,
  type ExportReport,
  type ExportSettings,
  type Project,
} from '@photomaster/shared';
import { api } from '../../api/client.ts';
import { useEditor } from '../../state/editorStore.ts';
import { toastError } from '../../state/toastStore.ts';
import { Button } from '../../ui/Button.tsx';
import { Dialog } from '../../ui/Dialog.tsx';
import { IconCheck, IconWarn } from '../../ui/Icons.tsx';
import { formatBytes } from '../../lib/format.ts';
import type { RendererHandle } from '../viewport/useRenderer.ts';
import './ExportDialog.css';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  project: Project;
  handle: RendererHandle;
}

type Phase = 'settings' | 'loading' | 'rendering' | 'encoding' | 'done';

const FORMATS: { id: ExportFormat; label: string; note: string }[] = [
  { id: 'jpeg', label: 'JPEG', note: 'Universell, kleine Dateien' },
  { id: 'png', label: 'PNG', note: 'Verlustfrei, große Dateien' },
  { id: 'tiff', label: 'TIFF', note: 'Verlustfrei, für die Weiterverarbeitung' },
];

export function ExportDialog({ open, onClose, project, handle }: ExportDialogProps) {
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [phase, setPhase] = useState<Phase>('settings');
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [customSize, setCustomSize] = useState(false);

  const params = useEditor((s) => s.params);
  const photo = project.photo;

  useEffect(() => {
    if (open) {
      setPhase('settings');
      setReport(null);
      setProgress(0);
    }
  }, [open]);

  const targetWidth = customSize && settings.resizeWidth > 0 ? settings.resizeWidth : photo.width;
  const scale = targetWidth / photo.width;
  const targetHeight = Math.round(photo.height * scale);
  const downscaling = targetWidth < photo.width;

  const busy = phase === 'loading' || phase === 'rendering' || phase === 'encoding';

  const start = async () => {
    try {
      setPhase('loading');
      // Ohne das Original in voller Auflösung wäre jeder Export eine
      // Hochrechnung aus der Vorschau — genau das, was §4 verbietet.
      await handle.ensureFullResolution();

      const renderer = handle.renderer;
      if (!renderer) throw new Error('Die Bildverarbeitung ist nicht bereit.');

      setPhase('rendering');
      setProgress(0);
      const result = await renderer.renderFullResolution(params, (p) => {
        setProgress(p.tilesDone / p.tilesTotal);
      });

      setPhase('encoding');
      const effective: ExportSettings = {
        ...settings,
        resizeWidth: customSize && settings.resizeWidth > 0 ? settings.resizeWidth : 0,
        resizeHeight: 0,
      };

      const response = await api.exportPixels(
        project.id,
        result.data,
        result.width,
        result.height,
        effective,
        project.name,
      );

      setReport(response.report);
      setPhase('done');
    } catch (err) {
      setPhase('settings');
      toastError(err, 'Der Export konnte nicht abgeschlossen werden. Dein Originalfoto wurde nicht verändert.');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Exportieren"
      subtitle={phase === 'done' ? 'Fertig' : `${photo.originalName}`}
      size="md"
      persistent={busy}
      footer={
        phase === 'done' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Schließen
            </Button>
            {report && (
              <a href={report.url} download className="btn btn--primary btn--md">
                <span className="btn__label">Datei speichern</span>
              </a>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Abbrechen
            </Button>
            <Button variant="primary" onClick={start} busy={busy}>
              {busy ? phaseLabel(phase) : 'Exportieren'}
            </Button>
          </>
        )
      }
    >
      {phase === 'done' && report ? (
        <ExportResult report={report} photo={photo} />
      ) : busy ? (
        <div className="export__progress">
          <div className="export__progress-label">
            {phaseLabel(phase)}
            {phase === 'rendering' && ` · ${Math.round(progress * 100)} %`}
          </div>
          <div className="export__bar">
            <div
              className="export__bar-fill"
              style={{ width: phase === 'rendering' ? `${progress * 100}%` : '100%' }}
              data-indeterminate={phase !== 'rendering'}
            />
          </div>
          <p className="panel__hint" style={{ marginTop: 'var(--space-3)' }}>
            {phase === 'loading'
              ? `Das Original wird geladen (${photo.megapixels} MP).`
              : phase === 'rendering'
                ? 'Das Bild wird in voller Auflösung kachelweise berechnet.'
                : 'Die Datei wird geschrieben.'}
          </p>
        </div>
      ) : (
        <>
          <section className="export__section">
            <h4 className="section-title">Format</h4>
            <div className="export__formats">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`export__format ${settings.format === f.id ? 'is-active' : ''}`}
                  onClick={() => setSettings((s) => ({ ...s, format: f.id }))}
                >
                  <span className="export__format-name">{f.label}</span>
                  <span className="export__format-note">{f.note}</span>
                </button>
              ))}
            </div>
          </section>

          {settings.format === 'jpeg' && (
            <section className="export__section">
              <h4 className="section-title">Qualität</h4>
              <div className="export__quality">
                <input
                  type="range"
                  min={60}
                  max={100}
                  step={1}
                  value={settings.quality}
                  onChange={(e) => setSettings((s) => ({ ...s, quality: Number(e.target.value) }))}
                  aria-label="JPEG-Qualität"
                />
                <span className="mono export__quality-value">{settings.quality}</span>
              </div>
              <label className="export__check">
                <input
                  type="checkbox"
                  checked={settings.chromaSubsampling === '4:4:4'}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      chromaSubsampling: e.target.checked ? '4:4:4' : '4:2:0',
                    }))
                  }
                />
                <span>
                  Volle Farbauflösung (4:4:4)
                  <em>
                    Ohne diese Einstellung wird die Farbinformation halbiert. Für
                    Fotos mit kräftigen Farbkanten deutlich sichtbar.
                  </em>
                </span>
              </label>
            </section>
          )}

          <section className="export__section">
            <h4 className="section-title">Auflösung</h4>
            <label className="export__check">
              <input
                type="radio"
                name="size"
                checked={!customSize}
                onChange={() => setCustomSize(false)}
              />
              <span>
                Originalauflösung — {photo.width} × {photo.height} ({photo.megapixels} MP)
                <em>Empfohlen. Es geht kein einziger Pixel verloren.</em>
              </span>
            </label>
            <label className="export__check">
              <input
                type="radio"
                name="size"
                checked={customSize}
                onChange={() => {
                  setCustomSize(true);
                  setSettings((s) => ({ ...s, resizeWidth: s.resizeWidth || 2048 }));
                }}
              />
              <span>Andere Breite</span>
            </label>

            {customSize && (
              <div className="export__size">
                <input
                  type="number"
                  min={16}
                  max={photo.width * 2}
                  value={settings.resizeWidth || ''}
                  onChange={(e) => setSettings((s) => ({ ...s, resizeWidth: Number(e.target.value) }))}
                  aria-label="Zielbreite in Pixeln"
                />
                <span className="dim mono">
                  × {targetHeight} px
                </span>
              </div>
            )}

            {downscaling && (
              <div className="notice notice--warn" style={{ marginTop: 'var(--space-3)' }}>
                <IconWarn size={15} className="notice__icon" />
                <div>
                  Du exportierst dieses Foto in einer niedrigeren Auflösung als das
                  Original. Aus {photo.width} × {photo.height} werden {targetWidth} ×{' '}
                  {targetHeight} — das sind{' '}
                  {Math.round((1 - (targetWidth * targetHeight) / (photo.width * photo.height)) * 100)} %
                  weniger Bildpunkte.
                </div>
              </div>
            )}
          </section>

          <section className="export__section">
            <h4 className="section-title">Metadaten</h4>
            <label className="export__check">
              <input
                type="checkbox"
                checked={settings.keepMetadata}
                onChange={(e) => setSettings((s) => ({ ...s, keepMetadata: e.target.checked }))}
              />
              <span>
                Aufnahmedaten übernehmen
                <em>
                  {settings.format === 'jpeg'
                    ? 'Kamera, Objektiv, Blende, Zeit und ISO werden aus dem Original übernommen.'
                    : 'Für dieses Format werden keine EXIF-Daten geschrieben; die Originaldatei behält sie.'}
                </em>
              </span>
            </label>
          </section>

          <section className="export__section">
            <h4 className="section-title">Vergleich</h4>
            <div className="export__compare">
              <div>
                <div className="export__compare-head">Original</div>
                <CompareRow label="Auflösung" value={`${photo.width} × ${photo.height}`} />
                <CompareRow label="Megapixel" value={`${photo.megapixels} MP`} />
                <CompareRow label="Dateigröße" value={formatBytes(photo.bytes)} />
                <CompareRow label="Format" value={photo.format.toUpperCase()} />
              </div>
              <div>
                <div className="export__compare-head">Export</div>
                <CompareRow
                  label="Auflösung"
                  value={`${targetWidth} × ${targetHeight}`}
                  warn={downscaling}
                />
                <CompareRow
                  label="Megapixel"
                  value={`${Math.round((targetWidth * targetHeight) / 1e5) / 10} MP`}
                  warn={downscaling}
                />
                <CompareRow label="Dateigröße" value="wird beim Export ermittelt" muted />
                <CompareRow
                  label="Format"
                  value={`${settings.format.toUpperCase()}${settings.format === 'jpeg' ? ` · Q ${settings.quality}` : ''}`}
                />
              </div>
            </div>
          </section>
        </>
      )}
    </Dialog>
  );
}

function ExportResult({ report, photo }: { report: ExportReport; photo: Project['photo'] }) {
  const sameResolution = report.width === photo.width && report.height === photo.height;

  return (
    <div className="export__result">
      <div className={`export__result-head ${sameResolution ? 'is-ok' : 'is-warn'}`}>
        {sameResolution ? <IconCheck size={18} /> : <IconWarn size={18} />}
        <span>
          {sameResolution
            ? 'In voller Originalauflösung exportiert.'
            : 'Exportiert — in geringerer Auflösung als das Original.'}
        </span>
      </div>

      <div className="export__compare">
        <div>
          <div className="export__compare-head">Original</div>
          <CompareRow label="Auflösung" value={`${photo.width} × ${photo.height}`} />
          <CompareRow label="Megapixel" value={`${photo.megapixels} MP`} />
          <CompareRow label="Dateigröße" value={formatBytes(photo.bytes)} />
          <CompareRow label="Format" value={photo.format.toUpperCase()} />
        </div>
        <div>
          <div className="export__compare-head">Export</div>
          <CompareRow label="Auflösung" value={`${report.width} × ${report.height}`} warn={!sameResolution} />
          <CompareRow label="Megapixel" value={`${report.megapixels} MP`} warn={!sameResolution} />
          <CompareRow label="Dateigröße" value={formatBytes(report.bytes)} />
          <CompareRow
            label="Format"
            value={`${report.format.toUpperCase()}${report.quality ? ` · Q ${report.quality}` : ''}`}
          />
        </div>
      </div>

      <div className="export__facts">
        {report.chromaSubsampling && (
          <Fact label="Farbauflösung" value={report.chromaSubsampling} />
        )}
        <Fact
          label="JPEG-Generationen"
          value={
            report.compressionGenerations === 0
              ? 'keine (verlustfrei)'
              : `${report.compressionGenerations} (inkl. Original)`
          }
        />
        <Fact label="Metadaten" value={report.metadataNote} />
        <Fact label="Dauer" value={`${(report.durationMs / 1000).toFixed(1)} s`} />
      </div>

      <p className="panel__hint" style={{ marginTop: 'var(--space-4)' }}>
        Die Originaldatei wurde nicht verändert.
      </p>
    </div>
  );
}

function CompareRow({
  label,
  value,
  warn = false,
  muted = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="export__compare-row">
      <span>{label}</span>
      <span className={`mono ${warn ? 'export__warn-value' : ''} ${muted ? 'dim' : ''}`}>{value}</span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="export__fact">
      <span className="export__fact-label">{label}</span>
      <span className="export__fact-value">{value}</span>
    </div>
  );
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'loading':
      return 'Original wird geladen';
    case 'rendering':
      return 'Bild wird berechnet';
    case 'encoding':
      return 'Datei wird geschrieben';
    default:
      return 'Exportieren';
  }
}
