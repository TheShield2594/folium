# 010 — Animate the meter without layout

- **Status**: TODO
- **Commit**: 2606b69
- **Severity**: LOW
- **Category**: Performance
- **Estimated scope**: 2 files, ~5 lines

## Problem

```css
/* src/styles/base.css:774-779 — current */
.meter > i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  background: var(--accent);
  transition: width var(--dur-3) var(--ease);
}
```

```tsx
// src/ui/controls.tsx:180 — current
<i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
```

`width` is a layout property. `scaleX` would squash the 3px rounded end, so use `clip-path`, which keeps rounded corners and only repaints.

## Target

```css
.meter > i {
  position: absolute;
  inset: 0;
  background: var(--accent);
  transition: clip-path var(--dur-3) var(--ease);
}
```

```tsx
<i style={{ clipPath: `inset(0 ${100 - Math.max(0, Math.min(100, value))}% 0 0 round 3px)` }} />
```

## Steps

1. Replace the `.meter > i` rule with the target.
2. Replace the `<i>` style in `Meter`.

## Boundaries

- Keep `role="meter"` and the aria attributes unchanged.

## Verification

- **Mechanical**: `npm run typecheck` succeeds.
- **Feel check**: wherever a Meter shows progress, the bar fills smoothly with a rounded right end at every value, including small ones (e.g. 5%).
- **Done when**: no `width` transition remains on `.meter > i`.
