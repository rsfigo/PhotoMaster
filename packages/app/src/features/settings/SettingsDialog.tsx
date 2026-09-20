/**
 * Ablage und Datenschutz (§30).
 *
 * §30 verlangt, dass die App klar definiert, was lokal liegt, was zur KI geht
 * und wann etwas gelöscht wird. Ein Text in der README erfüllt das nicht — der
 * Nutzer sieht ihn nie. Dieser Dialog zeigt deshalb keine Zusage, sondern den
 * gemessenen Zustand: das benutzte Verzeichnis, die Anzahl der Fotos und den
 * belegten Platz je Bereich.
 *
 * Genau eine Schaltfläche löscht hier etwas, und sie löscht ausschließlich
 * Exporte. Die sind jederzeit neu erzeugbar; Originale werden nie automatisch
 * entfernt.
 */

import { useEffect, useState } from 'react';
import type { ServerCapabilities, StorageReport } from '@photomaster/shared';
import { api } from '../../api/client.ts';
import { Button } from '../../ui/Button.tsx';
import { Dialog } from '../../ui/Dialog.tsx';
import { IconTrash } from '../../ui/Icons.tsx';
import { toastError, toastSuccess } from '../../state/toastStore.ts';
import { formatBytes } from '../../lib/format.ts';
import './settings.css';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  capabilities: ServerCapabilities | null;
}

export function SettingsDialog({ open, onClose, capabilities }: SettingsDialogProps) {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .storage()
      .then(setReport)
      .catch((err) => toastError(err, 'Die Ablage konnte nicht gelesen werden.'))
      .finally(() => setLoading(false));
  }, [open]);

  const clearExports = async () => {
    if (!report) return;
    if (
      !window.confirm(
        'Alle bereits erzeugten Exportdateien löschen? Deine Fotos und Bearbeitungen bleiben ' +
          'unverändert — Exporte lassen sich jederzeit neu erzeugen.',
      )
    ) {
      return;
    }

    setClearing(true);
    try {
      const result = await api.clearExports();
      setReport(await api.storage());
      toastSuccess(
        result.removed === 0
          ? 'Es lagen keine Exportdateien vor.'
          : `${result.removed} ${result.removed === 1 ? 'Datei' : 'Dateien'} gelöscht, ` +
              `${formatBytes(result.freedBytes)} frei.`,
      );
    } catch (err) {
      toastError(err, 'Die Exporte konnten nicht gelöscht werden.');
    } finally {
      setClearing(false);
    }
  };

  const ai = capabilities?.ai;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ablage & Datenschutz"
      subtitle="Wo deine Fotos liegen und was den Rechner verlässt"
      size="md"
      footer={<Button onClick={onClose}>Schließen</Button>}
    >
      {/* ── Wo alles liegt ──────────────────────────────────────────────── */}
      <section className="settings__section">
        <h3 className="section-title">Auf diesem Rechner</h3>
        <p className="settings__path mono">{report?.dataDir ?? '…'}</p>

        {loading && !report ? (
          <p className="settings__hint">Wird gelesen …</p>
        ) : report ? (
          <>
            <dl className="settings__rows">
              <Row label="Originale" hint="unverändert, schreibgeschützt" value={report.sizes.originals} />
              {report.sizes.working > 0 && (
                <Row
                  label="Arbeitskopien"
                  hint="verlustfrei, nur für HEIF und RAW"
                  value={report.sizes.working}
                />
              )}
              <Row label="Vorschauen" hint="Anzeige und Miniaturen" value={report.sizes.previews} />
              <Row label="Exporte" hint="fertige Dateien" value={report.sizes.exports} />
              <Row label="Datenbank" hint="Projekte, Regler, Masken" value={report.sizes.database} />
              <div className="settings__row settings__row--total">
                <dt>Zusammen</dt>
                <dd className="mono">{formatBytes(report.sizes.total)}</dd>
              </div>
            </dl>

            <p className="settings__hint">
              {report.counts.photos} {report.counts.photos === 1 ? 'Original' : 'Originale'} ·{' '}
              {report.counts.projects} {report.counts.projects === 1 ? 'Projekt' : 'Projekte'} ·{' '}
              {report.counts.versions} {report.counts.versions === 1 ? 'Version' : 'Versionen'}
              {report.counts.projects > 0 && (
                <>
                  {' '}
                  — eine Bearbeitung ist ein Satz Zahlen, kein zweites Bild. Alle Projekte und
                  Versionen zusammen belegen {formatBytes(report.sizes.database)}.
                </>
              )}
            </p>

            <div className="settings__actions">
              <Button
                variant="ghost"
                icon={<IconTrash />}
                busy={clearing}
                disabled={report.sizes.exports === 0}
                onClick={() => void clearExports()}
              >
                Exporte löschen ({formatBytes(report.sizes.exports)})
              </Button>
            </div>
            <p className="settings__hint">
              Originale werden nie automatisch gelöscht — auch dann nicht, wenn du ein Projekt
              schließt. Sie verschwinden nur, wenn du die Dateien selbst entfernst.
            </p>
          </>
        ) : null}
      </section>

      {/* ── Was den Rechner verlässt ────────────────────────────────────── */}
      <section className="settings__section">
        <h3 className="section-title">Was den Rechner verlässt</h3>

        {ai?.available ? (
          <>
            <p className="settings__text">
              Nur wenn du eine KI-Funktion ausdrücklich anklickst — „Automatisch bearbeiten",
              „Anwenden", „Bildinhalt analysieren", „Aufnahme bewerten lassen" oder das
              Stern-Symbol an einem Preset. Dann gehen an Anthropic:
            </p>
            <ul className="settings__list">
              <li>ein auf 1024 px verkleinertes Ansichtsbild</li>
              <li>die gemessenen Werte des Bildes (Histogramm, Clipping, Weißabgleich …)</li>
              <li>die aktuellen Reglerwerte und dein eingegebener Wunsch</li>
            </ul>
            <p className="settings__text">
              Ohne diese Klicks verlässt kein Bildmaterial den Rechner. Das Original wird nie
              gesendet, immer nur das kleine Ansichtsbild.
            </p>
          </>
        ) : (
          <p className="settings__text">
            Nichts. Ohne hinterlegten API-Schlüssel gibt es in dieser Installation keinen Weg nach
            außen — die KI-Schaltflächen sind abgeschaltet.
          </p>
        )}

        <dl className="settings__rows">
          <div className="settings__row">
            <dt>
              KI-Anbindung
              <span className="settings__row-hint">
                {ai?.available ? 'Schlüssel liegt serverseitig in .env' : (ai?.reason ?? '')}
              </span>
            </dt>
            <dd className="mono">{ai?.available ? ai.model : 'nicht eingerichtet'}</dd>
          </div>
          <div className="settings__row">
            <dt>
              GPS-Daten
              <span className="settings__row-hint">
                Der EXIF-Parser ist ohne GPS-Block konfiguriert
              </span>
            </dt>
            <dd className="mono">werden nicht gelesen</dd>
          </div>
          <div className="settings__row">
            <dt>
              Konto
              <span className="settings__row-hint">keine Anmeldung, keine Synchronisation</span>
            </dt>
            <dd className="mono">keines</dd>
          </div>
        </dl>
      </section>

      {/* ── Was dieser Rechner öffnen kann ──────────────────────────────── */}
      {capabilities && (
        <section className="settings__section">
          <h3 className="section-title">Was dieser Rechner öffnen kann</h3>
          <p className="settings__text">
            {capabilities.inputFormats.join(', ')} sowie RAW-Dateien (NEF, CR2, CR3, ARW, DNG, RAF,
            RW2, ORF, PEF, SRW) über die eingebettete Kameravorschau — RAW wird nicht entwickelt.
          </p>
          <p className="settings__hint">
            HEIC vom iPhone ist mit HEVC komprimiert. Ob dieser Rechner einen Dekoder dafür hat,
            zeigt sich erst beim Import; scheitert er, sagt die App, was stattdessen funktioniert.
            Maximale Dateigröße beim Import: {formatBytes(capabilities.maxUploadBytes)}.
          </p>
        </section>
      )}
    </Dialog>
  );
}

function Row({ label, hint, value }: { label: string; hint: string; value: number }) {
  return (
    <div className="settings__row">
      <dt>
        {label}
        <span className="settings__row-hint">{hint}</span>
      </dt>
      <dd className="mono">{formatBytes(value)}</dd>
    </div>
  );
}
