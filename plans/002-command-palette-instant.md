# 002 — Open the ⌘K command palette instantly

- **Status**: TODO
- **Commit**: 2606b69
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 2 files, ~6 lines

## Problem

The palette is toggled by ⌘K / Ctrl+K (`src/shell/Shell.tsx:180`) — a keyboard action people repeat all day. It reuses the modal classes, so it inherits the modal entrance:

```tsx
// src/shell/CommandPalette.tsx:97-98 — current
<div className="sheet-backdrop" style={{ placeItems: 'start center', paddingTop: '12vh' }} onMouseDown={...}>
  <div className="sheet" role="dialog" aria-modal="true" aria-label="Search Folium" style={{ width: 'min(620px, 100%)' }}>
```

```css
/* src/styles/base.css:887, :898 — current */
.sheet-backdrop { ... animation: fade-in var(--dur-2) var(--ease); }
.sheet { ... animation: sheet-in var(--dur-3) var(--ease); }
```

So every ⌘K plays a 220ms backdrop fade and a 380ms rise. Keyboard-initiated, high-frequency UI must not animate (Raycast/Spotlight open instantly).

## Target

```css
/* Keyboard-summoned overlays (the ⌘K palette) appear at once. */
.sheet-backdrop.instant,
.sheet-backdrop.instant .sheet {
  animation: none;
}
```

and both elements in `CommandPalette.tsx` get the modifier: `className="sheet-backdrop instant"` and `className="sheet"` stays (the descendant selector covers it).

## Steps

1. In `src/styles/base.css`, directly after the `.sheet.wide { ... }` rule, add the CSS above.
2. In `src/shell/CommandPalette.tsx:97`, change `className="sheet-backdrop"` to `className="sheet-backdrop instant"`.

## Boundaries

- Do not change `.sheet` / `.sheet-backdrop` for other dialogs.
- Do not change the palette's layout, keyboard handling or list behaviour.

## Verification

- **Mechanical**: `npm run typecheck` and `npm run build` succeed.
- **Feel check**: press ⌘K/Ctrl+K repeatedly: the palette appears and disappears in the same frame, no fade or rise. Open any other dialog (e.g. a Share sheet): it still rises in.
- **Done when**: the palette has no entrance animation.
