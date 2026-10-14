import type { Packet } from './store';

// A copy of the open packet in sessionStorage, so a reload, an expired sign-in or a
// crashed tab doesn't cost the advisor their work. sessionStorage survives reloads in
// the same tab and is cleared when the tab closes. It's cleared after a send and on
// Discard, too. Attachment bytes aren't kept here; saved drafts store them in SharePoint.
//
// Values that look like SSNs or tax IDs are left out, so the browser never holds one
// at rest (see the compliance note on #23). They come back from CRM, or are re-entered.

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

/** Value keys that hold an SSN or TIN (`contact.ev_ssn`, `bene.Prim.1.ssn`, `own.tin`). */
const SENSITIVE = /ssn|(^|[.:_\]])tin($|[._])/i;

export function redactPacket(packet: Packet): Packet {
  const values = Object.fromEntries(Object.entries(packet.values).filter(([k]) => !SENSITIVE.test(k)));
  return { ...packet, values };
}

function store(storage?: Storage): Storage | undefined {
  try {
    return storage ?? sessionStorage;
  } catch {
    return undefined;
  }
}

export function writeJournal(j: Omit<Journal, 'v' | 'savedAt'> & { savedAt?: string }, storage?: Storage) {
  const s = store(storage);
  if (!s) return;
  const entry: Journal = { v: 1, ...j, packet: redactPacket(j.packet), savedAt: j.savedAt ?? new Date().toISOString() };
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
