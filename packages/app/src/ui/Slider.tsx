import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react';
import { formatParamValue, isDefaultValue, type ParamDef } from '@photomaster/shared';
import { IconReset } from './Icons.tsx';
import './Slider.css';

interface SliderProps {
  def: ParamDef;
  value: number;
  onChange: (value: number) => void;
  /** Beginn/Ende einer zusammenhängenden Geste — erzeugt EINEN Verlaufsschritt. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onReset?: () => void;
}

export function Slider({ def, value, onChange, onGestureStart, onGestureEnd, onReset }: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /** Ausgangspunkt für die Feinjustierung mit gedrückter Umschalttaste. */
  const fineOrigin = useRef<{ x: number; value: number } | null>(null);

  const changed = !isDefaultValue(def.id, value);
  const span = def.max - def.min;
  const fraction = (value - def.min) / span;
  const defaultFraction = (def.default - def.min) / span;

  const valueFromEvent = useCallback(
    (event: { clientX: number; shiftKey: boolean }): number => {
      const track = trackRef.current;
      if (!track) return value;
      const rect = track.getBoundingClientRect();

      if (event.shiftKey && fineOrigin.current) {
        // Feinjustierung: Mausbewegung wirkt nur zu einem Viertel.
        const delta = ((event.clientX - fineOrigin.current.x) / rect.width) * span * 0.25;
        return fineOrigin.current.value + delta;
      }

      const t = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      return def.min + t * span;
    },
    [def.min, span, value],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // preventDefault unterbindet Textauswahl beim Ziehen — nimmt dem Element
    // aber auch den Fokus, den ein Klick sonst automatisch setzt. Ohne das
    // ausdrückliche focus() hier könnte man einen Regler anklicken und
    // anschließend nicht mit den Pfeiltasten feinjustieren.
    event.preventDefault();
    trackRef.current?.focus();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    fineOrigin.current = { x: event.clientX, value };
    setDragging(true);
    onGestureStart?.();
    // Beim Anfassen nicht springen, wenn mit Umschalt feinjustiert wird.
    if (!event.shiftKey) onChange(valueFromEvent(event));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    // Wechselt der Nutzer mitten in der Geste auf Feinjustierung, wird der
    // Bezugspunkt neu gesetzt — sonst springt der Wert beim Drücken von Shift.
    if (event.shiftKey && (!fineOrigin.current || fineOrigin.current.value !== value)) {
      fineOrigin.current = { x: event.clientX, value };
    }
    onChange(valueFromEvent(event));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    setDragging(false);
    fineOrigin.current = null;
    onGestureEnd?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const big = event.shiftKey ? 10 : 1;
    let next: number | null = null;

    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value - def.step * big;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = value + def.step * big;
        break;
      case 'Home':
        next = def.min;
        break;
      case 'End':
        next = def.max;
        break;
      case 'Backspace':
      case 'Delete':
        next = def.default;
        break;
      default:
        return;
    }

    event.preventDefault();
    onGestureStart?.();
    onChange(next);
    onGestureEnd?.();
  };

  // Der gefüllte Abschnitt läuft bei bipolaren Reglern vom Nullpunkt aus, nicht
  // vom linken Rand. Nur so ist auf einen Blick erkennbar, in welche Richtung
  // und wie weit ein Wert verschoben wurde.
  const fillStart = def.bipolar ? Math.min(fraction, defaultFraction) : 0;
  const fillEnd = def.bipolar ? Math.max(fraction, defaultFraction) : fraction;

  return (
    <div className={`slider ${dragging ? 'is-dragging' : ''} ${changed ? 'is-changed' : ''}`}>
      <div className="slider__head">
        <span className="slider__label" title={def.hint}>
          {def.label}
        </span>
        <span className="slider__actions">
          {changed && onReset && (
            <button
              type="button"
              className="slider__reset"
              onClick={onReset}
              aria-label={`${def.label} zurücksetzen`}
              title="Zurücksetzen"
            >
              <IconReset size={12} />
            </button>
          )}
          <span className="slider__value mono">{formatParamValue(def, value)}</span>
        </span>
      </div>

      <div
        ref={trackRef}
        className="slider__track"
        role="slider"
        tabIndex={0}
        aria-label={def.label}
        aria-valuemin={def.min}
        aria-valuemax={def.max}
        aria-valuenow={value}
        aria-valuetext={formatParamValue(def, value)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        onDoubleClick={() => onReset?.()}
      >
        <div className="slider__rail" />
        {def.bipolar && <div className="slider__zero" style={{ left: `${defaultFraction * 100}%` }} />}
        <div
          className="slider__fill"
          style={{ left: `${fillStart * 100}%`, width: `${Math.max(0, fillEnd - fillStart) * 100}%` }}
        />
        <div className="slider__thumb" style={{ left: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}
