import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Zusatzzeile, z. B. was die Validierung an einer KI-Antwort korrigiert hat. */
  detail?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string, detail?: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, detail) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, detail }] }));
    // Fehler bleiben stehen, bis sie weggeklickt werden — sie enthalten
    // Informationen, die der Nutzer womöglich noch braucht.
    if (kind !== 'error') {
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Kurzform für Fehlerobjekte aus dem API-Client. */
export function toastError(err: unknown, fallback = 'Es ist ein Fehler aufgetreten.'): void {
  const message = err instanceof Error && err.message ? err.message : fallback;
  useToasts.getState().push('error', message);
}

/** Bestätigung für eine abgeschlossene Aktion. Verschwindet von selbst. */
export function toastSuccess(message: string, detail?: string): void {
  useToasts.getState().push('success', message, detail);
}
