import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiStatus, Project, ProjectSummary, ServerCapabilities } from '@photomaster/shared';
import { api } from '../api/client.ts';
import { toastError, useToasts } from '../state/toastStore.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { IconPhoto, IconPlus, IconShield, IconSparkle, IconTrash, IconWarn } from '../ui/Icons.tsx';
import { SettingsDialog } from '../features/settings/SettingsDialog.tsx';
import { formatRelativeTime } from '../lib/format.ts';
import './HomeScreen.css';

interface HomeScreenProps {
  capabilities: ServerCapabilities | null;
  onOpenProject: (project: Project) => void;
}

export function HomeScreen({ capabilities, onOpenProject }: HomeScreenProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const push = useToasts((s) => s.push);

  const refresh = useCallback(() => {
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch((err) => toastError(err, 'Die Projekte konnten nicht geladen werden.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const importFile = useCallback(
    async (file: File) => {
      if (uploading) return;
      setUploading({ name: file.name, progress: 0 });
      const { promise } = api.uploadPhoto(file, (fraction) =>
        setUploading({ name: file.name, progress: fraction }),
      );
      try {
        const result = await promise;
        for (const warning of result.warnings) push('info', warning);
        onOpenProject(result.project);
      } catch (err) {
        toastError(err, 'Das Foto konnte nicht importiert werden.');
      } finally {
        setUploading(null);
      }
    },
    [uploading, push, onOpenProject],
  );

  const openProject = async (id: string) => {
    try {
      const { project } = await api.getProject(id);
      onOpenProject(project);
    } catch (err) {
      toastError(err, 'Das Projekt konnte nicht geöffnet werden.');
    }
  };

  const removeProject = async (id: string, name: string) => {
    if (!window.confirm(`„${name}" wirklich schließen? Die Originaldatei bleibt erhalten.`)) return;
    try {
      await api.deleteProject(id);
      setProjects((p) => p.filter((x) => x.id !== id));
    } catch (err) {
      toastError(err, 'Das Projekt konnte nicht gelöscht werden.');
    }
  };

  return (
    <div className="home">
      <header className="home__header">
        <div className="home__brand">
          <span className="home__logo" aria-hidden="true" />
          <div>
            <h1 className="home__title">PhotoMaster</h1>
            <p className="home__tagline">Non-destruktive Bildbearbeitung in voller Auflösung</p>
          </div>
        </div>
        <div className="home__header-actions">
          {capabilities && <AiBadge status={capabilities.ai} />}
          <IconButton
            label="Ablage & Datenschutz"
            icon={<IconShield />}
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      </header>

      <main className="home__main">
        <section
          className={`dropzone ${dragOver ? 'is-over' : ''} ${uploading ? 'is-busy' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void importFile(file);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/tiff,image/avif,.nef,.cr2,.cr3,.arw,.dng,.raf,.rw2,.orf,.pef,.srw"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = '';
            }}
          />

          {uploading ? (
            <>
              <div className="dropzone__progress">
                <div
                  className="dropzone__progress-fill"
                  style={{ width: `${uploading.progress * 100}%` }}
                />
              </div>
              <p className="dropzone__title">{uploading.name}</p>
              <p className="dropzone__hint">
                {uploading.progress < 1
                  ? `Wird übertragen — ${Math.round(uploading.progress * 100)} %`
                  : 'Wird ausgelesen und für die Bearbeitung vorbereitet …'}
              </p>
            </>
          ) : (
            <>
              <IconPhoto size={34} className="dropzone__icon" />
              <p className="dropzone__title">Foto hierher ziehen</p>
              {/* Die Formatliste kommt vom Server und nennt nur, was dieser
                  Rechner wirklich dekodieren kann — eine fest eingetragene
                  Liste würde sonst Formate versprechen, die hier scheitern. */}
              <p className="dropzone__hint">
                {(capabilities?.inputFormats ?? ['JPEG', 'PNG']).join(', ')} — sowie die
                eingebettete Vorschau aus RAW-Dateien. Die Originaldatei wird nie verändert.
              </p>
              <Button
                variant="primary"
                size="lg"
                icon={<IconPlus size={17} />}
                onClick={() => inputRef.current?.click()}
              >
                Foto auswählen
              </Button>
            </>
          )}
        </section>

        <section className="home__section">
          <div className="spread">
            <h2 className="section-title">
              {projects.length > 0 ? 'Letzte Bearbeitungen' : 'Meine Projekte'}
            </h2>
            {projects.length > 0 && (
              <span className="dim" style={{ fontSize: 'var(--fs-sm)' }}>
                {projects.length} {projects.length === 1 ? 'Projekt' : 'Projekte'}
              </span>
            )}
          </div>

          {loading ? (
            <div className="home__empty">Wird geladen …</div>
          ) : projects.length === 0 ? (
            <div className="home__empty">
              Noch nichts bearbeitet. Importiere ein Foto, um zu beginnen.
            </div>
          ) : (
            <div className="project-grid">
              {projects.map((project) => (
                <article className="project" key={project.id}>
                  <button
                    type="button"
                    className="project__open"
                    onClick={() => void openProject(project.id)}
                  >
                    <div className="project__thumb">
                      <img
                        src={api.thumbUrl(project.photoHash)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    </div>
                    <div className="project__info">
                      <div className="project__name">{project.name}</div>
                      <div className="project__meta mono">
                        {project.megapixels} MP · {formatRelativeTime(project.updatedAt)}
                        {project.versionCount > 0 &&
                          ` · ${project.versionCount} ${project.versionCount === 1 ? 'Version' : 'Versionen'}`}
                      </div>
                    </div>
                  </button>
                  <IconButton
                    label={`${project.name} schließen`}
                    icon={<IconTrash size={14} />}
                    size="sm"
                    className="project__delete"
                    onClick={() => void removeProject(project.id, project.name)}
                  />
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        capabilities={capabilities}
      />
    </div>
  );
}

function AiBadge({ status }: { status: AiStatus }) {
  return (
    <div className={`ai-badge ${status.available ? 'is-on' : ''}`} title={status.reason ?? undefined}>
      {status.available ? <IconSparkle size={14} /> : <IconWarn size={14} />}
      <span>{status.available ? `KI aktiv · ${status.model}` : 'KI nicht eingerichtet'}</span>
    </div>
  );
}
