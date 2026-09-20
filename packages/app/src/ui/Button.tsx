import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** Zeigt einen Spinner und sperrt die Schaltfläche. */
  busy?: boolean;
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  busy = false,
  block = false,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--${size} ${block ? 'btn--block' : ''} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="btn__spinner" aria-hidden="true" /> : icon}
      {children && <span className="btn__label">{children}</span>}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Pflicht — eine Schaltfläche ohne Text braucht einen zugänglichen Namen. */
  label: string;
  icon: ReactNode;
  active?: boolean;
  size?: Size;
}

export function IconButton({ label, icon, active, size = 'md', className = '', ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn icon-btn--${size} ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...rest}
    >
      {icon}
    </button>
  );
}
