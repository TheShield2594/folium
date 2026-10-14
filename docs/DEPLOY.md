# Deploying Folium to Power Platform

Folium is a [Power Apps code app](https://learn.microsoft.com/power-apps/developer/code-apps/). Without data sources it runs in demo mode, so you can build and look at it before any of this is done.

## Prerequisites

- Power Platform environment with Dataverse and **code apps enabled** (Power Platform admin center › Environments › Settings › Features).
- Users licensed for Power Apps Premium (Dataverse + premium connectors).
- Power Platform CLI (`pac`) 1.46 or later, Node 20+.

## 1. Initialise

```bash
npm install
pac auth create --environment <environment-url>
pac code init --displayName "Folium"     # writes power.config.json
```

Commit `power.config.json`. Set `appSettings.showHeader` to `false` so Folium's own toolbar is the only one.

## 2. Create the tables

Create the tables in [DATAVERSE.md](DATAVERSE.md) in a Folium solution. Add a Folium security role (read on contact, financial account, connection, document location; full access to the `ev_` Folium tables at the levels described in the security issue).

## 3. Add data sources

```bash
# Dataverse tables
for t in contact ev_financialaccount connection systemuser sharepointdocumentlocation \
         ev_formtemplate ev_signaturerequest ev_formpacket ev_foliumprofile ev_foliumgroup \
         ev_foliumsetting ev_formrequest; do
  pac code add-data-source -a dataverse -t $t
done

# SharePoint (template library + contact folders)
pac code add-data-source -a "shared_sharepointonline" -c <connection-id>

# DocuSign custom connector (step 4)
pac code add-data-source -a "<custom-connector-api-name>" -c <connection-id>
```

Then point `src/services/power/dataSourcesInfo.ts` at the generated file:

```ts
export { dataSourcesInfo } from '../../../.power/schemas/appschemas/dataSourcesInfo';
```

Check the names in `src/services/power/config.ts` against what `pac` generated (`CONNECTORS.sharePoint`, `CONNECTORS.docuSign`, table names, the SharePoint site URLs).

## 4. DocuSign custom connector

Import `connectors/folium-docusign.swagger.json` as a custom connector (Power Apps › Custom connectors › Import an OpenAPI file):

1. Host: `www.docusign.net` for production or `demo.docusign.net` for the developer sandbox. Base path `/restapi/v2.1/accounts/{accountId}`; set the account ID as a policy or connection parameter.
2. Security: OAuth 2.0, DocuSign authorization code grant (client ID/secret from DocuSign Admin › Apps and Keys; scope `signature`). Add the connector's redirect URL to the DocuSign app.
3. Operations used by Folium: `CreateEnvelope` (as a draft, `status: created`), `GetEnvelope`, `UpdateEnvelope` (send the draft / void / resend), `UpdateRecipients`, `CreateRecipientView` (in-session signing), `GetDocument` (`combined`, `certificate`).
4. In DocuSign Admin › Identity Verification, note the workflow IDs for **SMS**, **Phone authentication** and **ID Check (KBA)** and put them in `DOCUSIGN.idv` in `config.ts`. A method whose ID is blank can't be sent (Folium says so instead of sending with weaker verification).
5. In-session signing needs embedded signing on the DocuSign plan. DocuSign sends the signer back to Folium's `#/signing-return` route with `event=…`; that URL is built from where the app runs, so check it once the hosting decision (#3) is made.
6. Optional: set `DOCUSIGN.consentUrl` to the DocuSign consent link for the Folium app, so a `consent_required` answer offers it to the advisor instead of a generic error.
7. Size limits: Folium caps supporting documents at 10 per envelope and 30 MB in total by default (Administration › Settings › Envelopes), and shows the envelope's size on the Send screen. The bytes are base64-encoded into one `CreateEnvelope` request, about a third larger than the files. Before relying on 30 MB, confirm DocuSign's per-document and per-envelope limits and the custom connector's request size limit for Everence's plan, and lower the firm limit if either is smaller.
8. One DocuSign account. Folium uses a single connection (`CONNECTORS.docuSign`), whose account ID is fixed in the connector. If Everence ever needs a second account (Laser App lets a user pick between two), add a second connection and choose it by group behind the same `SigningProvider`; no screen changes are needed. Ask whether anyone needs one before building it.

Access codes need no setup. Folium sends the code with the envelope and saves only that one was set (`accessCodeSet`), never the code.

This answers spike 2: envelopes are created from Folium's own PDF bytes with tabs placed by page + x/y, so the standard DocuSign connector isn't needed.

## 5. Status updates (DocuSign Connect)

Create a Power Automate flow:

1. Trigger: *When an HTTP request is received* (or the DocuSign connector's *When an envelope status changes (Connect)*).
2. Find the `ev_signaturerequest` row by `ev_envelopeid`.
3. Update `ev_status` (`sent`→Sent, `delivered`→Viewed, `completed`→Signed, `declined`→Declined, `voided`→Voided, or **Expired** when `voidedReason` mentions expiry), `ev_signedon`, `ev_expireson` (from `expireDateTime`), and append to the audit in `ev_payload` (set `status`, `expiresOn` and `voidedReason` there too). Write the option values from `SIGNATURE_STATUS_OPTIONS` in `config.ts`, the same ones `mapDocuSignStatus` in `src/domain/requests.ts` implies. Confirm DocuSign's expiry wording in the sandbox before relying on it.

Optional: a scheduled flow that emails (or messages in Teams) the owning advisor when an open request's `ev_expireson` is 7 days away, with the client's name and a link.

Add the flow's URL as a Connect configuration in DocuSign Admin. Until it exists, **Check status** on each request polls DocuSign, which is the brief's acceptable v1 fallback.

## 5a. Draft retention (clean-up flow)

Drafts hold SSNs, account numbers and beneficiary details, so Folium deletes unsent drafts a set time after their last save (Administration › Settings › Draft retention: 90 days by default, or 60, 30, 10, 7, or 0 for no drafts at all). Every save restarts the clock, and Folium writes the date to `ev_expireson`. Ask Compliance for the period, and whether 0 should be allowed.

Create a scheduled Power Automate flow, run daily as a service account with delete rights on `ev_signaturerequest` and the CRM SharePoint site (Users don't have them; see #1):

1. **List rows** on `ev_signaturerequests`: `ev_status eq <Drafted option value> and ev_expireson lt @{utcNow()} and ev_envelopeid eq null`. Read `statecode` 0 and 1, so drafts already deleted in Folium (soft-deleted, waiting on Undo) are removed for good too.
2. For each row, parse `ev_payload`. Skip it if `inPerson` is true (a printed packet is a record, not abandoned work). Delete each file in `draftFiles[].url` and each `attachments[].storedAt.itemId` from the contact's SharePoint folder (*Delete file*; a file that's already gone is fine), then delete the row.
3. **Mid-send rows:** a `Drafted` row with an `ev_envelopeid` is a send that stopped after DocuSign created the envelope; step 1 skips it and it has no draft expiry. List these rows (`ev_status eq <Drafted> and ev_envelopeid ne null`) for an administrator to review weekly. Opening the draft in Folium offers **Finish sending**, which checks DocuSign first. If DocuSign already sent the envelope, record it as sent. If the envelope is abandoned, void it in DocuSign, then delete the row and its files, or clear `ev_envelopeid` and `envelopePhase` and set `ev_expireson` to today so the clean-up removes it.
4. **Reminder:** a third branch lists the same rows with `ev_expireson` between 6 and 7 days from now and emails the owner (`ownerId`), the preparer (`preparedById`) and anyone in `sharedWith`: "Your draft “{title}” for {client} will be deleted on {date}. Open and save it to keep it," with a link to Folium's Drafts screen (`…/#/drafts`). Opening and saving the draft renews it.

**Backfill, once at rollout.** Drafts saved before retention shipped have no `ev_expireson`. Run the flow once with a step that sets it to the last-saved date (the last audit entry's `at`) plus the retention period, but never less than 14 days after rollout, so nothing disappears without a warning email first. Shortening the period later applies at each draft's next save, never to drafts already past their date.

**Backstops.** A Dataverse bulk-delete job on the same filter catches rows the flow misses, and a Purview retention label with auto-delete on files named `DRAFT *` in the CRM library catches stray PDFs. Signed requests aren't affected: their retention stays with OnBase.

Deleting a draft in Folium already removes its DRAFT PDFs (`DraftStore.removeFile`) and soft-deletes the row so Undo works; its attachments stay until this flow deletes the row.

## 5b. Out-of-date drafts (optional notification)

Folium marks drafts whose forms have a newer Live revision ("1 of 3 forms updated", "Out of date") and offers **Update to current forms** when one is opened. To tell advisors sooner, add a flow triggered when an `ev_formtemplate` row's `ev_status` changes to Live: list Drafted `ev_signaturerequest` rows whose `ev_payload` contains the superseded template's ID (the new row's `supersedesId`), group them by owner, and send each a Teams or Outlook note: "2 of your drafts use a form that changed." No app change is needed.

## 6. Put it on the Contact form

Spike 1 decides which of these you use:

- **Embedded (preferred):** add a *Forms* tab to the Contact main form with an iframe/web resource pointing at the app's play URL, passing the record ID: `…/play/e/<env>/app/<appId>?contactId={recordId}`. Folium reads `contactId` from the query string or from `getContext().app.queryParams`.
- **Standalone:** a ribbon-free *Forms* button or link on the Contact form that opens the play URL with `contactId`.
- **Fallback:** a custom page or PCF control hosting the same bundle.

## 6a. Firm policy and privacy

Administration › Settings holds the firm-wide rules (the "Policy" row in `ev_foliumsetting`): who can share drafts (off, within groups, anyone), whether advisors can work as another advisor in their groups (rep data), which PDFs can leave Folium (all, signed envelopes only, none), draft retention and envelope limits. Ask Compliance for the `pdfDownload` default and whether sharing with "anyone" should be offered at all. Everence's Laser App setup matches the defaults: sharing within groups, rep data for assistants only, downloads allowed.

The screens apply these rules straight away. Dataverse enforces them with #1: sharing through `GrantAccess` only to members of the owner's group teams, and profile rep fields readable through group teams rather than by every user. Until then every profile is loaded into the browser at sign-in.

Turning sharing off doesn't take back drafts already shared: they stay with those people until they're sent, deleted or expire under retention.

**Location data is not collected.** Laser App can collect end-user location (never, opt-in or opt-out; Everence uses never). Folium has no such setting and doesn't ask the browser for location anywhere: nothing in the forms workflow needs it. Note this for the privacy review.

## 7. Build and publish

```bash
npm run build
pac code push
```

Share the app with the Folium security group. Admins then: set the Firm profile and Settings (sharing, downloads, retention), create groups, give each person a role, and map the first templates (Template library › New from Marketing).

## Fonts

Folium asks for Frutiger (text) and Sabon (display), falling back to Verdana and Times as the brand guidelines allow. Where Everence's licence covers web use, add the `.woff2` files to `public/fonts/` and declare them with `@font-face` in `src/styles/tokens.css` using the family names already in `--font-text` and `--font-display`.
