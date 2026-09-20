import {
  MAX_BRUSH_MASKS,
  MAX_MASKS,
  changedMaskParams,
  countStrokePoints,
  describeMask,
  localParamDefs,
  type LocalMask,
  type ParamDef,
} from '@photomaster/shared';
import { useEditor } from '../../state/editorStore.ts';
import { Button, IconButton } from '../../ui/Button.tsx';
import { Slider } from '../../ui/Slider.tsx';
import { IconBrush, IconLayers, IconPlus, IconReset, IconTrash } from '../../ui/Icons.tsx';
import './panels.css';
import './MasksPanel.css';

/**
 * Geometrie-Regler.
 *
 * Sie sind keine Bearbeitungsparameter und stehen deshalb nicht in der
 * Registry — aber sie benutzen dieselbe Slider-Komponente, damit sie sich
 * genauso bedienen lassen (Feinjustierung mit Umschalt, Zurücksetzen per
 * Doppelklick, Tastaturbedienung).
 */
const GEO: Record<string, ParamDef> = {
  angle: {
    id: 'angle', label: 'Winkel', group: 'effects', min: 0, max: 360, step: 1,
    default: 0, unit: '°', wrap: true, ai: false,
    hint: 'Richtung des Verlaufs. 0° wirkt oben im Bild.',
  },
  position: {
    id: 'position', label: 'Position', group: 'effects', min: 0, max: 1, step: 0.01,
    default: 0.45, ai: false, hint: 'Wo der Übergang liegt.',
  },
  feather: {
    id: 'feather', label: 'Weichheit', group: 'effects', min: 0, max: 1, step: 0.01,
    default: 0.35, ai: false, hint: 'Breite des weichen Übergangs.',
  },
  centerX: {
    id: 'centerX', label: 'Mitte horizontal', group: 'effects', min: 0, max: 1, step: 0.01,
    default: 0.5, ai: false, hint: 'Waagerechte Lage des Mittelpunkts.',
  },
  centerY: {
    id: 'centerY', label: 'Mitte vertikal', group: 'effects', min: 0, max: 1, step: 0.01,
    default: 0.5, ai: false, hint: 'Senkrechte Lage des Mittelpunkts.',
  },
  radiusX: {
    id: 'radiusX', label: 'Breite', group: 'effects', min: 0.02, max: 1.5, step: 0.01,
    default: 0.3, ai: false, hint: 'Halbe Breite der Ellipse, als Anteil der Bildbreite.',
  },
  radiusY: {
    id: 'radiusY', label: 'Höhe', group: 'effects', min: 0.02, max: 1.5, step: 0.01,
    default: 0.3, ai: false, hint: 'Halbe Höhe der Ellipse, als Anteil der Bildhöhe.',
  },
  strength: {
    id: 'strength', label: 'Stärke', group: 'effects', min: 0, max: 100, step: 1,
    default: 100, ai: false, hint: 'Skaliert alle Anpassungen dieser Maske gemeinsam.',
  },
  lumMin: {
    id: 'lumMin', label: 'Von', group: 'effects', min: 0, max: 1, step: 0.01,
    default: 0, ai: false, hint: 'Untere Helligkeitsgrenze.',
  },
  lumMax: {
    id: 'lumMax', label: 'Bis', group: 'effects', min: 0, max: 1, step: 0.01,
    default: 1, ai: false, hint: 'Obere Helligkeitsgrenze.',
  },
  lumFeather: {
    id: 'lumFeather', label: 'Übergang', group: 'effects', min: 0, max: 1, step: 0.01,
    default: 0.25, ai: false, hint: 'Weichheit der Helligkeitsgrenzen.',
  },
  hue: {
    id: 'hue', label: 'Farbton', group: 'effects', min: 0, max: 360, step: 1,
    default: 30, unit: '°', wrap: true, ai: false, hint: 'Welcher Farbton getroffen wird.',
  },
  tolerance: {
    id: 'tolerance', label: 'Toleranz', group: 'effects', min: 1, max: 100, step: 1,
    default: 25, ai: false, hint: 'Wie weit um den Farbton herum noch erfasst wird.',
  },
  brushRadius: {
    id: 'brushRadius', label: 'Größe', group: 'effects', min: 0.005, max: 0.4, step: 0.005,
    default: 0.06, ai: false, hint: 'Pinselradius als Anteil der langen Bildkante.',
  },
  brushHardness: {
    id: 'brushHardness', label: 'Härte', group: 'effects', min: 0, max: 1, step: 0.01,
    default: 0.5, ai: false, hint: '0 läuft weich aus, 1 setzt eine scharfe Kante.',
  },
  brushOpacity: {
    id: 'brushOpacity', label: 'Deckkraft', group: 'effects', min: 0.05, max: 1, step: 0.01,
    default: 1, ai: false, hint: 'Wie stark ein Strich die Maske deckt.',
  },
};

/**
 * Lokale Masken (§28).
 *
 * Aufbau in der Reihenfolge, in der man arbeitet: Maske anlegen → auf dem Bild
 * hinschieben → bei Bedarf nach Helligkeit oder Farbe verfeinern → anpassen.
 *
 * Solange eine Maske ausgewählt ist, liegt sie als roter Schleier über dem
 * Bild. Das ist keine Spielerei: Eine weiche Maske ist sonst nicht einstellbar,
 * weil man zwar ihre Wirkung sieht, aber nicht ihre Form — und bei einem
 * schwachen Ergebnis nicht weiß, ob die Anpassung zu klein oder die Maske am
 * falschen Ort ist.
 */
export function MasksPanel() {
  const masks = useEditor((s) => s.params.masks);
  const selectedId = useEditor((s) => s.selectedMaskId);
  const selectMask = useEditor((s) => s.selectMask);
  const addMask = useEditor((s) => s.addMask);
  const removeMask = useEditor((s) => s.removeMask);
  const duplicateMask = useEditor((s) => s.duplicateMask);
  const updateMask = useEditor((s) => s.updateMask);
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  const clearStrokes = useEditor((s) => s.clearStrokes);
  const updateMaskCommitted = useEditor((s) => s.updateMaskCommitted);
  const setMaskValue = useEditor((s) => s.setMaskValue);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);

  const selected = masks.find((m) => m.id === selectedId) ?? null;
  const full = masks.length >= MAX_MASKS;
  // Pinselmasken sind zusätzlich begrenzt: Alle vier teilen sich die Kanäle
  // einer einzigen Textur (siehe MAX_BRUSH_MASKS).
  const brushCount = masks.filter((m) => m.type === 'brush').length;
  const brushFull = brushCount >= MAX_BRUSH_MASKS;

  /** Werkzeugregler des Pinsels — sie gehören nicht zur Maske. */
  const toolSlider = (def: ParamDef, value: number, apply: (v: number) => void) => (
    <Slider
      key={def.id}
      def={def}
      value={value}
      onChange={apply}
      onReset={() => apply(def.default)}
    />
  );

  /** Geometrie-Regler: live ändern, beim Loslassen ein Verlaufseintrag. */
  const geoSlider = (mask: LocalMask, def: ParamDef, value: number, apply: (v: number) => Partial<LocalMask>) => (
    <Slider
      key={def.id}
      def={def}
      value={value}
      onChange={(v) => updateMask(mask.id, apply(v))}
      onGestureStart={() => beginGesture(`${mask.name}: ${def.label}`)}
      onGestureEnd={endGesture}
      onReset={() => updateMaskCommitted(mask.id, apply(def.default), `${mask.name}: ${def.label}`)}
    />
  );

  return (
    <div className="panel">
      <div className="panel__head">
        <h3 className="section-title">Lokale Masken</h3>
        {selected && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectMask(null)}
            title="Maskenvorschau ausblenden"
          >
            Fertig
          </Button>
        )}
      </div>

      <div className="panel__body">
        <div className="mask-add">
          <Button
            variant="secondary"
            size="sm"
            icon={<IconPlus size={14} />}
            disabled={full}
            onClick={() => addMask('linear')}
          >
            Verlauf
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<IconPlus size={14} />}
            disabled={full}
            onClick={() => addMask('radial')}
          >
            Radial
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<IconBrush size={14} />}
            disabled={full || brushFull}
            title={brushFull ? `Höchstens ${MAX_BRUSH_MASKS} Pinselmasken möglich` : undefined}
            onClick={() => addMask('brush')}
          >
            Pinsel
          </Button>
        </div>

        {full && (
          <p className="panel__hint" style={{ marginTop: 6 }}>
            Mehr als {MAX_MASKS} Masken sind nicht möglich.
          </p>
        )}
        {!full && brushFull && (
          <p className="panel__hint" style={{ marginTop: 6 }}>
            Mehr als {MAX_BRUSH_MASKS} Pinselmasken sind nicht möglich — Verlauf
            und Radial gehen weiterhin.
          </p>
        )}

        {masks.length === 0 ? (
          <div className="panel__empty">
            <IconLayers size={24} style={{ opacity: 0.4 }} />
            <p style={{ marginTop: 'var(--space-2)' }}>
              Noch keine Maske. Ein Verlauf dunkelt typischerweise den Himmel ab,
              eine radiale Maske hebt das Motiv hervor.
            </p>
          </div>
        ) : (
          <div className="mask-list">
            {masks.map((mask) => {
              const isSelected = mask.id === selectedId;
              return (
                <div key={mask.id} className={`mask ${isSelected ? 'is-selected' : ''}`}>
                  <button
                    type="button"
                    className="mask__toggle"
                    role="switch"
                    aria-checked={mask.enabled}
                    aria-label={`${mask.name} ${mask.enabled ? 'deaktivieren' : 'aktivieren'}`}
                    title={mask.enabled ? 'Maske deaktivieren' : 'Maske aktivieren'}
                    onClick={() =>
                      updateMaskCommitted(
                        mask.id,
                        { enabled: !mask.enabled },
                        `${mask.name} ${mask.enabled ? 'aus' : 'ein'}`,
                      )
                    }
                  >
                    <span className={`mask__dot ${mask.enabled ? 'is-on' : ''}`} />
                  </button>

                  <button
                    type="button"
                    className="mask__main"
                    onClick={() => selectMask(isSelected ? null : mask.id)}
                  >
                    <span className="mask__name">{mask.name}</span>
                    <span className="mask__meta">{describeMask(mask)}</span>
                  </button>

                  <IconButton
                    label={`${mask.name} duplizieren`}
                    icon={<IconPlus size={13} />}
                    size="sm"
                    disabled={full}
                    onClick={() => duplicateMask(mask.id)}
                  />
                  <IconButton
                    label={`${mask.name} löschen`}
                    icon={<IconTrash size={13} />}
                    size="sm"
                    onClick={() => removeMask(mask.id)}
                  />
                </div>
              );
            })}
          </div>
        )}

        {selected && (
          <div className="mask-editor">
            <div className="mask-editor__head">
              <input
                className="mask-editor__name"
                value={selected.name}
                aria-label="Name der Maske"
                onChange={(e) => updateMask(selected.id, { name: e.target.value })}
                onBlur={(e) =>
                  updateMaskCommitted(
                    selected.id,
                    { name: e.target.value.trim() || 'Maske' },
                    'Maske umbenannt',
                  )
                }
              />
              <button
                type="button"
                className={`mask-editor__invert ${selected.inverted ? 'is-on' : ''}`}
                onClick={() =>
                  updateMaskCommitted(
                    selected.id,
                    { inverted: !selected.inverted },
                    `${selected.name} umgekehrt`,
                  )
                }
                title="Kehrt die Maske um — aus dem Bereich wird alles außerhalb davon"
              >
                Umkehren
              </button>
            </div>

            <p className="panel__hint" style={{ marginBottom: 'var(--space-2)' }}>
              {selected.type === 'brush'
                ? 'Der rote Bereich zeigt, wo die Maske wirkt. Male direkt auf dem Bild.'
                : 'Der rote Bereich zeigt, wo die Maske wirkt. Auf dem Bild lässt sie sich direkt verschieben und in der Größe verändern.'}
            </p>

            {selected.type === 'brush' ? (
              <div className="panel__section">
                <div className="spread" style={{ marginBottom: 'var(--space-2)' }}>
                  <h4 className="panel__section-title" style={{ margin: 0 }}>
                    Pinsel
                  </h4>
                  <button
                    type="button"
                    className={`mask-editor__invert ${brush.erase ? 'is-on' : ''}`}
                    onClick={() => setBrush({ erase: !brush.erase })}
                    title="Nimmt Maskenfläche weg, statt sie hinzuzufügen (oder Alt gedrückt halten)"
                  >
                    Radieren
                  </button>
                </div>

                {toolSlider(GEO.brushRadius, brush.radius, (v) => setBrush({ radius: v }))}
                {toolSlider(GEO.brushHardness, brush.hardness, (v) => setBrush({ hardness: v }))}
                {toolSlider(GEO.brushOpacity, brush.opacity, (v) => setBrush({ opacity: v }))}
                {geoSlider(selected, GEO.strength, selected.strength, (v) => ({ strength: v }))}

                <p className="panel__hint" style={{ marginTop: 'var(--space-2)' }}>
                  Größe, Härte und Deckkraft gelten für den NÄCHSTEN Strich —
                  bereits gemalte Striche behalten ihre Einstellung, wie bei
                  einem echten Pinsel. Alt gedrückt halten radiert vorübergehend.
                </p>

                {selected.strokes.length > 0 && (
                  <div className="spread" style={{ marginTop: 'var(--space-3)' }}>
                    <span className="panel__hint">
                      {selected.strokes.length}{' '}
                      {selected.strokes.length === 1 ? 'Strich' : 'Striche'} ·{' '}
                      {countStrokePoints(selected)} Punkte
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconReset size={13} />}
                      onClick={() => clearStrokes(selected.id)}
                    >
                      Leeren
                    </Button>
                  </div>
                )}
              </div>
            ) : (
            <div className="panel__section">
              <h4 className="panel__section-title">Form</h4>
              {selected.type === 'linear' ? (
                <>
                  {geoSlider(selected, GEO.angle, selected.angle, (v) => ({ angle: v }))}
                  {geoSlider(selected, GEO.position, selected.position, (v) => ({ position: v }))}
                </>
              ) : (
                <>
                  {geoSlider(selected, GEO.centerX, selected.centerX, (v) => ({ centerX: v }))}
                  {geoSlider(selected, GEO.centerY, selected.centerY, (v) => ({ centerY: v }))}
                  {geoSlider(selected, GEO.radiusX, selected.radiusX, (v) => ({ radiusX: v }))}
                  {geoSlider(selected, GEO.radiusY, selected.radiusY, (v) => ({ radiusY: v }))}
                  {geoSlider(selected, GEO.angle, selected.angle, (v) => ({ angle: v }))}
                </>
              )}
              {geoSlider(selected, GEO.feather, selected.feather, (v) => ({ feather: v }))}
              {geoSlider(selected, GEO.strength, selected.strength, (v) => ({ strength: v }))}
            </div>
            )}

            <div className="panel__section">
              <label className="pm-check">
                <input
                  type="checkbox"
                  checked={selected.luminanceRange.active}
                  onChange={(e) =>
                    updateMaskCommitted(
                      selected.id,
                      { luminanceRange: { ...selected.luminanceRange, active: e.target.checked } },
                      'Luminanzbereich',
                    )
                  }
                />
                <span>
                  Nach Helligkeit verfeinern
                  <em>Trennt den hellen Himmel vom dunklen Baum davor.</em>
                </span>
              </label>

              {selected.luminanceRange.active && (
                <>
                  {geoSlider(selected, GEO.lumMin, selected.luminanceRange.min, (v) => ({
                    luminanceRange: { ...selected.luminanceRange, min: v },
                  }))}
                  {geoSlider(selected, GEO.lumMax, selected.luminanceRange.max, (v) => ({
                    luminanceRange: { ...selected.luminanceRange, max: v },
                  }))}
                  {geoSlider(selected, GEO.lumFeather, selected.luminanceRange.feather, (v) => ({
                    luminanceRange: { ...selected.luminanceRange, feather: v },
                  }))}
                </>
              )}
            </div>

            <div className="panel__section">
              <label className="pm-check">
                <input
                  type="checkbox"
                  checked={selected.colorRange.active}
                  onChange={(e) =>
                    updateMaskCommitted(
                      selected.id,
                      { colorRange: { ...selected.colorRange, active: e.target.checked } },
                      'Farbbereich',
                    )
                  }
                />
                <span>
                  Nach Farbe verfeinern
                  <em>Trifft nur Bildbereiche mit einem bestimmten Farbton.</em>
                </span>
              </label>

              {selected.colorRange.active && (
                <>
                  <div
                    className="mask-hue-preview"
                    style={{ background: `hsl(${selected.colorRange.hue} 70% 50%)` }}
                    aria-hidden="true"
                  />
                  {geoSlider(selected, GEO.hue, selected.colorRange.hue, (v) => ({
                    colorRange: { ...selected.colorRange, hue: v },
                  }))}
                  {geoSlider(selected, GEO.tolerance, selected.colorRange.tolerance, (v) => ({
                    colorRange: { ...selected.colorRange, tolerance: v },
                  }))}
                </>
              )}
            </div>

            <div className="panel__section">
              <div className="spread" style={{ marginBottom: 'var(--space-1)' }}>
                <h4 className="panel__section-title" style={{ margin: 0 }}>
                  Anpassungen
                </h4>
                {changedMaskParams(selected).length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconReset size={13} />}
                    onClick={() => {
                      const values = { ...selected.values };
                      for (const def of localParamDefs()) values[def.id] = def.default;
                      updateMaskCommitted(selected.id, { values }, `${selected.name} zurückgesetzt`);
                    }}
                  >
                    Zurücksetzen
                  </Button>
                )}
              </div>

              {localParamDefs().map((def) => (
                <Slider
                  key={def.id}
                  def={def}
                  value={selected.values[def.id] ?? def.default}
                  onChange={(v) => setMaskValue(selected.id, def.id, v)}
                  onGestureStart={() => beginGesture(`${selected.name}: ${def.label}`)}
                  onGestureEnd={endGesture}
                  onReset={() => {
                    beginGesture(`${selected.name}: ${def.label}`);
                    setMaskValue(selected.id, def.id, def.default);
                    endGesture();
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
