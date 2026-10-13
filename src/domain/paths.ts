import type { Account, Advisor, ClientRecord, Contact, FirmProfile } from './types';

/** What a field source resolves against. `account` is the account the form is about. */
export interface ResolveScope {
  client: ClientRecord;
  account?: Account;
  advisor: Advisor;
  firm?: FirmProfile;
  today?: Date;
}

export type SourceKind = 'crm' | 'rep' | 'firm' | 'computed' | 'static' | 'advisor' | 'signer';

export function sourceKind(source: string): SourceKind {
  if (source === 'advisor') return 'advisor';
  if (source === 'signer') return 'signer';
  if (source.startsWith('static:')) return 'static';
  if (source.startsWith('rep.')) return 'rep';
  if (source.startsWith('firm.')) return 'firm';
  if (source.startsWith('computed.')) return 'computed';
  return 'crm';
}

const CONNECTION_RE = /^connection\[([^\]#]+)(?:#(\d+))?\]\.(.+)$/;

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

function fmtDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function contactComputed(c: Contact | undefined, name: string): string | undefined {
  if (!c) return undefined;
  switch (name) {
    case 'cityStateZip': {
      const parts = [c.address1_city, [c.address1_stateorprovince, c.address1_postalcode].filter(Boolean).join(' ')].filter(Boolean);
      return parts.length ? parts.join(', ') : undefined;
    }
    case 'streetAddress':
      return [c.address1_line1, c.address1_line2].filter(Boolean).join(', ') || undefined;
    case 'ssnLast4':
      return c.ev_ssn ? c.ev_ssn.replace(/\D/g, '').slice(-4) : undefined;
    case 'phone':
      return c.mobilephone || c.telephone1 || undefined;
    default:
      return undefined;
  }
}

/**
 * Resolve a Dataverse-style path against a client record. Returns undefined when the
 * value isn't on file. Never throws on an unknown path: unknown paths are just empty.
 */
export function resolvePath(path: string, scope: ResolveScope): string | undefined {
  const kind = sourceKind(path);
  if (kind === 'advisor' || kind === 'signer') return undefined;
  if (kind === 'static') return path.slice('static:'.length);

  if (kind === 'rep') {
    const attr = path.slice('rep.'.length) as keyof Advisor;
    return str(scope.advisor[attr]);
  }

  if (kind === 'firm') {
    const attr = path.slice('firm.'.length) as keyof FirmProfile;
    return scope.firm ? str(scope.firm[attr]) : undefined;
  }

  if (kind === 'computed') {
    const name = path.slice('computed.'.length);
    if (name === 'today') return fmtDate(scope.today ?? new Date());
    const [subject, fn] = name.includes(':') ? name.split(':') : ['contact', name];
    if (subject === 'contact') return contactComputed(scope.client.contact, fn);
    const m = /^connection\[([^\]#]+)(?:#(\d+))?\]$/.exec(subject);
    if (m) return contactComputed(findConnection(scope.client, m[1], m[2])?.contact, fn);
    return undefined;
  }

  if (path.startsWith('contact.')) return str(scope.client.contact[path.slice(8)]);
  if (path.startsWith('account.')) return str((scope.account ?? scope.client.accounts[0])?.[path.slice(8)]);

  const m = CONNECTION_RE.exec(path);
  if (m) {
    const conn = findConnection(scope.client, m[1], m[2]);
    if (!conn) return undefined;
    const attr = m[3];
    if (attr === 'ev_sharepct') return str(conn.ev_sharepct);
    if (attr === 'role') return conn.role;
    return str(conn.contact[attr]);
  }
  return undefined;
}

function findConnection(client: ClientRecord, role: string, nth?: string) {
  const all = client.connections.filter((c) => c.role.toLowerCase() === role.toLowerCase());
  return all[(nth ? Number(nth) : 1) - 1];
}

/** Human-friendly description of a source, used in "Where values came from". */
export function describeSource(source: string): string {
  const kind = sourceKind(source);
  if (kind === 'advisor') return 'You, at review';
  if (kind === 'signer') return 'Signer, in DocuSign';
  if (kind === 'static') return 'Fixed value';
  if (kind === 'rep') return 'Advisor profile';
  if (kind === 'firm') return 'Firm profile';
  if (kind === 'computed') return source.includes('today') ? 'Today’s date' : 'Combined from the contact';
  const m = CONNECTION_RE.exec(source);
  if (m) return `Connection: ${m[1]}${m[2] ? ` #${m[2]}` : ''}`;
  if (source.startsWith('account.')) return 'Account record';
  return 'Contact record';
}

/**
 * Evaluate a condition like `contact.familystatuscode == married`.
 * Supports `==`, `!=`, bare truthiness, and `&&` / `||` (no parentheses).
 */
export function evaluateCondition(condition: string | undefined, scope: ResolveScope, values?: Record<string, string>): boolean {
  if (!condition || !condition.trim()) return true;
  return condition.split('||').some((orPart) =>
    orPart.split('&&').every((term) => evaluateTerm(term.trim(), scope, values)),
  );
}

function evaluateTerm(term: string, scope: ResolveScope, values?: Record<string, string>): boolean {
  const lookup = (p: string) => values?.[p] ?? resolvePath(p, scope);
  const neq = term.split('!=');
  if (neq.length === 2) return (lookup(neq[0].trim()) ?? '').toLowerCase() !== unquote(neq[1]).toLowerCase();
  const eq = term.split('==');
  if (eq.length === 2) return (lookup(eq[0].trim()) ?? '').toLowerCase() === unquote(eq[1]).toLowerCase();
  if (term.startsWith('!')) return !lookup(term.slice(1).trim());
  const v = lookup(term);
  return !!v && v !== 'false' && v !== '0';
}

function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '');
}
