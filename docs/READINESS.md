# Replacement readiness

What has to be true before Folium replaces Laser App is tracked on the readiness issue (#35): the forms people use, platform setup, testing against Everence's real environment, a pilot, and sign-off. **Administration › Readiness** (Admins only) shows the same list. Folium checks what it can from its own data and marks the rest **Check by hand**, to be ticked on the issue.

The checks are defined in `src/domain/readiness.ts` and tested in `readiness.test.ts`.

## What Folium checks

| Item | Done when | Look at this when |
|---|---|---|
| Usage by form | Forms have been added over at least 14 days | Some use, but under two weeks |
| Top companies' forms are Live | Each of Laser App's top 7 companies has Live templates and none waiting on mapping | All have Live forms, but some are still being mapped |
| Approved states recorded | Every Live form from those companies lists its states | Some list none (offered in every state) |
| Laser App's users loaded | At least Laser App's 169 active people | Fewer (some may have left; judge the number) |
| Regional groups set up | Every User and Assistant is in a group, and every group has a region | Someone is in no group, or a group has no region |
| DocuSign connected | A production account is set | Only the developer sandbox is set |
| Firm-wide policy matches Laser App | Sharing within groups, rep data for Assistants only, PDF download on | Anything else (fine if it was decided) |
| Advisor data filled | Every active User has a rep code, phone and office address | Some are missing one |
| Firm data filled | Every profile has a legal name, address, phone and disclosure, and no `[PLACEHOLDER]` text | Every profile is filled, but a top company has no profile and fills from the default |
| Reports link set | Firm profile › Reports has an https link | — |
| Pilot run | People from more than one region over at least 14 days | Some use, but not yet that |
| Pilot problems triaged | No open problem reports | Open problems, all looked at (In progress) |

Everything else (Dataverse security, Entra ID, hosting on the Contact form, the Connect flow, the end-to-end test packets, Compliance, training and cutover) is checked by hand.

Laser App's top companies (`LASER_APP_TOP_COMPANIES`) are matched to template issuers by name, ignoring case. The Folium issuer names for each are a first guess (for example, "Everence Trust Company and Foundation" covers `Everence Trust Company` and `Everence Foundation`). Confirm them with Marketing when the real templates are loaded, and change the list if they differ.

## Pilot numbers and forms by use

The page also shows, for the last 30 or 90 days or 12 months:

- **Pilot numbers**: form uses, requests sent (and signed in person), the blocked-send rate per press, median time to sign, people active in the last 30 days, and open problem reports. These use the definitions in `src/domain/reports.ts`, so they match the Power BI report.
- **Forms by use**: every form added to a packet in the window, every revision together, with its status in Folium and a link to the template. **Export CSV** gives Marketing the ranked mapping list (#4).
- **Laser App's top companies** against Folium's library: Live forms, forms still being mapped, and each company's share of use in Folium beside its Laser App share.

Folium reads at most 50,000 usage events at once; past that it says so, and the Power BI report has the rest. Reading needs **Read** on `ev_usageevent`, which Admins and the Folium Reporting role have ([DATAVERSE.md](DATAVERSE.md#ev_usageevent--what-happens-to-forms-for-reporting)). Without it the page still loads and marks the usage items **Check by hand**.
