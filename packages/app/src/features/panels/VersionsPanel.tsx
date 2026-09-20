import { useState } from 'react';
import { hasAnyChange, type Project } from '@photomaster/shared';
import { api } from '../../api/client.ts';
import { useEditor } from '../../state/editorStore.ts';
import { toastError, useToasts } from '../../state/toastStore.ts';
import { Button, IconButton } from '../../ui/Button.tsx';
import { IconCheck, IconLayers, IconPlus, IconTrash } from '../../ui/Icons.tsx';
import './panels.css';

interface VersionsPanelProps {
  project: Project;
  onProjectUpdate: (project: Project) => void;
}

/**
 * Versionen (§19).
 *
 * Eine Version ist ein benannter Parametersatz auf demselben Original — kein
 * zweites Bild. Vier Fassungen eines 12-MB-Fotos kosten wenige Kilobyte, und
 * das Original wird dabei kein einziges Mal angefasst.
 */
export function VersionsPanel({ project, onProjectUpdate }: VersionsPanelProps) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const params = useEditor((s) => s.params);
  const applyParams = useEditor((s) => s.applyParams);
  const markSaved = useEditor((s) => s.markSaved);
  const push = useToasts((s) => s.push);

  const save = async () => {
    setBusy(true);
    try {
      const name = `Version ${project.versions.length + 1}`;
      const response = await api.createVersion(project.id, name, params);
      onProjectUpdate(response.project);
      push('success', `„${name}" gespeichert.`);
    } catch (err) {
      toastError(err, 'Die Version konnte nicht gespeichert werden.');
    } finally {
      setBusy(false);
    }
  };

  const activate = async (versionId: string) => {
    const version = project.versions.find((v) => v.id === versionId);
    if (!version) return;
    try {
      const response = await api.activateVersion(project.id, versionId);
      applyParams(version.params, `Version: ${version.name}`);
      markSaved();
      onProjectUpdate(response.project);
    } catch (err) {
      toastError(err, 'Die Version konnte nicht geladen werden.');
    }
  };

  const remove = async (versionId: string) => {
    try {
      await api.deleteVersion(versionId);
      onProjectUpdate({
        ...project,
        versions: project.versions.filter((v) => v.id !== versionId),
        activeVersionId: project.activeVersionId === versionId ? null : project.activeVersionId,
      });
    } catch (err) {
      toastError(err, 'Die Version konnte nicht gelöscht werden.');
    }
  };

  const commitRename = async (versionId: string) => {
    const name = draftName.trim();
    setRenaming(null);
    if (!name) return;
    try {
      await api.renameVersion(versionId, name);
      onProjectUpdate({
        ...project,
        versions: project.versions.map((v) => (v.id === versionId ? { ...v, name } : v)),
      });
    } catch (err) {
      toastError(err, 'Die Version konnte nicht umbenannt werden.');
    }
  };

  return (
    <div className="panel">
      <div className="panel__head">
        <h3 className="section-title">Versionen</h3>
      </div>

      <div className="panel__body">
        <Button
          variant="secondary"
          block
          icon={<IconPlus size={15} />}
          busy={busy}
          disabled={!hasAnyChange(params)}
          onClick={save}
        >
          Aktuellen Stand sichern
        </Button>

        {!hasAnyChange(params) && (
          <p className="panel__hint" style={{ marginTop: 6 }}>
            Noch nichts verändert — es gibt nichts zu sichern.
          </p>
        )}

        <div style={{ marginTop: 'var(--space-4)' }}>
          {project.versions.length === 0 ? (
            <div className="panel__empty">
              <IconLayers size={24} style={{ opacity: 0.4 }} />
              <p style={{ marginTop: 'var(--space-2)' }}>
                Noch keine Versionen. Sichere verschiedene Fassungen desselben
                Fotos, um sie später zu vergleichen.
              </p>
            </div>
          ) : (
            project.versions.map((version) => (
              <div
                key={version.id}
                className={`version ${project.activeVersionId === version.id ? 'is-active' : ''}`}
              >
                {renaming === version.id ? (
                  <input
                    className="version__input"
                    value={draftName}
                    autoFocus
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={() => void commitRename(version.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(version.id);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="version__main"
                    onClick={() => void activate(version.id)}
                    onDoubleClick={() => {
                      setRenaming(version.id);
                      setDraftName(version.name);
                    }}
                    title="Klicken zum Laden, Doppelklick zum Umbenennen"
                  >
                    <div className="version__name">{version.name}</div>
                    <div className="version__meta">
                      {new Date(version.createdAt).toLocaleDateString('de-DE', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {version.rationale ? ' · KI' : ''}
                    </div>
                  </button>
                )}

                {project.activeVersionId === version.id && (
                  <IconCheck size={15} style={{ color: 'var(--accent)', flex: 'none' }} />
                )}
                <IconButton
                  label={`${version.name} löschen`}
                  icon={<IconTrash size={14} />}
                  size="sm"
                  onClick={() => void remove(version.id)}
                />
              </div>
            ))
          )}
        </div>

        <p className="panel__hint" style={{ marginTop: 'var(--space-4)' }}>
          Alle Versionen greifen auf dieselbe Originaldatei zu. Gespeichert
          werden nur die Reglerwerte, keine zweiten Bilddateien.
        </p>
      </div>
    </div>
  );
}
