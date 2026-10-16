# Architecture

```
Contact form (D365) ──► Folium (Power Apps code app: React + TypeScript + Vite)
                          │
                          ├─ domain/        pure logic: prefill, checks, signers, revision diff, formats
                          ├─ pdf/           pdf-lib fill/inspect/merge · pdf.js rendering
                          ├─ services/      interfaces + two implementations
                          │    ├─ demo/     in-browser data, generated template PDFs, simulated DocuSign
                          │    └─ power/    Dataverse tables, SharePoint + DocuSign connectors (@microsoft/power-apps)
                          ├─ state/         zustand store: user, acting-for, client, packet, favorites
                          ├─ shell/         sidebar, toolbar, contact picker, ⌘K palette
                          └─ screens/       library, review, send, requests, client, settings, admin
```

## Data flow for one packet

1. **Pick.** The store holds `packet.items` (template + account). `currentTemplates()` only offers the Live revision whose effective date has arrived, filtered by the user's groups.
2. **Prefill.** `prefillPacket()` resolves each field's `source` (`contact.*`, `account.*`, `connection[Role].*`, `rep.*`, `firm.*`, `computed.*`) against the client record. `firm.*` reads the firm profile for each form's issuer (`firmFor`), so a trust form and a Praxis form in one packet each get their own entity. Advisor entries live in `packet.values`, keyed by the field's canonical key, so one value fills every form that shares it.
3. **Check.** `runChecks()` returns pass/warn/block results: current revisions, required fields, formats, template rules (`sumEquals`, `oneOf`, `requiredIf`, `pattern`), and flat-PDF warnings.
4. **Review.** `PdfView` renders the blank template with pdf.js and overlays values and highlights in HTML, so typing is instant. Field rectangles come from the PDF's own widgets (`inspectPdf`) or, for scanned PDFs, from overlay rects in the mapping.
5. **Output.** `fillPacket()` fills with pdf-lib: editable (fillable download, drafts) or flattened (e-signature, in-person).
6. **Send.** `providerFor()` picks the e-signature connection (firm profile, group, firm default) from `services.signing`, a registry of connections; its `capabilities` decide what the Send screen offers. `rolesForPacket()` + `assignSigners()` build signers from template roles and CRM connections. `buildEnvelopeDefinition()` turns neutral placements (page + x/y in points from the top-left) into DocuSign tabs. The request is saved as an `ev_signaturerequest` row.
7. **Track.** Every request action goes through `services.signing.get(request.provider)`, the connection that sent it. Status comes from DocuSign Connect (Power Automate updates the row) or Check status (polling). Signed requests wait for the "Uploaded to OnBase" tick.

## Today and Start a packet

- **Today** (`screens/today`) reads the advisor's requests (`requests.listMine`) and the clients they're about plus recent contacts, then asks `domain/prompts.ts` what needs them: drafts with blocking checks (re-run with `runChecks`), requests that are declined, lapsing or waiting for OnBase, CRM prompts (first RMD year by SECURE 2.0 age, accounts with no beneficiary) and new revisions of forms in saved packets. Folium lands here unless it was opened with `?contactId=`.
- **Start a packet** (`domain/startPacket.ts`) is deterministic: intents recognised by keyword, forms found by name and Marketing's keywords, the client's accounts deciding what's needed (no application when the client already holds the IRA a rollover goes into). It only picks templates, never form content, and every form carries a sentence saying why; `packet.reasons` keeps them for Review. An LLM classifier (through a Power Automate flow, returning template IDs only) could replace the matcher later behind an admin setting.
- **Check fixes.** A `CheckResult` can carry a `fix`: a patch for `packet.values` (a key set to `undefined` drops the override, so the CRM value returns). `applyFix` applies it, records the resolved label in `packet.resolved` and returns an undo. `goodOrder()` scores the packet (warnings count half); blocking checks keep Signers closed.

## Why these choices

- **Overlay preview, pdf-lib output.** Re-filling a PDF on every keystroke is slow; the overlay is exact enough to review and the real fill happens once.
- **Placements, not anchors.** Tabs are stored by page and coordinates, so a vendor switch means a new converter in `services/docusign/tabs.ts` (or a sibling), not remapping every form.
- **One JSON payload column per Folium row.** Folium's own tables keep a few indexed columns (status, contact, envelope ID) plus `ev_payload`. The shape can grow without solution upgrades.
- **Demo mode is a first-class implementation.** It runs the same domain code against generated AcroForm PDFs, so the UI, tests and stakeholder demos don't need an environment.

## Roles and sharing

| Role | Can |
|---|---|
| User | Work on their own clients; share drafts; save and share packets with their groups |
| Assistant | Everything a User can, on behalf of any User in a group they belong to (chosen in the sidebar). Requests record `preparedById` and `ownerId`. |
| Admin | Template library, mapping and publishing, users and groups, firm profile |

Groups can limit which sources and categories of forms their members see. **The UI enforces this today; Dataverse row security must enforce it in production** (see the open issue).

## Tests

`npm test` runs the domain and PDF tests (prefill, enter-once keys, checks, signer rules, revision diff, DocuSign envelope shape, generate/inspect/fill/flatten/merge).
