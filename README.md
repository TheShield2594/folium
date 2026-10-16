# Folium

Everence's replacement for LaserApp Anywhere. Advisors pick forms from a client's contact record, Folium prefills them from Dynamics 365, checks them for anything not in good order, and sends them for signature with DocuSign. Templates come straight from Marketing's SharePoint library, so they're always current.

*Folium* is Latin for leaf — a leaf from the Everence vine.

![Find forms](docs/screenshots/find-forms.png)

| Review | Send |
|---|---|
| ![Prefill and review](docs/screenshots/review.png) | ![Signers and send](docs/screenshots/send.png) |
| **Signature requests** | **Template editor** |
| ![Signature requests](docs/screenshots/requests.png) | ![Template editor](docs/screenshots/template-editor.png) |

## Try it

**Live demo:** https://theshield2594.github.io/folium/ — sample data only, rebuilt from `main` on every push.

```bash
npm install
npm run dev        # http://localhost:5173 — demo mode, sample clients and forms
npm test           # domain and PDF tests
npm run build
VITE_FOLIUM_DEMO=1 npm run build && npm run test:a11y  # WCAG 2.1 AA checks (axe + Playwright) on the demo build
```

Demo mode needs nothing else: sample clients, a template library of generated AcroForm PDFs, and a simulated DocuSign that moves envelopes from Sent to Viewed to Signed over a couple of minutes. In **Settings › Demo mode** you can switch between an advisor, an assistant and an administrator. Add `?contactId=c-priya` (or `c-eli`, `c-grace`) to open a different client, the way the Contact form will. To try the recovery paths, add `?fail=offline`, `slow`, `auth` or `server` (failures start 10 seconds after launch; change with `&failAfter=`), or `?fail=send` / `?fail=release` to lose DocuSign's reply to the first envelope.

## What's in it

- **Today** — the home when Folium opens without a client: what needs you across every client (drafts not in good order, declined, lapsing or unfiled requests, a first RMD this year, accounts with no beneficiary on file, new revisions of forms in your saved packets) and the latest requests out for signature. **Start a packet** builds a packet from a description ("rolling her Fidelity 401(k) into an IRA"), using the client's Dynamics 365 accounts, and Review says why each form was added. Hide it in Settings.
- **Find forms** — search by name, number or keyword; suggested from the client's accounts; favorites, recent, saved packets; ask Marketing for a missing form.
- **Prefill & review** — the real PDF with highlights for what came from CRM, what needs input, and where signers sign. Enter a value once and it fills every form that uses it. Pre-send checks catch "not in good order" problems, with one-click fixes where Folium can make them (the Dynamics 365 value back in a cleared field, shares split evenly), an "In good order" meter, and Signers closed until nothing blocks. Download an editable (fillable) or flattened PDF, attach supporting documents, save a draft, share it with a colleague.
- **Signers & send** — signers from the template roles and the client's connections, signing order, SMS/KBA/email verification, message, reminders, expiration.
- **Signature requests** — Drafted → Sent → Viewed → Signed → In OnBase with audit trail, resend, correct signer, void, download signed PDF + certificate.
- **Contact & accounts** — fix the client's Dynamics 365 record in place.
- **Settings** — your own profile (from your Microsoft profile, with Folium overrides), sending defaults, appearance.
- **Administration** — template library with revision diff and carry-over, signature tab placement, check rules, test with a real contact, publish on an effective date; form feedback (requests for new forms and advisors' problem reports, straight to the field in the editor); users (status and last sign-in, bulk changes, CSV import and export), groups (role, region, default firm profile and e-signature connection), firm profiles (one per Everence entity, picked by each form’s issuer), announcements across the top of Folium, and e-signature connections with the DocuSign account (each person sends from their own DocuSign login; each request remembers the connection that sent it).
- **Reports** — form use, e-signature steps and blocked sends are recorded per form and revision (`ev_usageevent`) for a Power BI report, opened from the sidebar by Admins and the reporting role. The report's Power BI project is in `reports/`.
- **Readiness** — Administration › Readiness checks what Folium can of the switch from Laser App (top companies' forms Live, users and groups, firm and advisor data, DocuSign, policy) and shows the pilot's numbers and forms ranked by use.
- **Roles** — User, Assistant (works on behalf of the Users in their groups, like LaserApp Anywhere) and Admin.

See [docs/PARITY.md](docs/PARITY.md) for the feature-by-feature comparison with LaserApp Anywhere.

## Design

Layout and behaviour follow Apple's Human Interface Guidelines — sidebar, toolbars, inspectors, sheets, segmented controls, 44 pt targets, light and dark appearance, reduced motion, WCAG 2.1 AA ([audit](docs/ACCESSIBILITY.md)). Look follows the Everence Brand Guidelines (tokens in `src/styles/tokens.css`):

- **Type:** Frutiger for everything, headlines in Frutiger Bold; Sabon Italic only for disclosures (`.t-disclosure`). Verdana and Times are the fallbacks.
- **Shape:** one rounded corner per shape, top-left, sized from the 24px margin (`--r-panel`, `--r-card`, `--r-ctl`, `--r-chip`). Avatars, status dots, count badges and progress ends stay round.
- **Color:** navy text and count badges, grass for primary actions, royal for links and the current step, solid sage sidebar, mist for assist panels; pumpkin only as a status dot.
- **Gradients:** only the four approved pairs (`--grad-green` and friends): green for the good-order meter and Start a packet.
- **Brandmark:** the sidebar shows the approved Everence brandmark from `public/brand/everence-brandmark.svg` (supplied by Marketing, not in this repo) with the Folium name below it as plain text.
- **Icons:** one 1.5px stroke.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Deploying to Power Platform](docs/DEPLOY.md)
- [Dataverse schema](docs/DATAVERSE.md)
- [Reports](docs/REPORTS.md)
- [Replacement readiness](docs/READINESS.md)
- [Accessibility (WCAG 2.1 AA audit and conformance)](docs/ACCESSIBILITY.md)
- [DocuSign custom connector](connectors/folium-docusign.swagger.json)
