import { useMemo } from 'react';
import { create } from 'zustand';
import { upgradeAuditDetail, upgradePacketItems, type UpgradeReport } from '../domain/drafts';
import type { ResolveScope } from '../domain/paths';
import { actableUsers, DEFAULT_POLICY } from '../domain/policy';
import { ANNOUNCEMENT_REFRESH_MS, type Announcement } from '../domain/announcements';
import { withDocuSignDefaults, type DocuSignSetup } from '../domain/docusign';
import { defaultFirm, firmGroup } from '../domain/firms';
import type { SigningSettings } from '../domain/signing';
import { carryVariantValues, copyScope, migrateAccountValues, seedCopyValues, type PersonPick } from '../domain/prefill';
import { currentTemplates, latestLive } from '../domain/revisions';
import type { CheckResult } from '../domain/checks';
import { normalizeState, pickVariant } from '../domain/states';
import { statusEvents, usageEvents, type UsageEventType } from '../domain/usage';
import type {
  Attachment,
  ClientRecord,
  FirmPolicy,
  FirmProfile,
  FormTemplate,
  PacketItem,
  SavedPacket,
  SignatureRequest,
  UserGroup,
  UserProfile,
} from '../domain/types';
import type { Services } from '../services/types';
import { clearJournal, debounced, newerThanDraft, readJournal, sensitiveKeys, worthKeeping, writeJournal, type Journal } from './journal';

// Small persisted per-viewer conveniences (favorites, recents, theme). Never business data.
function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export type Theme = 'system' | 'light' | 'dark';

export interface Packet {
  items: PacketItem[];
  values: Record<string, string>;
  title: string;
  /**
   * The state forms must be approved in. Undefined follows the client's address; the
   * advisor sets it when what matters is where the application is signed.
   */
  state?: string;
  /** Who filled each person block, by block (per copy on an added copy). */
  personBlocks?: Record<string, PersonPick>;
  /** Set when the packet was opened from (or saved as) a draft request. */
  requestId?: string;
  attachments: Attachment[];
  sharedWith: string[];
  /** CRM values when the open draft was saved; see `snapshotDiff`. */
  snapshot?: Record<string, string>;
  /** Changed since it was opened or last saved. Cleared by Save draft and Send. */
  dirty?: boolean;
  /** A DocuSign send in flight, kept here (and in the journal) so it survives a reload. */
  send?: SendState;
  /** Revision changes from "Update to current forms", recorded in the audit trail at the next save. */
  formsUpdated?: string;
  /** Checks fixed with one click, by check id, with what the row says now ("Filled from Dynamics 365"). */
  resolved?: Record<string, string>;
  /** Why Start a packet added each form, by template id, so Review can explain it. */
  reasons?: Record<string, string>;
}

/**
 * Where a send got to. `created`: DocuSign holds the envelope as a draft; finishing
 * releases it. `sent`: DocuSign sent it and Folium still has to record it. `unknown`:
 * creating it failed in a way that may have landed; the advisor checks before sending again.
 */
export interface SendState {
  phase: 'created' | 'sent' | 'unknown';
  envelopeId?: string;
  /** The e-signature connection holding the envelope, so finishing goes to the same one. */
  provider?: string;
  at: string;
}

const emptyPacket = (): Packet => ({ items: [], values: {}, title: '', attachments: [], sharedWith: [] });

/** setPacket keys that are bookkeeping, not the advisor's work, so they don't make a packet dirty. */
const CLEAN_KEYS = new Set<keyof Packet>(['requestId', 'snapshot', 'send', 'dirty']);

/** What to do with unsaved work before it's replaced. */
export type LeaveChoice = 'save' | 'discard' | 'cancel';

interface AppState {
  services?: Services;
  ready: boolean;
  error?: string;

  me?: UserProfile;
  users: UserProfile[];
  groups: UserGroup[];
  /** Firm profiles, one per legal entity (domain/firms). */
  firms: FirmProfile[];
  /** The default firm profile: it fills forms no other profile claims and holds the firm-wide settings. */
  firm?: FirmProfile;
  /** Which e-signature connection is the default, and whether people choose (Administration › Settings). */
  signingSettings: SigningSettings;
  /** Every announcement; the Shell shows the live ones meant for this person (`activeAnnouncements`). */
  announcements: Announcement[];
  /** Announcements this person hid, by id (kept on this device). */
  dismissed: string[];
  /** Firm-wide rules (sharing, rep data, downloads, retention). Defaults until boot loads them. */
  policy: FirmPolicy;
  /** The firm's DocuSign account and verification workflows (Administration › Settings). */
  docuSign: DocuSignSetup;
  /**
   * The User whose book and rep data the work is for: the User an Assistant works for,
   * or (when the policy allows) another User in a User's groups. Usually `me` for Users.
   */
  actingForId?: string;

  templates: FormTemplate[];
  packets: SavedPacket[];

  contactId?: string;
  client?: ClientRecord;
  clientLoading: boolean;
  requests: SignatureRequest[];

  packet: Packet;
  favorites: string[];
  recent: { templateId: string; at: string }[];
  theme: Theme;
  /** Show Start a packet on Today (Settings). Kept on this device. */
  showAssist: boolean;
  /** What the advisor typed into Start a packet, kept while they move around. */
  startPrompt: string;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  /** Set while asking what to do with unsaved work; the Shell renders the question. */
  leavePrompt?: { reason: 'switch' | 'open-draft' | 'navigate'; resolve: (c: LeaveChoice) => void };
  /** A journalled packet from before a reload, offered back by the Shell. */
  pendingRestore?: Journal;

  boot(services: Services, contactId?: string): Promise<void>;
  reloadDirectory(): Promise<void>;
  /** Read announcements again. Without `force`, only when the last read is 15 minutes old. */
  refreshAnnouncements(force?: boolean): Promise<void>;
  dismissAnnouncement(id: string): void;
  setActingFor(userId: string): void;
  /** Resolves false when the advisor chose to keep their unsaved packet instead. */
  openContact(contactId: string): Promise<boolean>;
  /** Ask before unsaved work is replaced. True when it's fine to go ahead. */
  confirmReplacePacket(reason?: 'switch' | 'open-draft'): Promise<boolean>;
  restoreJournal(): Promise<void>;
  discardJournal(): void;
  refreshClient(): Promise<void>;
  refreshRequests(): Promise<void>;
  refreshTemplates(): Promise<void>;
  refreshPackets(): Promise<void>;

  /**
   * Add a form. Without `duplicate`, a form already in the packet isn't added again.
   * With it, a copy is added that starts from the last copy's values.
   */
  addToPacket(templateId: string, accountId?: string, opts?: { duplicate?: boolean }): AddResult;
  /** Remove one form (a single copy) by its item id. */
  removeFromPacket(itemId: string): void;
  /** Swap one form for another version of it (another state's), keeping its place, account and values. */
  replaceInPacket(itemId: string, templateId: string): void;
  /** Remove every copy of a form, for the library's add/remove toggle. */
  removeTemplateFromPacket(templateId: string): void;
  moveInPacket(itemId: string, delta: number): void;
  setPacketAccount(itemId: string, accountId: string): void;
  setValue(key: string, value: string | undefined): void;
  /** Set several values at once (filling a person block). */
  setValues(patch: Record<string, string | undefined>): void;
  setPacket(p: Partial<Packet>): void;
  clearPacket(): void;
  loadPacket(saved: SavedPacket): void;
  loadRequest(req: SignatureRequest): void;
  /** Move out-of-date forms in the open packet to the current revisions ("Update" in Review). */
  upgradePacket(): UpgradeReport;
  /**
   * Apply a check's one-click fix to the packet's values and remember it as resolved.
   * Returns an undo that puts the values (and the check) back.
   */
  applyFix(check: CheckResult): (() => void) | undefined;

  toggleFavorite(templateId: string): void;
  markUsed(templateIds: string[]): void;
  setTheme(t: Theme): void;
  setShowAssist(on: boolean): void;
  setStartPrompt(text: string): void;
  setSidebar(open: boolean): void;
  setPalette(open: boolean): void;
}

function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
}

/**
 * Pick the account a form is most likely about. Accounts in `taken` (ones other copies
 * of the form already use) are passed over while an unused one of a matching type is
 * left, so "Add another copy" on an IRA form picks the second IRA.
 */
export function suggestAccount(t: FormTemplate, client?: ClientRecord, taken: string[] = []) {
  if (!client || !t.appliesTo?.length) return undefined;
  const pickFrom = (free: boolean) => {
    // appliesTo is in order of preference; within a type, prefer the form issuer's own accounts.
    for (const type of t.appliesTo!) {
      const ofType = client.accounts.filter((a) => a.ev_accounttype === type && (!free || !taken.includes(a.accountid)));
      const pick = ofType.find((a) => a.ev_custodian === t.issuer) ?? ofType[0];
      if (pick) return pick.accountid;
    }
    return undefined;
  };
  return (taken.length ? pickFrom(true) : undefined) ?? pickFrom(false);
}

/** Whether a form, or another state's version of it, is already in the packet. */
export function formInPacket(items: PacketItem[], templates: FormTemplate[], t: Pick<FormTemplate, 'id' | 'variantGroup'>): boolean {
  return items.some((i) => i.templateId === t.id || (!!t.variantGroup && templates.find((x) => x.id === i.templateId)?.variantGroup === t.variantGroup));
}

/** The state a packet's forms must be approved in: the one the advisor set, else the client's. */
export function packetState(packet: Pick<Packet, 'state'>, client: ClientRecord | undefined): string | undefined {
  return normalizeState(packet.state ?? client?.contact.address1_stateorprovince);
}

/** The most forms one packet can hold (Laser App caps a launch at 20 too). */
export const PACKET_LIMIT = 20;

export type AddResult = 'added' | 'present' | 'full';

/** A new packet item id. */
export function newItemId(): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `pi-${rand}`;
}

/**
 * Give items saved before packet items had ids (old journals and drafts) an id, and
 * number repeated forms as copies.
 */
export function normalizeItems(items: (Omit<PacketItem, 'id'> & { id?: string })[]): PacketItem[] {
  const seen = new Map<string, number>();
  return items.map((i) => {
    const n = (seen.get(i.templateId) ?? 0) + 1;
    const copy = i.copy ?? n;
    seen.set(i.templateId, Math.max(n, copy));
    const { copy: _c, ...rest } = i;
    return { ...rest, id: i.id ?? newItemId(), ...(copy > 1 ? { copy } : {}) };
  });
}

/** Counts contact picks, so a slow load for an earlier pick never lands over a later one. */
let openSeq = 0;
/** When announcements were last read, for the 15-minute refresh on focus. */
let announcementsReadAt = 0;
/** Where a person's dismissed announcements are kept: a convenience, so losing it only shows them again. */
const dismissKey = (userId: string) => `folium.dismissed.${userId}`;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  policy: DEFAULT_POLICY,
  docuSign: withDocuSignDefaults(undefined),
  signingSettings: {},
  firms: [],
  announcements: [],
  dismissed: [],
  users: [],
  groups: [],
  templates: [],
  packets: [],
  clientLoading: false,
  requests: [],
  packet: emptyPacket(),
  favorites: readLocal('folium.favorites', ['tpl-ev1120-0326', 'tpl-ev1004-0125']),
  recent: readLocal('folium.recent', []),
  theme: readLocal<Theme>('folium.theme', 'system'),
  showAssist: readLocal('folium.showAssist', true),
  startPrompt: '',
  sidebarOpen: false,
  paletteOpen: false,

  async boot(services, contactId) {
    applyTheme(get().theme);
    set({ services });
    try {
      const [me, users, groups, firms, policy, docuSign, signingSettings, announcements, templates, packets] = await Promise.all([
        services.directory.currentUser(),
        services.directory.listUsers(),
        services.directory.listGroups(),
        services.directory.listFirms(),
        services.directory.getPolicy(),
        // Only sending needs these: a failed read leaves DocuSign "not set up" instead of stopping Folium.
        services.directory.getDocuSign().catch(() => withDocuSignDefaults(undefined)),
        services.directory.getSigning().catch((): SigningSettings => ({})),
        // Announcements are a nicety: none is better than no Folium.
        services.directory.listAnnouncements().catch((): Announcement[] => []),
        services.templates.list(),
        services.packets.list(),
      ]);
      announcementsReadAt = Date.now();
      set({
        me,
        users,
        groups,
        firms,
        firm: defaultFirm(firms),
        policy,
        docuSign,
        signingSettings,
        announcements,
        dismissed: readLocal<string[]>(dismissKey(me.systemuserid), []),
        templates,
        packets,
        actingForId: actingForFor(me, users, groups, policy),
        ready: true,
      });
      const journal = readJournal(me.systemuserid);
      if (journal && worthKeeping(journal.packet)) set({ pendingRestore: journal });
      const start = contactId ?? readLocal<string | undefined>('folium.lastContact', undefined);
      if (start) await get().openContact(start).catch(() => undefined);
      // Don't offer a copy older than the draft it came from (a colleague may have saved since).
      if (journal?.packet.requestId && get().pendingRestore === journal) {
        const row = await services.requests.get(journal.packet.requestId).catch(() => undefined);
        const updated = row?.audit.at(-1)?.at;
        if (row && !journal.packet.send && !newerThanDraft(journal, updated)) {
          clearJournal(me.systemuserid);
          if (get().pendingRestore === journal) set({ pendingRestore: undefined });
        }
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), ready: true });
    }
  },

  async reloadDirectory() {
    const s = get().services!;
    const [me, users, groups, firms, policy, docuSign, signingSettings] = await Promise.all([
      s.directory.currentUser(),
      s.directory.listUsers(),
      s.directory.listGroups(),
      s.directory.listFirms(),
      s.directory.getPolicy(),
      s.directory.getDocuSign().catch(() => withDocuSignDefaults(undefined)),
      s.directory.getSigning().catch(() => get().signingSettings),
    ]);
    // A policy change can take away someone the user was working as.
    const keep = actableUsers(me, users, groups, policy).some((u) => u.systemuserid === get().actingForId);
    set({ me, users, groups, firms, firm: defaultFirm(firms), policy, docuSign, signingSettings, ...(keep ? {} : { actingForId: actingForFor(me, users, groups, policy) }) });
  },

  async refreshAnnouncements(force) {
    const s = get().services;
    if (!s || (!force && Date.now() - announcementsReadAt < ANNOUNCEMENT_REFRESH_MS)) return;
    announcementsReadAt = Date.now();
    try {
      set({ announcements: await s.directory.listAnnouncements() });
    } catch {
      // Keep what's on screen; the next focus tries again.
      announcementsReadAt = 0;
    }
  },
  dismissAnnouncement(id) {
    const { me, dismissed, announcements } = get();
    // Only ids that still exist, so the list doesn't grow forever.
    const next = [...new Set([...dismissed.filter((d) => announcements.some((a) => a.id === d)), id])];
    if (me) writeLocal(dismissKey(me.systemuserid), next);
    set({ dismissed: next });
  },

  setActingFor(userId) {
    writeLocal('folium.actingFor', userId);
    set({ actingForId: userId });
  },

  async openContact(contactId) {
    const s = get().services!;
    const switching = get().contactId !== contactId;
    if (switching && !(await get().confirmReplacePacket('switch'))) return false;
    // Nothing on screen changes until the new client has loaded, so a failed load keeps
    // the current client and packet.
    const pick = ++openSeq;
    set({ clientLoading: true });
    try {
      const [client, requests] = await Promise.all([s.crm.getClient(contactId), s.requests.listForContact(contactId)]);
      // A newer pick wins: ignore a slow response for a contact the user has moved away from.
      if (pick !== openSeq) return true;
      writeLocal('folium.lastContact', contactId);
      set({ contactId, client, requests, clientLoading: false, ...(switching ? { packet: emptyPacket() } : {}) });
      return true;
    } catch (e) {
      if (pick === openSeq) set({ clientLoading: false });
      throw e;
    }
  },

  async confirmReplacePacket(reason = 'switch') {
    if (!get().packet.dirty || !get().packet.items.length) return true;
    const choice = await new Promise<LeaveChoice>((resolve) => set({ leavePrompt: { reason, resolve } }));
    set({ leavePrompt: undefined });
    if (choice === 'cancel') return false;
    // Discard: the caller replaces the packet once its own work succeeds (a client opens,
    // a draft loads). Until then it stays on screen, no longer counted as unsaved.
    if (choice === 'discard') set({ packet: { ...get().packet, dirty: false } });
    return true;
  },

  async restoreJournal() {
    const j = get().pendingRestore;
    if (!j) return;
    if (get().contactId !== j.contactId) {
      // openContact asks about unsaved work on screen first (Save draft / Discard / Cancel).
      // Keep the offer if the advisor cancels or the client can't be opened (a failed load
      // throws; the banner reports it).
      if (!(await get().openContact(j.contactId))) return;
    }
    set({ pendingRestore: undefined, packet: { ...emptyPacket(), ...j.packet, items: normalizeItems(j.packet.items), dirty: true } });
  },
  discardJournal() {
    const { pendingRestore, me } = get();
    if (pendingRestore && me) {
      // Only drop what's stored if it's still the copy we offered (not newer work since).
      const current = readJournal(me.systemuserid);
      if (current?.savedAt === pendingRestore.savedAt) clearJournal(me.systemuserid);
    }
    set({ pendingRestore: undefined });
  },

  async refreshClient() {
    const { services, contactId } = get();
    if (!services || !contactId) return;
    set({ client: await services.crm.getClient(contactId) });
  },
  async refreshRequests() {
    const { services, contactId } = get();
    if (!services || !contactId) return;
    set({ requests: await services.requests.listForContact(contactId) });
  },
  async refreshTemplates() {
    set({ templates: await get().services!.templates.list() });
  },
  async refreshPackets() {
    set({ packets: await get().services!.packets.list() });
  },

  addToPacket(requestedId, accountId, opts) {
    const { packet, templates, client } = get();
    let t = templates.find((x) => x.id === requestedId);
    // A form with state versions: add the version for the packet's state.
    const group = t?.variantGroup;
    if (group) t = pickVariant(currentTemplates(templates), group, packetState(packet, client)) ?? t;
    const templateId = t?.id ?? requestedId;
    const copies = packet.items.filter((i) => i.templateId === templateId);
    const sameForm = packet.items.some((i) => i.templateId === templateId || (!!group && templates.find((x) => x.id === i.templateId)?.variantGroup === group));
    if (sameForm && !opts?.duplicate) return 'present';
    if (packet.items.length >= PACKET_LIMIT) return 'full';
    const id = newItemId();
    if (t) track('form.added', [t]);
    if (!copies.length) {
      set({ packet: { ...packet, dirty: true, items: [...packet.items, { id, templateId, accountId: accountId ?? (t ? suggestAccount(t, client) : undefined) }] } });
      return 'added';
    }
    // A copy: numbered after the highest copy, on the next unused account, starting from the last copy's values.
    const last = copies.reduce((a, b) => ((b.copy ?? 1) > (a.copy ?? 1) ? b : a));
    const copy = (last.copy ?? 1) + 1;
    const taken = copies.map((c) => c.accountId).filter((a): a is string => !!a);
    const item: PacketItem = { id, templateId, copy, accountId: accountId ?? (t ? suggestAccount(t, client, taken) : undefined) };
    const index = packet.items.indexOf(copies[copies.length - 1]) + 1;
    const values = t ? { ...packet.values, ...seedCopyValues(t, packet.values, id, copyScope(last)) } : packet.values;
    set({ packet: { ...packet, dirty: true, values, items: [...packet.items.slice(0, index), item, ...packet.items.slice(index)] } });
    return 'added';
  },
  removeFromPacket(itemId) {
    const { packet } = get();
    // A copy's own values go with it.
    const values = Object.fromEntries(Object.entries(packet.values).filter(([k]) => !k.startsWith(`${itemId}/`)));
    set({ packet: { ...packet, dirty: true, values, items: packet.items.filter((i) => i.id !== itemId) } });
  },
  replaceInPacket(itemId, templateId) {
    const { packet, templates } = get();
    const item = packet.items.find((i) => i.id === itemId);
    const from = templates.find((t) => t.id === item?.templateId);
    const to = templates.find((t) => t.id === templateId);
    if (!item || !to) return;
    // Same item id and copy number: the copy's own values stay readable. Values under
    // form-number keys move to the new version's keys.
    const values = from ? { ...packet.values, ...carryVariantValues(from, to, packet.values, copyScope(item)) } : packet.values;
    set({ packet: { ...packet, dirty: true, values, items: packet.items.map((i) => (i.id === itemId ? { ...i, templateId } : i)) } });
  },
  removeTemplateFromPacket(templateId) {
    for (const i of get().packet.items.filter((x) => x.templateId === templateId)) get().removeFromPacket(i.id);
  },
  moveInPacket(itemId, delta) {
    const items = [...get().packet.items];
    const i = items.findIndex((x) => x.id === itemId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    set({ packet: { ...get().packet, dirty: true, items } });
  },
  setPacketAccount(itemId, accountId) {
    const { packet } = get();
    // Picking an account clears the "account replaced" flag.
    set({ packet: { ...packet, dirty: true, items: packet.items.map((i) => (i.id === itemId ? { id: i.id, templateId: i.templateId, ...(i.copy ? { copy: i.copy } : {}), accountId } : i)) } });
  },
  setValue(key, value) {
    const values = { ...get().packet.values };
    if (value === undefined) delete values[key];
    else values[key] = value;
    set({ packet: { ...get().packet, dirty: true, values } });
  },
  setValues(patch) {
    const values = { ...get().packet.values };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete values[k];
      else values[k] = v;
    }
    set({ packet: { ...get().packet, dirty: true, values } });
  },
  setPacket(p) {
    const work = (Object.keys(p) as (keyof Packet)[]).some((k) => !CLEAN_KEYS.has(k));
    set({ packet: { ...get().packet, ...p, dirty: p.dirty ?? (work || get().packet.dirty) } });
  },
  clearPacket() {
    set({ packet: emptyPacket() });
  },
  loadPacket(saved) {
    const { templates, client } = get();
    const live = saved.templateIds
      .map((id) => templates.find((t) => t.id === id))
      .filter((t): t is FormTemplate => !!t)
      // A saved packet points at a revision; always use the current live one.
      .map((t) => latestLive(templates, t.formNumber) ?? t);
    const items: PacketItem[] = [];
    for (const t of live.slice(0, PACKET_LIMIT)) {
      const taken = items.filter((i) => i.templateId === t.id).map((i) => i.accountId).filter((a): a is string => !!a);
      items.push({ id: newItemId(), templateId: t.id, accountId: suggestAccount(t, client, taken) });
    }
    set({ packet: { ...emptyPacket(), title: saved.name, items: normalizeItems(items) } });
  },
  loadRequest(req) {
    const { templates, client } = get();
    // Drafts saved before copies existed have no item ids: normalizeItems gives them some.
    const isActive = (id?: string) => !!id && !!client?.accounts.some((a) => a.accountid === id);
    // Accounts the copies of each form keep, so a replacement suggestion avoids them.
    const taken = new Map<string, string[]>();
    for (const d of req.documents) if (isActive(d.accountId)) taken.set(d.templateId, [...(taken.get(d.templateId) ?? []), d.accountId!]);
    const items = normalizeItems(
      req.documents.map((d) => {
        const t = templates.find((x) => x.id === d.templateId);
        // A template that no longer exists keeps its name, so Review can say which form it was.
        const base = { id: d.itemId, templateId: d.templateId, copy: d.copy, ...(t ? {} : { missing: { name: d.name, formNumber: d.formNumber, revision: d.revision } }) };
        if (isActive(d.accountId)) return { ...base, accountId: d.accountId };
        // The saved account was closed or moved: suggest one and have Review ask.
        const accountId = t ? suggestAccount(t, client, taken.get(d.templateId)) : undefined;
        if (accountId) taken.set(d.templateId, [...(taken.get(d.templateId) ?? []), accountId]);
        return { ...base, accountId, accountReplaced: !!d.accountId || undefined };
      }),
    );
    // The first form that reads account data gets any pre-scoping `account.*` overrides.
    const used = items.map((i) => ({ item: i, t: templates.find((t) => t.id === i.templateId) })).filter((x): x is { item: PacketItem; t: FormTemplate } => !!x.t);
    const first = used.find((x) => x.t.mapping.fields.some((m) => m.source.startsWith('account.'))) ?? used[0];
    const firstAccountId = first?.item.accountId ?? client?.accounts[0]?.accountid;
    const sharedKeys = new Set(used.flatMap((x) => x.t.mapping.fields.map((m) => m.key).filter((k): k is string => !!k)));
    set({
      packet: {
        items,
        values: migrateAccountValues(req.values, firstAccountId, sharedKeys),
        title: req.title,
        requestId: req.id,
        attachments: req.attachments,
        sharedWith: req.sharedWith ?? [],
        state: req.state,
        personBlocks: req.personBlocks,
        snapshot: req.prefillSnapshot,
        // A send that stopped after DocuSign created the envelope picks up where it left off.
        send: req.status === 'Drafted' && req.envelopeId && req.envelopePhase === 'created' ? { phase: 'created', envelopeId: req.envelopeId, provider: req.provider, at: req.audit.at(-1)?.at ?? req.createdOn } : undefined,
        dirty: false,
      },
    });
  },

  upgradePacket() {
    const { packet, templates } = get();
    const { items, values, report } = upgradePacketItems(packet.items, packet.values, templates);
    const detail = upgradeAuditDetail(report);
    if (detail) set({ packet: { ...packet, items, values, dirty: true, formsUpdated: [packet.formsUpdated, detail].filter(Boolean).join('; ') } });
    return report;
  },

  applyFix(check) {
    const fix = check.fix;
    if (!fix) return undefined;
    const before = get().packet;
    const previous = Object.fromEntries(Object.keys(fix.values).map((k) => [k, Object.prototype.hasOwnProperty.call(before.values, k) ? before.values[k] : undefined]));
    const values = { ...before.values };
    for (const [k, v] of Object.entries(fix.values)) {
      if (v === undefined) delete values[k];
      else values[k] = v;
    }
    set({ packet: { ...before, dirty: true, values, resolved: { ...before.resolved, [check.id]: fix.resolvedLabel } } });
    return () => {
      const now = get().packet;
      const back = { ...now.values };
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete back[k];
        else back[k] = v;
      }
      const { [check.id]: _undone, ...resolved } = now.resolved ?? {};
      set({ packet: { ...now, dirty: true, values: back, resolved } });
    };
  },

  toggleFavorite(id) {
    const f = get().favorites.includes(id) ? get().favorites.filter((x) => x !== id) : [...get().favorites, id];
    writeLocal('folium.favorites', f);
    set({ favorites: f });
  },
  markUsed(ids) {
    const now = new Date().toISOString();
    const recent = [...ids.map((templateId) => ({ templateId, at: now })), ...get().recent.filter((r) => !ids.includes(r.templateId))].slice(0, 30);
    writeLocal('folium.recent', recent);
    set({ recent });
  },
  setTheme(t) {
    writeLocal('folium.theme', t);
    applyTheme(t);
    set({ theme: t });
  },
  setShowAssist(on) {
    writeLocal('folium.showAssist', on);
    set({ showAssist: on });
  },
  setStartPrompt(text) {
    set({ startPrompt: text });
  },
  setSidebar(open) {
    set({ sidebarOpen: open });
  },
  setPalette(open) {
    set({ paletteOpen: open });
  },
}));

// ------------------------------------------------------------------ usage

type FormRef = Pick<FormTemplate, 'id' | 'formNumber' | 'revision' | 'source' | 'issuer' | 'category'>;

/**
 * Record that something happened to these forms (`ev_usageevent`, see domain/usage).
 * Queued and written in the background: it never throws and never waits.
 */
export function track(type: UsageEventType, forms: FormRef[], extra: { requestId?: string; detail?: Record<string, unknown> } = {}): void {
  try {
    const s = useApp.getState();
    if (!s.services || !s.me) return;
    const actingFor = s.users.find((u) => u.systemuserid === s.actingForId) ?? s.me;
    s.services.usage.track(usageEvents(type, { user: s.me, actingFor, groups: s.groups, contactId: s.contactId, requestId: extra.requestId }, forms, { detail: extra.detail }));
  } catch {
    /* never in the way */
  }
}

/** A request's forms as templates, falling back to what the request saved for a template that's gone. */
export function requestForms(req: Pick<SignatureRequest, 'documents'>, templates: FormTemplate[]): FormRef[] {
  return req.documents.map((d) => {
    const t = templates.find((x) => x.id === d.templateId);
    return t ?? { id: d.templateId, formNumber: d.formNumber, revision: d.revision, source: 'Everence', category: 'Account maintenance' as const };
  });
}

/**
 * Record what DocuSign reported for a request (viewed, signed, declined, voided,
 * expired). Rows are the preparer's, for the owner, with DocuSign's times and the
 * request's dedupe keys, so Check status and the Connect flow (#5) never count one twice.
 */
export function trackStatus(prev: SignatureRequest, next: SignatureRequest): void {
  try {
    const s = useApp.getState();
    if (!s.services) return;
    const events = statusEvents(prev, next);
    if (!events.length) return;
    const forms = requestForms(next, s.templates);
    const user = s.users.find((u) => u.systemuserid === next.preparedById) ?? s.users.find((u) => u.systemuserid === next.ownerId) ?? s.me;
    if (!user) return;
    const owner = s.users.find((u) => u.systemuserid === next.ownerId);
    for (const e of events) {
      s.services.usage.track(usageEvents(e.type, { user, actingFor: owner, groups: s.groups, contactId: next.contactId, requestId: next.id, at: e.at }, forms));
    }
  } catch {
    /* never in the way */
  }
}

// ------------------------------------------------------------------ journal

/**
 * Keep the open packet in the session journal, a second after it stops changing, and
 * write at once when the page is going away. Returns a stop function.
 */
export function startJournal(): () => void {
  const write = () => {
    const { me, contactId, packet, client, pendingRestore, templates } = useApp.getState();
    if (!me) return;
    if (contactId && worthKeeping(packet)) writeJournal({ userId: me.systemuserid, contactId, contactName: client?.contact.fullname, packet, sensitive: sensitiveKeys(templates) });
    // Leave an offered copy alone until the advisor answers the banner.
    else if (!pendingRestore) clearJournal(me.systemuserid);
  };
  const d = debounced(write, 1000);
  const unsub = useApp.subscribe((s, prev) => {
    if (s.packet !== prev.packet || s.contactId !== prev.contactId) d.schedule();
  });
  const flush = () => d.flush();
  window.addEventListener('pagehide', flush);
  return () => {
    unsub();
    d.cancel();
    window.removeEventListener('pagehide', flush);
  };
}

// ------------------------------------------------------------------ selectors

// Moved to the domain with the firm policy; re-exported for existing callers.
export { actableUsers } from '../domain/policy';

/** Who to work as after sign-in: the last choice if it's still allowed, else an Assistant's first User, else yourself. */
function actingForFor(me: UserProfile, users: UserProfile[], groups: UserGroup[], policy: FirmPolicy): string | undefined {
  const can = actableUsers(me, users, groups, policy);
  const saved = readLocal<string | undefined>('folium.actingFor', undefined);
  if (can.some((u) => u.systemuserid === saved)) return saved;
  return me.role === 'Assistant' ? can[0]?.systemuserid : me.systemuserid;
}

/** The advisor whose details prefill `rep.*` fields and who owns the work. */
export function useActingFor(): UserProfile | undefined {
  return useApp((s) => s.users.find((u) => u.systemuserid === s.actingForId) ?? s.me);
}

/**
 * What forms prefill from. `firm` is the default profile; each form resolves its own
 * from `firms` (`firmFor`), with the advisor's group default in between.
 */
export function useScope(): Omit<ResolveScope, 'account'> | undefined {
  const client = useApp((s) => s.client);
  const firm = useApp((s) => s.firm);
  const firms = useApp((s) => s.firms);
  const groups = useApp((s) => s.groups);
  const advisor = useActingFor();
  return useMemo(() => (client && advisor ? { client, advisor, firm, firms, firmGroup: firmGroup(advisor, groups) } : undefined), [client, advisor, firm, firms, groups]);
}

/** Templates this user's groups can see. Admins see everything. */
export function visibleTemplates(me: UserProfile | undefined, groups: UserGroup[], templates: FormTemplate[]): FormTemplate[] {
  if (!me) return [];
  if (me.role === 'Admin') return templates;
  const mine = groups.filter((g) => g.memberIds.includes(me.systemuserid));
  const sources = mine.flatMap((g) => g.sources ?? []);
  const cats = mine.flatMap((g) => g.categories ?? []);
  return templates.filter((t) => (!sources.length || sources.includes(t.source)) && (!cats.length || cats.includes(t.category)));
}

// Moved to the domain so domain code doesn't import the store; re-exported for existing callers.
export { currentTemplates, latestLive } from '../domain/revisions';
