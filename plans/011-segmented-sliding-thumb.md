# 011 — Slide the segmented control's selection

- **Status**: DONE
- **Commit**: 2606b69
- **Severity**: LOW (missed opportunity)
- **Category**: Missed opportunities
- **Estimated scope**: 2 files, ~35 lines

## Problem

`Segmented` (`src/ui/controls.tsx:139-149`, used in 9 places) shows the selection by giving the pressed button a white background (`base.css:682-686`). Switching teleports the highlight. The app follows Apple's HIG, where the segmented thumb slides to the new segment.

## Target

One thumb element, positioned under the selected button, moved with `transform` and sized with `width`, both over `--dur-2` with `--ease`. No animation on first paint.

```tsx
export function Segmented<T extends string>({ value, options, onChange, label }: { ... unchanged ... }) {
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
      {options.map((o) => ( ...unchanged buttons... ))}
    </div>
  );
}
```

```css
/* base.css, after the .segmented button[aria-pressed='true'] rule */
.segmented {
  position: relative;
}
.segmented button {
  position: relative;
  z-index: 1;
}
.segmented-thumb {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  border-radius: 6px;
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 0 0 0.5px rgba(0, 0, 0, 0.04);
  transition: transform var(--dur-2) var(--ease), width var(--dur-2) var(--ease);
}
.segmented.has-thumb button[aria-pressed='true'] {
  background: transparent;
  box-shadow: none;
}
```

`offsetLeft` is relative to `.segmented` because it becomes the positioned ancestor; it already has `padding: 2px`, which `offsetLeft` includes. If the group scrolls horizontally (`overflow-x: auto`), the thumb scrolls with the content, which is correct.

## Repo conventions to follow

- `useLayoutEffect`, `useRef`, `useState` are imported in `controls.tsx` already (check; add if missing).
- The `[aria-selected='true']` selector in the same rule serves other markup; leave it.

## Boundaries

- Do not change `Segmented`'s props or the 9 call sites.
- Keep `aria-pressed` on the buttons as the source of truth.

## Verification

- **Mechanical**: `npm run typecheck`, `npm run build` succeed.
- **Feel check**: on any screen with a segmented control, click between options: the white thumb slides and resizes to the new option in ~220ms; on first load it is already in place (no slide from the left). Click rapidly back and forth: it retargets mid-slide without jumping. Resize the window: the thumb stays aligned.
- **Done when**: selection change slides; no double highlight.
