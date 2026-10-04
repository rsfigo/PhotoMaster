import { useState } from 'react';
import { PARAM_BY_ID, type AiEditResult, type AiStatus, type ChatTurn, type Project } from '@photomaster/shared';
import { api } from '../../api/client.ts';
import { useEditor } from '../../state/editorStore.ts';
import { toastError, useToasts } from '../../state/toastStore.ts';
import { Button } from '../../ui/Button.tsx';
import { IconInfo, IconSparkle, IconWarn } from '../../ui/Icons.tsx';
import './AiPanel.css';

interface AiPanelProps {
  project: Project;
  aiStatus: AiStatus;
  onProjectUpdate: (project: Project) => void;
}

const SUGGESTIONS = [
  'Cinematic, dunkel und etwas kälter',
  'Warmer Sonnenuntergang, aber natürlich',
  'Moody Automotive — Lack soll plastisch wirken',
  'Clean und professionell, keine Effekte',
  'Filmlook mit angehobenen Schwarztönen',
];

/**
 * Vibe-Editor (§9) und AI AUTO (§14).
 *
 * Der Gesprächsverlauf wird bei jeder Anfrage mitgeschickt (§27). Dadurch
 * versteht "mach es etwas heller" als Folgeeingabe, worauf es sich bezieht,
 * und die KI setzt auf der bestehenden Bearbeitung auf, statt neu anzufangen.
 */
export function AiPanel({ project, aiStatus, onProjectUpdate }: AiPanelProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'auto' | 'vibe' | 'scene'>(null);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [result, setResult] = useState<AiEditResult | null>(null);
  const [showReasons, setShowReasons] = useState(false);

  const params = useEditor((s) => s.params);
  const applyParams = useEditor((s) => s.applyParams);
  const markSaved = useEditor((s) => s.markSaved);
  const push = useToasts((s) => s.push);

  const run = async (mode: 'auto' | 'vibe', instruction?: string) => {
    if (busy) return;
    setBusy(mode);
    try {
      // Den aktuellen Stand zuerst sichern: Die KI arbeitet serverseitig auf
      // den GESPEICHERTEN Parametern. Ohne diesen Schritt würde sie auf einem
      // veralteten Stand aufsetzen, sobald noch ungespeicherte Regleränderungen
      // offen sind — und der Nutzer bekäme ein Ergebnis, das seine letzten
      // Handgriffe stillschweigend verwirft.
      await api.saveParams(project.id, params);
      markSaved(params);

      const response = await api.aiEdit(project.id, {
        mode,
        text: instruction,
        history,
      });

      applyParams(response.result.params, mode === 'auto' ? 'KI-Automatik' : 'KI-Bearbeitung');
      markSaved();
      onProjectUpdate(response.project);
      setResult(response.result);
      setShowReasons(true);

      setHistory((prev) => [
        ...prev,
        { role: 'user', content: instruction ?? 'Erstelle eine natürliche Grundbearbeitung.' },
        { role: 'assistant', content: response.result.rationale.summary },
      ]);

      if (response.result.issues.length > 0) {
        push(
          'info',
          'Die KI-Antwort wurde korrigiert.',
          response.result.issues.slice(0, 3).join(' '),
        );
      }
      setText('');
    } catch (err) {
      toastError(err, 'Die KI-Bearbeitung ist fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  };

  const analyzeScene = async () => {
    if (busy) return;
    setBusy('scene');
    try {
      const response = await api.aiScene(project.id);
      onProjectUpdate({ ...project, analysis: response.analysis });
    } catch (err) {
      toastError(err, 'Die Bildanalyse ist fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  };

  if (!aiStatus.available) {
    return (
      <div className="panel">
        <div className="panel__head">
          <h3 className="section-title">KI-Bearbeitung</h3>
        </div>
        <div className="panel__body">
          <div className="notice notice--warn">
            <IconWarn size={15} className="notice__icon" />
            <div>
              <strong>Nicht eingerichtet</strong>
              <p style={{ marginTop: 4 }}>{aiStatus.reason}</p>
            </div>
          </div>
          <p className="panel__hint" style={{ marginTop: 'var(--space-3)' }}>
            Alle Regler, Presets, Versionen und der Export in voller Auflösung
            funktionieren unabhängig davon.
          </p>
        </div>
      </div>
    );
  }

  const scene = project.analysis?.scene;

  return (
    <div className="panel">
      <div className="panel__head">
        <h3 className="section-title">KI-Bearbeitung</h3>
      </div>

      <div className="panel__body">
        <Button
          variant="primary"
          block
          icon={<IconSparkle size={16} />}
          busy={busy === 'auto'}
          disabled={busy !== null}
          onClick={() => run('auto')}
        >
          Automatisch bearbeiten
        </Button>
        <p className="panel__hint" style={{ marginTop: 6, marginBottom: 'var(--space-4)' }}>
          Eine natürliche Grundbearbeitung ohne Stil — wie ein Fotograf sie nach
          dem Import anlegt.
        </p>

        <label className="ai__label" htmlFor="vibe-input">
          Welchen Look möchtest du?
        </label>
        <textarea
          id="vibe-input"
          className="ai__input"
          rows={3}
          value={text}
          placeholder={
            history.length > 0
              ? 'Weiter anpassen, z. B. „etwas heller" oder „die Farben kräftiger"'
              : 'Beschreibe den gewünschten Look in eigenen Worten …'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Strg/Cmd+Enter sendet — Enter allein macht eine neue Zeile,
            // damit mehrzeilige Beschreibungen möglich bleiben.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
              e.preventDefault();
              void run('vibe', text.trim());
            }
          }}
          disabled={busy !== null}
        />

        <Button
          variant="secondary"
          block
          busy={busy === 'vibe'}
          disabled={busy !== null || text.trim().length === 0}
          onClick={() => run('vibe', text.trim())}
          style={{ marginTop: 'var(--space-2)' }}
        >
          Anwenden
        </Button>

        {history.length === 0 && (
          <div className="ai__suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="ai__chip"
                disabled={busy !== null}
                onClick={() => void run('vibe', s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {history.length > 0 && (
          <div className="ai__history">
            <div className="spread" style={{ marginBottom: 'var(--space-2)' }}>
              <span className="section-title">Verlauf</span>
              <button type="button" className="ai__link" onClick={() => setHistory([])}>
                Neu beginnen
              </button>
            </div>
            {history.map((turn, i) => (
              <div key={i} className={`ai__turn ai__turn--${turn.role}`}>
                {turn.content}
              </div>
            ))}
          </div>
        )}

        {/* „Warum diese Bearbeitung?" — §16 */}
        {result && result.rationale.reasons.length > 0 && (
          <div className="ai__reasons">
            <button
              type="button"
              className="ai__reasons-toggle"
              onClick={() => setShowReasons((v) => !v)}
              aria-expanded={showReasons}
            >
              <IconInfo size={14} />
              Warum diese Bearbeitung? ({result.rationale.reasons.length})
            </button>
            {showReasons && (
              <ul className="ai__reason-list">
                {result.rationale.reasons.map((reason, i) => (
                  <li key={i}>
                    <span className="ai__reason-param">
                      {/* Bei einer lokalen Anpassung muss der Bildbereich
                          dabeistehen — sonst liest sich "Belichtung −0,6" wie
                          eine globale Änderung, die es nicht gab. */}
                      {reason.mask && <span className="ai__reason-mask">{reason.mask}</span>}
                      {PARAM_BY_ID.get(reason.param)?.label ?? reason.param}
                    </span>
                    <span className="ai__reason-text">{reason.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Bildinhalt (§8) */}
        <div className="ai__scene">
          {scene ? (
            <>
              <div className="spread" style={{ marginBottom: 'var(--space-2)' }}>
                <span className="section-title">Bildinhalt</span>
              </div>
              <p className="ai__scene-subject">{scene.subject}</p>
              <div className="ai__tags">
                {scene.categories.map((c) => (
                  <span key={c} className="ai__tag">
                    {c}
                  </span>
                ))}
              </div>
              <ul className="ai__observations">
                {scene.observations.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              block
              busy={busy === 'scene'}
              disabled={busy !== null}
              onClick={analyzeScene}
            >
              Bildinhalt analysieren
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
