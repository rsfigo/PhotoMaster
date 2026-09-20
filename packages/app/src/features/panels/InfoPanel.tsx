import { useState } from 'react';
import type { AiStatus, CoachReport, Project } from '@photomaster/shared';
import { api } from '../../api/client.ts';
import { toastError } from '../../state/toastStore.ts';
import { Button } from '../../ui/Button.tsx';
import { IconGraduation, IconInfo, IconWarn } from '../../ui/Icons.tsx';
import { formatBytes, formatExposure } from '../../lib/format.ts';
import './panels.css';

interface InfoPanelProps {
  project: Project;
  aiStatus: AiStatus;
}

/** Aufnahmedaten (§7) und Photo Coach (§17). */
export function InfoPanel({ project, aiStatus }: InfoPanelProps) {
  const [report, setReport] = useState<CoachReport | null>(null);
  const [busy, setBusy] = useState(false);
  const photo = project.photo;
  const camera = photo.camera;

  const runCoach = async () => {
    setBusy(true);
    try {
      const response = await api.aiCoach(project.id);
      setReport(response.report);
    } catch (err) {
      toastError(err, 'Die Bildbewertung ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel__head">
        <h3 className="section-title">Foto</h3>
      </div>

      <div className="panel__body">
        <Row label="Datei" value={photo.originalName} />
        <Row label="Auflösung" value={`${photo.width} × ${photo.height}`} mono />
        <Row label="Megapixel" value={`${photo.megapixels} MP`} mono />
        <Row label="Dateigröße" value={formatBytes(photo.bytes)} mono />
        <Row label="Format" value={photo.format.toUpperCase()} />

        {(camera.make || camera.model) && (
          <Row label="Kamera" value={[camera.make, camera.model].filter(Boolean).join(' ')} />
        )}
        {camera.lens && <Row label="Objektiv" value={camera.lens} />}
        {(camera.focalLength || camera.fNumber || camera.iso) && (
          <Row
            label="Aufnahme"
            mono
            value={[
              camera.focalLength ? `${Math.round(camera.focalLength)} mm` : null,
              camera.fNumber ? `f/${camera.fNumber}` : null,
              formatExposure(camera.exposureTime),
              camera.iso ? `ISO ${camera.iso}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        )}
        {camera.takenAt && (
          <Row
            label="Aufgenommen"
            value={new Date(camera.takenAt).toLocaleString('de-DE', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          />
        )}

        {/* Bei RAW und konvertierten Formaten ist klar zu sagen, WAS bearbeitet
            wird — alles andere wäre eine vorgetäuschte Fähigkeit (§39). */}
        {photo.source.note && (
          <div
            className={`notice ${photo.source.kind === 'raw-preview' ? 'notice--warn' : ''}`}
            style={{ marginTop: 'var(--space-4)' }}
          >
            {photo.source.kind === 'raw-preview' ? (
              <IconWarn size={15} className="notice__icon" />
            ) : (
              <IconInfo size={15} className="notice__icon" />
            )}
            <div>
              {photo.source.note}
              {photo.source.rawWidth && photo.source.rawHeight && (
                <div style={{ marginTop: 4 }} className="mono dim">
                  Sensor {photo.source.rawWidth} × {photo.source.rawHeight} · bearbeitbar{' '}
                  {photo.source.width} × {photo.source.height}
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ marginTop: 'var(--space-5)' }}>
          <div className="spread" style={{ marginBottom: 'var(--space-3)' }}>
            <span className="section-title">Photo Coach</span>
          </div>

          {!aiStatus.available ? (
            <p className="panel__hint">
              Der Photo Coach braucht die KI-Anbindung. {aiStatus.reason}
            </p>
          ) : !report ? (
            <>
              <Button
                variant="secondary"
                block
                icon={<IconGraduation size={15} />}
                busy={busy}
                onClick={runCoach}
              >
                Aufnahme bewerten lassen
              </Button>
              <p className="panel__hint" style={{ marginTop: 6 }}>
                Beurteilt die AUFNAHME, nicht die Bearbeitung — mit Hinweisen für
                das nächste Mal.
              </p>
            </>
          ) : (
            <>
              <p style={{ fontSize: 'var(--fs-base)', lineHeight: 1.55, marginBottom: 'var(--space-4)' }}>
                {report.overall}
              </p>

              {report.ratings.map((rating) => (
                <div className="coach__rating" key={rating.label}>
                  <div className="coach__rating-head">
                    <span className="coach__rating-label">{rating.label}</span>
                    <span className="coach__rating-score mono">{rating.score}</span>
                  </div>
                  <div className="coach__bar">
                    <div className="coach__bar-fill" style={{ width: `${rating.score}%` }} />
                  </div>
                  <p className="coach__comment">{rating.comment}</p>
                </div>
              ))}

              {report.tips.length > 0 && (
                <div style={{ marginTop: 'var(--space-5)' }}>
                  <div className="section-title" style={{ marginBottom: 'var(--space-3)' }}>
                    Für das nächste Mal
                  </div>
                  <ul className="coach__tips">
                    {report.tips.map((tip, i) => (
                      <li key={i}>{tip}</li>
                    ))}
                  </ul>
                </div>
              )}

              <Button
                variant="ghost"
                size="sm"
                block
                busy={busy}
                onClick={runCoach}
                style={{ marginTop: 'var(--space-4)' }}
              >
                Neu bewerten
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info-row">
      <span className="info-row__label">{label}</span>
      <span className={`info-row__value ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  );
}
