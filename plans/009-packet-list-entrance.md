# 009 — Shorten the packet list item entrance

- **Status**: TODO
- **Commit**: 2606b69
- **Severity**: LOW
- **Category**: Cohesion / duration
- **Estimated scope**: 1 file, 1 line

## Problem

`src/styles/screens.css:152` — current:

```css
.packet-list li {
  ...
  animation: pop-in var(--dur-3) var(--ease);
}
```

Each form in the packet (`PacketInspector.tsx:70`) pops in over 380ms. Adding one form, that's a list item taking modal-length time; switching packets, every item does it at once. List items belong in the 150–250ms band.

## Target

```css
  animation: pop-in var(--dur-2) var(--ease);
```

A stagger was considered and deliberately left out: the index-based delay would also apply to a single form added at the end of a long packet, delaying exactly the item the user is watching.

## Steps

1. Change `var(--dur-3)` to `var(--dur-2)` on that line.

## Verification

- **Feel check**: add a form to a packet: it appears promptly and settles. Switch packets: the list arrives without a lingering float.
- **Done when**: value matches the target.
