import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ClientRecord, FirmProfile, FormTemplate, SavedPacket, SignatureRequest, UserGroup, UserProfile } from '../../domain/types';
import { generateTemplatePdf } from '../../pdf/generate';
import type {
  CrmService,
  DirectoryService,
  DraftStore,
  EnvelopeStatus,
  IncomingFile,
  PacketStore,
  RequestStore,
  SendRequest,
  Services,
  SigningProvider,
  TemplateLibrary,
} from '../types';
import { CLIENTS, FIRM, GROUPS, seedPackets, seedRequests, TEMPLATES, USERS } from './seed';
import { SPECS } from './specs';

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
  formRequests: { name: string; issuer?: string; note?: string; requestedBy: string; at: string }[];
  users: UserProfile[];
  groups: UserGroup[];
  firm: FirmProfile;
  clients: Record<string, ClientRecord>;
  currentUserId: string;
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
    formRequests: [],
    users: structuredClone(USERS),
    groups: structuredClone(GROUPS),
    firm: { ...FIRM },
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

const me = () => state.users.find((u) => u.systemuserid === state.currentUserId) ?? state.users[0];

const directory: DirectoryService = {
  async currentUser() {
    return clone(me());
  },
  async listUsers() {
    return clone(state.users);
  },
  async saveUser(u) {
    const i = state.users.findIndex((x) => x.systemuserid === u.systemuserid);
    if (i >= 0) state.users[i] = clone(u);
    else state.users.push(clone(u));
    persist();
    return clone(u);
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
  async getFirm() {
    return clone(state.firm);
  },
  async saveFirm(f) {
    state.firm = clone(f);
    persist();
    return clone(f);
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
      description: prev?.description,
      modifiedOn: new Date().toISOString(),
      modifiedBy: file.uploadedBy,
    };
    state.templates.push(t);
    state.incomingDismissed.push(file.itemId);
    persist();
    return clone(t);
  },
  async requestForm(req) {
    state.formRequests.push({ ...req, at: new Date().toISOString() });
    persist();
    await wait(200);
  },
};

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

/** Simulated DocuSign. Envelopes move Sent → Viewed → Signed over a couple of minutes. */
const sentAt = new Map<string, number>();
const sentDocs = new Map<string, SendRequest>();

const signing: SigningProvider = {
  name: 'DocuSign (demo)',
  async send(req) {
    await wait(700);
    const id = crypto.randomUUID();
    sentAt.set(id, Date.now());
    sentDocs.set(id, req);
    return { envelopeId: id };
  },
  async getStatus(envelopeId): Promise<EnvelopeStatus> {
    const t = sentAt.get(envelopeId);
    const req = state.requests.find((r) => r.envelopeId === envelopeId);
    if (!t) {
      return { status: req?.status ?? 'Sent', viewedOn: req?.viewedOn, signedOn: req?.signedOn, recipients: [] };
    }
    const age = (Date.now() - t) / 1000;
    const status = age > 90 ? 'Signed' : age > 30 ? 'Viewed' : 'Sent';
    const now = new Date().toISOString();
    return {
      status,
      viewedOn: age > 30 ? new Date(t + 30_000).toISOString() : undefined,
      signedOn: age > 90 ? now : undefined,
      recipients: (sentDocs.get(envelopeId)?.signers ?? []).map((s) => ({ role: s.role, email: s.email, status: status === 'Signed' ? 'completed' : status === 'Viewed' ? 'delivered' : 'sent' })),
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
};

export function createDemoServices(): Services {
  return { mode: 'demo', directory, crm, templates, drafts, requests, packets, signing, attachments: new Map() };
}
