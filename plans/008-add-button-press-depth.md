# 008 — Soften the add button's press

- **Status**: TODO
- **Commit**: 2606b69
- **Severity**: LOW
- **Category**: Physicality
- **Estimated scope**: 1 file, 2 lines

## Problem

`src/styles/screens.css:54-61` — current:

```css
.form-row .add {
  ...
  transition: background var(--dur-1), color var(--dur-1), transform var(--dur-2) var(--ease);
}
.form-row .add:active {
  transform: scale(0.9);
}
```

90% is a heavy squash (press feedback belongs in 0.95–0.98) and 220ms is slower than the app's own `.btn` press (`transform var(--dur-1) var(--ease)` → `scale(0.97)`, `base.css:399-406`).

## Target

```css
  transition: background var(--dur-1), color var(--dur-1), transform var(--dur-1) var(--ease);
...
.form-row .add:active {
  transform: scale(0.95);
}
```

## Steps

1. Change `transform var(--dur-2)` to `transform var(--dur-1)` on `.form-row .add`.
2. Change `scale(0.9)` to `scale(0.95)`.

## Boundaries

- Nothing else in `screens.css`.

## Verification

- **Feel check**: in the library, press-and-hold a form's round "+" button: a small, quick dip that matches the regular buttons.
- **Done when**: values match the target.
