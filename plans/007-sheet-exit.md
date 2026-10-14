# 007 — Give dialogs a short exit

- **Status**: TODO
- **Commit**: 2606b69
- **Severity**: LOW
- **Category**: Missed exit
- **Estimated scope**: 2 files, ~25 lines

## Problem

`Sheet` (`src/ui/controls.tsx:203-252`) rises in (`sheet-in`, 380ms) but closes in one frame: Escape, the × button and a backdrop click all call `onClose` directly, and the parent unmounts it.

## Target

When the Sheet itself initiates the close (Escape, ×, backdrop), play a 150ms exit, then call `onClose`. Closes initiated by the parent (footer Save/Cancel buttons that flip parent state) stay instant — that is acceptable and out of scope.

```tsx
// inside Sheet
const [closing, setClosing] = useState(false);
const closingRef = useRef(false);
const timer = useRef<ReturnType<typeof setTimeout>>();
const requestClose = useCallback(() => {
  if (closingRef.current) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return onCloseRef.current();
  closingRef.current = true;
  setClosing(true);
  timer.current = setTimeout(() => onCloseRef.current(), 150);
}, []);
useEffect(() => () => clearTimeout(timer.current), []);
```

- Escape handler: `onCloseRef.current()` → `requestClose()` (the effect already reads through refs; add `requestClose` to its body only — it's stable).
- Backdrop: `onMouseDown={(e) => e.target === e.currentTarget && requestClose()}`
- × button: `onClick={requestClose}`
- Backdrop className: `['sheet-backdrop', closing && 'closing'].filter(Boolean).join(' ')`

```css
/* base.css, after .sheet.wide */
.sheet-backdrop.closing {
  animation: fade-out 150ms var(--ease) forwards;
  pointer-events: none;
}
.sheet-backdrop.closing .sheet {
  animation: sheet-out 150ms var(--ease) forwards;
}
/* keyframe block */
@keyframes fade-out { to { opacity: 0; } }
@keyframes sheet-out { to { opacity: 0; transform: scale(0.98); } }
```

## Repo conventions to follow

- `Sheet` already reads `onClose` via `onCloseRef` so the focus-trap effect doesn't re-run; keep that. Import `useCallback`/`useState` from React if not already imported.

## Steps

1. Add the state, ref, timer and `requestClose` to `Sheet`.
2. Route Escape, backdrop and × through `requestClose`.
3. Add the `closing` class to the backdrop.
4. Add the CSS rules and keyframes.

## Boundaries

- Do not change the focus trap, focus restore, or the command palette (it doesn't use `Sheet`).
- Do not delay parent-initiated closes.

## Verification

- **Mechanical**: `npm run typecheck`, `npm test`, `npm run build` succeed.
- **Feel check**: open any dialog, press Escape: it fades and settles to 98% over 150ms, then focus returns to the opener. Repeat with × and backdrop click. Double-press Escape: no error, closes once. With reduced motion emulated it closes immediately.
- **Done when**: self-initiated dialog closes animate out.
