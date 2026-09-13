import { useEffect, useRef, type ReactNode } from 'react';
import { X, FlaskConical } from 'lucide-react';

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="la-brand">
      <img src="/brand/lina-mark.svg" width="32" height="32" alt="" />
      <span>
        Lina<span className="la-brand-sub">{subtitle || 'Terminal'}</span>
      </span>
    </div>
  );
}
export function PreviewBar({
  children,
  onReset,
}: {
  children?: ReactNode;
  onReset(): void;
}) {
  return (
    <aside className="la-preview" aria-label="Preview controls">
      <span>
        <FlaskConical size={14} />
        <strong>Interactive preview</strong>
        <span className="la-preview-note">
          Sample data · no connections · resets on reload
        </span>
      </span>
      <div>
        {children}
        <button onClick={onReset}>Reset preview</button>
      </div>
    </aside>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red';
}) {
  return (
    <span className={`la-badge la-badge--${tone}`}>
      <i />
      {children}
    </span>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`la-dialog ${wide ? 'la-dialog--wide' : ''}`}
      aria-labelledby="la-dialog-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="la-dialog-inner">
        <header>
          <h2 id="la-dialog-title">{title}</h2>
          <button
            className="la-icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
