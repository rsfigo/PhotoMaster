/**
 * Reglerpanel für eine Parametergruppe.
 *
 * Es gibt bewusst KEINE eigene Komponente je Gruppe: Aufbau, Beschriftung,
 * Wertebereich und Schrittweite kommen vollständig aus der Parameter-Registry
 * (ARCHITECTURE.md §6). "Licht", "Farbe", "Details" und "Effekte" sind
 * derselbe Code mit einem anderen Gruppennamen — ein neuer Regler erscheint
 * hier automatisch, sobald er in der Registry steht.
 */

import { GROUP_LABELS, sectionsInGroup, type ParamGroup } from '@photomaster/shared';
import { useEditor } from '../../state/editorStore.ts';
import { Slider } from '../../ui/Slider.tsx';
import { Button } from '../../ui/Button.tsx';
import { IconReset } from '../../ui/Icons.tsx';
import './panels.css';

interface AdjustPanelProps {
  group: ParamGroup;
  /** Zusätzlicher Inhalt unter den Reglern (z. B. der Kurveneditor). */
  children?: React.ReactNode;
}

export function AdjustPanel({ group, children }: AdjustPanelProps) {
  const values = useEditor((s) => s.params.values);
  const setValue = useEditor((s) => s.setValue);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);
  const resetParam = useEditor((s) => s.resetParam);
  const resetGroup = useEditor((s) => s.resetGroup);

  const sections = sectionsInGroup(group);
  const anyChanged = sections.some((section) =>
    section.params.some((p) => Math.abs((values[p.id] ?? p.default) - p.default) >= p.step / 2),
  );

  return (
    <div className="panel">
      <div className="panel__head">
        <h3 className="section-title">{GROUP_LABELS[group]}</h3>
        {anyChanged && (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconReset size={13} />}
            onClick={() => resetGroup(group)}
          >
            Zurücksetzen
          </Button>
        )}
      </div>

      <div className="panel__body">
        {sections.map((section, index) => (
          <div className="panel__section" key={section.section ?? `_${index}`}>
            {section.section && <h4 className="panel__section-title">{section.section}</h4>}
            {section.params.map((def) => (
              <Slider
                key={def.id}
                def={def}
                value={values[def.id] ?? def.default}
                onChange={(v) => setValue(def.id, v)}
                onGestureStart={() => beginGesture(def.label)}
                onGestureEnd={endGesture}
                onReset={() => resetParam(def.id)}
              />
            ))}
          </div>
        ))}
        {children}
      </div>
    </div>
  );
}
