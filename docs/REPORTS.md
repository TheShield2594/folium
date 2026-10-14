# Usage, activity and e-signature reports

Folium's reports are a **Power BI report on Dataverse**, not charts inside the app. Power BI gives date slicers, drill-down, export to CSV and Excel, subscriptions and row-level security without Folium code. Admins and people with the reporting role open it from the sidebar's **Reports** link, which goes to the URL in Administration › Firm profile › Reports.

Status: the data (`ev_usageevent`, the promoted `ev_signaturerequest` columns), the Reports link and the reference metric definitions are in Folium. The report itself is built in Power BI Desktop from this document and checked in as a `.pbip` project under `reports/` once it exists. Its numbers are checked against the same definitions in `src/domain/reports.ts` (see [Checking the numbers](#checking-the-numbers)).

## Data

| Table | What the report reads |
|---|---|
| `ev_usageevent` | Every event, one row per event per form ([DATAVERSE.md](DATAVERSE.md#ev_usageevent--what-happens-to-forms-for-reporting)) |
| `ev_signaturerequest` | `ev_status`, `ev_senton`, `ev_signedon`, `ev_viewedon`, `ev_expireson`, `ev_inperson`, `ev_formcount`, `ev_owner`, `ev_preparedby`, `createdon`, `modifiedon` |
| `ev_formtemplate` | `ev_name`, `ev_formnumber`, `ev_status` |
| `ev_foliumprofile` | `ev_user`, `ev_role`, `ev_name`, `statecode` |
| `ev_foliumgroup` | `ev_name`, `ev_region` (members are in the payload; use the owner teams from #1 for security) |
| `systemuser` | `fullname`, `isdisabled` |

Relationships: `ev_usageevent[ev_user]` → `systemuser`; `ev_usageevent[ev_actingfor]` → `systemuser` (inactive, used with `USERELATIONSHIP`); `ev_usageevent[ev_request]` → `ev_signaturerequest`; `ev_usageevent[ev_template]` → `ev_formtemplate`; `ev_signaturerequest[ev_owner]` → `systemuser`. A `Date` table marked as a date table, related to `ev_usageevent[ev_occurredon]` (date part) and, inactive, to `ev_signaturerequest[ev_senton]`. Map `ev_eventtype` option values to names with the list in `USAGE_EVENT_OPTIONS` (`src/services/power/config.ts`).

Every page shares one **date slicer** (on `Date`), synced across pages. Every table visual allows **Export data** (CSV and Excel); turn it on for the report in Power BI's settings.

## Measures

The definitions match `src/domain/reports.ts`. The DAX is a starting point, not tested in Power BI yet: check each measure against the sample in [Checking the numbers](#checking-the-numbers). `EventType` is the name column mapped from `ev_eventtype`.

```dax
Form uses = CALCULATE ( COUNTROWS ( ev_usageevent ), ev_usageevent[EventType] = "form.added" )
Outputs = CALCULATE ( COUNTROWS ( ev_usageevent ), ev_usageevent[EventType] IN { "pdf.fillable", "pdf.flattened", "pdf.print", "request.sent", "request.inperson" } )

Requests sent = CALCULATE ( DISTINCTCOUNT ( ev_usageevent[ev_request] ), ev_usageevent[EventType] = "request.sent" )
// One of these per step (viewed, signed, declined, voided, expired): requests sent in
// the range that reached the step, whenever they reached it.
Requests signed =
    VAR sent = CALCULATETABLE ( VALUES ( ev_usageevent[ev_request] ), ev_usageevent[EventType] = "request.sent" )
    RETURN CALCULATE ( DISTINCTCOUNT ( ev_usageevent[ev_request] ), ev_usageevent[EventType] = "request.signed", REMOVEFILTERS ( 'Date' ), TREATAS ( sent, ev_usageevent[ev_request] ) )

Blocked presses = CALCULATE ( COUNTROWS ( ev_usageevent ), ev_usageevent[EventType] = "send.blocked" )
Send attempts = CALCULATE ( COUNTROWS ( ev_usageevent ), ev_usageevent[EventType] IN { "send.blocked", "request.sent" } )
Blocked-send rate = DIVIDE ( [Blocked presses], [Send attempts] )

Active users (30 days) =
    VAR last = MAX ( 'Date'[Date] )
    RETURN CALCULATE ( DISTINCTCOUNT ( ev_usageevent[ev_user] ), DATESINPERIOD ( 'Date'[Date], last, -30, DAY ) )
```

**Time to sign** is per request, not per form row: hours from the earliest `request.sent` to the earliest `request.signed` for requests sent in the range. Build it on a request-level calculated table (`SUMMARIZE` by `ev_request` with `MIN` of each), then take the median and the 90th percentile by **nearest rank** (sort the hours and take the value at `ROUNDUP(p × n, 0)`). DAX's `PERCENTILE.INC` interpolates and can differ on small samples, so don't use it here.

**Blocking checks** come from `ev_detail`'s `blockingChecks` list. Parse `ev_detail` in Power Query (`Json.Document`), expand the list to rows, and count by check ID. IDs are stable across packets: `required`, `check:<n>` (the template's nth check), `format:<field key>`, `state`, `state:licence`, `attachments:count`, `attachments:size`, `attachments:unreachable` (an attachment Folium can't reach), `signers`, `auth:notSetUp` (a verification method not set up in DocuSign), `subject`.

## Pages

1. **Form usage** (replaces Laser App's Form Companies and Form Categories). Form uses by issuer (`ev_issuer`, else `ev_source`) and by category over the date range, as bars with a table under each. Drill from issuer or category to form number, then to revision. A second visual compares outputs (downloads, prints, sends). Export to CSV. *Open: which counts against the Laser App baseline, form uses (`form.added`) or outputs; both are here.*
2. **People** (replaces Usage Time). Active users in the last 7, 30 and 90 days; per person: last activity, forms sent, drafts saved, packets printed to sign in person, form uses. Split by group and region (`ev_region`, `ev_groups`). Work an Assistant did for a User shows separately (rows with `ev_actingfor`), under both people. People with a profile but no events in 90 days are listed as dormant, as Users & groups shows.
3. **E-signature pipeline.** A funnel of requests sent → viewed → signed, with declined, voided and expired beside it; median and 90th-percentile time to sign; open envelopes by age (from `ev_signaturerequest`: status Sent or Viewed, age = today − `ev_senton`, in buckets 0–7, 8–30, 31–60, 60+ days); expiring in the next 7 days (`ev_expireson`). In person versus DocuSign (`request.inperson` versus `request.sent`).
4. **Quality.** Blocked-send rate by form (`send.blocked` ÷ send attempts), highest first, with attempts shown so a rate on 2 attempts isn't mistaken for a pattern. The checks that block most often, by form. Point Marketing at forms that need better mapping or defaults, and at Administration › Form feedback for what advisors reported.
5. **Drafts.** From `ev_signaturerequest` where status is Drafted and not in person: drafts by age (today − `modifiedon`) in buckets, by owner, against the firm's retention period (`draftRetentionDays`) using `ev_expireson`: due for deletion this week, this month, later.

## Access

Publish to a workspace owned by the forms and operations team, and put its link in Administration › Firm profile › Reports. The sidebar link shows for Admins and for people whose profile has **Can open usage reports** (the reporting role) in Users & groups; it's hidden from everyone while no link is set.

Use **DirectQuery with single sign-on** to Dataverse, so the Dataverse security from #1 decides what each person sees: the Folium Reporting role gives Read on the tables above, scoped by business unit or owner team, so managers see their groups' rows and Admins see everything. An advisor without the role can't read `ev_usageevent` at all (they only have Create), so the report shows them nothing even if they find the link. If the report uses **Import** mode instead, the data is read with the publisher's rights: then mirror the same rules in Power BI row-level security (a role per group on `ev_groups`/`ev_region`, and an Admin role with no filter), and share the report only with the reporting group.

Set up a **subscription** for managers: a monthly PDF of pages 1–3, so nobody has to remember to look.

**Fallback.** If Power BI Pro licences are a blocker, ship pages 1, 3 and 5 as model-driven views and dashboards on the same columns first: a view on `ev_usageevent` grouped by `ev_issuer` and `ev_formnumber`, a chart on `ev_signaturerequest` by `ev_status`, and a view of Drafted requests sorted by `ev_expireson`.

## Not needed

- **Browsers & Platforms.** Laser App's numbers are about 99.7% Windows and 99% Chrome or Edge, and Power Platform admin analytics already reports browser, device and active users for the app.
- **Data Sources.** Folium reads and writes Dataverse directly; there are no CRM push or pull jobs to count.
- **Minutes in the app.** Active days and last activity (page 2) replace Usage Time.

## Checking the numbers

`src/domain/reports.ts` defines each metric in TypeScript, and `src/domain/reports.test.ts` checks them against a hand-built sample (time to sign, blocked-send rate, the funnel, form use matching a direct count of `form.added` rows). Before the report goes live:

1. For a test month, count `ev_usageevent` rows with `ev_eventtype` = form.added directly (Advanced Find or a FetchXML aggregate) and check page 1's total matches.
2. Export a month of `request.sent` and `request.signed` rows, work out time to sign and the blocked-send rate by hand (or with the functions in `reports.ts`), and check pages 3 and 4.
3. Sign in as a manager and check they see only their groups; sign in as an advisor and check the report shows nothing.

Demo mode has a seeded year of usage events (`seedUsage` in `src/services/demo/usageSeed.ts`, read with `demoUsage()`), for trying the definitions without Dataverse.

## Open questions

- Power BI licensing (Pro, Premium per user or capacity) and who owns the workspace.
- Whether to load Laser App's CSV exports (company and category by month) into a static table, so year-on-year trends survive the switch.
- Who counts as a manager: a group role or the Folium Reporting role (#1, #2).
