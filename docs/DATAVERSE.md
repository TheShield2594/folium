# Dataverse schema

Use Everence's publisher prefix if it isn't `ev_`, and change `src/services/power/config.ts` to match. Every Folium-owned table stores its full record in `ev_payload` (multiline text, 1,048,576 chars) plus the indexed columns below.

## ev_formtemplate — one row per template revision

| Column | Type | Notes |
|---|---|---|
| ev_name | Text | Form name |
| ev_formnumber | Text (indexed) | e.g. `EV-1120` |
| ev_status | Choice | Draft · Needs mapping · Live · Retired |
| ev_payload | Multiline | `FormTemplate` JSON incl. mapping (fields, signers, placements, checks), revision, effective date, SharePoint item ID, supersedes |

## ev_signaturerequest — one row per packet

| Column | Type | Notes |
|---|---|---|
| ev_name | Text | Title |
| ev_contact | Lookup → contact | |
| ev_status | Choice | Drafted · Sent · Viewed · Signed · Declined · Voided · Expired. Option values 100000000 upward in this order; `SIGNATURE_STATUS_OPTIONS` in `config.ts` must match. |
| ev_expireson | Date/time (indexed) | On a sent request, when the envelope lapses: set on send, then from DocuSign's `expireDateTime`. On an unsent draft, when draft retention deletes it: the last save plus the firm's retention period (`draftRetentionDays`). Empty for drafts the clean-up never deletes (printed to sign in person, or mid-send with an `ev_envelopeid`). For "expiring this week" views, the reminder flows and the draft clean-up flow (DEPLOY.md §5a). |
| ev_provider | Text | `DocuSign` |
| ev_envelopeid | Text (indexed) | For Connect updates |
| ev_senton / ev_signedon | Date/time | |
| ev_uploadedtoonbase | Yes/No | Manual in v1 |
| ev_owner | Lookup → systemuser | The User whose client it is (`ownerId`). For reporting and row ownership (#1). |
| ev_preparedby | Lookup → systemuser | Who prepared it: the owner, or an Assistant for them (`preparedById`). |
| ev_viewedon | Date/time | When a signer first opened it |
| ev_inperson | Yes/No | Printed to sign in person |
| ev_formcount | Whole number | Forms in the packet |
| ev_payload | Multiline | `SignatureRequest` JSON: documents + revisions, signers, values entered, attachments metadata (`storedAt` for the SharePoint copy), `draftFiles` (the DRAFT PDFs written to the contact's folder, for clean-up), owner/preparer, sharedWith, audit |

`ev_owner`, `ev_preparedby`, `ev_viewedon`, `ev_inperson` and `ev_formcount` copy values that are also in the payload, so Power BI and model-driven views can use them (`requestRow` in `src/services/power/rows.ts` fills them on every save). Rows saved before them have them empty until their next save.

Later: `ev_onbasehandle` (phase 2).

## ev_formpacket — saved packets

`ev_name`, `ev_shared` (Yes/No), `ev_payload` (`SavedPacket`: template IDs, owner, groupIds, usage count).

## ev_foliumprofile — one row per Folium user

`ev_user` (Lookup → systemuser), `ev_role` (Choice: User · Assistant · Admin), `ev_name`, `ev_payload` (`UserProfile`: rep code, OSJ and RIA numbers, branch, region, defaults, sign-off, groupIds, office address, `canEditRepData`, `canViewReports` (the reporting role), `repDataAudit`, `lastSeenOn`). `statecode` 1 (Inactive, `statuscode` 2) is a profile an Admin deactivated: it's kept, so requests keep their owner.

The payload stores only what Folium overrides. Name, middle name, email, phone, fax, mobile and title are read from the user's `systemuser` row (`fullname`, `middlename`, `internalemailaddress`, `address1_telephone1`, `address1_fax`, `mobilephone`, `title`) every time, and `isdisabled` marks someone who has left. Folium users need read access to those `systemuser` columns. A Compliance view on `ev_foliumprofile` (name, role, status, modified on) can be opened in Excel for audits; Users & groups also downloads the list as CSV.

## Contact: ID documents (to confirm)

If Everence keeps driver's licence, passport, green card or citizenship columns on `contact`, name them in `ID_DOCUMENT_COLUMNS` (`src/services/power/config.ts`) and add the number columns to the same field security profile as `ev_ssn`. Folium reads them for the client and the Spouse connection (`id.client.*`, `id.spouse.*`) and never writes them.

## ev_foliumgroup

`ev_name`, `ev_region`, `ev_payload` (`UserGroup`: members, source/category limits).

## ev_foliumsetting — one row per kind of setting

Folium finds each row by `ev_name`; changing them needs no release, and Dataverse auditing on the table records who changed what.

- `ev_name` = "Firm", `ev_payload` (`FirmProfile`): firm data for `firm.*` fields, the envelope disclosure, Send screen defaults (`sending`: `defaultAnyOrder`, `subjectTemplate`, `messageTemplate`), `blockFillableWhenIncomplete`, `idleAutoSave`, `reportsUrl` (the Power BI report the sidebar's Reports link opens). Administration › Firm profile. (#26 turns this into one row per Everence entity.)
- `ev_name` = "Policy", `ev_payload` (`FirmPolicy`): firm-wide rules shared by every firm profile: `sharing` (`off` · `groups` · `anyone`, default `groups`), `repDataVisibility` (`assistants` · `groupMembers`, default `assistants`), `pdfDownload` (`all` · `signedOnly` · `none`, default `all`), `draftRetentionDays` (90 default, 60, 30, 10, 7 or 0), `lockMessage`, `maxAttachments`, `maxAttachmentsMB`, `usageRetentionMonths` (36 default; drives the `ev_usageevent` bulk-delete job, DEPLOY.md §5c). Administration › Settings. A missing row means every default.
- `ev_name` = "DocuSign", `ev_payload` (`DocuSignSetup`): `environment` (`demo` · `production`), `accountId` (API Account ID), `integrationKey` (client ID, for the consent link only), `redirectUrl`, `idv` (`sms`, `phone`, `kba` workflow IDs). Administration › Settings › DocuSign. No secrets: the client secret stays in the custom connector. A missing row means DocuSign isn't set up and nothing can be sent.

## ev_formrequest — form feedback

Requests for forms that aren't in the library ("Ask Marketing to add it") and problem reports on forms that are (Review › Report a problem, or "Something wrong with this field?"). Administration › Form feedback lists both.

| Column | Type | Notes |
|---|---|---|
| ev_name | Text | The form's name |
| ev_issuer | Text | Company |
| ev_note | Multiline (2,000) | The advisor's note |
| ev_requestedby | Text | The requester's name. The only requester column on rows from before feedback; Folium still shows those rows. |
| ev_requester | Lookup → systemuser | Who sent it (new rows) |
| ev_kind | Choice | Request · Problem (100000000 upward; `FEEDBACK_KIND_OPTIONS` in `config.ts`) |
| ev_status | Choice | New · In progress · Fixed in revision · Won't fix · Duplicate (`FEEDBACK_STATUS_OPTIONS`). Empty on old rows, which read as New. Folium reads this column over the payload, so a flow or view can change it. |
| ev_template | Lookup → ev_formtemplate | Problems: the revision reported |
| ev_formnumber / ev_revision | Text | Copied from the template, so a report survives its template |
| ev_category | Text | Problems: `wrongValue` · `missingField` · `layout` · `outdated` · `signature` · `other` |
| ev_resolvedon | Date/time | When it was closed |
| ev_payload | Multiline | `FormFeedback` JSON: the above plus `fieldKeys` (PDF field names), `resolution` (the reply the advisor sees), `fixedInTemplateId` and an allow-listed `detail` (the packet's other form numbers, the account type, the PDF kind) |

Never field values: `problemReport` in `src/domain/feedback.ts` has nowhere to put one. Advisors need Create on the table and Read on their own rows (`ev_requester` = them, for "Forms you reported" in Settings); Admins need org-wide Read and Write.

## ev_usageevent — what happens to forms, for reporting

One row per event per form: a packet sent with 3 forms writes 3 rows sharing `ev_batchid`, so "uses of EV-1120" is a plain count. Written by Folium in the background (`src/services/usage.ts`) and by the Connect flow for status events. No payload, and nothing about the client except the contact lookup. See [REPORTS.md](REPORTS.md) for how the report reads it.

| Column | Type | Notes |
|---|---|---|
| ev_name | Text | `<event> <form number>`, for views |
| ev_eventtype | Choice | form.added · pdf.fillable · pdf.flattened · pdf.print · draft.saved · send.blocked · request.sent · request.viewed · request.signed · request.declined · request.voided · request.expired · request.inperson. 100000000 upward in this order; `USAGE_EVENT_OPTIONS` in `config.ts` must match. |
| ev_occurredon | Date/time (indexed) | The device's clock for app events; DocuSign's time for status events |
| ev_user | Lookup → systemuser | Who did it (for status events, the request's preparer) |
| ev_actingfor | Lookup → systemuser | The User an Assistant (or colleague) worked for; empty when it's the same person |
| ev_template | Lookup → ev_formtemplate | The revision used |
| ev_formnumber / ev_revision | Text | Copied from the template, so retired revisions still report |
| ev_source / ev_issuer / ev_category | Text | As on the template at the time |
| ev_region / ev_groups | Text | From the user's profile at the time (groups as names, `; `-separated) |
| ev_contact | Lookup → contact | The client; no names, values or account numbers anywhere on the row |
| ev_request | Lookup → ev_signaturerequest | When there is a saved request |
| ev_batchid | Text | Rows from one action |
| ev_dedupekey | Text (**alternate key**) | `<scope>\|<event>\|<template ID>\|<position>`. The scope is the request ID for status events (viewed, signed, declined, voided, expired) and the batch ID otherwise. A second row with the same key is refused, so Check status and the Connect flow can both report a status safely; Folium treats that refusal as done. |
| ev_detail | Text (2,000) | JSON with allow-listed keys only: `mode` (fillable · fillable-draft · flatten · print), `signerCount`, `auth`, `blockingChecks` (check IDs without the packet item, e.g. `required`, `check:0`, `state`) |

Create the alternate key on `ev_dedupekey` before Folium writes to the table. Security: Folium users get **Create** and no organisation-wide Read, Write or Delete. If the Power Apps SDK reads a created row back (check once in the test environment: a create that fails with a privilege error on Read), add Read at User level, which only covers their own rows. A **Folium Reporting** role gets organisation-wide Read, and Admins have it too. Retention: a bulk-delete job removes rows older than the firm's `usageRetentionMonths` (DEPLOY.md §5c). Volume: Laser App's 55,374 form uses a year suggest about 200,000–300,000 rows a year across all event types; make it an elastic table if that grows.

## Existing tables Folium reads

- `contact` — standard columns plus `ev_ssn`, `ev_clientid`, `ev_region`, `ev_employer`
- `ev_financialaccount` (or Everence's account table) — `ev_accountno`, `ev_accounttype`, `ev_custodian`, `ev_balance`, lookup `ev_contactid`
- `connection` — `record1id` = the client, `record2id` = the related contact, `record2roleid` = Spouse / Joint owner / Trusted contact / Insured; optional `ev_sharepct`
- `sharepointdocumentlocation` — the contact's document folder for drafts
- `systemuser` — `azureactivedirectoryobjectid` to find the signed-in user

## Security (to do before production)

See the "Enforce Folium roles, groups and sharing with Dataverse security" issue. In short: owner teams per Folium group, row ownership on `ev_signaturerequest` by the advising User, sharing via `GrantAccess` for `sharedWith`, and field security on `ev_ssn`. For reporting: Create-only on `ev_usageevent` for everyone, and a Folium Reporting role (organisation-wide Read on `ev_usageevent`, `ev_signaturerequest`'s promoted columns, `ev_formtemplate`, `ev_foliumprofile` and `ev_foliumgroup`) for managers; manager scoping by group comes from the same owner teams.
