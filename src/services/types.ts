import type {
  Account,
  Attachment,
  ClientRecord,
  Contact,
  FirmPolicy,
  FirmProfile,
  FormTemplate,
  Placement,
  SavedPacket,
  SignatureRequest,
  SignatureStatus,
  TemplateMapping,
  UserGroup,
  UserProfile,
  VerificationMethod,
} from '../domain/types';
import type { DirectoryUser } from '../domain/advisor';
import type { Announcement } from '../domain/announcements';
import type { DocuSignSetup } from '../domain/docusign';
import type { ProviderCapabilities, SigningSettings } from '../domain/signing';
import type { FormFeedback } from '../domain/feedback';
import type { UsageEvent } from '../domain/usage';

/** Dataverse reads for the client the advisor is working on. */
export interface CrmService {
  getClient(contactId: string): Promise<ClientRecord>;
  /** Write corrections back to the D365 contact. Separate from form edits, which never touch CRM. */
  updateContact(contactId: string, changes: Partial<Contact>): Promise<Contact>;
  updateAccount(accountId: string, changes: Partial<Account>): Promise<Account>;
  searchContacts(query: string): Promise<Contact[]>;
  recentContacts(): Promise<Contact[]>;
}

/** Marketing's SharePoint template library plus the `ev_formtemplate` rows that describe it. */
export interface TemplateLibrary {
  list(): Promise<FormTemplate[]>;
  /** The blank PDF for a template revision, straight from SharePoint. */
  getPdf(template: FormTemplate): Promise<Uint8Array>;
  /** Files in the SharePoint library that don't have a template row yet ("New from Marketing"). */
  listIncoming(): Promise<IncomingFile[]>;
  saveMapping(templateId: string, mapping: TemplateMapping): Promise<FormTemplate>;
  setStatus(templateId: string, status: FormTemplate['status'], effectiveDate?: string): Promise<FormTemplate>;
  /** Where a form may be used: its approved states and the variant group of its state versions. */
  saveDetails(templateId: string, details: TemplateDetails): Promise<FormTemplate>;
  /** Create a template row for an incoming file (optionally as a new revision of an existing form). */
  register(file: IncomingFile, init: Partial<FormTemplate>): Promise<FormTemplate>;
}

/**
 * `ev_formrequest` rows: requests for forms that aren't in the library ("Ask Marketing
 * to add it") and problem reports on forms that are. Build rows with `formRequest` and
 * `problemReport` (domain/feedback), which keep field values out.
 */
export interface FeedbackStore {
  submit(f: Omit<FormFeedback, 'id'>): Promise<FormFeedback>;
  /** Everything, for Administration › Form feedback (Admins and the reporting role). */
  list(): Promise<FormFeedback[]>;
  /** What this person sent, so they see when it's fixed. */
  listMine(userId: string): Promise<FormFeedback[]>;
  /** Status, resolution note and fixing revision. */
  update(f: FormFeedback): Promise<FormFeedback>;
}

/**
 * `ev_usageevent` rows (see domain/usage). `track` queues and returns at once: it never
 * throws, never waits on Dataverse and never shows anything to the advisor.
 */
export interface UsageLog {
  track(events: UsageEvent[]): void;
  /** Write what's waiting now (the queue also does this on its own). */
  flush(): Promise<void>;
  /**
   * Rows since `since` (ISO), oldest first, for Administration › Readiness. Admins and the
   * reporting role only: everyone else has Create and no Read. `truncated` when there were
   * more than Folium reads in one go (the Power BI report has the rest).
   */
  list(since: string): Promise<{ events: UsageEvent[]; truncated: boolean }>;
}

/** Where a form may be used (states, variant group) and which firm profile fills it. */
export type TemplateDetails = Pick<FormTemplate, 'states' | 'variantGroup' | 'firmId'>;

export interface IncomingFile {
  itemId: string;
  name: string;
  url: string;
  uploadedBy: string;
  uploadedOn: string;
  sizeBytes: number;
  /** Form number parsed from the file name, when it looks like one. */
  guessedFormNumber?: string;
}

/** Unsigned drafts in the contact's SharePoint document location. */
export interface DraftStore {
  saveDraft(contactId: string, fileName: string, pdf: Uint8Array): Promise<{ url: string }>;
  folderUrl(contactId: string): Promise<string>;
  /** Save an attached document next to the drafts, so the draft can be resumed or shared. */
  saveAttachment(contactId: string, fileName: string, bytes: Uint8Array): Promise<{ itemId: string; url: string }>;
  /** Read back a file saved with `saveAttachment`. */
  getFile(itemId: string): Promise<Uint8Array>;
  /** Delete a draft PDF written by `saveDraft`, by the URL it returned. A file that's already gone is fine. */
  removeFile(url: string): Promise<void>;
}

/** `ev_signaturerequest` rows. */
export interface RequestStore {
  listForContact(contactId: string): Promise<SignatureRequest[]>;
  listMine(): Promise<SignatureRequest[]>;
  get(id: string): Promise<SignatureRequest | undefined>;
  save(req: SignatureRequest): Promise<SignatureRequest>;
  /** Soft delete: the row is deactivated and drops out of the lists. */
  remove(id: string): Promise<void>;
  /** Undo `remove`, keeping the same row ID. */
  restore(id: string): Promise<void>;
}

export interface PacketStore {
  list(): Promise<SavedPacket[]>;
  save(p: SavedPacket): Promise<SavedPacket>;
  /** Soft delete, like `RequestStore.remove`. */
  remove(id: string): Promise<void>;
  restore(id: string): Promise<void>;
}

export interface EnvelopeStatus {
  /** Undefined when DocuSign reports a status Folium doesn't know: keep the stored one. */
  status?: SignatureStatus;
  /** Why DocuSign voided it (an expiry reason maps to `Expired`). */
  voidedReason?: string;
  /** DocuSign's `expireDateTime`. */
  expiresOn?: string;
  viewedOn?: string;
  signedOn?: string;
  recipients: { role: string; email: string; status: 'sent' | 'delivered' | 'completed' | 'declined'; at?: string; authMethod?: string }[];
}

export interface SendRequest {
  documents: { name: string; pdf: Uint8Array; placements: Placement[] }[];
  signers: {
    role: string;
    name: string;
    email: string;
    phone?: string;
    order: number;
    auth: VerificationMethod;
    /** Only ever here, on its way to DocuSign: `SignerAssignment` keeps `accessCodeSet`. */
    accessCode?: string;
    /** Embedded signing: DocuSign gets a `clientUserId` and the signer goes first. */
    inSession?: boolean;
    contactId?: string;
  }[];
  ccs?: { name: string; email: string }[];
  subject: string;
  message: string;
  reminderDays?: number;
  expiresInDays?: number;
  attachments?: { name: string; pdf: Uint8Array }[];
}

/**
 * Provider-neutral e-signature interface (see brief). One instance is one connection:
 * a provider and an account (`docusign:main`). Screens read `capabilities` and offer
 * only what the provider supports.
 *
 * Sending is two steps so it's safe to resume: `create` makes the envelope as a
 * draft (nothing reaches the signers), then `release` sends it. If `release` times
 * out, `getStatus` says whether it went out (status other than `Drafted`).
 */
export interface SigningProvider {
  /** The connection id stored on requests (`SignatureRequest.provider`). */
  readonly id: string;
  /** What people see: "DocuSign", "DocuSign (Trust account)". */
  readonly label: string;
  /** `docusign` connections read the DocuSign setup (account, verification workflows). */
  readonly kind: 'docusign' | 'other';
  readonly capabilities: ProviderCapabilities;
  create(req: SendRequest): Promise<{ envelopeId: string }>;
  release(envelopeId: string): Promise<void>;
  getStatus(envelopeId: string): Promise<EnvelopeStatus>;
  downloadCompleted(envelopeId: string): Promise<{ pdf: Uint8Array; certificate: Uint8Array }>;
  void(envelopeId: string, reason: string): Promise<void>;
  resend(envelopeId: string): Promise<void>;
  /** Corrects only what's given. A signer's access code and in-session setting stay as they were. */
  correctRecipient(envelopeId: string, role: string, change: { email?: string; phone?: string; name?: string }): Promise<void>;
  /**
   * A short-lived link to sign now, for a signer sent `inSession`. Ask for a fresh one
   * each time: a used, cancelled or timed-out link can't be opened again. DocuSign
   * sends the signer to `returnUrl` with `event` added (`signing_complete`, `decline`,
   * `cancel`, `ttl_expired`, …).
   */
  signingUrl(envelopeId: string, role: string, returnUrl: string): Promise<string>;
  /**
   * Test connection: whether the signed-in person's connection reaches the account, and
   * the account's name when it does. Throws with the reason when it doesn't. A DocuSign
   * connection takes `setup` to try settings before they're saved.
   */
  checkConnection(setup?: DocuSignSetup): Promise<DocuSignAccount>;
}

/** Every e-signature connection Folium has, by id. */
export interface SigningRegistry {
  /** In the order they're registered; the first is the fallback default. */
  list(): SigningProvider[];
  /**
   * The connection with this id. A legacy `DocuSign` id is the main DocuSign connection;
   * an unknown id gets the first registered, with a console warning, so an old request
   * still opens.
   */
  get(id: string | undefined): SigningProvider;
  has(id: string): boolean;
}

export interface DocuSignAccount {
  accountId: string;
  accountName: string;
}

/** Folium users, groups, firm profiles and settings (Admin-managed; users edit their own profile). */
export interface DirectoryService {
  /**
   * The signed-in person: their profile over their directory details (see
   * `mergeAdvisor`). Records today's sign-in on the profile, at most once a day.
   */
  currentUser(): Promise<UserProfile>;
  /** Every profile, active or not, each merged with its directory details and `disabled` flag. */
  listUsers(): Promise<UserProfile[]>;
  /** Saves overrides only (`profileToSave`): values equal to the directory's aren't stored. */
  saveUser(u: UserProfile): Promise<UserProfile>;
  /**
   * Deactivate or reactivate a profile (`ev_foliumprofile.statecode`). Deactivating
   * also takes the person out of every group. Their requests and drafts are kept.
   */
  setActive(systemuserid: string, active: boolean): Promise<void>;
  /** Directory (`systemuser`) rows for these sign-in emails, with or without a Folium profile. */
  lookupDirectory(emails: string[]): Promise<DirectoryUser[]>;
  listGroups(): Promise<UserGroup[]>;
  saveGroup(g: UserGroup): Promise<UserGroup>;
  removeGroup(id: string): Promise<void>;
  /**
   * Every firm profile (domain/firms), made whole by `normalizeFirms`: exactly one is the
   * default, and the single profile from before profiles loads as it.
   */
  listFirms(): Promise<FirmProfile[]>;
  /** Saves one profile. Saving one as the default takes the default from the others. */
  saveFirm(f: FirmProfile): Promise<FirmProfile>;
  /** Removes a profile that isn't the default. */
  removeFirm(id: string): Promise<void>;
  /** Firm-wide rules, with defaults filled in when nothing is saved yet. */
  getPolicy(): Promise<FirmPolicy>;
  savePolicy(p: FirmPolicy): Promise<FirmPolicy>;
  /** The firm's DocuSign account and verification workflows, with defaults when nothing is saved. */
  getDocuSign(): Promise<DocuSignSetup>;
  saveDocuSign(s: DocuSignSetup): Promise<DocuSignSetup>;
  /** Which e-signature connection is the default and whether people may choose. */
  getSigning(): Promise<SigningSettings>;
  saveSigning(s: SigningSettings): Promise<SigningSettings>;
  /** Every announcement, past and scheduled too (Administration › Announcements filters them). */
  listAnnouncements(): Promise<Announcement[]>;
  /** Refuses a blank message or one over 1,000 characters (`cleanAnnouncement`). */
  saveAnnouncement(a: Announcement): Promise<Announcement>;
  removeAnnouncement(id: string): Promise<void>;
}

export interface Services {
  mode: 'demo' | 'power';
  directory: DirectoryService;
  crm: CrmService;
  templates: TemplateLibrary;
  drafts: DraftStore;
  requests: RequestStore;
  packets: PacketStore;
  /** E-signature connections. A request's actions use `signing.get(request.provider)`. */
  signing: SigningRegistry;
  feedback: FeedbackStore;
  /** Not guarded like the others: a failure here is dropped, not reported. */
  usage: UsageLog;
  /** Bytes of files attached in this session. Saved drafts also store them in SharePoint (`Attachment.storedAt`). */
  attachments: Map<string, { meta: Attachment; bytes: Uint8Array }>;
}
