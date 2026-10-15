import { repComputed } from './advisor';
import { parseIdSource, resolveIdSource } from './idDocuments';
import type { Account, Advisor, ClientRecord, Contact, FirmProfile, UserGroup } from './types';

/** What a field source resolves against. `account` is the account the form is about. */
export interface ResolveScope {
  client: ClientRecord;
  account?: Account;
  advisor: Advisor;
  /**
   * The profile `firm.*` reads. With `firms`, `prefillForm` sets it per form (`firmFor`)
   * and this is only the fallback when there are no profiles.
   */
  firm?: FirmProfile;
  /** Every firm profile, so each form fills from its issuer's. */
  firms?: FirmProfile[];
  /** The advisor's group that names a default profile, for forms no profile claims. */
  firmGroup?: Pick<UserGroup, 'defaultFirmId'>;
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
    const attr = path.slice('rep.'.length);
    const v = scope.advisor[attr as keyof Advisor];
    return typeof v === 'object' ? repComputed(scope.advisor, attr === 'office' ? 'officeStreet' : attr) : (str(v) ?? repComputed(scope.advisor, attr));
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

  if (path.startsWith('id.')) return resolveIdSource(path, scope.client);
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
  const id = parseIdSource(source);
  if (id) return id.who === 'spouse' ? 'Spouse’s ID documents' : 'Client’s ID documents';
  const m = CONNECTION_RE.exec(source);
  if (m) return `Connection: ${m[1]}${m[2] ? ` #${m[2]}` : ''}`;
  if (source.startsWith('account.')) return 'Account record';
  return 'Contact record';
}

// ---------------------------------------------------------------- Conditions
//
// Conditions gate signers (`SignerRule.condition`), requirements (`requiredWhen`) and
// locks (`lockWhen`). The grammar is small and dependency-free:
//
//   expr       := or
//   or         := and ('||' and)*
//   and        := unary ('&&' unary)*
//   unary      := '!' unary | '(' expr ')' | comparison
//   comparison := term [ ('==' | '!=' | 'contains') value | 'in' '(' value (',' value)* ')' ]
//
// A term is a packet value key or a CRM path (`contact.familystatuscode`,
// `connection[Joint owner].fullname`); packet values win. Values may be quoted, which
// they need to be when they hold an operator or a comma. Comparisons ignore case.

export type ConditionNode =
  | { op: 'or' | 'and'; left: ConditionNode; right: ConditionNode }
  | { op: 'not'; arg: ConditionNode }
  | { op: 'truthy'; term: string }
  | { op: '==' | '!=' | 'contains'; term: string; value: string }
  | { op: 'in'; term: string; values: string[] };

export class ConditionError extends Error {}

type Token = { t: 'text' | 'str'; v: string } | { t: 'op'; v: '||' | '&&' | '==' | '!=' | '!' | '(' | ')' | ',' | 'contains' | 'in' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let buf = '';
  let depth = 0; // inside [...] (connection roles) nothing is an operator
  const flush = () => {
    const v = buf.trim();
    if (v) out.push({ t: 'text', v });
    buf = '';
  };
  const wordAt = (i: number, w: string) => {
    if (src.slice(i, i + w.length).toLowerCase() !== w) return false;
    const before = i === 0 ? ' ' : src[i - 1];
    const after = src[i + w.length] ?? ' ';
    return /\s/.test(before) && (/\s/.test(after) || after === '(');
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (depth > 0) {
      if (c === ']') depth--;
      buf += c;
      i++;
      continue;
    }
    if (c === '[') {
      depth++;
      buf += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ConditionError('A quote isn’t closed.');
      flush();
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '||' || two === '&&' || two === '==' || two === '!=') {
      flush();
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (c === '!' || c === '(' || c === ')' || c === ',') {
      flush();
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    // `in` only counts before a list, so a field named "Opt in" still reads as a name.
    const word = wordAt(i, 'contains') ? 'contains' : wordAt(i, 'in') && buf.trim() && /^\s*\(/.test(src.slice(i + 2)) ? 'in' : undefined;
    if (word) {
      flush();
      out.push({ t: 'op', v: word });
      i += word.length;
      continue;
    }
    buf += c;
    i++;
  }
  if (depth > 0) throw new ConditionError('A [ isn’t closed.');
  flush();
  return out;
}

/** Parse a condition. Throws `ConditionError` when it can't be read. */
export function parseCondition(condition: string): ConditionNode {
  const tokens = tokenize(condition);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ConditionError(`Expected “${v}”.`);
    pos++;
  };
  const operand = (what: string): string => {
    const tok = peek();
    if (!tok || tok.t === 'op') throw new ConditionError(`Expected ${what}.`);
    pos++;
    return tok.v;
  };

  const or = (): ConditionNode => {
    let left = and();
    while (isOp('||')) {
      pos++;
      left = { op: 'or', left, right: and() };
    }
    return left;
  };
  const and = (): ConditionNode => {
    let left = unary();
    while (isOp('&&')) {
      pos++;
      left = { op: 'and', left, right: unary() };
    }
    return left;
  };
  const unary = (): ConditionNode => {
    if (isOp('!')) {
      pos++;
      return { op: 'not', arg: unary() };
    }
    if (isOp('(')) {
      pos++;
      const inner = or();
      expectOp(')');
      return inner;
    }
    const term = operand('a field or path');
    if (isOp('==') || isOp('!=') || isOp('contains')) {
      const op = peek()!.v as '==' | '!=' | 'contains';
      pos++;
      return { op, term, value: operand('a value') };
    }
    if (isOp('in')) {
      pos++;
      expectOp('(');
      const values = [operand('a value')];
      while (isOp(',')) {
        pos++;
        values.push(operand('a value'));
      }
      expectOp(')');
      return { op: 'in', term, values };
    }
    return { op: 'truthy', term };
  };

  if (!tokens.length) throw new ConditionError('The condition is empty.');
  const node = or();
  if (pos < tokens.length) throw new ConditionError(`Unexpected “${tokens[pos].v}”.`);
  return node;
}

/** Every term (value key or path) a condition reads. Empty when it can't be parsed. */
export function conditionTerms(condition: string | undefined): string[] {
  if (!condition?.trim()) return [];
  let node: ConditionNode;
  try {
    node = parseCondition(condition);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (n: ConditionNode) => {
    if (n.op === 'or' || n.op === 'and') (walk(n.left), walk(n.right));
    else if (n.op === 'not') walk(n.arg);
    else if ('term' in n) out.push(n.term);
  };
  walk(node);
  return [...new Set(out)];
}

/**
 * Evaluate a condition like `contact.familystatuscode == married`. An empty condition
 * holds. One that can't be parsed gives `onError` (true unless the caller says).
 */
export function evaluateCondition(condition: string | undefined, scope: ResolveScope, values?: Record<string, string>, onError = true): boolean {
  if (!condition || !condition.trim()) return true;
  let node: ConditionNode;
  try {
    node = parseCondition(condition);
  } catch {
    return onError;
  }
  const lookup = (p: string) => (values?.[p] ?? resolvePath(p, scope) ?? '').toLowerCase();
  const evalNode = (n: ConditionNode): boolean => {
    switch (n.op) {
      case 'or':
        return evalNode(n.left) || evalNode(n.right);
      case 'and':
        return evalNode(n.left) && evalNode(n.right);
      case 'not':
        return !evalNode(n.arg);
      case 'truthy': {
        const v = lookup(n.term);
        return !!v && v !== 'false' && v !== '0';
      }
      case '==':
        return lookup(n.term) === n.value.toLowerCase();
      case '!=':
        return lookup(n.term) !== n.value.toLowerCase();
      case 'contains':
        return lookup(n.term).includes(n.value.toLowerCase());
      case 'in':
        return n.values.some((v) => v.toLowerCase() === lookup(n.term));
    }
  };
  return evalNode(node);
}

/** How the editor names a term: its field label, and whether it's a checkbox. */
export type TermLabel = (term: string) => { label: string; checkbox?: boolean } | undefined;

const CHECKED = /^(true|yes|y|x|on|1|checked)$/i;

/**
 * A condition as a plain sentence for the editor and for locked fields, e.g. "when
 * Contingent beneficiary is checked". Falls back to the raw text when it can't be parsed.
 */
export function explainCondition(condition: string | undefined, labelFor: TermLabel = () => undefined): string {
  if (!condition?.trim()) return '';
  let node: ConditionNode;
  try {
    node = parseCondition(condition);
  } catch {
    return `when ${condition.trim()}`;
  }
  const name = (term: string) => labelFor(term)?.label ?? term;
  const say = (n: ConditionNode, nested: boolean): string => {
    switch (n.op) {
      case 'or':
      case 'and': {
        const s = `${say(n.left, n.left.op !== n.op)} ${n.op} ${say(n.right, n.right.op !== n.op)}`;
        return nested ? `(${s})` : s;
      }
      case 'not':
        if (n.arg.op === 'truthy') return `${name(n.arg.term)} is ${labelFor(n.arg.term)?.checkbox ? 'not checked' : 'empty'}`;
        if (n.arg.op === '==') return say({ ...n.arg, op: '!=' }, nested);
        return `not ${say(n.arg, true)}`;
      case 'truthy':
        return `${name(n.term)} is ${labelFor(n.term)?.checkbox ? 'checked' : 'filled in'}`;
      case '==':
      case '!=': {
        const box = labelFor(n.term)?.checkbox;
        if (box) return `${name(n.term)} is ${CHECKED.test(n.value) === (n.op === '==') ? 'checked' : 'not checked'}`;
        if (!n.value) return `${name(n.term)} is ${n.op === '==' ? 'empty' : 'filled in'}`;
        return `${name(n.term)} is ${n.op === '!=' ? 'not ' : ''}${n.value}`;
      }
      case 'contains':
        return `${name(n.term)} contains “${n.value}”`;
      case 'in':
        return `${name(n.term)} is ${n.values.length > 1 ? `${n.values.slice(0, -1).join(', ')} or ${n.values[n.values.length - 1]}` : n.values[0]}`;
    }
  };
  return `when ${say(node, false)}`;
}

/** What the editor's condition builder offers. */
export type BuilderOp = 'checked' | 'unchecked' | 'filled' | 'empty' | 'equals' | 'notEquals' | 'contains' | 'in';

/** Quote a value when it holds something the grammar would read as an operator. */
export function quoteValue(v: string): string {
  if (!/[|&=!(),'"[\]]|^\s|\s$|(^|\s)(in|contains)(\s|$)/i.test(v) && v !== '') return v;
  return v.includes('"') ? `'${v}'` : `"${v}"`;
}

/** One builder row as an expression, e.g. `beneficiary.contingent` or `contact.familystatuscode in (married, widowed)`. */
export function buildCondition(term: string, op: BuilderOp, value = ''): string {
  switch (op) {
    case 'checked':
    case 'filled':
      return term;
    case 'unchecked':
    case 'empty':
      return `!${term}`;
    case 'equals':
      return `${term} == ${quoteValue(value)}`;
    case 'notEquals':
      return `${term} != ${quoteValue(value)}`;
    case 'contains':
      return `${term} contains ${quoteValue(value)}`;
    case 'in':
      return `${term} in (${value.split(',').map((v) => quoteValue(v.trim())).filter(Boolean).join(', ')})`;
  }
}
