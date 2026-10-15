# Folium usage report (Power BI project)

The Power BI report described in [docs/REPORTS.md](../docs/REPORTS.md), saved as a Power BI Project (`.pbip`) so changes are reviewed like code. Open `Folium.pbip` in Power BI Desktop (with **File › Options › Preview features › Power BI Project (.pbip) save option** on in older versions).

**Status: not yet opened in Power BI Desktop.** Everything here was written by hand from REPORTS.md and checked against the reference definitions in `src/domain/reports.ts` on paper only. The first person to open it should expect to fix small things, then save it back from Desktop so the files take Desktop's own form.

## What's here

| Path | What it is |
|---|---|
| `Folium.SemanticModel/definition/` | The model in TMDL: tables, relationships and every measure in REPORTS.md |
| `Folium.Report/report.json` | The five pages, named, with no visuals yet |
| `Folium.pbip` | Opens both |

### Tables

| Table | Source | Mode |
|---|---|---|
| `UsageEvent` | `ev_usageevent`, with `EventType` (name of `ev_eventtype`, as `USAGE_EVENT_OPTIONS`), `Issuer` (`ev_issuer`, else `ev_source`) and `Form` (number and revision) added in Power Query | DirectQuery |
| `BlockingCheck` | `ev_detail`'s `blockingChecks` on `send.blocked` rows, one row per check ID | Import (JSON can't be parsed in DirectQuery); refresh daily |
| `SignatureRequest` | `ev_signaturerequest`'s promoted columns, with `Status` named from `ev_status` (`SIGNATURE_STATUS_OPTIONS`) | DirectQuery |
| `FormTemplate`, `User` | `ev_formtemplate`, `systemuser` | DirectQuery |
| `Date` | Calculated, 1 Jan 2026 to 30 days ahead; the shared slicer | Import |
| `AgeBucket` | 0–7, 8–30, 31–60, 60+ days, for open envelopes and drafts | Import |

Data comes through Dataverse's TDS endpoint (`CommonDataService.Database`), so DirectQuery with single sign-on lets Dataverse security (#1) decide what each person sees. Set the `DataverseUrl` parameter to the environment (for example `everence.crm.dynamics.com`); turn on the TDS endpoint in the Power Platform admin center if it's off.

**Row-level security.** `BlockingCheck` is imported, so single sign-on doesn't secure it. The `Viewer` role keeps only the checks on usage rows the viewer can read through DirectQuery. In the service, add the reporting group to `Viewer` (Semantic model › Security) and give them Viewer access to the workspace; Admins, Members and Contributors aren't filtered by roles. Check with two managers who see different groups before publishing.

Relationships follow REPORTS.md: `UsageEvent` to `User` (who did it; `ev_actingfor` inactive, for `USERELATIONSHIP`), to `SignatureRequest`, `FormTemplate` and `Date`; `SignatureRequest[SentDate]` and `[ev_owner]` inactive to `Date` and `User`. Option values are mapped in Power Query; if Folium's option values change, change them here too.

### Measures

Usage: Form uses, Outputs, Drafts saved, In-person packets. People: Active people (and 7, 30, 90 days), Last activity, Form uses for others. E-signature: Requests sent, viewed, signed, declined, voided, expired; Hours to sign (median and 90th percentile, nearest rank); Open envelopes, Open envelopes by age, Expiring in 7 days. Quality: Blocked presses, Send attempts, Blocked-send rate; Times blocking (on `BlockingCheck`). Drafts: Drafts, Drafts by age, Drafts due this week and this month.

## To finish in Power BI Desktop

1. Open `Folium.pbip`, set `DataverseUrl`, sign in with an Admin account, and refresh.
2. Mark `Date` as the date table (Table tools › Mark as date table, on `Date[Date]`) if it isn't already.
3. Build the visuals on each page as REPORTS.md › Pages describes, with one `Date` slicer synced across pages. Turn on **Export data** in the report settings.
4. Check the numbers as REPORTS.md › Checking the numbers says, then save. Desktop rewrites the files; commit what it saves.
5. Publish to the forms and operations workspace and put the report's link in Administration › Firm profile › Reports.
