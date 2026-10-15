import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ClientRecord, FirmPolicy, FirmProfile, FormTemplate, SavedPacket, SignatureRequest, UserGroup, UserProfile } from '../../domain/types';
import { mergeAdvisor, profileToSave } from '../../domain/advisor';
import { withPolicyDefaults } from '../../domain/policy';
import { cleanAnnouncement, type Announcement } from '../../domain/announcements';
import { docuSignReady, withDocuSignDefaults, type DocuSignSetup } from '../../domain/docusign';
import { normalizeFirms } from '../../domain/firms';
import { DOCUSIGN_MAIN, type ProviderCapabilities, type SigningSettings } from '../../domain/signing';
import { needsSeenStamp } from '../../domain/users';
import { mapDocuSignStatus } from '../../domain/requests';
import { formRequest, type FormFeedback } from '../../domain/feedback';
import type { UsageEvent } from '../../domain/usage';
import { generateTemplatePdf } from '../../pdf/generate';
import type {
  CrmService,
  DirectoryService,
  DraftStore,
  EnvelopeStatus,
  FeedbackStore,
  IncomingFile,
  PacketStore,
  RequestStore,
  SendRequest,
  Services,
  SigningProvider,
  TemplateLibrary,
} from '../types';
import { createSigningRegistry } from '../registry';
import { CLIENTS, DIRECTORY, FIRMS, GROUPS, seedAnnouncements, seedFeedback, seedPackets, seedRequests, TEMPLATES, USERS } from './seed';
import { SPECS } from './specs';
import { createUsageQueue } from '../usage';
import { seedUsage } from './usageSeed';

// In-browser implementations used in demo mode (and in local dev without a Power
// Platform environment). State persists to localStorage so a demo survives reloads.

const KEY = 'folium.demo.v1';

interface DemoState {
  requests: SignatureRequest[];
  packets: SavedPacket[];
  /** Soft-deleted rows, so Undo can bring back the same ID. */
  deletedRequests?: SignatureRequest[];
  deletedPackets?: SavedPacket[];
  templates: FormTemplate[];
  incomingDismissed: string[];
  /** Before form feedback: "Ask Marketing" requests by name. Read once into `feedback`. */
  formRequests?: { name: string; issuer?: string; note?: string; requestedBy: string; at: string }[];
  /** `ev_formrequest` rows: form requests and problem reports. */
  feedback?: FormFeedback[];
  /** `ev_usageevent` rows recorded in this demo (the seeded year isn't stored). */
  usage?: UsageEvent[];
  users: UserProfile[];
  groups: UserGroup[];
  /** Before firm profiles: the one firm. Read once into `firms`. */
  firm?: Partial<FirmProfile>;
  /** Firm profiles (`ev_foliumsetting` rows named "Firm: …"). */
  firms?: FirmProfile[];
  /** Missing in demo data saved before announcements: the seeded ones apply. */
  announcements?: Announcement[];
  /** Missing in demo data saved before connections: DocuSign is the default. */
  signing?: SigningSettings;
  clients: Record<string, ClientRecord>;
  currentUserId: string;
  /** Simulated DocuSign envelopes: created (a draft) and, once released, when they went out. */
  envelopes?: Record<string, DemoEnvelope>;
  /** Missing in demo data saved before policies existed: defaults apply. */
  policy?: FirmPolicy;
  /** Missing in demo data saved before DocuSign setup existed: the demo setup applies. */
  docuSign?: DocuSignSetup;
  /** Deactivated profiles (`statecode` 1 in Dataverse). */
  inactiveUserIds?: string[];
}

function load(): DemoState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DemoState;
  } catch {
    /* storage unavailable; fall through to seed */
  }
  return {
    requests: seedRequests(),
    packets: seedPackets(),
    templates: structuredClone(TEMPLATES),
    incomingDismissed: [],
    feedback: seedFeedback(),
    users: structuredClone(USERS),
    groups: structuredClone(GROUPS),
    firms: structuredClone(FIRMS),
    announcements: seedAnnouncements(),
    clients: structuredClone(CLIENTS),
    currentUserId: USERS[0].systemuserid,
  };
}

let state = load();
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function resetDemo() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(FILES_KEY);
  } catch {
    /* ignore */
  }
  state = load();
}

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(x: T): T => structuredClone(x);

/** Demo-only: switch who is signed in, to try the Assistant and Admin experiences. */
export function setDemoUser(id: string) {
  state.currentUserId = id;
  persist();
}

/** Firm profiles, reading demo data saved before profiles (one `firm`) as the default. */
const firms = (): FirmProfile[] => (state.firms ??= normalizeFirms(state.firm ? [state.firm] : clone(FIRMS)));

const me = () => state.users.find((u) => u.systemuserid === state.currentUserId) ?? state.users[0];

/** A stored profile as the power service returns it: over its directory row, with its active flag. */
const asLoaded = (u: UserProfile): UserProfile => {
  const merged = mergeAdvisor(DIRECTORY.find((d) => d.systemuserid === u.systemuserid), clone(u));
  return state.inactiveUserIds?.includes(u.systemuserid) ? { ...merged, active: false } : merged;
};

const directory: DirectoryService = {
  async currentUser() {
    const u = me();
    const now = new Date();
    if (needsSeenStamp(u.lastSeenOn, now)) {
      u.lastSeenOn = now.toISOString();
      persist();
    }
    return asLoaded(u);
  },
  async listUsers() {
    return state.users.map(asLoaded);
  },
  async saveUser(u) {
    const stored = profileToSave(u);
    const i = state.users.findIndex((x) => x.systemuserid === u.systemuserid);
    if (i >= 0) state.users[i] = clone(stored);
    else state.users.push(clone(stored));
    persist();
    return clone(u);
  },
  async setActive(id, active) {
    const u = state.users.find((x) => x.systemuserid === id);
    if (!u) throw new Error('That person has no Folium profile.');
    const ids = new Set(state.inactiveUserIds ?? []);
    if (active) ids.delete(id);
    else {
      ids.add(id);
      u.groupIds = [];
      for (const g of state.groups) g.memberIds = g.memberIds.filter((m) => m !== id);
    }
    state.inactiveUserIds = [...ids];
    persist();
  },
  async lookupDirectory(emails) {
    const want = new Set(emails.map((e) => e.trim().toLowerCase()));
    return clone(DIRECTORY.filter((d) => d.email && want.has(d.email.toLowerCase())));
  },
  async listGroups() {
    return clone(state.groups);
  },
  async saveGroup(g) {
    const i = state.groups.findIndex((x) => x.id === g.id);
    if (i >= 0) state.groups[i] = clone(g);
    else state.groups.push(clone(g));
    // Keep each user's groupIds in step with group membership.
    for (const u of state.users) {
      const inGroup = g.memberIds.includes(u.systemuserid);
      const has = u.groupIds.includes(g.id);
      if (inGroup && !has) u.groupIds.push(g.id);
      if (!inGroup && has) u.groupIds = u.groupIds.filter((x) => x !== g.id);
    }
    persist();
    return clone(g);
  },
  async removeGroup(id) {
    state.groups = state.groups.filter((g) => g.id !== id);
    for (const u of state.users) u.groupIds = u.groupIds.filter((x) => x !== id);
    persist();
  },
  async listFirms() {
    return normalizeFirms(clone(firms()));
  },
  async saveFirm(f) {
    const list = firms().map((x) => (f.isDefault ? { ...x, isDefault: false } : x));
    const i = list.findIndex((x) => x.id === f.id);
    if (i >= 0) list[i] = clone(f);
    else list.push(clone(f));
    state.firms = normalizeFirms(list);
    persist();
    return clone(state.firms.find((x) => x.id === f.id)!);
  },
  async removeFirm(id) {
    const f = firms().find((x) => x.id === id);
    if (f?.isDefault) throw new Error('The default firm profile can’t be removed. Make another profile the default first.');
    state.firms = firms().filter((x) => x.id !== id);
    persist();
  },
  async getSigning() {
    return clone(state.signing ?? {});
  },
  async saveSigning(s) {
    state.signing = clone(s);
    persist();
    return clone(s);
  },
  async listAnnouncements() {
    return clone((state.announcements ??= seedAnnouncements()));
  },
  async saveAnnouncement(a) {
    const clean = cleanAnnouncement(a);
    const list = (state.announcements ??= seedAnnouncements());
    const i = list.findIndex((x) => x.id === clean.id);
    if (i >= 0) list[i] = clone(clean);
    else list.unshift(clone(clean));
    persist();
    return clone(clean);
  },
  async removeAnnouncement(id) {
    state.announcements = (state.announcements ?? []).filter((a) => a.id !== id);
    persist();
  },
  async getPolicy() {
    return withPolicyDefaults(clone(state.policy));
  },
  async savePolicy(p) {
    state.policy = clone(p);
    persist();
    return clone(p);
  },
  async getDocuSign() {
    return withDocuSignDefaults(clone(state.docuSign ?? DEMO_DOCUSIGN));
  },
  async saveDocuSign(s) {
    state.docuSign = clone(s);
    persist();
    return clone(s);
  },
};

const crm: CrmService = {
  async getClient(contactId) {
    await wait(80);
    const rec = state.clients[contactId];
    if (!rec) throw new Error(`Contact ${contactId} not found`);
    return clone(rec);
  },
  async updateContact(contactId, changes) {
    const rec = state.clients[contactId];
    if (!rec) throw new Error('Contact not found');
    Object.assign(rec.contact, changes);
    rec.contact.fullname = [rec.contact.firstname, rec.contact.middlename, rec.contact.lastname].filter(Boolean).join(' ');
    // Connections hold copies of related contacts; keep them in step.
    for (const r of Object.values(state.clients)) for (const c of r.connections) if (c.contact.contactid === contactId) c.contact = clone(rec.contact);
    persist();
    return clone(rec.contact);
  },
  async updateAccount(accountId, changes) {
    for (const r of Object.values(state.clients)) {
      const a = r.accounts.find((x) => x.accountid === accountId);
      if (a) {
        Object.assign(a, changes);
        persist();
        return clone(a);
      }
    }
    throw new Error('Account not found');
  },
  async searchContacts(q) {
    const s = q.trim().toLowerCase();
    return Object.values(state.clients)
      .map((r) => r.contact)
      .filter((c) => !s || c.fullname.toLowerCase().includes(s) || c.ev_clientid.toLowerCase().includes(s) || (c.emailaddress1 ?? '').toLowerCase().includes(s));
  },
  async recentContacts() {
    return Object.values(state.clients).map((r) => r.contact);
  },
};

const pdfCache = new Map<string, Promise<Uint8Array>>();

const templates: TemplateLibrary = {
  async list() {
    await wait(60);
    return clone(state.templates);
  },
  getPdf(t) {
    const key = t.id;
    if (!pdfCache.has(key)) {
      // Registered demo uploads reuse the nearest spec; brand-new forms get a generic one.
      const spec = SPECS.find((s) => s.id === t.id) ?? SPECS.find((s) => s.formNumber === t.formNumber) ?? {
        ...SPECS[0],
        name: t.name,
        formNumber: t.formNumber,
        revision: t.revision,
        issuer: t.issuer ?? 'Everence Financial',
        intro: undefined,
        sections: [SPECS[1].sections[0], { title: 'Signature', signatures: [{ role: 'Owner', label: 'Owner' }] }],
      };
      pdfCache.set(
        key,
        generateTemplatePdf({ title: spec.name, formNumber: spec.formNumber, revision: spec.revision, issuer: spec.issuer, intro: spec.intro, sections: spec.sections, kind: spec.pdfKind === 'flat' ? 'flat' : 'fillable' }),
      );
    }
    return pdfCache.get(key)!;
  },
  async listIncoming() {
    const files: IncomingFile[] = [
      { itemId: 'sp-new-ev1120', name: 'EV-1120_Beneficiary_Designation_Rev-01-2027.pdf', url: 'https://everence.sharepoint.com/sites/Marketing/Forms/EV-1120_Rev-01-2027.pdf', uploadedBy: 'Dana Yoder', uploadedOn: new Date(Date.now() - 2 * 864e5).toISOString(), sizeBytes: 214_331, guessedFormNumber: 'EV-1120' },
      { itemId: 'sp-new-hsa', name: 'Everence_HSA_Enrollment.pdf', url: 'https://everence.sharepoint.com/sites/Marketing/Forms/Everence_HSA_Enrollment.pdf', uploadedBy: 'Dana Yoder', uploadedOn: new Date(Date.now() - 5 * 864e5).toISOString(), sizeBytes: 388_020 },
    ];
    return files.filter((f) => !state.incomingDismissed.includes(f.itemId));
  },
  async saveMapping(id, mapping) {
    const t = state.templates.find((x) => x.id === id);
    if (!t) throw new Error('Template not found');
    t.mapping = clone(mapping);
    t.modifiedOn = new Date().toISOString();
    t.modifiedBy = me().fullname;
    if (t.status === 'Needs mapping' && mapping.fields.length) t.status = 'Draft';
    persist();
    return clone(t);
  },
  async saveDetails(id, details) {
    const t = state.templates.find((x) => x.id === id);
    if (!t) throw new Error('Template not found');
    t.states = details.states?.length ? [...details.states] : undefined;
    t.variantGroup = details.variantGroup?.trim() || undefined;
    if ('firmId' in details) t.firmId = details.firmId || undefined;
    t.modifiedOn = new Date().toISOString();
    t.modifiedBy = me().fullname;
    persist();
    return clone(t);
  },
  async setStatus(id, status, effectiveDate) {
    const t = state.templates.find((x) => x.id === id);
    if (!t) throw new Error('Template not found');
    t.status = status;
    if (effectiveDate) t.effectiveDate = effectiveDate;
    if (status === 'Live' && t.effectiveDate <= new Date().toISOString().slice(0, 10)) {
      // Publishing an effective revision retires older live ones. A future-dated revision
      // stays alongside the current one and takes over on its effective date.
      for (const other of state.templates) if (other.id !== id && other.formNumber === t.formNumber && other.status === 'Live' && other.effectiveDate <= t.effectiveDate) other.status = 'Retired';
    }
    persist();
    return clone(t);
  },
  async register(file, init) {
    const prev = state.templates.find((t) => t.formNumber === init.formNumber && t.status === 'Live');
    const t: FormTemplate = {
      id: `tpl-${Date.now()}`,
      name: init.name ?? file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
      formNumber: init.formNumber ?? 'NEW',
      source: init.source ?? prev?.source ?? 'Everence',
      issuer: init.issuer ?? prev?.issuer,
      category: init.category ?? prev?.category ?? 'Account maintenance',
      revision: init.revision ?? 'New',
      effectiveDate: init.effectiveDate ?? new Date().toISOString().slice(0, 10),
      status: 'Needs mapping',
      pdfKind: prev?.pdfKind ?? 'fillable',
      pageCount: prev?.pageCount ?? 1,
      sharePointItemId: file.itemId,
      sharePointUrl: file.url,
      supersedesId: prev?.id,
      mapping: { formNumber: init.formNumber ?? 'NEW', revision: init.revision ?? 'New', fields: [], signers: prev?.mapping.signers ?? [{ role: 'Owner' }], placements: [], checks: [] },
      keywords: prev?.keywords,
      appliesTo: prev?.appliesTo,
      // A new revision is approved where the last one was, unless the admin says otherwise.
      states: init.states ?? prev?.states,
      variantGroup: init.variantGroup ?? prev?.variantGroup,
      description: prev?.description,
      modifiedOn: new Date().toISOString(),
      modifiedBy: file.uploadedBy,
    };
    state.templates.push(t);
    state.incomingDismissed.push(file.itemId);
    persist();
    return clone(t);
  },
};

/** Feedback rows, with requests saved before feedback existed read in as requests. */
function feedbackRows(): FormFeedback[] {
  if (!state.feedback) state.feedback = seedFeedback();
  if (state.formRequests?.length) {
    for (const [i, r] of state.formRequests.entries()) state.feedback.push({ ...formRequest(r, { systemuserid: '', fullname: r.requestedBy }, new Date(r.at)), id: `fb-legacy-${i}` });
    state.formRequests = undefined;
    persist();
  }
  return state.feedback;
}

const feedback: FeedbackStore = {
  async submit(f) {
    await wait(200);
    const row = { ...clone(f), id: `fb-${crypto.randomUUID().slice(0, 8)}` };
    feedbackRows().unshift(row);
    persist();
    return clone(row);
  },
  async list() {
    await wait(60);
    return clone(feedbackRows());
  },
  async listMine(userId) {
    return clone(feedbackRows().filter((f) => f.requestedById === userId));
  },
  async update(f) {
    const rows = feedbackRows();
    const i = rows.findIndex((x) => x.id === f.id);
    if (i < 0) throw new Error('That report is no longer there');
    rows[i] = clone(f);
    persist();
    return clone(f);
  },
};

// ---------------------------------------------------------------- Usage events

/** Most usage events the demo keeps in localStorage. */
const USAGE_CAP = 2000;

/** Writes usage to the demo state. Like Dataverse's alternate key, a dedupe key already there is skipped. */
export async function demoUsageWriter(events: UsageEvent[]): Promise<void> {
  const rows = (state.usage ??= []);
  const have = new Set(rows.map((e) => e.dedupeKey));
  for (const e of events) if (!have.has(e.dedupeKey)) (rows.push(clone(e)), have.add(e.dedupeKey));
  if (rows.length > USAGE_CAP) state.usage = rows.slice(rows.length - USAGE_CAP);
  persist();
}

let seeded: UsageEvent[] | undefined;
/** The demo's usage: a seeded year of history plus what was recorded here. For reporting and tests. */
export function demoUsage(): UsageEvent[] {
  seeded ??= seedUsage(USERS, GROUPS, TEMPLATES);
  return [...seeded, ...clone(state.usage ?? [])];
}

/** Only what was recorded in this demo, without the seeded history. */
export const recordedUsage = (): UsageEvent[] => clone(state.usage ?? []);

const usage = createUsageQueue(demoUsageWriter);

// Attached files: in memory, and in localStorage when it has room, so a demo draft's
// attachments survive a reload.
const FILES_KEY = 'folium.demo.files.v1';
const files = new Map<string, Uint8Array>();
function storedFile(id: string): Uint8Array | undefined {
  if (files.has(id)) return files.get(id);
  try {
    const all = JSON.parse(localStorage.getItem(FILES_KEY) ?? '{}') as Record<string, string>;
    return all[id] ? Uint8Array.from(atob(all[id]), (c) => c.charCodeAt(0)) : undefined;
  } catch {
    return undefined;
  }
}
function storeFile(id: string, bytes: Uint8Array) {
  files.set(id, bytes);
  try {
    const all = JSON.parse(localStorage.getItem(FILES_KEY) ?? '{}') as Record<string, string>;
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    all[id] = btoa(bin);
    localStorage.setItem(FILES_KEY, JSON.stringify(all));
  } catch {
    /* too big for storage; memory only */
  }
}

/** Draft PDFs deleted this session (the demo writes none), for tests. */
export const removedFiles: string[] = [];

const drafts: DraftStore = {
  async saveDraft(contactId, fileName) {
    await wait(150);
    return { url: `${await drafts.folderUrl(contactId)}/${encodeURIComponent(fileName)}` };
  },
  async saveAttachment(contactId, fileName, bytes) {
    await wait(100);
    const itemId = `file-${crypto.randomUUID()}`;
    storeFile(itemId, bytes);
    return { itemId, url: `${await drafts.folderUrl(contactId)}/Folium%20attachments/${encodeURIComponent(fileName)}` };
  },
  async removeFile(url) {
    await wait(60);
    removedFiles.push(url);
  },
  async getFile(itemId) {
    const bytes = storedFile(itemId);
    if (!bytes) throw new Error('That attachment is no longer stored. Attach it again.');
    return bytes;
  },
  async folderUrl(contactId) {
    const c = state.clients[contactId]?.contact;
    return `https://everence.sharepoint.com/sites/CRM/contact/${encodeURIComponent(`${c?.fullname ?? contactId}_${c?.ev_clientid ?? ''}`)}`;
  },
};

const requests: RequestStore = {
  async listForContact(contactId) {
    await wait(60);
    return clone(state.requests.filter((r) => r.contactId === contactId));
  },
  async listMine() {
    return clone(state.requests);
  },
  async get(id) {
    return clone(state.requests.find((r) => r.id === id));
  },
  async save(req) {
    const i = state.requests.findIndex((r) => r.id === req.id);
    if (i >= 0) state.requests[i] = clone(req);
    else state.requests.unshift(clone(req));
    persist();
    return clone(req);
  },
  async remove(id) {
    state.deletedRequests = [...(state.deletedRequests ?? []), ...state.requests.filter((r) => r.id === id)];
    state.requests = state.requests.filter((r) => r.id !== id);
    persist();
  },
  async restore(id) {
    const row = state.deletedRequests?.find((r) => r.id === id);
    if (!row) throw new Error('That draft can’t be restored');
    state.deletedRequests = state.deletedRequests!.filter((r) => r.id !== id);
    state.requests.unshift(row);
    persist();
  },
};

const packets: PacketStore = {
  async list() {
    return clone(state.packets);
  },
  async save(p) {
    const i = state.packets.findIndex((x) => x.id === p.id);
    if (i >= 0) state.packets[i] = clone(p);
    else state.packets.unshift(clone(p));
    persist();
    return clone(p);
  },
  async remove(id) {
    state.deletedPackets = [...(state.deletedPackets ?? []), ...state.packets.filter((p) => p.id === id)];
    state.packets = state.packets.filter((p) => p.id !== id);
    persist();
  },
  async restore(id) {
    const row = state.deletedPackets?.find((p) => p.id === id);
    if (!row) throw new Error('That packet can’t be restored');
    state.deletedPackets = state.deletedPackets!.filter((p) => p.id !== id);
    state.packets.unshift(row);
    persist();
  },
};

const forceExpiry = () => typeof location !== 'undefined' && /[?&]expire=1(&|$)/.test(location.search + location.hash);

interface DemoEnvelope {
  createdAt: number;
  sentAt?: number;
  /** Kept with the envelope (not just in memory) so a signing tab opened from Folium can read it. */
  signers?: { role: string; email: string; inSession?: boolean }[];
  expiresInDays?: number;
  /** In-session signers who finished, and when. */
  signedInSession?: Record<string, number>;
}

/**
 * Simulated DocuSign. Envelopes move Sent → Viewed → Signed over a couple of minutes,
 * except in-session signers, who sign on the demo signing page.
 */
const envelopes = () => (state.envelopes ??= {});
/** When an envelope went out, for envelopes this demo created. */
const sentAtOf = (id: string) => envelopes()[id]?.sentAt;
const sentDocs = new Map<string, SendRequest>();


/** Sample sandbox setup, so the demo's Administration › Settings shows a working account. */
const DEMO_DOCUSIGN: DocuSignSetup = {
  environment: 'demo',
  accountId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
  idv: { sms: '11111111-2222-4333-8444-555555555555', phone: '22222222-3333-4444-8555-666666666666', kba: '33333333-4444-4555-8666-777777777777' },
};

const DOCUSIGN_CAPABILITIES: ProviderCapabilities = { verification: ['email', 'sms', 'phone', 'kba'], accessCode: true, inSession: true, correctRecipient: true };

/**
 * Simulated providers. Both run the same pretend envelopes; the second stands in for
 * another e-signature platform with fewer features, so switching connections can be
 * tried without a tenant.
 */
function demoProvider(meta: Pick<SigningProvider, 'id' | 'label' | 'kind' | 'capabilities'>, checkConnection: SigningProvider['checkConnection']): SigningProvider {
  return { ...meta, checkConnection, ...envelopeOps };
}

const envelopeOps: Omit<SigningProvider, 'id' | 'label' | 'kind' | 'capabilities' | 'checkConnection'> = {
  async create(req) {
    await wait(500);
    const id = crypto.randomUUID();
    envelopes()[id] = { createdAt: Date.now(), signers: req.signers.map((x) => ({ role: x.role, email: x.email, inSession: x.inSession || undefined })), expiresInDays: req.expiresInDays };
    persist();
    sentDocs.set(id, req);
    return { envelopeId: id };
  },
  async release(envelopeId) {
    await wait(200);
    const env = envelopes()[envelopeId];
    if (!env) throw new Error('Envelope not found');
    // Like DocuSign, releasing an envelope that already went out doesn't send it again.
    env.sentAt ??= Date.now();
    persist();
  },
  async getStatus(envelopeId): Promise<EnvelopeStatus> {
    syncSignedInSession(envelopeId);
    const env = envelopes()[envelopeId];
    if (env && !env.sentAt) return { status: 'Drafted', recipients: [] };
    const t = sentAtOf(envelopeId);
    const req = state.requests.find((r) => r.envelopeId === envelopeId);
    // Like DocuSign, an envelope still open past its expiry comes back voided with an
    // expiry reason. `?demo=1&expire=1` makes every open envelope lapse now.
    const expiresOn = req?.expiresOn ?? (t && env?.expiresInDays ? new Date(t + env.expiresInDays * 86_400_000).toISOString() : undefined);
    const open = !req || req.status === 'Sent' || req.status === 'Viewed';
    if (open && (forceExpiry() || (expiresOn && new Date(expiresOn).getTime() <= Date.now()))) {
      return {
        status: mapDocuSignStatus('voided', 'Envelope has expired.'),
        voidedReason: 'Envelope has expired.',
        expiresOn: expiresOn ?? new Date().toISOString(),
        viewedOn: req?.viewedOn,
        recipients: (req?.signers ?? []).map((s) => ({ role: s.role, email: s.email, status: s.status === 'signed' ? 'completed' : s.status === 'viewed' ? 'delivered' : 'sent', at: s.signedOn })),
      };
    }
    if (!t) {
      return { status: req?.status ?? 'Sent', viewedOn: req?.viewedOn, signedOn: req?.signedOn, expiresOn, recipients: [] };
    }
    const age = (Date.now() - t) / 1000;
    const remote: 'completed' | 'delivered' | 'sent' = age > 90 ? 'completed' : age > 30 ? 'delivered' : 'sent';
    const done = env?.signedInSession ?? {};
    const recipients = (env?.signers ?? sentDocs.get(envelopeId)?.signers ?? []).map((s) => {
      const at = done[s.role];
      return { role: s.role, email: s.email, status: at ? ('completed' as const) : s.inSession ? ('sent' as const) : remote, at: at ? new Date(at).toISOString() : undefined };
    });
    const status = recipients.length && recipients.every((x) => x.status === 'completed') ? 'Signed' : recipients.some((x) => x.status !== 'sent') ? 'Viewed' : age > 30 && !recipients.length ? 'Viewed' : 'Sent';
    return {
      status,
      expiresOn,
      viewedOn: status !== 'Sent' ? new Date(Math.min(t + 30_000, ...Object.values(done))).toISOString() : undefined,
      signedOn: status === 'Signed' ? new Date().toISOString() : undefined,
      recipients,
    };
  },
  async downloadCompleted(envelopeId) {
    const req = state.requests.find((r) => r.envelopeId === envelopeId);
    const out = await PDFDocument.create();
    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    for (const d of req?.documents ?? []) {
      const t = state.templates.find((x) => x.id === d.templateId);
      if (!t) continue;
      const src = await PDFDocument.load(await templates.getPdf(t));
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      for (const pl of t.mapping.placements.filter((p) => p.type === 'signature')) {
        const signer = req?.signers.find((s) => s.role === pl.role);
        if (!signer || signer.status !== 'signed') continue;
        const page = pages[pl.page - 1];
        page.drawText(signer.name, { x: pl.x + 4, y: page.getHeight() - pl.y - 20, size: 14, font: bold, color: rgb(0.05, 0.2, 0.45) });
      }
    }
    const cert = await PDFDocument.create();
    const cp = cert.addPage([612, 792]);
    cp.drawText('Certificate of completion', { x: 48, y: 720, size: 20, font: await cert.embedFont(StandardFonts.HelveticaBold) });
    const cf = await cert.embedFont(StandardFonts.Helvetica);
    let y = 690;
    for (const line of [`Envelope ${envelopeId}`, `Subject: ${req?.subject ?? ''}`, ...(req?.audit ?? []).map((a) => `${new Date(a.at).toLocaleString()} — ${a.actor}: ${a.action}${a.detail ? ` (${a.detail})` : ''}`)]) {
      cp.drawText(line, { x: 48, y, size: 10, font: cf });
      y -= 16;
    }
    return { pdf: await out.save(), certificate: await cert.save() };
  },
  async void() {
    await wait(300);
  },
  async resend() {
    await wait(300);
  },
  async correctRecipient() {
    await wait(300);
  },
  async signingUrl(envelopeId, role, returnUrl) {
    await wait(300);
    const signer = envelopes()[envelopeId]?.signers?.find((x) => x.role === role);
    if (!signer) throw new Error(`No ${role} on this envelope`);
    if (!signer.inSession) throw new Error('This signer was sent by email, not to sign in session.');
    const q = new URLSearchParams({ envelope: envelopeId, role, return: returnUrl });
    return `${location.origin}${location.pathname}${location.search}#/demo-signing?${q}`;
  },
};

const signing = createSigningRegistry([
  demoProvider({ id: DOCUSIGN_MAIN, label: 'DocuSign', kind: 'docusign', capabilities: DOCUSIGN_CAPABILITIES }, async (setup) => {
    await wait(400);
    const s = setup ?? (await directory.getDocuSign());
    if (!docuSignReady(s)) throw new Error('No DocuSign account is set up. An administrator adds it in Administration › Settings.');
    return { accountId: s.accountId!, accountName: 'Everence Financial (demo sandbox)' };
  }),
  demoProvider(
    { id: 'demo:altsign', label: 'Second provider (demo)', kind: 'other', capabilities: { verification: ['email', 'sms'], accessCode: false, inSession: false, correctRecipient: false, maxAttachmentsMb: 10, expiryDays: [30, 60] } },
    async () => {
      await wait(400);
      return { accountId: 'demo-altsign', accountName: 'Everence (second provider, demo)' };
    },
  ),
]);

/** Signing happens in another tab: pick up what it saved. */
function syncSignedInSession(envelopeId: string) {
  try {
    const saved = (JSON.parse(localStorage.getItem(KEY) ?? 'null') as DemoState | null)?.envelopes?.[envelopeId]?.signedInSession;
    const env = envelopes()[envelopeId];
    if (saved && env) env.signedInSession = { ...saved, ...env.signedInSession };
  } catch {
    /* ignore */
  }
}

/** The demo signing page's "Finish": the in-session signer has signed. */
export function demoSignInSession(envelopeId: string, role: string) {
  const env = envelopes()[envelopeId];
  if (!env) throw new Error('Envelope not found');
  (env.signedInSession ??= {})[role] = Date.now();
  persist();
}

export function createDemoServices(): Services {
  return { mode: 'demo', directory, crm, templates, drafts, requests, packets, signing, feedback, usage, attachments: new Map() };
}
