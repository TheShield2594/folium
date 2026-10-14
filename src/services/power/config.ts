// Names Folium uses in Dataverse and SharePoint. Adjust here (once) if Everence's
// publisher prefix or table names differ from the brief's `ev_` defaults.

export const DATAVERSE = {
  contact: 'contacts',
  /** Financial accounts held by a contact. */
  account: 'ev_financialaccounts',
  accountContactLookup: '_ev_contactid_value',
  connection: 'connections',
  systemuser: 'systemusers',
  formTemplate: 'ev_formtemplates',
  signatureRequest: 'ev_signaturerequests',
  packet: 'ev_formpackets',
  formRequest: 'ev_formrequests',
  /** Folium role/group/defaults per systemuser (one row per user). */
  profile: 'ev_foliumprofiles',
  group: 'ev_foliumgroups',
  /** Single-row firm settings. */
  settings: 'ev_foliumsettings',
} as const;

/** Data source names as registered with `pac code add-data-source`. */
export const CONNECTORS = {
  sharePoint: 'sharepointonline',
  docuSign: 'foliumdocusign',
} as const;

export const SHAREPOINT = {
  /** Marketing's forms site and library. */
  templateSite: 'https://everence.sharepoint.com/sites/Marketing',
  templateLibrary: 'Forms',
  /** Site that backs Dynamics 365 document locations for contacts. */
  crmSite: 'https://everence.sharepoint.com/sites/CRM',
  crmLibrary: 'contact',
} as const;

export const DOCUSIGN = {
  /** Identity-verification workflow IDs from DocuSign Admin › Identity Verification. */
  idv: { sms: '', kba: '' },
} as const;

/**
 * Dataverse choice (option set) columns Folium reads or writes, keyed by table and
 * column. Dataverse stores option numbers; the domain uses the words on the right,
 * so conditions like `contact.familystatuscode == married` stay readable. The
 * numbers are the out-of-box `contact` values. Confirm them against Everence's
 * environment (Power Apps › Tables › Contact › Columns) and add any other choice
 * column a template or condition reads here.
 */
export const CHOICES: ChoiceMap = {
  contact: {
    familystatuscode: { label: 'Marital status', options: { 1: 'single', 2: 'married', 3: 'divorced', 4: 'widowed' } },
  },
};

export interface ChoiceColumn {
  /** Shown to the advisor when a stored option has no mapping. */
  label: string;
  options: Record<number, string>;
}
export type ChoiceMap = Record<string, Record<string, ChoiceColumn>>;
