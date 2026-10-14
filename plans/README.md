# Animation plans

Written by an animation audit at commit `2606b69`. Each plan is self-contained.

| # | Plan | Severity | Status |
|---|------|----------|--------|
| 001 | [Stop reduced-motion from strobing infinite animations](001-reduced-motion-infinite-flicker.md) | HIGH | DONE |
| 002 | [Open the ⌘K command palette instantly](002-command-palette-instant.md) | HIGH | DONE |
| 003 | [Scale menus from their trigger](003-popover-origin.md) | MEDIUM | DONE |
| 004 | [Let the "needs input" pulse settle](004-need-pulse-settles.md) | MEDIUM | DONE |
| 005 | [Animate toast exits and the stack shifting](005-toast-exit-and-stack.md) | MEDIUM | DONE |
| 006 | [Fade the compact sidebar's scrim](006-sidebar-scrim-fade.md) | MEDIUM | DONE |
| 007 | [Give dialogs a short exit](007-sheet-exit.md) | LOW | DONE |
| 008 | [Soften the add button's press](008-add-button-press-depth.md) | LOW | DONE |
| 009 | [Shorten the packet list item entrance](009-packet-list-entrance.md) | LOW | DONE |
| 010 | [Animate the meter without layout](010-meter-clip-path.md) | LOW | DONE |
| 011 | [Slide the segmented control's selection](011-segmented-sliding-thumb.md) | LOW | DONE |
| 012 | [Expand disclosure content smoothly](012-details-expand.md) | LOW | DONE |

## Order and dependencies

Run in numeric order. 001 first: it changes the reduced-motion rule that 005, 007 and 011 rely on. 002 and 007 both touch the `.sheet` CSS block in `base.css` (independent rules, adjacent lines). 005, 007, 010 and 011 all edit `src/ui/controls.tsx` in different components.

## Already right (don't change)

Motion tokens (`--ease`, `--dur-1/2/3`) in `tokens.css`; `.btn:active` scale(0.97) at 120ms; the switch thumb and compact sidebar animate `transform`; menu items have no hover transition (keyboard navigation stays instant); the palette's list scrolls with `block: 'nearest'` and no smooth scroll.
