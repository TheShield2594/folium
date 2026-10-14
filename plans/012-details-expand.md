# 012 — Expand disclosure content smoothly

- **Status**: DONE
- **Commit**: 2606b69
- **Severity**: LOW (missed opportunity)
- **Category**: Missed opportunities
- **Estimated scope**: 1 file, ~15 lines

## Problem

`src/screens/requests/RequestCard.tsx:296` uses `<details>` ("Forms, signers and audit trail"). The chevron rotates over `--dur-2` (`screens.css:682-687`) but the content appears in one frame, so the chevron's motion and the content disagree.

## Target

Progressive enhancement with `::details-content` and `interpolate-size` (Chromium today; other engines keep the current instant behaviour):

```css
/* src/styles/screens.css, after details[open] .disclosure */
@supports (interpolate-size: allow-keywords) {
  details {
    interpolate-size: allow-keywords;
  }
  details::details-content {
    block-size: 0;
    overflow-y: clip;
    opacity: 0;
    transition: block-size var(--dur-2) var(--ease), opacity var(--dur-2) var(--ease), content-visibility var(--dur-2) allow-discrete;
  }
  details[open]::details-content {
    block-size: auto;
    opacity: 1;
  }
}
```

This animates height, which is a layout property; acceptable here because it's a rare, user-initiated disclosure in a card list, and the alternative (no motion) is what we have.

## Steps

1. Add the block above to `screens.css`.

## Boundaries

- CSS only; do not change `RequestCard.tsx`.

## Verification

- **Mechanical**: `npm run build` succeeds (the CSS minifier must keep `::details-content`).
- **Feel check** (Chrome): expand and collapse the disclosure — the content grows/shrinks with the chevron over ~220ms. In Firefox/Safari it still opens instantly and works. With reduced motion, it opens instantly.
- **Done when**: content and chevron move together in Chromium.
