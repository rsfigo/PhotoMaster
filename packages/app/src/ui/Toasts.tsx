import { useToasts } from '../state/toastStore.ts';
import { IconCheck, IconClose, IconInfo, IconWarn } from './Icons.tsx';
import './Toasts.css';

const ICONS = {
  info: IconInfo,
  success: IconCheck,
  error: IconWarn,
};

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    /* aria-live: Meldungen werden vorgelesen, ohne den Fokus zu stehlen. */
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <Icon size={16} className="toast__icon" />
            <div className="toast__body">
              <p className="toast__message">{toast.message}</p>
              {toast.detail && <p className="toast__detail">{toast.detail}</p>}
            </div>
            <button
              type="button"
              className="toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="Meldung schließen"
            >
              <IconClose size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
