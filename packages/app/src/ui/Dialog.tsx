import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button.tsx';
import { IconClose } from './Icons.tsx';
import './Dialog.css';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  footer?: ReactNode;
  /** Verhindert Schließen per Escape oder Klick auf den Hintergrund. */
  persistent?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  children,
  footer,
  persistent = false,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Fokus in den Dialog holen, damit Tastaturbedienung dort beginnt.
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !persistent) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      // Fokus im Dialog halten: Ein Dialog, aus dem man heraustabbt, ist für
      // Tastaturnutzer eine Sackgasse.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, persistent]);

  if (!open) return null;

  return createPortal(
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (!persistent && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`dialog dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="dialog__head">
          <div>
            <h2 className="dialog__title">{title}</h2>
            {subtitle && <p className="dialog__subtitle">{subtitle}</p>}
          </div>
          {!persistent && (
            <IconButton label="Schließen" icon={<IconClose />} onClick={onClose} size="sm" />
          )}
        </header>

        <div className="dialog__body">{children}</div>

        {footer && <footer className="dialog__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
