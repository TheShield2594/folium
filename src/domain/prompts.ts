import { expiryInfo } from './requests';
import type { ClientRecord, FormTemplate, SavedPacket, SignatureRequest } from './types';

/**
 * What Today's "Needs you" list holds: work waiting on the advisor across every client.
 * Drafts that aren't in good order and requests that need a hand come first (pumpkin);
 * prompts from Dynamics 365 and the form library follow (royal).
 */
export type PromptKind = 'draft' | 'request' | 'rmd' | 'beneficiary' | 'revision';

export interface Prompt {
  id: string;
  kind: PromptKind;
  /** Pumpkin dot: something is stuck. Royal: something to start. */
  tone: 'attention' | 'info';
  title: string;
  detail: string;
  /** The link on the right: "Resume", "Fix signer", "Start packet". */
  action: string;
  contactId?: string;
  requestId?: string;
  /** For "Start packet": the description Start a packet should build from. */
  intent?: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Parse an ISO date (`1953-12-09`) as a local calendar date. */
function day(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/**
 * The age required minimum distributions start, by birth year (SECURE 2.0): 72 for
 * people born 1950 and earlier, 73 for 1951–1959, 75 from 1960.
 */
export function rmdAge(birthYear: number): number {
  if (birthYear <= 1950) return 72;
  if (birthYear <= 1959) return 73;
  return 75;
}

/** Account types an owner takes RMDs from. Roth IRAs don't have them while the owner lives. */
const RMD_ACCOUNT = /\b(ira|401\s?\(?k\)?|403\s?\(?b\)?|457|sep|simple)\b/i;
const isRmdAccount = (type: string) => RMD_ACCOUNT.test(type) && !/\broth\b/i.test(type) && !/inherited/i.test(type);

/** Accounts that should name beneficiaries. */
const NEEDS_BENEFICIARY = /\b(ira|annuity|401\s?\(?k\)?|403\s?\(?b\)?)\b/i;

/** Prompts from a client's Dynamics 365 record: an RMD that starts this year, beneficiaries missing. */
export function clientPrompts(client: ClientRecord, today: Date): Prompt[] {
  const out: Prompt[] = [];
  const { contact, accounts, connections } = client;
  const name = contact.fullname;

  if (contact.birthdate) {
    const born = day(contact.birthdate);
    const age = rmdAge(born.getFullYear());
    const iras = accounts.filter((a) => isRmdAccount(a.ev_accounttype));
    if (today.getFullYear() - born.getFullYear() === age && iras.length) {
      const birthday = new Date(today.getFullYear(), born.getMonth(), born.getDate());
      out.push({
        id: `rmd:${contact.contactid}:${today.getFullYear()}`,
        kind: 'rmd',
        tone: 'info',
        title: `${name} ${birthday > today ? 'turns' : 'turned'} ${age} in ${MONTHS[born.getMonth()]}`,
        detail: `From Dynamics 365. An RMD election is due by Dec 31${iras.length > 1 ? ` for ${iras.length} accounts` : ''}.`,
        action: 'Start packet',
        contactId: contact.contactid,
        intent: 'RMD election',
      });
    }
  }

  const named = connections.some((c) => /beneficiar/i.test(c.role));
  const bare = accounts.filter((a) => NEEDS_BENEFICIARY.test(a.ev_accounttype));
  if (!named && bare.length) {
    out.push({
      id: `bene:${contact.contactid}`,
      kind: 'beneficiary',
      tone: 'info',
      title: `${name} has no beneficiary on file`,
      detail: `From Dynamics 365: ${bare.length === 1 ? bare[0].name : `${bare.length} accounts`} ${bare.length === 1 ? 'names' : 'name'} no beneficiary. Worth a review.`,
      action: 'Start packet',
      contactId: contact.contactid,
      intent: 'Update beneficiaries',
    });
  }
  return out;
}

/** A saved draft that isn't in good order yet. `blocking` is its open blocking checks. */
export function draftPrompt(req: SignatureRequest, clientName: string, blocking: number): Prompt | undefined {
  if (req.status !== 'Drafted' || blocking < 1) return undefined;
  return {
    id: `draft:${req.id}`,
    kind: 'draft',
    tone: 'attention',
    title: `${clientName} · ${req.title}`,
    detail: `Draft, ${blocking} ${blocking === 1 ? 'item' : 'items'} to fix before it’s in good order.`,
    action: 'Resume',
    contactId: req.contactId,
    requestId: req.id,
  };
}

/** A sent request that needs the advisor: declined, lapsing, or signed and waiting for OnBase. */
export function requestPrompt(req: SignatureRequest, clientName: string, today: Date): Prompt | undefined {
  const base = { kind: 'request' as const, tone: 'attention' as const, contactId: req.contactId, requestId: req.id };
  if (req.status === 'Declined') {
    const who = req.signers.find((s) => s.status === 'declined')?.name;
    return { ...base, id: `req:${req.id}:declined`, title: `${clientName} · ${who ? `${who} declined` : 'declined to sign'}`, detail: `${req.title}. Correct it and send again, or void it.`, action: 'Fix signer' };
  }
  const exp = expiryInfo(req, today);
  if (exp?.pastDue) return { ...base, id: `req:${req.id}:lapsed`, title: `${clientName} · request lapsed`, detail: `${req.title} passed its expiry date unsigned.`, action: 'Open' };
  if (exp?.soon) {
    return { ...base, id: `req:${req.id}:expiring`, title: `${clientName} · expires in ${exp.daysLeft} ${exp.daysLeft === 1 ? 'day' : 'days'}`, detail: `${req.title} is still ${req.status === 'Viewed' ? 'opened, not signed' : 'not opened'}. A reminder may help.`, action: 'Remind' };
  }
  if (req.status === 'Signed' && !req.uploadedToOnBase) {
    return { ...base, id: `req:${req.id}:onbase`, title: `${clientName} · signed, not filed`, detail: `${req.title} is signed. File it in OnBase, then tick it off.`, action: 'File' };
  }
  return undefined;
}

/**
 * A new revision of a form in one of the advisor's saved packets takes effect within
 * `days`: packets pick it up on their own, but drafts on the old one will need updating.
 */
export function revisionPrompts(packets: SavedPacket[], templates: FormTemplate[], today: Date, days = 30): Prompt[] {
  const until = new Date(today.getTime() + days * 86_400_000);
  const out: Prompt[] = [];
  const seen = new Set<string>();
  for (const p of packets) {
    for (const id of p.templateIds) {
      const t = templates.find((x) => x.id === id);
      if (!t) continue;
      const next = templates.find((x) => x.formNumber === t.formNumber && x.status === 'Live' && x.id !== t.id && day(x.effectiveDate) > today && day(x.effectiveDate) <= until);
      if (!next || seen.has(next.id)) continue;
      seen.add(next.id);
      const on = day(next.effectiveDate);
      out.push({
        id: `rev:${next.id}`,
        kind: 'revision',
        tone: 'info',
        title: `${t.name} Rev ${next.revision} takes effect ${MONTHS[on.getMonth()].slice(0, 3)} ${on.getDate()}`,
        detail: `It’s in your saved packet “${p.name}”. Drafts on the old revision will need updating.`,
        action: 'See packets',
      });
    }
  }
  return out;
}

/** Stuck work first, then prompts; within each, in the order given. */
export function sortPrompts(list: Prompt[]): Prompt[] {
  return [...list.filter((p) => p.tone === 'attention'), ...list.filter((p) => p.tone === 'info')];
}

/** "Good morning" until noon, "Good afternoon" until 6, then "Good evening". */
export function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** "Just now", "35 min ago", "2 h ago", "Yesterday", "Oct 12". */
export function relativeTime(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const at = new Date(iso);
  const mins = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 12) return `${Math.round(mins / 60)} h ago`;
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
