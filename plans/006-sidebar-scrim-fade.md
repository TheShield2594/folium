# 006 — Fade the compact sidebar's scrim with the sidebar

- **Status**: DONE
- **Commit**: 2606b69
- **Severity**: MEDIUM
- **Category**: Cohesion
- **Estimated scope**: 2 files, ~20 lines

## Problem

On compact widths (≤860px) the sidebar slides in over `--dur-3` (380ms) with `--ease` (`base.css:1074-1086`), but the scrim is mounted/unmounted conditionally:

```tsx
// src/shell/Shell.tsx:193-196 — current
const scrim = useMemo(
  () => sidebarOpen && <div onClick={() => setSidebar(false)} style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(0,0,0,.25)' }} aria-hidden="true" />,
  [sidebarOpen, setSidebar],
);
```

It darkens the page in one frame before the sidebar arrives, and vanishes in one frame while the sidebar is still sliding out.

## Target

Always render the scrim; animate its opacity with exactly the sidebar's timing.

```tsx
// Shell.tsx — replace the useMemo and `{scrim}` with:
<div className="scrim" onClick={() => setSidebar(false)} aria-hidden="true" />
```

```css
/* src/styles/base.css — inside the existing @media (max-width: 860px) block that holds .sidebar */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 55;
  background: rgba(0, 0, 0, 0.25);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-3) var(--ease);
}
.app[data-sidebar='open'] .scrim {
  opacity: 1;
  pointer-events: auto;
}
```

plus, outside any media query (so it never shows on wide layouts):

```css
.scrim {
  display: none;
}
```

and inside the 860px block add `display: block;` to the `.scrim` rule.

## Steps

1. In `Shell.tsx`, delete the `scrim` `useMemo` and render `<div className="scrim" ... />` where `{scrim}` was (still the first children of `.app`, right after `<Sidebar />`).
2. If `useMemo` is no longer used anywhere in `Shell.tsx`, remove it from the React import (`noUnusedLocals` is on).
3. Add the CSS: a base `.scrim { display: none; }` near the sidebar styles, and the full rule (with `display: block;`) plus the open-state rule inside the `@media (max-width: 860px)` block at `base.css:1069`.

## Boundaries

- Do not change sidebar transform, z-index (sidebar is 60, scrim stays 55) or open/close logic.

## Verification

- **Mechanical**: `npm run typecheck` and `npm run build` succeed.
- **Feel check**: at ≤860px width, open and close the sidebar at 10% playback: the dim fades in and out in step with the slide. Tapping the dim closes the sidebar. At desktop width nothing dims and clicks reach the page.
- **Done when**: the scrim never appears or disappears in a single frame.
