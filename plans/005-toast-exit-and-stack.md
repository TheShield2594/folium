# 005 — Animate toast exits and the stack shifting

- **Status**: DONE
- **Commit**: 2606b69
- **Severity**: MEDIUM
- **Category**: Interruptibility
- **Estimated scope**: 2 files, ~45 lines

## Problem

`src/ui/controls.tsx:385-405` — toasts are removed from the store the instant they're dismissed (timeout, action click, or overflow past three), so they vanish in one frame:

```ts
dismiss: (id) => {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  set({ toasts: get().toasts.filter((x) => x.id !== id) });
},
```

And the stack is bottom-anchored (`.toasts { position: fixed; bottom: var(--sp-6); flex-direction: column }`, `base.css:972`), so when a new toast arrives at the bottom, every older toast jumps up by one toast height in a single frame.

## Target

1. **Exit**: a dismissed toast gets `leaving: true`, plays a 200ms exit, then is removed.

```css
/* src/styles/base.css, after .toast.error svg */
.toast.leaving {
  animation: toast-out 200ms var(--ease) forwards;
  pointer-events: none;
}
/* in the keyframe block */
@keyframes toast-out { to { opacity: 0; transform: translateY(8px) scale(0.96); } }
```

2. **Store** (replace `interface Toast`, `push`, `dismiss`):

```ts
interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
  action?: { label: string; onClick: () => void };
  leaving?: boolean;
}

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
```

3. **Stack shift (FLIP)** in `Toasts()`: remember each toast's `top` after every render and, when it moved, animate it from the old spot with the individual `translate` property (so it composes with the `transform` used by `toast-in`/`toast-out`):

```tsx
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
          ...unchanged children...
```

`cubic-bezier(0.32, 0.72, 0, 1)` is the value of the repo's `--ease` token (WAAPI can't read CSS vars in `easing`).

## Repo conventions to follow

- `useLayoutEffect`/`useRef` are already imported in `controls.tsx` (used by `Menu`). Class lists are built with `[...].filter(Boolean).join(' ')`.
- Durations: `--dur-2` is 220ms; 200ms is used for exits deliberately (exits a touch faster than entrances).

## Steps

1. Add `leaving?: boolean` to `Toast`.
2. Replace `push` and `dismiss` with the target code.
3. Update `Toasts()` as shown (ref, layout effect, `data-toast`, `leaving` class).
4. Add the `.toast.leaving` rule and `toast-out` keyframe to `base.css`.

## Boundaries

- Do not change toast copy, timings (3800/6500ms), the `toast` API, or `repeatsBanner`.
- No new dependencies.
- `el.animate?.` and `window.matchMedia?.` stay optional-chained (jsdom lacks both).

## Verification

- **Mechanical**: `npm run typecheck`, `npm test`, `npm run build` succeed.
- **Feel check**: trigger several toasts quickly (e.g. save a draft repeatedly):
  - Each new toast rises in; the older ones *glide* up rather than jump.
  - A fourth toast makes the oldest fade/drop out while the others glide.
  - A toast timing out fades and sinks 8px over 200ms; the ones above glide down.
  - Clicking a toast's action button during its exit does nothing (pointer-events none).
- **Done when**: no toast appears, disappears or moves in a single frame.
