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
| ev_payload | Multiline | `SignatureRequest` JSON: documents + revisions, signers, values entered, attachments metadata (`storedAt` for the SharePoint copy), `draftFiles` (the DRAFT PDFs written to the contact's folder, for clean-up), owner/preparer, sharedWith, audit |

Later: `ev_onbasehandle` (phase 2).

## ev_formpacket — saved packets

`ev_name`, `ev_shared` (Yes/No), `ev_payload` (`SavedPacket`: template IDs, owner, groupIds, usage count).

## ev_foliumprofile — one row per Folium user

`ev_user` (Lookup → systemuser), `ev_role` (Choice: User · Assistant · Admin), `ev_name`, `ev_payload` (`UserProfile`: rep code, branch, region, defaults, sign-off, groupIds).

## ev_foliumgroup

`ev_name`, `ev_region`, `ev_payload` (`UserGroup`: members, source/category limits).

## ev_foliumsetting — one row per kind of setting

Folium finds each row by `ev_name`; changing them needs no release, and Dataverse auditing on the table records who changed what.

- `ev_name` = "Firm", `ev_payload` (`FirmProfile`): firm data for `firm.*` fields, the envelope disclosure, Send screen defaults (`sending`: `defaultAnyOrder`, `subjectTemplate`, `messageTemplate`), `blockFillableWhenIncomplete`, `idleAutoSave`. Administration › Firm profile. (#26 turns this into one row per Everence entity.)
- `ev_name` = "Policy", `ev_payload` (`FirmPolicy`): firm-wide rules shared by every firm profile: `sharing` (`off` · `groups` · `anyone`, default `groups`), `repDataVisibility` (`assistants` · `groupMembers`, default `assistants`), `pdfDownload` (`all` · `signedOnly` · `none`, default `all`), `draftRetentionDays` (90 default, 60, 30, 10, 7 or 0), `lockMessage`, `maxAttachments`, `maxAttachmentsMB`. Administration › Settings. A missing row means every default.

## ev_formrequest

`ev_name`, `ev_issuer`, `ev_note`, `ev_requestedby` — "Ask Marketing to add it".

## Existing tables Folium reads

- `contact` — standard columns plus `ev_ssn`, `ev_clientid`, `ev_region`, `ev_employer`
- `ev_financialaccount` (or Everence's account table) — `ev_accountno`, `ev_accounttype`, `ev_custodian`, `ev_balance`, lookup `ev_contactid`
- `connection` — `record1id` = the client, `record2id` = the related contact, `record2roleid` = Spouse / Joint owner / Trusted contact / Insured; optional `ev_sharepct`
- `sharepointdocumentlocation` — the contact's document folder for drafts
- `systemuser` — `azureactivedirectoryobjectid` to find the signed-in user

## Security (to do before production)

See the "Enforce Folium roles, groups and sharing with Dataverse security" issue. In short: owner teams per Folium group, row ownership on `ev_signaturerequest` by the advising User, sharing via `GrantAccess` for `sharedWith`, and field security on `ev_ssn`.
