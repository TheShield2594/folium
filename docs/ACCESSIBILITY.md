# Accessibility

Folium aims to meet **WCAG 2.1 Level AA**. This page is the audit of the main flows (issue #56), what it found and fixed, the automated checks that keep it fixed, and a conformance statement in the style of a VPAT.

## How it's checked

**Automated, on every push.** `.github/workflows/accessibility.yml` builds the demo and runs `npm run test:a11y` (Playwright with axe-core, tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`). Any violation fails the build.

| Spec | What it covers |
|---|---|
| `e2e/a11y.spec.ts` | axe on every screen, light and dark: Find forms, Saved packets, Recent, Signature requests, Drafts, Contact & accounts, Settings, Review (both forms of a two-form packet, with the PDF and its field overlays), Send, and Administration (Templates, the template editor, People, Feedback, Announcements, Firm profiles, Settings, Readiness). Also the Quick Look and “Ask Marketing” sheets, the command palette and the Download menu. |
| `e2e/keyboard.spec.ts` | What axe can't see: the skip link; each screen naming the browser tab; PDF overlay boxes in reading order, saying when they need input, linked to their checks, and moving focus to their input; arrow keys in the form tabs; focus kept in and returned from a sheet; templates opened from the keyboard; and **reflow at 320 px** (400% zoom) on 11 screens, with axe again at that width. |

```bash
VITE_FOLIUM_DEMO=1 npm run build
npm run test:a11y          # serves dist/ with vite preview on :4173
```

**By hand.** Keyboard only, through every flow, at 200% and 400% browser zoom, in light and dark appearance. Reviewing the code of the shared controls (`src/ui/controls.tsx`), the shell and the PDF overlay (`src/screens/common/PdfView.tsx`).

**Still to do with screen readers.** The audit couldn't run NVDA, JAWS or VoiceOver. Before sign-off, someone should run the script at the end of this page with **NVDA + Edge**, **JAWS + Edge** and **VoiceOver + Safari** inside the Power Apps host on the Contact form, and record the results here. Until then, criteria that depend on what a screen reader says are marked *Supports (pending screen-reader check)*.

## What the audit found

Blocking means someone using a keyboard or a screen reader couldn't finish the task, or the build would fail WCAG AA outright. All blocking findings are fixed. The Everence palette (brand guidelines, p. 13) is unchanged: no fix alters a color token.

| # | Where | Finding | WCAG | Severity | Status |
|---|---|---|---|---|---|
| 1 | Review › PDF | Field boxes were in the template's mapping order, so Tab jumped around the page. Now sorted top to bottom, left to right, per page. | 2.4.3 | Blocking | Fixed |
| 2 | Review › PDF | A box's name gave its label and value but not that it was required, missing or invalid, or where the value came from. Now: “Share %: empty, needs input” / “Date of birth: 04/18/1961, from CRM” / “… invalid: …”. | 1.3.1, 4.1.2 | Blocking | Fixed |
| 3 | Review › PDF | Check results (“Shares must total 100%”) weren't tied to the fields they're about. The box and the input are now `aria-describedby` the open checks for that field. | 1.3.1, 3.3.1 | Blocking | Fixed |
| 4 | Review › PDF | Signer-only boxes and every box in read-only previews (Quick Look, the editor's test fill) were buttons that did nothing. Now they're text the screen reader reads in place. | 4.1.2 | Serious | Fixed |
| 5 | Review › PDF | Pages weren't named. Each page is now a group, “Page 1 of 3”. | 1.3.1 | Moderate | Fixed |
| 6 | Review › inputs | Required inputs weren't marked `aria-required`; missing or invalid ones weren't `aria-invalid`; the format error and help text weren't linked. The “•” required marker was a `span` with `aria-label`, which screen readers skip; it now reads “required”. | 1.3.1, 3.3.1, 3.3.2 | Blocking | Fixed |
| 7 | Review › form tabs | `role="tab"` without arrow keys, a tab panel, or a roving tab stop. The count badge read as a bare number. Now arrow keys, Home and End; the PDF is the tab panel; the badge reads “1 to fill”. | 2.1.1, 4.1.2 | Serious | Fixed |
| 8 | Review › checks | Pass, note and to-fix were shown only by icon and color. The icons now say “Passed:”, “Note:”, “To fix:”. | 1.1.1, 1.4.1 | Serious | Fixed |
| 9 | Administration › Templates | Rows opened only on mouse click; nothing to Tab to. The form name is now a link. | 2.1.1 | Blocking | Fixed |
| 10 | Template editor | Field-mapping rows and signature-tab rows were selected only by mouse click (and the tab rows used `aria-selected` on a plain `div`). Focusing anything in a row now selects it; tab rows have a toggle button. | 2.1.1, 4.1.2 | Serious | Fixed |
| 11 | Everywhere | No skip link and no `main` landmark; after moving between screens focus stayed in the sidebar; every tab was titled “Folium”. Now a “Skip to content” link, `<main>`, focus moves to the new screen, and each screen sets the title (“Prefill & review – Folium”). | 2.4.1, 2.4.2, 2.4.3 | Serious | Fixed |
| 12 | Everywhere | The focus ring is the brand royal at 55% opacity: about 2.3:1 on white, under the 3:1 for focus indicators. Fixing it means drawing the ring in solid royal (`#00739f`, 5.3:1) and solid robin (`#4dc5e2`) in dark: both are in the palette, but the ring would look stronger. Focused inputs already get a 2 px border in the accent green. | 1.4.11, 2.4.7 | Serious | **Open: brand decision** |
| 13 | Everywhere | Text contrast under 4.5:1: secondary gray text on gray fills (role tags, key hints, selected rows), links in announcements (grass on the tinted banner, 3.64), danger badges on the gray page (4.43), a tinted button on a warning banner (4.48), the command palette's selected detail text (3.32). Fixed **without changing any color in the palette**: those spots use the next existing text step (brand slate `#4B5457` in light), announcement links use the app's existing green for text on tints, and tinted badges and buttons lay their tint over the surface so they look as they do on a card. | 1.4.3 | Serious | Fixed |
| 14 | Everywhere | Links in running text were distinguishable only by color. Now underlined. | 1.4.1 | Serious | Fixed |
| 15 | 400% zoom | The toolbar ran off the right edge, hiding “Signers” and “Send”. It now wraps. Wide admin tables scroll inside a named, focusable region. | 1.4.10, 2.1.1 | Blocking | Fixed |
| 16 | Command palette | The results list had no name, the empty message sat inside the listbox, and the input wasn't a combobox. | 4.1.2 | Moderate | Fixed |
| 17 | Quick Look | The scrolling preview couldn't be reached by keyboard. | 2.1.1 | Moderate | Fixed |

### Known limitations (not blocking)

- **The PDF itself.** The page image is drawn on a canvas and hidden from assistive technology; everything on it that Folium knows about (fields, signature tabs) is exposed through the overlay, and the form's static text is not. The same text is in the template, so an advisor can open the PDF in a reader for it. Folium's downloaded and filled PDFs are untagged AcroForms; tagging them is a template (Marketing) task.
- **Highlight colors.** The overlay's green, amber and blue fills tell the states apart; the outline style also differs (underline, full box, hatch), and the state is in each box's name and in the side panel, so color isn't the only cue. The fills themselves are below 3:1 against white, by design, so the form text stays readable.
- **The form tab strip** scrolls sideways at 400% zoom when a packet has several forms. Arrow keys reach every tab.
- **DocuSign.** Signing happens on DocuSign's pages, which have their own conformance statement.
- **Auto-save countdown** (Recovery): when someone is idle, Folium saves their draft rather than discarding it, so no data is lost and no time limit applies to the work itself.

## Conformance statement

**Product:** Folium (Power Apps code app) · **Standard:** WCAG 2.1 Level A and AA · **Date:** October 2026 · **Method:** automated (axe-core 4.11 via Playwright, on every push), keyboard and zoom testing by hand, code review. Screen-reader testing pending (see above).

Terms: **Supports** — meets the criterion without known defects. **Partially supports** — some functionality does not meet it. **Not applicable** — Folium has no content the criterion is about.

### Level A

| Criterion | Level | Remarks |
|---|---|---|
| 1.1.1 Non-text content | Supports | Icons are hidden or named; status icons say what they mean. The PDF page image is described by its overlay (see Known limitations). |
| 1.2.1–1.2.3 Audio and video | Not applicable | No audio or video. |
| 1.3.1 Info and relationships | Supports (pending screen-reader check) | Landmarks, headings, labelled inputs, `aria-required`/`aria-invalid`, checks linked with `aria-describedby`, named page groups and tables. |
| 1.3.2 Meaningful sequence | Supports | PDF overlay in reading order. |
| 1.3.3 Sensory characteristics | Supports | Instructions don't depend on shape, color or position alone. |
| 1.4.1 Use of color | Supports | Link underlines; check and field states in text. |
| 1.4.2 Audio control | Not applicable | |
| 2.1.1 Keyboard | Supports | Every flow tested with the keyboard alone; ⌘K / Ctrl+K palette, “/” for search. |
| 2.1.2 No keyboard trap | Supports | Sheets trap focus by design and close with Escape, returning focus. |
| 2.1.4 Character key shortcuts | Supports | “/” works only outside text fields. |
| 2.2.1 Timing adjustable | Supports | No time limits on work; idle auto-save keeps the work. |
| 2.2.2 Pause, stop, hide | Supports | The need-input pulse runs twice and stops; none with reduced motion. |
| 2.3.1 Three flashes | Supports | |
| 2.4.1 Bypass blocks | Supports | Skip link, `main` and `nav` landmarks. |
| 2.4.2 Page titled | Supports | Each screen sets the document title. |
| 2.4.3 Focus order | Supports | New screens take focus; sheets return it; overlay in reading order. |
| 2.4.4 Link purpose | Supports | |
| 2.5.1 Pointer gestures | Supports | No path or multipoint gestures. |
| 2.5.2 Pointer cancellation | Supports | Actions fire on click (up event). |
| 2.5.3 Label in name | Supports | Accessible names begin with the visible label. |
| 2.5.4 Motion actuation | Not applicable | |
| 3.1.1 Language of page | Supports | `lang="en"`. |
| 3.2.1 On focus | Supports | Focusing a row in the template editor selects it (shows it on the PDF); nothing else changes context. |
| 3.2.2 On input | Supports | |
| 3.3.1 Error identification | Supports (pending screen-reader check) | Missing and invalid fields are marked and described; pre-send checks list each problem and jump to it. |
| 3.3.2 Labels or instructions | Supports | |
| 4.1.1 Parsing | Supports | (Obsolete in WCAG 2.2; React output.) |
| 4.1.2 Name, role, value | Supports (pending screen-reader check) | Tabs, menus, sheets, switches, segmented controls, the combobox and the overlay use the matching roles and states. |

### Level AA

| Criterion | Level | Remarks |
|---|---|---|
| 1.2.4–1.2.5 Captions, audio description | Not applicable | |
| 1.3.4 Orientation | Supports | |
| 1.3.5 Identify input purpose | Partially supports | Folium edits *the client's* data, not the user's, so `autocomplete` tokens for the user don't apply to most fields and are turned off to keep browsers from filling in the advisor's own details. |
| 1.4.3 Contrast (minimum) | Supports | Checked by axe in light and dark on every screen. |
| 1.4.4 Resize text | Supports | Tested at 200%. |
| 1.4.5 Images of text | Supports | The PDF page is an image of a document, which is exempt; its fields are real text in the overlay. |
| 1.4.10 Reflow | Supports | Tested at 320 px. Data tables and the PDF scroll in their own regions (two-dimensional content is exempt). |
| 1.4.11 Non-text contrast | Partially supports | The focus ring is translucent royal, about 2.3:1 (finding 12, open). Input borders and controls meet 3:1. Highlight fills: see Known limitations. |
| 1.4.12 Text spacing | Supports | No fixed-height text containers clip with increased spacing, except the field values drawn on the PDF, which mirror the printed form. |
| 1.4.13 Content on hover or focus | Supports | Tooltips are the browser's own (`title`); popovers open on click and close with Escape. |
| 2.4.5 Multiple ways | Supports | Sidebar, command palette (⌘K), search. |
| 2.4.6 Headings and labels | Supports | |
| 2.4.7 Focus visible | Supports | Every focusable element shows the ring; its contrast is under 1.4.11 above. |
| 3.1.2 Language of parts | Supports | |
| 3.2.3 Consistent navigation | Supports | |
| 3.2.4 Consistent identification | Supports | |
| 3.3.3 Error suggestion | Supports | Format errors say what’s expected (“Use a real date, like 04/18/1971.”). |
| 3.3.4 Error prevention (legal, financial, data) | Supports | Pre-send checks, signer review on Send, confirm before void; nothing is sent until the advisor sends it. |
| 4.1.3 Status messages | Supports (pending screen-reader check) | Toasts are a polite live region; announcements and connection banners use `status`/`alert`. |

## Screen-reader test script

Run in the Power Apps host from a Contact form, with the demo data or a test contact. For each step note what's announced and anything missing.

1. **Find forms.** Tab past “Skip to content”; land in the screen. Search for a form, add two to the packet with the add buttons, star one. Expect the toggle state (“pressed”) to be announced.
2. **Review.** Open Review. Arrow between the form tabs; expect “Beneficiary designation, 1 to fill, tab, selected”. Tab into the PDF; expect “Page 1 of 2, group”, then each field in reading order: label, value, and “needs input”/“invalid”/“from CRM”. Press Enter on one that needs input; expect focus in its input, announced as required and invalid, with its check (for example “To fix: Primary beneficiary shares must total 100%”).
3. **Checks before send.** Move through the list; expect “Passed:”/“Note:”/“To fix:” before each. Activate a “To fix” row; expect focus on the field.
4. **Send.** Add a signer from the client's connections, pick the verification, set the order. Send; expect the toast to be read.
5. **Signature requests.** Open a request's details, read the audit trail, resend a reminder.
6. **Administration.** Templates: Tab to a form name and open it. In the editor, Tab through the mapping table; expect each row's inputs to be labelled with the PDF field name. Add a signature tab with “Place on page”, then select it from the list.
7. Repeat steps 1–3 at **200%** and **400%** browser zoom, and with **Windows High Contrast / forced colors** on.
