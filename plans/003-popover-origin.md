# 003 — Scale menus from their trigger, not their centre

- **Status**: TODO
- **Commit**: 2606b69
- **Severity**: MEDIUM
- **Category**: Physicality & origin
- **Estimated scope**: 1 file, 1 line

## Problem

`src/ui/controls.tsx:349` — current:

```tsx
<div ref={pop} className="popover" role="menu" style={{ top: pos.top, left: pos.left }}>
```

`.popover` animates `pop-in` (`base.css:934`, `@keyframes pop-in { from { opacity: 0; transform: scale(0.96) translateY(-4px); } }`) with the default `transform-origin: center`. The menu is always placed *below* its trigger (`top: r.bottom + 6`), aligned to the trigger's right edge (`align='end'`, default) or left edge (`align='start'`), so it should grow out of that corner.

## Target

```tsx
<div
  ref={pop}
  className="popover"
  role="menu"
  style={{ top: pos.top, left: pos.left, transformOrigin: align === 'end' ? 'top right' : 'top left' }}
>
```

## Steps

1. Make the edit above in `Menu` (`src/ui/controls.tsx`). `align` is already in scope.

## Boundaries

- Do not change positioning maths, keyframes or durations.

## Verification

- **Mechanical**: `npm run typecheck` succeeds.
- **Feel check**: set DevTools Animations playback to 10%, open a "…" menu: it unfolds from the corner under the button, not from its middle.
- **Done when**: transform-origin matches the alignment.
