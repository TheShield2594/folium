// Core domain model for Folium. Mirrors the Dataverse tables and the
// provider-neutral template mapping format described in the project brief.

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
  /** Only required when this condition holds (same grammar as signer conditions). */
  requiredWhen?: string;
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
  /** Carrier or fund family, for `Carrier` forms. */
  issuer?: string;
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
  ev_clientid: string;
  ev_region?: string;
  /** Owning advisor (systemuser). */
  ownerid?: string;
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
  email: string;
  phone: string;
  repCode: string;
  branch: string;
  title: string;
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
  templateId: string;
  /** Which account this form is about, if the form is account-specific. */
  accountId?: string;
  /** Set when a resumed draft's account is no longer active and Folium picked another. */
  accountReplaced?: boolean;
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

export type SignatureStatus = 'Drafted' | 'Sent' | 'Viewed' | 'Signed' | 'Declined' | 'Voided';

export type VerificationMethod = 'email' | 'sms' | 'kba';

export interface SignerAssignment {
  role: string;
  name: string;
  email: string;
  phone?: string;
  order: number;
  auth: VerificationMethod;
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
  provider: 'DocuSign';
  envelopeId?: string;
  status: SignatureStatus;
  documents: RequestDocument[];
  signers: SignerAssignment[];
  ccs: { name: string; email: string }[];
  subject: string;
  message: string;
  reminderDays?: number;
  expiresInDays?: number;
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
  emailSignature?: string;
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
}

/** Firm-wide data available to every form as `firm.*`. */
export interface FirmProfile {
  name: string;
  legalName: string;
  address1: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  website: string;
  brokerDealer: string;
  crd: string;
  /** Default email message footer for envelopes. */
  disclosure: string;
}
