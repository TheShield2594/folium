// Core domain model for Folium. Mirrors the Dataverse tables and the
// provider-neutral template mapping format described in the project brief.

import type { DirectoryUser } from './advisor';
import type { IdAttr } from './idDocuments';

export type FormSource = 'Everence' | 'Praxis' | 'Carrier';

export type FormCategory =
  | 'Account maintenance'
  | 'Beneficiary'
  | 'Distributions'
  | 'Transfers'
  | 'New accounts'
  | 'Insurance service'
  | 'Banking';

export type TemplateStatus = 'Draft' | 'Needs mapping' | 'Live' | 'Retired';

/** How a PDF was built. Only `fillable` templates can be prefilled without overlay fields. */
export type PdfKind = 'fillable' | 'xfa' | 'flat';

/**
 * Where a PDF field's value comes from.
 * - a Dataverse path, e.g. `contact.fullname`, `account.ev_accountno`, `connection[Spouse].fullname`
 * - `advisor`: entered by the advisor during review
 * - `signer`: left blank and completed by the signer inside the signing ceremony
 * - `rep.*`: the signed-in advisor's own profile (rep code, branch, phone)
 * - `static:<value>`: a constant
 */
export type FieldSource = string;

export type FieldFormat =
  | 'text'
  | 'date'
  | 'ssn'
  | 'ssnLast4'
  | 'ein'
  | 'ssnOrTin'
  | 'phone'
  | 'zip'
  | 'email'
  | 'currency'
  | 'percent'
  | 'integer'
  | 'decimal'
  | 'checkbox';

export type DateLayout = 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'MMDDYYYY' | 'DD/MM/YYYY';

/** Per-field limits on top of the format. No limits means the format's defaults. */
export interface FieldLimits {
  /** For integer, decimal, currency and percent (percent defaults to 0–100). */
  min?: number;
  max?: number;
  /** For text. `maxLength` is copied from the PDF field's MaxLen when there is one. */
  minLength?: number;
  maxLength?: number;
  /** ISO date, or relative to today: `today`, `-120y`, `+1y`, `-30d`, `+6m`. */
  dateMin?: string;
  dateMax?: string;
  /** How a date prints on the form. Defaults to MM/DD/YYYY. */
  dateLayout?: DateLayout;
}

export interface FieldMapping {
  pdfField: string;
  source: FieldSource;
  required: boolean;
  /** Human label shown in the review panel. Falls back to a prettified pdfField. */
  label?: string;
  /** Canonical data key. Fields that share a key share a value across every form in a packet ("enter once"). */
  key?: string;
  format?: FieldFormat;
  limits?: FieldLimits;
  /** Short guidance shown next to the input. */
  help?: string;
  /**
   * Required when this condition holds (same grammar as signer conditions). Setting it
   * makes the field conditionally required on its own, whatever `required` says.
   */
  requiredWhen?: string;
  /**
   * Locked when this condition holds: read-only, not required and printed blank (and
   * read-only in the editable PDF). What the advisor typed is kept, so unlocking
   * restores it.
   */
  lockWhen?: string;
  /**
   * For a checkbox (or one option of a set of boxes): ticked when the source's value is
   * this word, e.g. `married` on `contact.familystatuscode`. The value stays the source's
   * word, so ticking another box in the set changes it, and two can't both be ticked.
   */
  checkedWhen?: string;
  /**
   * For a radio group: the PDF option (export value) to select for each source value,
   * e.g. `{ married: 'M', single: 'S' }`.
   */
  options?: Record<string, string>;
  /**
   * A field in a block about one person (beneficiary 2, a joint owner). Review can fill
   * the whole block from any related person: `attr` is a contact column, `role` or
   * `ev_sharepct`.
   */
  person?: { block: string; attr: string };
  /**
   * On a second or later copy of a form in one packet, advisor-entered values are kept
   * per copy. Set this for the rare advisor value that must match on every copy.
   */
  shareAcrossCopies?: boolean;
  /**
   * Overlay box for flat (scanned) or XFA PDFs that have no fillable field, in PDF
   * points from the page's top-left. Fillable PDFs take positions from their widgets.
   */
  rect?: FieldRect;
}

export interface FieldRect {
  page: number; // 1-based
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SignerRule {
  role: string;
  /** e.g. `contact.familystatuscode == married` */
  condition?: string;
}

export type PlacementType = 'signature' | 'initials' | 'dateSigned' | 'text' | 'checkbox';

export interface Placement {
  role: string;
  type: PlacementType;
  /** 1-based page number. */
  page: number;
  /** PDF user-space points, origin at the page's top-left (converted from PDF bottom-left at authoring time). */
  x: number;
  y: number;
  width?: number;
  height?: number;
  optional?: boolean;
}

export type Check =
  | { type: 'sumEquals'; fields: string[]; value: number; label?: string }
  | { type: 'requiredIf'; field: string; when: string; label?: string }
  | { type: 'oneOf'; fields: string[]; label?: string }
  | { type: 'pattern'; field: string; pattern: string; label?: string };

export interface TemplateMapping {
  formNumber: string;
  revision: string;
  fields: FieldMapping[];
  signers: SignerRule[];
  placements: Placement[];
  checks: Check[];
}

export interface FormTemplate {
  id: string;
  name: string;
  formNumber: string;
  source: FormSource;
  /** The entity, carrier or fund family that issues the form ("Everence Trust Company"). Matches firm profiles. */
  issuer?: string;
  /** Firm profile its `firm.*` fields fill from, when its issuer doesn't settle it (see `firmFor`). */
  firmId?: string;
  category: FormCategory;
  revision: string;
  effectiveDate: string; // ISO date
  status: TemplateStatus;
  pdfKind: PdfKind;
  pageCount: number;
  sharePointItemId: string;
  sharePointUrl: string;
  supersedesId?: string;
  mapping: TemplateMapping;
  /** Account types this form applies to, for suggestions. */
  appliesTo?: string[];
  /** USPS codes where this form may be used. Undefined or empty means every state. */
  states?: string[];
  /** Same form, different state version: templates sharing a variant group are alternatives. */
  variantGroup?: string;
  keywords?: string[];
  description?: string;
  modifiedOn: string;
  modifiedBy: string;
}

// ---------------------------------------------------------------------------
// CRM

export interface Contact {
  contactid: string;
  fullname: string;
  firstname: string;
  middlename?: string;
  lastname: string;
  birthdate?: string;
  ev_ssn?: string;
  emailaddress1?: string;
  mobilephone?: string;
  telephone1?: string;
  address1_line1?: string;
  address1_line2?: string;
  address1_city?: string;
  address1_stateorprovince?: string;
  address1_postalcode?: string;
  familystatuscode?: 'single' | 'married' | 'divorced' | 'widowed';
  gendercode?: 'male' | 'female';
  ev_clientid: string;
  ev_region?: string;
  /** Owning advisor (systemuser). */
  ownerid?: string;
  /** ID documents, when Dynamics holds them (see ID_DOCUMENT_COLUMNS in power/config.ts). */
  idDocuments?: Partial<Record<IdAttr, string>>;
  /** Choice columns whose stored option Folium couldn't map to a word (column → label and the value Dataverse showed). */
  unrecognisedChoices?: Record<string, { label: string; value: string }>;
  [key: string]: unknown;
}

export interface Account {
  accountid: string;
  name: string;
  ev_accountno: string;
  ev_accounttype: string; // e.g. 'Traditional IRA', 'Roth IRA', 'Brokerage', 'Life policy'
  ev_custodian?: string;
  ev_balance?: number;
  ev_openedon?: string;
  [key: string]: unknown;
}

export interface Connection {
  role: string; // 'Spouse', 'Beneficiary', 'Joint owner', 'Trusted contact', 'Insured'
  contact: Contact;
  /** Beneficiary share, when the connection carries one. */
  ev_sharepct?: number;
}

export interface Advisor {
  systemuserid: string;
  fullname: string;
  middleName?: string;
  /** Sign-in email (from the directory). */
  email: string;
  /** Email as printed on forms, when it differs from the sign-in email. */
  formEmail?: string;
  phone: string;
  phoneExt?: string;
  fax?: string;
  mobile?: string;
  office?: OfficeAddress;
  repCode: string;
  /** Office of Supervisory Jurisdiction number. */
  osjNumber?: string;
  /** Registered investment adviser number. */
  riaNumber?: string;
  branch: string;
  title: string;
}

export interface OfficeAddress {
  line1: string;
  suite?: string;
  city: string;
  state: string;
  zip: string;
}

/** Everything the prefill engine can read for one client. */
export interface ClientRecord {
  contact: Contact;
  accounts: Account[];
  connections: Connection[];
}

// ---------------------------------------------------------------------------
// Packets & requests

export interface PacketItem {
  /** This instance of the form in the packet. Copies of one form have different ids. */
  id: string;
  templateId: string;
  /**
   * 2 and up for an added copy of a form already in the packet ("Add another copy").
   * A copy keeps its own advisor-entered values (see `fieldKey`).
   */
  copy?: number;
  /** Which account this form is about, if the form is account-specific. */
  accountId?: string;
  /** Set when a resumed draft's account is no longer active and Folium picked another. */
  accountReplaced?: boolean;
  /**
   * Set when a resumed draft names a template that no longer exists, so Review can name
   * the form instead of dropping it.
   */
  missing?: { name: string; formNumber: string; revision: string };
}

/** A saved, reusable list of forms ("Save as packet"). */
export interface SavedPacket {
  id: string;
  name: string;
  description?: string;
  templateIds: string[];
  shared: boolean;
  owner: string;
  /** Groups the packet is shared with; empty + shared means everyone. */
  groupIds?: string[];
  createdOn: string;
  usedCount: number;
}

/** `Expired`: DocuSign voided the envelope because it lapsed before everyone signed. */
export type SignatureStatus = 'Drafted' | 'Sent' | 'Viewed' | 'Signed' | 'Declined' | 'Voided' | 'Expired';

/** `phone`: DocuSign Phone authentication (a call or text with a code), through an IDV workflow like SMS. */
export type VerificationMethod = 'email' | 'sms' | 'phone' | 'kba';

export interface SignerAssignment {
  role: string;
  name: string;
  email: string;
  phone?: string;
  order: number;
  auth: VerificationMethod;
  /**
   * An access code was set for this signer. The code itself is never stored: it goes
   * to DocuSign with the envelope and the advisor gives it to the client by phone or
   * in person.
   */
  accessCodeSet?: boolean;
  /** Signs in DocuSign on the advisor's device, with the advisor present (embedded signing). */
  inSession?: boolean;
  /** Contact this signer was resolved from, if any. */
  contactId?: string;
  status?: 'pending' | 'sent' | 'viewed' | 'signed' | 'declined';
  signedOn?: string;
}

export interface AuditEvent {
  at: string;
  actor: string;
  action: string;
  detail?: string;
}

export interface RequestDocument {
  templateId: string;
  name: string;
  formNumber: string;
  revision: string;
  /** The account the form is about, so a resumed draft reopens on the same one. */
  accountId?: string;
  /** The packet item this was, so a resumed draft keeps each copy's own values. */
  itemId?: string;
  /** Set on an added copy of a form (2 and up). */
  copy?: number;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  addedOn: string;
  /** Where the bytes were saved with the draft (the contact's SharePoint folder). */
  storedAt?: { itemId: string; url: string };
}

export interface SignatureRequest {
  id: string;
  contactId: string;
  title: string;
  /** The User whose client/book this belongs to. */
  ownerId?: string;
  /** Who prepared it — the owner, or an Assistant working on their behalf. */
  preparedById?: string;
  preparedBy?: string;
  /** Other users who can open and continue this draft or request. */
  sharedWith?: string[];
  sentBy: string;
  sentOn?: string;
  createdOn: string;
  /**
   * The e-signature connection that sent it (`docusign:main`), so Requests keeps using it
   * after the default changes. Rows from before connections say `DocuSign`.
   */
  provider: string;
  envelopeId?: string;
  /** `created` while the envelope is a DocuSign draft that Folium hasn't released yet. */
  envelopePhase?: 'created';
  status: SignatureStatus;
  documents: RequestDocument[];
  signers: SignerAssignment[];
  ccs: { name: string; email: string }[];
  subject: string;
  message: string;
  reminderDays?: number;
  expiresInDays?: number;
  /**
   * When the envelope lapses (ISO): worked out on send, then DocuSign's `expireDateTime`
   * once status is read. On a draft, when the firm's retention deletes it (see
   * `draftExpiry`); both live in `ev_expireson`.
   */
  expiresOn?: string;
  anyOrder: boolean;
  draftFolderUrl?: string;
  /** Draft PDFs written to SharePoint, so a later cleanup can find them. */
  draftFiles?: { name: string; url: string }[];
  viewedOn?: string;
  signedOn?: string;
  voidedReason?: string;
  uploadedToOnBase: boolean;
  uploadedBy?: string;
  uploadedOn?: string;
  /** Who filled each person block ("Primary beneficiary 2" → Sam Miller, Spouse), so a resumed draft shows it. */
  personBlocks?: Record<string, { contactId?: string; name: string; role: string }>;
  /** The state the packet's forms must be approved in, when the advisor changed it from the client's. */
  state?: string;
  /** Field values the advisor entered, keyed by canonical key, so a draft can be resumed. */
  values: Record<string, string>;
  /**
   * CRM-derived value per field key when the draft was saved, so a resumed draft can
   * say what changed in Dynamics since. SSN fields are left out (they stay live only).
   */
  prefillSnapshot?: Record<string, string>;
  attachments: Attachment[];
  audit: AuditEvent[];
  inPerson?: boolean;
  lastReminderOn?: string;
}

// ---------------------------------------------------------------------------
// People, groups and the firm

/**
 * - `User`: an advisor who owns clients and sends forms.
 * - `Assistant`: fills out and sends forms on behalf of the Users in their groups
 *   (LaserApp Anywhere's assistant model). Requests record both who did the work and
 *   whose client/book it belongs to.
 * - `Admin`: manages templates, groups and firm data.
 */
export type UserRole = 'User' | 'Assistant' | 'Admin';

export interface UserProfile extends Advisor {
  role: UserRole;
  groupIds: string[];
  region?: string;
  /** Signature block / preferred defaults. */
  defaultAuth?: VerificationMethod;
  defaultReminderDays?: number;
  /** Start new envelopes with "any order" on or off. Unset follows the firm's default. */
  defaultAnyOrder?: boolean;
  emailSignature?: string;
  /**
   * USPS codes of the states this advisor is licensed to sell insurance in. Empty or
   * missing means unknown, and nothing is checked.
   */
  licensedStates?: string[];
  /**
   * May change their own rep data (title, phones, office…) in Settings. Unset follows
   * the firm (`FirmPolicy.repDataSelfEdit`). Rep, OSJ and RIA numbers are Admin-only.
   */
  canEditRepData?: boolean;
  /** Who changed which rep field, and when (newest last). */
  repDataAudit?: RepDataChange[];
  /** May open the firm's usage reports (the reporting role, #32). Admins always may. */
  canViewReports?: boolean;
  /** Last day this person opened Folium (ISO timestamp, written at most once a day). */
  lastSeenOn?: string;
  /** Read-only, from the services: false when the profile is deactivated (`statecode` 1). */
  active?: boolean;
  /** Read-only, from the services: the `systemuser` is disabled in the directory. */
  disabled?: boolean;
  /** Read-only, from the services: what the directory holds, under any values set in Folium. */
  directory?: DirectoryUser;
}

export interface RepDataChange {
  at: string;
  /** Name of the person who made the change. */
  by: string;
  field: string;
  from?: string;
  to?: string;
}

export interface UserGroup {
  id: string;
  name: string;
  description?: string;
  /** Region or office the group covers, e.g. "Goshen" or "Mid-Atlantic". */
  region?: string;
  memberIds: string[];
  /** Restrict the forms this group sees. Empty means the whole library. */
  sources?: FormSource[];
  categories?: FormCategory[];
  /** Firm profile for forms whose issuer no profile claims (see `firmFor`). */
  defaultFirmId?: string;
  /** E-signature connection this group sends with, over the firm's default (see `providerFor`). */
  signingProviderId?: string;
}

/**
 * One legal entity's data (the trust company, Praxis…), available to its forms as
 * `firm.*` (see domain/firms). One profile is the default; the settings below the
 * disclosure are firm-wide and live on the default profile only.
 */
export interface FirmProfile {
  id: string;
  /** Fills forms no other profile claims, and holds the firm-wide settings. Exactly one profile has it. */
  isDefault?: boolean;
  /** Template issuers this profile covers ("Everence Trust Company"). An issuer is on one profile at most. */
  issuers: string[];
  name: string;
  legalName: string;
  address1: string;
  /** Suite or PO box. */
  suite?: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  phoneExt?: string;
  fax?: string;
  email?: string;
  website: string;
  brokerDealer: string;
  crd: string;
  /** Firm, broker-dealer or IMO number as forms print it. */
  firmNumber?: string;
  branchNumber?: string;
  /** Office of Supervisory Jurisdiction name. */
  osjName?: string;
  /** Registered investment adviser name. */
  riaName?: string;
  /** Email message footer for envelopes with this entity's forms (see `envelopeDisclosure`). */
  disclosure: string;
  /** E-signature connection for packets of this entity's forms, over a group's and the firm's default. */
  signingProviderId?: string;
  /** Refuse the editable PDF too while checks are open (Laser App's stricter behaviour). */
  blockFillableWhenIncomplete?: boolean;
  /** Save the open packet as a draft when an advisor leaves unsaved work idle. Off unless turned on. */
  idleAutoSave?: boolean;
  /** Minutes idle before the 2-minute countdown to the auto-save starts. Default 25. */
  idleAutoSaveMinutes?: number;
  /** Send screen defaults: what a new envelope starts with. The rules are in `FirmPolicy`. */
  sending?: SendingDefaults;
  /** The Power BI usage report (docs/REPORTS.md), opened from the sidebar's Reports link. */
  reportsUrl?: string;
}

/** Send screen defaults for the firm (Administration › Firm profile). */
export interface SendingDefaults {
  /** New envelopes start with "Signers can sign in any order" on. A user's own default wins. */
  defaultAnyOrder?: boolean;
  /** Email subject with tokens such as `{client.firstname}` and `{forms}`; see `fillTokens`. */
  subjectTemplate?: string;
  /** Email note with tokens such as `{client.firstname}`, `{forms}` and `{advisor.signature}`. */
  messageTemplate?: string;
}

/**
 * - `off`: nobody shares drafts. `groups`: only with people in a group you're in.
 * - `anyone`: with anyone who uses Folium.
 */
export type SharingPolicy = 'off' | 'groups' | 'anyone';
/**
 * Whose rep data (rep code, phone, branch) can prefill a form besides your own.
 * - `assistants`: only Assistants work as the Users in their groups.
 * - `groupMembers`: Users can also work as another User in their groups.
 */
export type RepDataVisibility = 'assistants' | 'groupMembers';
/** `signedOnly`: only the completed envelope; `none`: e-signature is the only way out. */
export type PdfDownloadPolicy = 'all' | 'signedOnly' | 'none';

/**
 * Firm-wide rules (Administration › Settings), kept in their own `ev_foliumsetting` row
 * ("Policy") so several firm profiles (#26) share one set.
 */
export interface FirmPolicy {
  sharing: SharingPolicy;
  repDataVisibility: RepDataVisibility;
  pdfDownload: PdfDownloadPolicy;
  /**
   * Days an unsent draft is kept after its last save: 90 (default), 60, 30, 10, 7 or 0.
   * 0 turns off saving and sharing drafts.
   */
  draftRetentionDays?: number;
  /** Users and Assistants can't edit the envelope note; Admins can. The disclosure is still added. */
  lockMessage?: boolean;
  /** Most supporting documents on one envelope. Default 10. */
  maxAttachments?: number;
  /** Most megabytes of supporting documents on one envelope. Default 30. */
  maxAttachmentsMB?: number;
  /** Whether people may edit their own rep data in Settings unless their profile says otherwise. Default true. */
  repDataSelfEdit?: boolean;
  /** Days without signing in before someone shows as dormant in Users & groups. Default 90. */
  dormantAfterDays?: number;
  /** Months usage events (`ev_usageevent`) are kept before the bulk-delete job removes them. Default 36. */
  usageRetentionMonths?: number;
}
