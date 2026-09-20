import { useState } from 'react';
import { HSL_BANDS, PARAM_BY_ID, type HslBandKey } from '@photomaster/shared';
import { useEditor } from '../../state/editorStore.ts';
import { Slider } from '../../ui/Slider.tsx';
import { Button } from '../../ui/Button.tsx';
import { IconReset } from '../../ui/Icons.tsx';
import './panels.css';

/**
 * HSL-Farbmischer (§13).
 *
 * Acht Bänder × drei Werte sind 24 Regler. Alle gleichzeitig zu zeigen wäre
 * eine Wand aus Schiebereglern, in der man den gesuchten Farbton nicht findet.
 * Stattdessen wählt man erst die Farbe (als Farbfläche, nicht als Wort) und
 * sieht dann deren drei Werte. Bänder mit Änderungen bekommen einen Punkt,
 * damit nichts unbemerkt verstellt bleibt.
 */
export function HslPanel() {
  const [band, setBand] = useState<HslBandKey>('Orange');
  const values = useEditor((s) => s.params.values);
  const setValue = useEditor((s) => s.setValue);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);
  const resetParam = useEditor((s) => s.resetParam);
  const resetGroup = useEditor((s) => s.resetGroup);

  const bandChanged = (key: HslBandKey): boolean =>
    (['Hue', 'Sat', 'Lum'] as const).some((suffix) => (values[`hsl${key}${suffix}`] ?? 0) !== 0);

  const anyChanged = HSL_BANDS.some((b) => bandChanged(b.key));
  const active = HSL_BANDS.find((b) => b.key === band)!;

  return (
    <div className="panel">
      <div className="panel__head">
        <h3 className="section-title">HSL / Farbmischer</h3>
        {anyChanged && (
          <Button variant="ghost" size="sm" icon={<IconReset size={13} />} onClick={() => resetGroup('hsl')}>
            Zurücksetzen
          </Button>
        )}
      </div>

      <div className="panel__body">
        <div className="hsl-bands" role="tablist" aria-label="Farbkanal wählen">
          {HSL_BANDS.map((b) => (
            <button
              key={b.key}
              type="button"
              role="tab"
              aria-selected={b.key === band}
              aria-label={b.label}
              title={b.label}
              className={`hsl-band ${b.key === band ? 'is-active' : ''} ${bandChanged(b.key) ? 'is-changed' : ''}`}
              style={{ background: `hsl(${b.center} 72% 52%)` }}
              onClick={() => setBand(b.key)}
            />
          ))}
        </div>

        <div className="panel__section-title" style={{ marginBottom: 0 }}>
          {active.label}
        </div>

        {(['Hue', 'Sat', 'Lum'] as const).map((suffix) => {
          const id = `hsl${band}${suffix}`;
          const def = PARAM_BY_ID.get(id);
          if (!def) return null;
          return (
            <Slider
              key={id}
              def={def}
              value={values[id] ?? 0}
              onChange={(v) => setValue(id, v)}
              onGestureStart={() => beginGesture(`${active.label} ${def.label}`)}
              onGestureEnd={endGesture}
              onReset={() => resetParam(id)}
            />
          );
        })}

        <p className="panel__hint" style={{ marginTop: 'var(--space-3)' }}>
          Wirkt nur auf Bildbereiche mit diesem Farbton. Graue und nahezu
          farblose Flächen bleiben unberührt.
        </p>
      </div>
    </div>
  );
}
