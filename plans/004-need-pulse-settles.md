# 004 — Let the "needs input" pulse settle instead of looping forever

- **Status**: TODO
- **Commit**: 2606b69
- **Severity**: MEDIUM
- **Category**: Purpose & performance
- **Estimated scope**: 1 file, 1 line

## Problem

`src/styles/screens.css:239` — current:

```css
.hl-need {
  background: var(--hl-need);
  box-shadow: inset 0 0 0 1.25px var(--hl-need-line);
  animation: need-pulse 2.4s var(--ease-in-out) infinite;
}
```

Every field still needing input on the PDF preview (`PdfView.tsx:111`, tone `'need'`) pulses forever, all in sync. The review screen is where advisors spend most of their time, so this is permanent peripheral motion, and it repaints `background` on dozens of absolutely-positioned boxes over the PDF canvas for as long as the screen is open. The pulse's job — "look here" — is done after a couple of cycles; the static amber fill + outline carries the state after that.

## Target

```css
  animation: need-pulse 2.4s var(--ease-in-out) 2;
```

Two cycles (4.8s), ending on the base `--hl-need` background (the keyframe only defines 50%). A field that newly becomes "need" mounts the class fresh and pulses again, which is the desired attention cue.

## Steps

1. Change `infinite` to `2` on that line.

## Boundaries

- Do not change the keyframe, colours or the legend swatch in `ReviewScreen.tsx:319`.

## Verification

- **Mechanical**: `npm run build` succeeds.
- **Feel check**: open a review with missing fields: highlights pulse twice, then stay amber. Clear a required value so a field becomes missing again: that one pulses. Performance panel: no continuous paint after ~5s.
- Feel is subjective — if two pulses feel too short on a busy form, `3` is acceptable; never `infinite`.
- **Done when**: no infinite animation remains on `.hl-need`.
