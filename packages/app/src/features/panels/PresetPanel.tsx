import { useEffect, useState } from 'react';
import {
  applyValuePatch,
  createDefaultParams,
  defaultCurve,
  type AiStatus,
  type Preset,
  type Project,
} from '@photomaster/shared';
import { api } from '../../api/client.ts';
import { useEditor } from '../../state/editorStore.ts';
import { toastError, useToasts } from '../../state/toastStore.ts';
import { IconSparkle } from '../../ui/Icons.tsx';
import './panels.css';

interface PresetPanelProps {
  project: Project;
  aiStatus: AiStatus;
  onProjectUpdate: (project: Project) => void;
}

/**
 * Preset-Bibliothek (§15).
 *
 * Presets sind hier ausdrücklich keine Filter. Es gibt zwei Wege, sie
 * anzuwenden, und der Unterschied ist für das Ergebnis erheblich:
 *
 *  - **Direkt**: die hinterlegten Werte, unverändert. Vorhersehbar und sofort.
 *  - **Angepasst**: Die KI bekommt die Preset-Werte als Ausgangspunkt und
 *    verschiebt sie anhand der Messwerte dieses Fotos. Ein Preset mit
 *    `highlights: −35` nimmt bei einem unauffälligen Himmel weniger zurück.
 *
 * Ohne eingerichtete KI bleibt der direkte Weg — und wird als das benannt,
 * was er ist.
 */
export function PresetPanel({ project, aiStatus, onProjectUpdate }: PresetPanelProps) {
  const [groups, setGroups] = useState<{ category: string; presets: Preset[] }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);

  const params = useEditor((s) => s.params);
  const applyParams = useEditor((s) => s.applyParams);
  const markSaved = useEditor((s) => s.markSaved);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    api
      .presets()
      .then((r) => setGroups(r.categories))
      .catch((err) => toastError(err, 'Die Presets konnten nicht geladen werden.'));
  }, []);

  /** Direktes Anwenden: Standardwerte + die Preset-Werte, sonst nichts. */
  const applyDirect = (preset: Preset) => {
    const base = createDefaultParams();
    const next = applyValuePatch(base, preset.values);
    if (preset.curve) {
      next.curves = {
        rgb: preset.curve.map((p) => ({ ...p })),
        r: defaultCurve(),
        g: defaultCurve(),
        b: defaultCurve(),
      };
    }
    applyParams(next, `Preset: ${preset.name}`);
    setAppliedId(preset.id);
  };

  const applyWithAi = async (preset: Preset) => {
    if (busyId) return;
    setBusyId(preset.id);
    try {
      await api.saveParams(project.id, params);
      markSaved();
      const response = await api.aiEdit(project.id, { mode: 'preset', presetId: preset.id });
      applyParams(response.result.params, `Preset: ${preset.name}`);
      markSaved();
      onProjectUpdate(response.project);
      setAppliedId(preset.id);
      if (response.result.rationale.summary) {
        push('info', `${preset.name} angepasst`, response.result.rationale.summary);
      }
    } catch (err) {
      toastError(err, 'Das Preset konnte nicht angepasst werden.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel__head">
        <h3 className="section-title">Presets</h3>
      </div>

      <div className="panel__body">
        <p className="panel__hint" style={{ marginBottom: 'var(--space-4)' }}>
          {aiStatus.available
            ? 'Klicken übernimmt die Werte direkt. Mit dem Stern-Symbol passt die KI sie an dieses Foto an.'
            : 'Die Werte werden direkt übernommen und können anschließend von Hand nachjustiert werden.'}
        </p>

        {groups.map((group) => (
          <div className="preset-group" key={group.category}>
            <h4 className="preset-group__title">{group.category}</h4>
            <div className="preset-list">
              {group.presets.map((preset) => (
                <div
                  key={preset.id}
                  className={`preset ${appliedId === preset.id ? 'is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="grow"
                    style={{ textAlign: 'left' }}
                    onClick={() => applyDirect(preset)}
                    disabled={busyId !== null}
                  >
                    <div className="preset__name">{preset.name}</div>
                    <div className="preset__desc">{preset.description}</div>
                  </button>

                  {aiStatus.available && (
                    <button
                      type="button"
                      className="preset__ai"
                      title={`${preset.name} von der KI an dieses Foto anpassen lassen`}
                      aria-label={`${preset.name} an dieses Foto anpassen`}
                      disabled={busyId !== null}
                      onClick={() => void applyWithAi(preset)}
                    >
                      {busyId === preset.id ? (
                        <span className="preset__spinner" />
                      ) : (
                        <IconSparkle size={15} />
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
