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
3. Operations used by Folium: `CreateEnvelope` (as a draft, `status: created`), `GetEnvelope`, `UpdateEnvelope` (send the draft / void / resend), `UpdateRecipients`, `GetDocument` (`combined`, `certificate`).
4. In DocuSign Admin › Identity Verification, note the workflow IDs for **SMS** and **ID Check (KBA)** and put them in `DOCUSIGN.idv` in `config.ts`.

This answers spike 2: envelopes are created from Folium's own PDF bytes with tabs placed by page + x/y, so the standard DocuSign connector isn't needed.

## 5. Status updates (DocuSign Connect)

Create a Power Automate flow:

1. Trigger: *When an HTTP request is received* (or the DocuSign connector's *When an envelope status changes (Connect)*).
2. Find the `ev_signaturerequest` row by `ev_envelopeid`.
3. Update `ev_status` (`sent`→Sent, `delivered`→Viewed, `completed`→Signed, `declined`→Declined, `voided`→Voided), `ev_signedon`, and append to the audit in `ev_payload`.

Add the flow's URL as a Connect configuration in DocuSign Admin. Until it exists, **Check status** on each request polls DocuSign, which is the brief's acceptable v1 fallback.

## 6. Put it on the Contact form

Spike 1 decides which of these you use:

- **Embedded (preferred):** add a *Forms* tab to the Contact main form with an iframe/web resource pointing at the app's play URL, passing the record ID: `…/play/e/<env>/app/<appId>?contactId={recordId}`. Folium reads `contactId` from the query string or from `getContext().app.queryParams`.
- **Standalone:** a ribbon-free *Forms* button or link on the Contact form that opens the play URL with `contactId`.
- **Fallback:** a custom page or PCF control hosting the same bundle.

## 7. Build and publish

```bash
npm run build
pac code push
```

Share the app with the Folium security group. Admins then: set the Firm profile, create groups, give each person a role, and map the first templates (Template library › New from Marketing).

## Fonts

Folium asks for Frutiger (text) and Sabon (display), falling back to Verdana and Times as the brand guidelines allow. Where Everence's licence covers web use, add the `.woff2` files to `public/fonts/` and declare them with `@font-face` in `src/styles/tokens.css` using the family names already in `--font-text` and `--font-display`.
