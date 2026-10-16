import type { FeedbackKind, FeedbackStatus } from '../../domain/feedback';
import type { IdAttr } from '../../domain/idDocuments';
import { DOCUSIGN_MAIN, type ProviderCapabilities } from '../../domain/signing';
import type { SignatureStatus } from '../../domain/types';
import type { UsageEventType } from '../../domain/usage';

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
  /** Form feedback: requests for new forms and problem reports (DATAVERSE.md). */
  formRequest: 'ev_formrequests',
  /** Usage events for reporting (DATAVERSE.md, docs/REPORTS.md). */
  usageEvent: 'ev_usageevents',
  /** Folium role/group/defaults per systemuser (one row per user). */
  profile: 'ev_foliumprofiles',
  group: 'ev_foliumgroups',
  /** Firm settings, by `ev_name`: "Policy", "DocuSign", "Signing", one "Firm: …" per firm profile, one "Announcement" each. */
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
  /** Subfolder of the contact's folder for documents attached to drafts. */
  attachmentsFolder: 'Folium attachments',
} as const;

export interface SigningConnection {
  /** Stored on each request (`ev_provider`). Never change it once requests use it. */
  id: string;
  label: string;
  /** The custom connector's data source name (`pac code add-data-source`). */
  connector: string;
  capabilities: ProviderCapabilities;
}

/**
 * E-signature connections, in order; the first is the fallback default. Administration ›
 * Settings › E-signature picks the default, and groups and firm profiles can name another.
 * Another DocuSign account is another connection of the custom connector, added as its
 * own data source; another provider needs its own adapter (DEPLOY.md, "Adding a provider").
 */
export const SIGNING_CONNECTIONS: SigningConnection[] = [
  {
    id: DOCUSIGN_MAIN,
    label: 'DocuSign',
    connector: CONNECTORS.docuSign,
    capabilities: { verification: ['email', 'sms', 'phone', 'kba'], accessCode: true, inSession: true, correctRecipient: true },
  },
];

// The DocuSign account ID, identity-verification workflow IDs and consent link are set
// in Administration › Settings › DocuSign (the "DocuSign" `ev_foliumsetting` row), so
// moving from the sandbox to production needs no rebuild. See DEPLOY.md §4.

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
    gendercode: { label: 'Gender', options: { 1: 'male', 2: 'female' } },
  },
};

/**
 * Contact columns that hold ID documents, if Everence's Dynamics 365 keeps them
 * (to confirm). Name a column here, e.g. `dlNumber: 'ev_dlnumber'`, and forms fill
 * that field from the client's or spouse's contact; put the number columns under
 * Dataverse field security, as for `ev_ssn`. A field with no column is entered at
 * review, once per packet.
 */
export const ID_DOCUMENT_COLUMNS: Partial<Record<IdAttr, string>> = {};

/**
 * `ev_signaturerequest.ev_status` option values, in one place so `toRow` and the
 * DocuSign Connect flow (DEPLOY.md §5) write the same numbers. These are the defaults
 * for a new choice with the `ev_` publisher (100000000 upward, in the order of
 * DATAVERSE.md). Confirm them in Power Apps › Tables › Signature request › Columns.
 */
export const SIGNATURE_STATUS_OPTIONS: Record<SignatureStatus, number> = {
  Drafted: 100000000,
  Sent: 100000001,
  Viewed: 100000002,
  Signed: 100000003,
  Declined: 100000004,
  Voided: 100000005,
  Expired: 100000006,
};

/**
 * `ev_usageevent.ev_eventtype` option values: 100000000 upward in the order of
 * DATAVERSE.md. The Connect flow writes the status ones, so keep them in step.
 */
export const USAGE_EVENT_OPTIONS: Record<UsageEventType, number> = {
  'form.added': 100000000,
  'pdf.fillable': 100000001,
  'pdf.flattened': 100000002,
  'pdf.print': 100000003,
  'draft.saved': 100000004,
  'send.blocked': 100000005,
  'request.sent': 100000006,
  'request.viewed': 100000007,
  'request.signed': 100000008,
  'request.declined': 100000009,
  'request.voided': 100000010,
  'request.expired': 100000011,
  'request.inperson': 100000012,
  'user.noprofile': 100000013,
};

/** `ev_formrequest.ev_kind` and `ev_status` option values (DATAVERSE.md). */
export const FEEDBACK_KIND_OPTIONS: Record<FeedbackKind, number> = { request: 100000000, problem: 100000001 };
export const FEEDBACK_STATUS_OPTIONS: Record<FeedbackStatus, number> = { new: 100000000, inProgress: 100000001, fixed: 100000002, wontFix: 100000003, duplicate: 100000004 };

export interface ChoiceColumn {
  /** Shown to the advisor when a stored option has no mapping. */
  label: string;
  options: Record<number, string>;
}
export type ChoiceMap = Record<string, Record<string, ChoiceColumn>>;
