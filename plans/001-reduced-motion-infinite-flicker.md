# 001 — Stop reduced-motion from strobing infinite animations

- **Status**: DONE
- **Commit**: 2606b69
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 1 file, ~15 lines

## Problem

`src/styles/base.css:1050` — current:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    transition-duration: 1ms !important;
  }
}
```

The rule shortens every animation to 1ms but leaves `animation-iteration-count: infinite` alone. Three animations are infinite:

- `.spinner` — `animation: spin 0.8s linear infinite;` (`base.css:1015`)
- `.skeleton` — `animation: shimmer 1.4s linear infinite;` (`base.css:1022`)
- `.hl-need` — `animation: need-pulse 2.4s var(--ease-in-out) infinite;` (`screens.css:239`)

At 1ms per cycle the browser samples a different phase each frame, so the "needs input" highlight on the PDF preview flickers between its two backgrounds every frame and spinners/skeletons jitter. Users who asked for *less* motion get strobing.

## Target

Reduced motion = no movement, but busy indicators still show a calm, opacity-only signal, and nothing loops at 1ms.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
  /* Busy indicators keep a slow fade so the page still reads as working. */
  .spinner,
  .skeleton {
    animation: busy-fade 1.6s ease-in-out infinite !important;
  }
  .hl-need {
    animation: none !important;
  }
}

@keyframes busy-fade { 50% { opacity: 0.45; } }
```

`.spinner` / `.skeleton` (class specificity) beat `*` when both are `!important`, so the shorthand restores a 1.6s infinite fade for them only.

## Repo conventions to follow

- Keyframes live in a block at `base.css:1043-1048` (`@keyframes fade-in { from { opacity: 0; } }` style, one line each). Put `busy-fade` there.

## Steps

1. In `src/styles/base.css`, add `@keyframes busy-fade { 50% { opacity: 0.45; } }` after the `@keyframes shimmer` line.
2. Replace the whole `@media (prefers-reduced-motion: reduce)` block with the target block above (without repeating the keyframe).

## Boundaries

- CSS only. Do not touch `screens.css` or any TSX.
- Do not change the non-reduced-motion behaviour of any animation.

## Verification

- **Mechanical**: `npm run build` succeeds.
- **Feel check** (DevTools › Rendering › Emulate `prefers-reduced-motion: reduce`):
  - Open a review screen with missing fields: amber highlights are static, no flicker.
  - A spinner (e.g. launch screen, any busy button) shows a still ring that fades slowly; it does not jitter.
  - Turn emulation off: the spinner rotates and the amber highlight pulses as before.
- **Done when**: nothing on screen flickers with reduced motion on.
