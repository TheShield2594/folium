import { fieldKey } from '../domain/prefill';
import type { FieldFormat, FormTemplate } from '../domain/types';
import type { Packet } from './store';

// A copy of the open packet in sessionStorage, so a reload, an expired sign-in or a
// crashed tab doesn't cost the advisor their work. sessionStorage survives reloads in
// the same tab and is cleared when the tab closes. It's cleared after a send and on
// Discard, too. Attachment bytes aren't kept here; saved drafts store them in SharePoint.
//
// SSNs and tax IDs are left out, so the browser never holds one at rest (see the
// compliance note on #23). They come back from CRM, or are re-entered. A value is left
// out when its field's format says it's one, and, as a backstop, when its key looks
// like one.

export interface Journal {
  v: 1;
  userId: string;
  contactId: string;
  /** For the restore banner. */
  contactName?: string;
  packet: Packet;
  savedAt: string;
}

const PREFIX = 'folium.journal.';
const keyFor = (userId: string) => `${PREFIX}${userId}`;

/** Value keys that look like an SSN or TIN (`contact.ev_ssn`, `bene.Prim.1.ssn`, `own.tin`). */
const SENSITIVE = /ssn|(^|[.:_\]])tin($|[._])/i;
const SENSITIVE_FORMATS = new Set<FieldFormat>(['ssn', 'ssnOrTin', 'ein', 'ssnLast4']);

/** Whether a value key holds an SSN, EIN or TIN. */
export type SensitiveTest = (key: string) => boolean;

/**
 * Value keys that hold an SSN, EIN or TIN, by the mapped format or source of any field
 * in the library, not just the forms now in the packet: a value outlives the form it
 * was entered on when that form is removed. Account fields are keyed per account
 * (`account[<id>].<attr>`), so those match on the attribute.
 */
export function sensitiveKeys(templates: FormTemplate[]): SensitiveTest {
  const exact = new Set<string>();
  const accountAttrs = new Set<string>();
  for (const t of templates) {
    for (const m of t.mapping.fields) {
      if (!((m.format && SENSITIVE_FORMATS.has(m.format)) || /ev_ssn|ssnLast4/.test(m.source))) continue;
      exact.add(fieldKey(m, t));
      if (!m.key && m.source.startsWith('account.')) accountAttrs.add(m.source.slice('account.'.length));
    }
  }
  return (key) => {
    // A copy's own values are keyed `<itemId>/<key>`: judge them by the key underneath.
    const base = key.replace(/^pi-[^/]+\//, '');
    return exact.has(base) || accountAttrs.has(/^account\[[^\]]+\]\.(.+)$/.exec(base)?.[1] ?? '');
  };
}

const keep = (sensitive?: SensitiveTest) => ([k]: [string, string]) => !sensitive?.(k) && !SENSITIVE.test(k);

/** The packet without SSN, EIN or TIN values, in what was entered and in the CRM snapshot. */
export function redactPacket(packet: Packet, sensitive?: SensitiveTest): Packet {
  const values = Object.fromEntries(Object.entries(packet.values).filter(keep(sensitive)));
  return packet.snapshot ? { ...packet, values, snapshot: Object.fromEntries(Object.entries(packet.snapshot).filter(keep(sensitive))) } : { ...packet, values };
}

function store(storage?: Storage): Storage | undefined {
  try {
    return storage ?? sessionStorage;
  } catch {
    return undefined;
  }
}

export function writeJournal(j: Omit<Journal, 'v' | 'savedAt'> & { savedAt?: string; sensitive?: SensitiveTest }, storage?: Storage) {
  const s = store(storage);
  if (!s) return;
  const { sensitive, ...rest } = j;
  const entry: Journal = { v: 1, ...rest, packet: redactPacket(j.packet, sensitive), savedAt: j.savedAt ?? new Date().toISOString() };
  try {
    s.setItem(keyFor(j.userId), JSON.stringify(entry));
  } catch {
    /* full or blocked: the journal is a safety net, not a requirement */
  }
}

export function readJournal(userId: string, storage?: Storage): Journal | undefined {
  const s = store(storage);
  if (!s) return undefined;
  try {
    const raw = s.getItem(keyFor(userId));
    if (!raw) return undefined;
    const j = JSON.parse(raw) as Journal;
    return j && j.v === 1 && j.userId === userId && j.packet && Array.isArray(j.packet.items) ? j : undefined;
  } catch {
    return undefined;
  }
}

export function clearJournal(userId: string, storage?: Storage) {
  try {
    store(storage)?.removeItem(keyFor(userId));
  } catch {
    /* ignore */
  }
}

/** Whether a packet holds anything worth offering back: unsaved work, or a send in flight. */
export function worthKeeping(p: Packet): boolean {
  return p.items.length > 0 && (!!p.dirty || !!p.send);
}

/** The journal is worth offering only if it's newer than the saved draft it came from. */
export function newerThanDraft(j: Journal, draftUpdatedAt: string | undefined): boolean {
  return !draftUpdatedAt || j.savedAt > draftUpdatedAt;
}

/** "4 min ago" for the restore banner. */
export function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
}

/**
 * Write the journal a second after the packet stops changing. Returns `flush` (write
 * now, for `pagehide`) and `cancel`.
 */
export function debounced(write: () => void, ms = 1000) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = undefined;
        write();
      }, ms);
    },
    flush() {
      if (!t) return;
      clearTimeout(t);
      t = undefined;
      write();
    },
    cancel() {
      if (t) clearTimeout(t);
      t = undefined;
    },
  };
}
