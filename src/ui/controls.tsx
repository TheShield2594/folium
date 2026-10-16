import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { repeatsBanner } from '../services/errors';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Icon, type IconName } from './Icon';

// ------------------------------------------------------------------ Buttons

type Variant = 'filled' | 'tinted' | 'gray' | 'plain' | 'bordered' | 'danger' | 'fix';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconAfter?: IconName;
  block?: boolean;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'gray', size = 'md', icon, iconAfter, block, busy, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = ['btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spinner" style={{ width: 14, height: 14, borderTopColor: 'currentColor' }} /> : icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
      {iconAfter && <Icon name={iconAfter} size={size === 'sm' ? 13 : 15} />}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; hit?: boolean; pressed?: boolean; size?: number }>(
  function IconButton({ icon, label, hit, pressed, size = 18, className, type = 'button', ...rest }, ref) {
    return (
      <button ref={ref} type={type} className={['icon-btn', hit && 'hit', className].filter(Boolean).join(' ')} aria-label={label} title={label} aria-pressed={pressed} {...rest}>
        <Icon name={icon} size={size} />
      </button>
    );
  },
);

// ------------------------------------------------------------------ Inputs

export function Field({ label, help, error, children, htmlFor, optional }: { label: ReactNode; help?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; optional?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {optional && <span className="c3" style={{ fontWeight: 400 }}> · optional</span>}
      </label>
      {children}
      {error ? <span className="err" role="alert">{error}</span> : help ? <span className="help">{help}</span> : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { need?: boolean }>(function TextInput({ className, need, ...rest }, ref) {
  return <input ref={ref} className={['input', need && 'need', className].filter(Boolean).join(' ')} {...rest} />;
});

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={['textarea', props.className].filter(Boolean).join(' ')} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={['select', props.className].filter(Boolean).join(' ')} />;
}

export function LabeledField({ label, help, error, optional, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string; error?: string; optional?: boolean }) {
  const id = useId();
  return (
    <Field label={label} help={help} error={error} htmlFor={id} optional={optional}>
      <TextInput id={id} aria-invalid={error ? true : undefined} {...input} />
    </Field>
  );
}

export function SearchField({ value, onChange, placeholder, shortcut, autoFocus, inputRef, label = 'Search' }: { value: string; onChange: (v: string) => void; placeholder?: string; shortcut?: string; autoFocus?: boolean; inputRef?: React.Ref<HTMLInputElement>; label?: string }) {
  return (
    <div className="search">
      <Icon name="search" size={16} />
      <input
        ref={inputRef}
        className="input"
        type="search"
        aria-label={label}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
        spellCheck={false}
      />
      {shortcut && !value && <span className="kbd" aria-hidden="true">{shortcut}</span>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export function SwitchRow({ checked, onChange, label, detail, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; detail?: string; disabled?: boolean }) {
  return (
    <div className="list-row">
      <div className="grow">
        <div>{label}</div>
        {detail && <div className="t-footnote c3">{detail}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  const group = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number; ready: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = group.current;
    if (!el) return;
    const measure = () => {
      const b = el.querySelector<HTMLElement>('button[aria-pressed="true"]');
      if (!b) return setThumb(null);
      setThumb((prev) => ({ x: b.offsetLeft, w: b.offsetWidth, ready: prev !== null }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [value]);
  return (
    <div ref={group} className={['segmented', thumb && 'has-thumb'].filter(Boolean).join(' ')} role="group" aria-label={label}>
      {thumb && (
        <span
          className="segmented-thumb"
          aria-hidden="true"
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)`, transition: thumb.ready ? undefined : 'none' }}
        />
      )}
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A wide table's sideways scroll box. Focusable and named, so keyboard users can scroll
 * it too (at 400% zoom the table is wider than the screen).
 */
export function TableScroll({ label, children, style }: { label: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} style={{ overflowX: 'auto', ...style }}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ Display

export function Avatar({ name, size = 32, alt }: { name: string; size?: number; alt?: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter((p) => /^[A-Za-z]/.test(p))
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className={['avatar', alt && 'alt'].filter(Boolean).join(' ')} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {initials}
    </span>
  );
}

export function Badge({ tone, children, icon }: { tone?: 'accent' | 'warn' | 'info' | 'danger' | 'solid-warn'; children: ReactNode; icon?: IconName }) {
  return (
    <span className={['badge', tone && `badge-${tone}`].filter(Boolean).join(' ')}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

export function Meter({ value, label }: { value: number; label?: string }) {
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
      <i style={{ clipPath: `inset(0 ${100 - Math.max(0, Math.min(100, value))}% 0 0 round 3px)` }} />
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={40} />
      <h3>{title}</h3>
      {children && <p className="t-callout" style={{ maxWidth: 380 }}>{children}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

// ------------------------------------------------------------------ Sheet (modal)

export function Sheet({ title, onClose, children, footer, wide, icon }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; icon?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Read onClose through a ref so an inline handler from the parent doesn't re-run the
  // focus effect on every render (which would pull focus out of the field being typed in).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return onCloseRef.current();
    closingRef.current = true;
    setClosing(true);
    timer.current = setTimeout(() => onCloseRef.current(), 150);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
      }
      if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const [a, b] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);

  return createPortal(
    <div className={['sheet-backdrop', closing && 'closing'].filter(Boolean).join(' ')} onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div ref={ref} className={['sheet', wide && 'wide'].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="sheet-head">
          {icon}
          <h2 id={titleId} className="grow">{title}</h2>
          <IconButton icon="x" label="Close" onClick={requestClose} data-close />
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Ask before something destructive. Cancel comes first, so it has focus by default. */
export function ConfirmSheet({ title, children, confirmLabel, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  // Once the action has started it can't be called back, so don't let the sheet close mid-way.
  const close = () => {
    if (!busy) onClose();
  };
  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong');
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={title}
      onClose={close}
      footer={
        <>
          <Button variant="gray" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={confirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="t-callout">{children}</p>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Menu (popover)

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export function Menu({ trigger, items, align = 'end' }: { trigger: (p: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu'; ref: React.Ref<HTMLButtonElement> }) => ReactNode; items: MenuItem[]; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = pop.current?.offsetWidth ?? 220;
    const left = align === 'end' ? r.right - w : r.left;
    setPos({ top: r.bottom + 6 + window.scrollY, left: Math.max(8, Math.min(left, window.innerWidth - w - 8)) });
    pop.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu', ref: btn })}
      {open &&
        createPortal(
          <div
            ref={pop}
            className="popover"
            role="menu"
            style={{ top: pos.top, left: pos.left, transformOrigin: align === 'end' ? 'top right' : 'top left' }}
          >
            {items.map((it, i) =>
              it.separator ? (
                <div key={i} className="menu-sep" role="separator" />
              ) : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  className={['menu-item', it.danger && 'danger'].filter(Boolean).join(' ')}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect?.();
                  }}
                >
                  {it.icon && <Icon name={it.icon} size={16} />}
                  {it.label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ------------------------------------------------------------------ Toasts

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
  action?: { label: string; onClick: () => void };
  leaving?: boolean;
}

let nextToastId = 1;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: number) => void }>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextToastId++;
    const live = get().toasts.filter((x) => !x.leaving);
    set({ toasts: [...get().toasts, { ...t, id }] });
    // Only three show at once; the oldest leave (and their timers with them).
    for (const old of live.slice(0, -2)) get().dismiss(old.id);
    toastTimers.set(id, setTimeout(() => get().dismiss(id), t.action ? 6500 : 3800));
  },
  dismiss: (id) => {
    clearTimeout(toastTimers.get(id));
    toastTimers.delete(id);
    const current = get().toasts.find((x) => x.id === id);
    if (!current || current.leaving) return;
    set({ toasts: get().toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x)) });
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== id) }), 200);
  },
}));

export const toast = {
  ok: (text: string, action?: Toast['action']) => useToasts.getState().push({ text, tone: 'ok', action }),
  error: (text: string) => {
    if (!repeatsBanner(text)) useToasts.getState().push({ text, tone: 'error' });
  },
};

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const box = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<number, number>();
    for (const el of box.current?.querySelectorAll<HTMLElement>('[data-toast]') ?? []) {
      const id = Number(el.dataset.toast);
      const top = el.getBoundingClientRect().top;
      const before = tops.current.get(id);
      if (!reduce && before !== undefined && Math.abs(before - top) > 0.5) {
        el.animate?.([{ translate: `0 ${before - top}px` }, { translate: '0 0' }], { duration: 220, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
      }
      next.set(id, top);
    }
    tops.current = next;
  }, [toasts]);
  return (
    <div ref={box} className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} data-toast={t.id} className={['toast', t.tone === 'error' && 'error', t.leaving && 'leaving'].filter(Boolean).join(' ')}>
          <Icon name={t.tone === 'error' ? 'warning' : 'checkCircle'} size={18} />
          <span>{t.text}</span>
          {t.action && (
            <button
              className="btn btn-plain btn-sm"
              onClick={() => {
                t.action!.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Files

export function downloadBytes(bytes: Uint8Array, fileName: string, type = 'application/pdf') {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function openPdf(bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const w = window.open(url, '_blank', 'noopener');
  if (!w) downloadBytes(bytes, 'folium.pdf');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
