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
}

/** `ev_signaturerequest` rows. */
export interface RequestStore {
  listForContact(contactId: string): Promise<SignatureRequest[]>;
  listMine(): Promise<SignatureRequest[]>;
  get(id: string): Promise<SignatureRequest | undefined>;
  save(req: SignatureRequest): Promise<SignatureRequest>;
  remove(id: string): Promise<void>;
}

export interface PacketStore {
  list(): Promise<SavedPacket[]>;
  save(p: SavedPacket): Promise<SavedPacket>;
  remove(id: string): Promise<void>;
}

export interface EnvelopeStatus {
  status: SignatureStatus;
  viewedOn?: string;
  signedOn?: string;
  recipients: { role: string; email: string; status: 'sent' | 'delivered' | 'completed' | 'declined'; at?: string; authMethod?: string }[];
}

export interface SendRequest {
  documents: { name: string; pdf: Uint8Array; placements: Placement[] }[];
  signers: { role: string; name: string; email: string; phone?: string; order: number; auth: VerificationMethod }[];
  ccs?: { name: string; email: string }[];
  subject: string;
  message: string;
  reminderDays?: number;
  expiresInDays?: number;
  attachments?: { name: string; pdf: Uint8Array }[];
}

/** Provider-neutral e-signature interface (see brief). Only DocuSign is implemented in v1. */
export interface SigningProvider {
  readonly name: string;
  send(req: SendRequest): Promise<{ envelopeId: string }>;
  getStatus(envelopeId: string): Promise<EnvelopeStatus>;
  downloadCompleted(envelopeId: string): Promise<{ pdf: Uint8Array; certificate: Uint8Array }>;
  void(envelopeId: string, reason: string): Promise<void>;
  resend(envelopeId: string): Promise<void>;
  correctRecipient(envelopeId: string, role: string, change: { email?: string; phone?: string; name?: string }): Promise<void>;
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
  /** Files the advisor attached for an envelope (supporting docs, IDs). Held in memory until send. */
  attachments: Map<string, { meta: Attachment; bytes: Uint8Array }>;
}
