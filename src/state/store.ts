import { useMemo } from 'react';
import { create } from 'zustand';
import type { ResolveScope } from '../domain/paths';
import type {
  Attachment,
  ClientRecord,
  FirmProfile,
  FormTemplate,
  PacketItem,
  SavedPacket,
  SignatureRequest,
  UserGroup,
  UserProfile,
} from '../domain/types';
import type { Services } from '../services/types';

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
  /** Set when the packet was opened from (or saved as) a draft request. */
  requestId?: string;
  attachments: Attachment[];
  sharedWith: string[];
}

const emptyPacket = (): Packet => ({ items: [], values: {}, title: '', attachments: [], sharedWith: [] });

interface AppState {
  services?: Services;
  ready: boolean;
  error?: string;

  me?: UserProfile;
  users: UserProfile[];
  groups: UserGroup[];
  firm?: FirmProfile;
  /** The User an Assistant is working for; equals `me` for Users. */
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
  sidebarOpen: boolean;
  paletteOpen: boolean;

  boot(services: Services, contactId?: string): Promise<void>;
  reloadDirectory(): Promise<void>;
  setActingFor(userId: string): void;
  openContact(contactId: string): Promise<void>;
  refreshClient(): Promise<void>;
  refreshRequests(): Promise<void>;
  refreshTemplates(): Promise<void>;
  refreshPackets(): Promise<void>;

  addToPacket(templateId: string, accountId?: string): void;
  removeFromPacket(templateId: string): void;
  moveInPacket(templateId: string, delta: number): void;
  setPacketAccount(templateId: string, accountId: string): void;
  setValue(key: string, value: string | undefined): void;
  setPacket(p: Partial<Packet>): void;
  clearPacket(): void;
  loadPacket(saved: SavedPacket): void;
  loadRequest(req: SignatureRequest): void;

  toggleFavorite(templateId: string): void;
  markUsed(templateIds: string[]): void;
  setTheme(t: Theme): void;
  setSidebar(open: boolean): void;
  setPalette(open: boolean): void;
}

function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
}

/** Pick the account a form is most likely about. */
export function suggestAccount(t: FormTemplate, client?: ClientRecord) {
  if (!client || !t.appliesTo?.length) return undefined;
  // appliesTo is in order of preference; within a type, prefer the form issuer's own accounts.
  for (const type of t.appliesTo) {
    const ofType = client.accounts.filter((a) => a.ev_accounttype === type);
    const pick = ofType.find((a) => a.ev_custodian === t.issuer) ?? ofType[0];
    if (pick) return pick.accountid;
  }
  return undefined;
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
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
  sidebarOpen: false,
  paletteOpen: false,

  async boot(services, contactId) {
    applyTheme(get().theme);
    set({ services });
    try {
      const [me, users, groups, firm, templates, packets] = await Promise.all([
        services.directory.currentUser(),
        services.directory.listUsers(),
        services.directory.listGroups(),
        services.directory.getFirm(),
        services.templates.list(),
        services.packets.list(),
      ]);
      const savedActing = readLocal<string | undefined>('folium.actingFor', undefined);
      const actingForId = me.role === 'Assistant' ? (actableUsers(me, users, groups).some((u) => u.systemuserid === savedActing) ? savedActing : actableUsers(me, users, groups)[0]?.systemuserid) : me.systemuserid;
      set({ me, users, groups, firm, templates, packets, actingForId, ready: true });
      const start = contactId ?? readLocal<string | undefined>('folium.lastContact', undefined);
      if (start) await get().openContact(start).catch(() => undefined);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), ready: true });
    }
  },

  async reloadDirectory() {
    const s = get().services!;
    const [me, users, groups, firm] = await Promise.all([s.directory.currentUser(), s.directory.listUsers(), s.directory.listGroups(), s.directory.getFirm()]);
    set({ me, users, groups, firm });
  },

  setActingFor(userId) {
    writeLocal('folium.actingFor', userId);
    set({ actingForId: userId });
  },

  async openContact(contactId) {
    const s = get().services!;
    if (get().contactId !== contactId) set({ packet: emptyPacket() });
    set({ contactId, clientLoading: true });
    writeLocal('folium.lastContact', contactId);
    try {
      const [client, requests] = await Promise.all([s.crm.getClient(contactId), s.requests.listForContact(contactId)]);
      // A newer pick wins: ignore a slow response for a contact the user has moved away from.
      if (get().contactId !== contactId) return;
      set({ client, requests, clientLoading: false });
    } catch (e) {
      if (get().contactId !== contactId) return;
      set({ clientLoading: false, client: undefined, contactId: undefined });
      throw e;
    }
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

  addToPacket(templateId, accountId) {
    const { packet, templates, client } = get();
    if (packet.items.some((i) => i.templateId === templateId)) return;
    const t = templates.find((x) => x.id === templateId);
    set({ packet: { ...packet, items: [...packet.items, { templateId, accountId: accountId ?? (t ? suggestAccount(t, client) : undefined) }] } });
  },
  removeFromPacket(templateId) {
    const { packet } = get();
    set({ packet: { ...packet, items: packet.items.filter((i) => i.templateId !== templateId) } });
  },
  moveInPacket(templateId, delta) {
    const items = [...get().packet.items];
    const i = items.findIndex((x) => x.templateId === templateId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    set({ packet: { ...get().packet, items } });
  },
  setPacketAccount(templateId, accountId) {
    const { packet } = get();
    set({ packet: { ...packet, items: packet.items.map((i) => (i.templateId === templateId ? { ...i, accountId } : i)) } });
  },
  setValue(key, value) {
    const values = { ...get().packet.values };
    if (value === undefined) delete values[key];
    else values[key] = value;
    set({ packet: { ...get().packet, values } });
  },
  setPacket(p) {
    set({ packet: { ...get().packet, ...p } });
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
    set({ packet: { ...emptyPacket(), title: saved.name, items: live.map((t) => ({ templateId: t.id, accountId: suggestAccount(t, client) })) } });
  },
  loadRequest(req) {
    set({
      packet: {
        items: req.documents.map((d) => ({ templateId: d.templateId })),
        values: { ...req.values },
        title: req.title,
        requestId: req.id,
        attachments: req.attachments,
        sharedWith: req.sharedWith ?? [],
      },
    });
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
  setSidebar(open) {
    set({ sidebarOpen: open });
  },
  setPalette(open) {
    set({ paletteOpen: open });
  },
}));

// ------------------------------------------------------------------ selectors

/** Users an Assistant can act for: every User in a group they belong to. */
export function actableUsers(me: UserProfile, users: UserProfile[], groups: UserGroup[]): UserProfile[] {
  if (me.role !== 'Assistant') return [me];
  const mine = groups.filter((g) => g.memberIds.includes(me.systemuserid));
  const ids = new Set(mine.flatMap((g) => g.memberIds));
  return users.filter((u) => u.role === 'User' && ids.has(u.systemuserid));
}

/** The advisor whose details prefill `rep.*` fields and who owns the work. */
export function useActingFor(): UserProfile | undefined {
  return useApp((s) => s.users.find((u) => u.systemuserid === s.actingForId) ?? s.me);
}

export function useScope(): Omit<ResolveScope, 'account'> | undefined {
  const client = useApp((s) => s.client);
  const firm = useApp((s) => s.firm);
  const advisor = useActingFor();
  return useMemo(() => (client && advisor ? { client, advisor, firm } : undefined), [client, advisor, firm]);
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

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The revision advisors should use for a form number: the Live revision with the
 * latest effective date that has arrived. A revision published with a future
 * effective date takes over automatically on that day.
 */
export function latestLive(templates: FormTemplate[], formNumber: string, on = today()) {
  return templates
    .filter((t) => t.formNumber === formNumber && t.status === 'Live' && t.effectiveDate <= on)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
}

/** One current revision per form number. */
export function currentTemplates(templates: FormTemplate[], on = today()): FormTemplate[] {
  const nums = [...new Set(templates.map((t) => t.formNumber))];
  return nums.map((n) => latestLive(templates, n, on)).filter((t): t is FormTemplate => !!t);
}
