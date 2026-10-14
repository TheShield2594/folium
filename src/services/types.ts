import type {
  Account,
  Attachment,
  ClientRecord,
  Contact,
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
  /** Create a template row for an incoming file (optionally as a new revision of an existing form). */
  register(file: IncomingFile, init: Partial<FormTemplate>): Promise<FormTemplate>;
  /** Ask Marketing for a form that isn't in the library yet. */
  requestForm(req: { name: string; issuer?: string; note?: string; requestedBy: string }): Promise<void>;
}

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
 * Provider-neutral e-signature interface (see brief). Only DocuSign is implemented in v1.
 *
 * Sending is two steps so it's safe to resume: `create` makes the envelope as a
 * DocuSign draft (nothing reaches the signers), then `release` sends it. If `release`
 * times out, `getStatus` says whether it went out (status other than `Drafted`).
 */
export interface SigningProvider {
  readonly name: string;
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
}

/** Folium users, groups and the firm profile (Admin-managed; users edit their own profile). */
export interface DirectoryService {
  currentUser(): Promise<UserProfile>;
  listUsers(): Promise<UserProfile[]>;
  saveUser(u: UserProfile): Promise<UserProfile>;
  listGroups(): Promise<UserGroup[]>;
  saveGroup(g: UserGroup): Promise<UserGroup>;
  removeGroup(id: string): Promise<void>;
  getFirm(): Promise<FirmProfile>;
  saveFirm(f: FirmProfile): Promise<FirmProfile>;
}

export interface Services {
  mode: 'demo' | 'power';
  directory: DirectoryService;
  crm: CrmService;
  templates: TemplateLibrary;
  drafts: DraftStore;
  requests: RequestStore;
  packets: PacketStore;
  signing: SigningProvider;
  /** Bytes of files attached in this session. Saved drafts also store them in SharePoint (`Attachment.storedAt`). */
  attachments: Map<string, { meta: Attachment; bytes: Uint8Array }>;
}
