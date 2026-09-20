import { useCallback, useEffect, useState } from 'react';
import type { Project, ServerCapabilities } from '@photomaster/shared';
import { api } from './api/client.ts';
import { useEditor } from './state/editorStore.ts';
import { toastError } from './state/toastStore.ts';
import { Toasts } from './ui/Toasts.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { EditorScreen } from './screens/EditorScreen.tsx';
import './styles/global.css';

/**
 * Navigation ohne Router-Bibliothek.
 *
 * Die App hat zwei Ansichten. Das Projekt steht in der URL (`?p=<id>`), damit
 * ein geöffneter Editor als Lesezeichen taugt und die Zurück-Taste des
 * Browsers wie erwartet funktioniert. Eine Routing-Bibliothek hätte hier
 * nichts zu tun, was diese dreißig Zeilen nicht tun.
 */
export function App() {
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProject = useEditor((s) => s.loadProject);
  const updateProjectState = useEditor((s) => s.updateProject);
  const clearEditor = useEditor((s) => s.clear);

  const openProject = useCallback(
    (next: Project, pushState = true) => {
      setProject(next);
      loadProject(next);
      if (pushState) {
        window.history.pushState({ projectId: next.id }, '', `?p=${next.id}`);
      }
    },
    [loadProject],
  );

  const goHome = useCallback(
    (pushState = true) => {
      setProject(null);
      clearEditor();
      if (pushState) window.history.pushState({}, '', window.location.pathname);
    },
    [clearEditor],
  );

  /** Projektdaten aktualisieren, ohne den Bearbeitungsstand zu überschreiben. */
  const handleProjectUpdate = useCallback(
    (next: Project) => {
      setProject(next);
      updateProjectState(next);
    },
    [updateProjectState],
  );

  // Erststart: Fähigkeiten laden und ein eventuell verlinktes Projekt öffnen.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const caps = await api.capabilities();
        if (!cancelled) setCapabilities(caps);
      } catch (err) {
        if (!cancelled) toastError(err, 'Der Server ist nicht erreichbar.');
      }

      const id = new URLSearchParams(window.location.search).get('p');
      if (id) {
        try {
          const { project: loaded } = await api.getProject(id);
          if (!cancelled) openProject(loaded, false);
        } catch {
          // Das verlinkte Projekt gibt es nicht mehr — still zur Übersicht.
          if (!cancelled) window.history.replaceState({}, '', window.location.pathname);
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [openProject]);

  // Vor- und Zurück-Taste des Browsers.
  useEffect(() => {
    const onPopState = async () => {
      const id = new URLSearchParams(window.location.search).get('p');
      if (!id) {
        goHome(false);
        return;
      }
      try {
        const { project: loaded } = await api.getProject(id);
        openProject(loaded, false);
      } catch {
        goHome(false);
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [goHome, openProject]);

  return (
    <>
      {loading ? (
        <div className="app-boot">
          <span className="app-boot__spinner" />
        </div>
      ) : project && capabilities ? (
        <EditorScreen
          project={project}
          aiStatus={capabilities.ai}
          onBack={() => goHome()}
          onProjectUpdate={handleProjectUpdate}
        />
      ) : (
        <HomeScreen capabilities={capabilities} onOpenProject={(p) => openProject(p)} />
      )}
      <Toasts />
    </>
  );
}
