import { defaultDraftTitle } from '../domain/drafts';
import { firmGroup } from '../domain/firms';
import { prefillPacket, type FormFill } from '../domain/prefill';
import { draftsAllowed, retentionDays } from '../domain/requests';
import type { SignatureRequest } from '../domain/types';
import { toast } from '../ui/controls';
import { saveDraft, writeDraftPdfs } from './actions';
import { debounced } from './journal';
import { samePacket, useApp } from './store';
import { knownVersion, noteRow, oneAtATime, rowVersion } from './versions';

// Autosave: a few seconds after the advisor stops editing, the open packet is saved to
// its draft row (a new one the first time). Only the row: the draft PDFs in SharePoint
// are written at Save draft, at the idle save, or when the advisor moves on to another
// packet, so typing doesn't churn files. Off when the firm keeps no drafts (retention 0).
// Each autosave restarts the retention clock, as any save does.
//
// Before writing into an existing row it reads the row back: if someone else saved it
// since this tab last did (a colleague on a shared draft, or another tab), autosave stops
// and asks instead of writing over their work.

/** How long after the last edit autosave waits. */
export const AUTOSAVE_MS = 3000;
/** How long after a failed autosave it tries again (an edit tries sooner). */
const RETRY_MS = 15_000;

type State = ReturnType<typeof useApp.getState>;

export type AutosaveConflict = { reason: 'changed'; row: SignatureRequest } | { reason: 'gone' };

/** Whether the open packet should be autosaved now: drafts on, a client, forms, unsaved work, no send in flight. */
export function autosaveEligible(s: Pick<State, 'policy' | 'contactId' | 'me' | 'packet'>): boolean {
  const p = s.packet;
  return draftsAllowed(s.policy) && !!s.contactId && !!s.me && p.items.length > 0 && !!p.dirty && !p.send;
}

/**
 * Why the saved row can't take an autosave: it's gone, it's no longer a draft (sent,
 * voided), or someone saved it since this tab last read or wrote it.
 */
export function conflictWith(row: SignatureRequest | undefined): AutosaveConflict | undefined {
  if (!row) return { reason: 'gone' };
  if (row.status !== 'Drafted') return { reason: 'changed', row };
  const known = knownVersion(row.id);
  // Not seen in this tab yet (a packet restored after a reload): take it as it is.
  if (!known) return void noteRow(row);
  return known === rowVersion(row) ? undefined : { reason: 'changed', row };
}

/** The packet's forms filled from the client, as Review shows them. */
export function packetFills(s: Pick<State, 'client' | 'users' | 'actingForId' | 'me' | 'firm' | 'firms' | 'groups' | 'templates' | 'packet'>): FormFill[] | undefined {
  const advisor = s.users.find((u) => u.systemuserid === s.actingForId) ?? s.me;
  if (!s.client || !advisor) return undefined;
  const scope = { client: s.client, advisor, firm: s.firm, firms: s.firms, firmGroup: firmGroup(advisor, s.groups) };
  const items = s.packet.items
    .map((i) => ({ template: s.templates.find((t) => t.id === i.templateId)!, account: s.client!.accounts.find((a) => a.accountid === i.accountId), itemId: i.id, copy: i.copy }))
    .filter((i) => i.template);
  return prefillPacket(items, scope, s.packet.values);
}

/** Whose work the packet is: the User being worked for, else the person signed in. */
const owner = (s: State) => s.users.find((u) => u.systemuserid === s.actingForId) ?? s.me;
/** Tell the toolbar what autosave did. */
const setStatus = (autosave: State['autosave']) => useApp.setState({ autosave });

let saving = false;
let retry: ReturnType<typeof setTimeout> | undefined;

/** Save the open packet's row now, if it needs it. Resolves once done; never throws. */
export async function autosaveNow(): Promise<void> {
  if (retry) clearTimeout(retry);
  retry = undefined;
  if (!autosaveEligible(useApp.getState())) return;
  saving = true;
  // A conflict stays on show while edits go on: each try reads the row again until it's settled.
  if (useApp.getState().autosave.phase !== 'conflict') setStatus({ phase: 'saving' });
  try {
    // One save at a time, so this and a Save draft never write the row at once. What to
    // save is read inside, after any save ahead of it has finished.
    const outcome = await oneAtATime(async () => {
      const s = useApp.getState();
      const cur = s.packet;
      const me = s.me;
      const who = owner(s);
      const fills = packetFills(s);
      if (!autosaveEligible(s) || !me || !who || !s.services || !fills?.length) return { skipped: true as const };
      const existing = cur.requestId ? await s.services.requests.get(cur.requestId) : undefined;
      if (cur.requestId) {
        const conflict = conflictWith(existing);
        if (conflict) return { conflict };
      }
      // Until the advisor names it, a draft autosave started keeps the default name, which follows the forms.
      const title = cur.autoNamed || !cur.requestId ? defaultDraftTitle(fills) : cur.title;
      const saved = await saveDraft({ services: s.services, packet: { ...cur, title }, fills, contactId: s.contactId!, me, owner: who, existing, autosave: true, retentionDays: retentionDays(s.policy) });
      return { saved, cur };
    });
    if ('conflict' in outcome) return setStatus({ phase: 'conflict', conflict: outcome.conflict });
    if ('skipped' in outcome) return setStatus(useApp.getState().autosave.phase === 'saving' ? { phase: 'idle' } : useApp.getState().autosave);
    const { saved, cur } = outcome;
    const now = useApp.getState();
    if (samePacket(cur, now.packet)) {
      // Edits made while saving stay unsaved (and are saved next); everything else is in the row.
      const changed = now.packet !== cur;
      const stored = new Map(saved.attachments.map((a) => [a.id, a]));
      now.setPacket({
        requestId: saved.id,
        title: saved.title,
        autoNamed: !cur.requestId || cur.autoNamed || undefined,
        attachments: now.packet.attachments.map((a) => stored.get(a.id) ?? a),
        snapshot: saved.prefillSnapshot,
        formsUpdated: now.packet.formsUpdated === cur.formsUpdated ? undefined : now.packet.formsUpdated,
        pdfsBehind: true,
        dirty: changed,
      });
    }
    setStatus({ phase: 'saved', at: saved.audit.at(-1)?.at });
    // A new draft: list it, so Drafts and Review's Save draft know the row.
    if (!cur.requestId) await useApp.getState().refreshRequests().catch(() => undefined);
  } catch (e) {
    setStatus({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    retry = setTimeout(() => void autosaveNow(), RETRY_MS);
  } finally {
    saving = false;
  }
}

/**
 * The advisor moved on from a packet autosave kept (another client, another draft, a
 * cleared packet): write its draft PDFs now, so SharePoint matches the row. Skipped if
 * the row changed hands or stopped being a draft since.
 */
async function writeLeftBehind(prev: State): Promise<void> {
  const p = prev.packet;
  const services = prev.services;
  const fills = packetFills(prev);
  if (!p.pdfsBehind || p.dirty || !p.requestId || !services || !fills?.length) return;
  const id = p.requestId;
  try {
    await oneAtATime(async () => {
      const row = await services.requests.get(id);
      if (!row || conflictWith(row) || row.envelopeId || row.inPerson) return;
      await writeDraftPdfs(services, row, fills);
    });
  } catch {
    toast.error(`Couldn’t write the PDFs for “${p.title || 'your draft'}”. Its values are saved; open it and Save draft to write them.`);
  }
}

/**
 * Autosave the open packet a few seconds after it stops changing, and try at once when
 * the page is hidden or going away. Returns a stop function.
 */
export function startAutosave(): () => void {
  const d = debounced(() => void autosaveNow(), AUTOSAVE_MS);
  const unsub = useApp.subscribe((s, prev) => {
    if (s.packet === prev.packet && s.contactId === prev.contactId) return;
    if (!samePacket(prev.packet, s.packet) || s.contactId !== prev.contactId) {
      void writeLeftBehind(prev);
      setStatus({ phase: 'idle' });
    } else if (prev.packet.dirty && !s.packet.dirty && !saving) {
      // Saved some other way (Save draft, Share): whatever autosave last said no longer holds.
      setStatus(s.packet.requestId ? { phase: 'saved', at: new Date().toISOString() } : { phase: 'idle' });
    }
    if (autosaveEligible(s)) d.schedule();
    else d.cancel();
  });
  const flush = () => d.flush();
  const onHide = () => document.visibilityState === 'hidden' && d.flush();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onHide);
  return () => {
    unsub();
    d.cancel();
    if (retry) clearTimeout(retry);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onHide);
  };
}
