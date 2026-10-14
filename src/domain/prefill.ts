import { formatValue, prettifyFieldName, validateFormat } from './format';
import { ConditionError, conditionTerms, describeSource, evaluateCondition, explainCondition, parseCondition, resolvePath, sourceKind, type ResolveScope, type TermLabel } from './paths';
import type { Account, ClientRecord, Contact, FieldMapping, FormTemplate, TemplateMapping } from './types';

export type FieldOrigin = 'crm' | 'rep' | 'firm' | 'computed' | 'static' | 'edited' | 'advisor' | 'signer' | 'missing';

export interface FieldState {
  templateId: string;
  /** The packet item (form instance) this field is on. */
  itemId: string;
  mapping: FieldMapping;
  /** Canonical key shared across forms in a packet. */
  key: string;
  label: string;
  /** Raw value (before formatting). */
  value: string;
  /** Value as it will print on the PDF. */
  display: string;
  origin: FieldOrigin;
  /** Where the value came from, for the provenance list. */
  sourceLabel: string;
  /** What the CRM had, when the advisor overrode it. */
  crmValue?: string;
  /** What the CRM has for this field, whatever the advisor did to it (empty for advisor/signer fields). */
  crmBaseline?: string;
  required: boolean;
  missing: boolean;
  formatError?: string;
  /** `lockWhen` holds: the field is read-only and prints blank. */
  locked: boolean;
  /** Why it's locked, as a sentence ("when Contingent beneficiary is checked"). */
  lockReason?: string;
}

export interface FormFill {
  template: FormTemplate;
  /** The packet item this is: a form's id in the packet, distinct for each copy. Defaults to the template id. */
  itemId: string;
  /** 2 and up on an added copy of a form. */
  copy?: number;
  account?: Account;
  /** The account `account.*` fields resolved against, including the first-account fallback. */
  accountId?: string;
  fields: FieldState[];
  filledCount: number;
  requiredCount: number;
  missingCount: number;
}

/**
 * The canonical key for a field. Fields with the same key share one value across
 * every form in a packet — LaserApp's "enter once, use everywhere". Account fields
 * are scoped to the account the form is about, so a correction on one account's
 * form never leaks onto a form about another account. On an added copy of a form
 * (`copyId`, the copy's item id), advisor-entered fields are scoped to that copy, so
 * typing on copy 2 never changes copy 1; client data stays shared.
 */
export function fieldKey(m: FieldMapping, t: Pick<FormTemplate, 'formNumber'>, accountId?: string, copyId?: string): string {
  const base = baseKey(m, t, accountId);
  return copyId && perCopy(m) ? copyKey(copyId, base) : base;
}

/**
 * Fields a copy keeps its own value for: what the advisor types, and person blocks
 * (beneficiary 2 on one IRA's form needn't be the same person on the other's), even
 * when the block reads a connection from CRM.
 */
const perCopy = (m: FieldMapping) => (sourceKind(m.source) === 'advisor' || !!m.person) && !m.shareAcrossCopies;

function baseKey(m: FieldMapping, t: Pick<FormTemplate, 'formNumber'>, accountId?: string): string {
  if (m.key) return m.key;
  const kind = sourceKind(m.source);
  if (kind === 'advisor' || kind === 'signer') return `${t.formNumber}:${m.pdfField}`;
  if (accountId && m.source.startsWith('account.')) return accountKey(accountId, m.source.slice('account.'.length));
  return m.source;
}

export const accountKey = (accountId: string, attr: string) => `account[${accountId}].${attr}`;
export const copyKey = (itemId: string, key: string) => `${itemId}/${key}`;

/** The item id a copy's own values are keyed under: set for copy 2 and later, never for the first. */
export const copyScope = (item: { id?: string; copy?: number } | undefined) => (item?.id && (item.copy ?? 1) > 1 ? item.id : undefined);

/** The account a form's `account.*` sources resolve against (see resolvePath). */
export const formAccountId = (scope: Pick<ResolveScope, 'account' | 'client'>) => (scope.account ?? scope.client.accounts[0])?.accountid;

/**
 * Values as conditions on one form see them: overrides for this form's account also
 * answer to the plain `account.<attr>` path, so `account.ev_accounttype == Roth IRA`
 * keeps working. On a copy, the copy's own values answer to their plain keys too.
 */
export function valuesForAccount(values: Record<string, string>, accountId: string | undefined, copyId?: string): Record<string, string> {
  if (!accountId && !copyId) return values;
  const prefix = `account[${accountId}].`;
  const mine = copyId ? `${copyId}/` : undefined;
  const out = { ...values };
  for (const [k, v] of Object.entries(values)) {
    if (accountId && k.startsWith(prefix)) out[`account.${k.slice(prefix.length)}`] = v;
    if (mine && k.startsWith(mine)) out[k.slice(mine.length)] = v;
  }
  return out;
}

/**
 * Values for a new copy of a form: its advisor fields start from the original's
 * (`fromCopyId` when the original is itself a copy), so the advisor edits only what
 * differs.
 */
export function seedCopyValues(t: FormTemplate, values: Record<string, string>, toItemId: string, fromCopyId?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of t.mapping.fields) {
    if (!perCopy(m)) continue;
    const from = fieldKey(m, t, undefined, fromCopyId);
    if (from in values) out[fieldKey(m, t, undefined, toItemId)] = values[from];
  }
  return out;
}

/**
 * Drafts saved before account keys were scoped hold `account.<attr>` overrides. Apply
 * them to the first form's account only, which is what the advisor most likely meant.
 * Keys an admin set by hand (`sharedKeys`) are left as they are.
 */
export function migrateAccountValues(values: Record<string, string>, firstAccountId: string | undefined, sharedKeys: Set<string> = new Set()): Record<string, string> {
  if (!firstAccountId) return values;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith('account.') && !sharedKeys.has(k)) {
      const scoped = accountKey(firstAccountId, k.slice('account.'.length));
      if (!(scoped in values)) out[scoped] = v;
    } else out[k] = v;
  }
  return out;
}

/**
 * Values to carry when one form is swapped for another version of it (another state's).
 * A field whose key differs between the two (keys that default to the form number) gets
 * the old value under its new key, matched by PDF field name. Nothing is overwritten.
 */
export function carryVariantValues(from: FormTemplate, to: FormTemplate, values: Record<string, string>, copyId?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of from.mapping.fields) {
    const n = to.mapping.fields.find((x) => x.pdfField === m.pdfField);
    if (!n) continue;
    const a = fieldKey(m, from, undefined, copyId);
    const b = fieldKey(n, to, undefined, copyId);
    if (a !== b && a in values && !(b in values)) out[b] = values[a];
  }
  return out;
}

/** Mapping problems worth flagging in the template editor. */
export function mappingWarnings(mapping: TemplateMapping): string[] {
  return [
    ...mapping.fields
      .filter((m) => m.key && m.source.startsWith('account.'))
      .map((m) => `${m.pdfField} reads ${m.source} but has a fixed key (${m.key}), so its value is shared by every form in a packet, whichever account each is about.`),
    ...validateMapping(mapping),
  ];
}

/** The value key a mapped field answers to in conditions on its own form (account fields by their path). */
const conditionKey = (m: FieldMapping) => m.key ?? (sourceKind(m.source) === 'advisor' || sourceKind(m.source) === 'signer' ? undefined : m.source);

/** Names condition terms after the mapping's fields, for `explainCondition`. */
export function termLabels(mapping: Pick<TemplateMapping, 'fields' | 'formNumber'>): TermLabel {
  return (term) => {
    const m = mapping.fields.find((f) => conditionKey(f) === term || fieldKey(f, mapping) === term);
    return m ? { label: m.label ?? prettifyFieldName(m.pdfField), checkbox: m.format === 'checkbox' } : undefined;
  };
}

/**
 * Condition problems: ones that can't be parsed, and locks that depend on a field that
 * can itself be locked. Locks are worked out in one pass, so a chain doesn't cascade.
 */
export function validateMapping(mapping: Pick<TemplateMapping, 'fields' | 'formNumber'>): string[] {
  const out: string[] = [];
  const lockable = new Set(mapping.fields.filter((m) => m.lockWhen?.trim()).flatMap((m) => [fieldKey(m, mapping), conditionKey(m)].filter(Boolean) as string[]));
  for (const m of mapping.fields) {
    for (const [what, cond] of [['Required when', m.requiredWhen], ['Locked when', m.lockWhen]] as const) {
      if (!cond?.trim()) continue;
      try {
        parseCondition(cond);
      } catch (e) {
        out.push(`${m.pdfField}: “${what}” can’t be read (${e instanceof ConditionError ? e.message : 'invalid'}).`);
      }
    }
    if (m.lockWhen?.trim()) {
      const chained = conditionTerms(m.lockWhen).filter((t) => lockable.has(t));
      if (chained.length) out.push(`${m.pdfField} is locked by ${chained.join(', ')}, which can be locked too. Locks don’t chain: base it on the field that starts the chain.`);
    }
  }
  return out;
}

export function prefillForm(
  template: FormTemplate,
  scope: ResolveScope,
  values: Record<string, string>,
  item?: { id?: string; copy?: number },
): FormFill {
  const accountId = formAccountId(scope);
  const copyId = copyScope(item);
  const condValues = valuesForAccount(values, accountId, copyId);
  const labels = termLabels(template.mapping);
  const fields = template.mapping.fields.map((m): FieldState => {
    const key = fieldKey(m, template, accountId, copyId);
    const kind = sourceKind(m.source);
    const crmValue = kind === 'advisor' || kind === 'signer' ? undefined : resolvePath(m.source, scope);
    const edited = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    // Locks read the packet's values in one pass (they don't chain; validateMapping warns).
    // A lock that can't be parsed doesn't lock: a typo must never blank a field.
    const locked = !!m.lockWhen?.trim() && evaluateCondition(m.lockWhen, scope, condValues, false);
    const value = locked ? '' : (edited ?? crmValue ?? '');
    const required = !locked && (m.requiredWhen?.trim() ? evaluateCondition(m.requiredWhen, scope, condValues) : m.required);

    let origin: FieldOrigin;
    if (kind === 'signer') origin = 'signer';
    else if (locked) origin = 'missing';
    else if (edited !== undefined && edited !== '' && crmValue !== undefined && edited !== crmValue) origin = 'edited';
    else if (edited !== undefined && edited !== '' && crmValue === undefined) origin = 'advisor';
    else if (value) origin = kind === 'advisor' ? 'advisor' : (kind as FieldOrigin);
    else origin = 'missing';

    const choice = !!(m.checkedWhen || m.options);
    // A radio prints nothing for a value with no option, so a required one is still missing.
    // (A box in a `checkedWhen` set is blank whenever another box is ticked, so its value counts.)
    const missing = kind !== 'signer' && !locked && required && (!value.trim() || (!!m.options && !choiceDisplay(m, value)));
    return {
      templateId: template.id,
      itemId: item?.id ?? template.id,
      mapping: m,
      key,
      label: m.label ?? prettifyFieldName(m.pdfField),
      value,
      display: choiceDisplay(m, value) ?? (m.format === 'checkbox' ? value : formatValue(value, m.format, m.limits)),
      origin,
      sourceLabel: describeSource(m.source),
      crmValue: origin === 'edited' ? crmValue : undefined,
      crmBaseline: crmValue ?? '',
      required,
      missing,
      // CRM values are checked too, so bad data already in D365 surfaces here.
      formatError: locked || choice ? undefined : validateFormat(value, m.format, m.limits, scope.today),
      locked,
      lockReason: locked ? explainCondition(m.lockWhen, labels) : undefined,
    };
  });

  const relevant = fields.filter((f) => f.origin !== 'signer');
  return {
    template,
    itemId: item?.id ?? template.id,
    copy: item?.copy && item.copy > 1 ? item.copy : undefined,
    account: scope.account,
    accountId: template.mapping.fields.some((m) => m.source.startsWith('account.')) ? accountId : scope.account?.accountid,
    fields,
    filledCount: relevant.filter((f) => f.value.trim()).length,
    requiredCount: relevant.filter((f) => f.required).length,
    missingCount: fields.filter((f) => f.missing).length,
  };
}

const sameWord = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What a box or radio mapped to a choice prints: `Yes` when the value is the box's word
 * (empty otherwise), or the radio option for the value. Undefined for other fields.
 */
export function choiceDisplay(m: Pick<FieldMapping, 'checkedWhen' | 'options'>, value: string): string | undefined {
  if (m.checkedWhen) return value && sameWord(value, m.checkedWhen) ? 'Yes' : '';
  if (m.options) return Object.entries(m.options).find(([k]) => value && sameWord(k, value))?.[1] ?? '';
  return undefined;
}

/** The choices a set of fields sharing one key offers (each box's word, or each radio value), in mapping order. */
export function choiceOptions(fields: Pick<FieldState, 'mapping' | 'label'>[]): { value: string; label: string }[] {
  const out = new Map<string, string>();
  for (const f of fields) {
    if (f.mapping.checkedWhen && !out.has(f.mapping.checkedWhen.toLowerCase())) out.set(f.mapping.checkedWhen.toLowerCase(), f.label);
    for (const k of Object.keys(f.mapping.options ?? {})) if (!out.has(k.toLowerCase())) out.set(k.toLowerCase(), k.charAt(0).toUpperCase() + k.slice(1));
  }
  return [...out.entries()].map(([value, label]) => ({ value, label }));
}

const CHOICE_NAMES: Record<string, string> = { familystatuscode: 'Marital status', gendercode: 'Gender', ev_employmentstatus: 'Employment status' };

/** What a set of choice boxes asks, from their source: `contact.familystatuscode` → "Marital status". */
export function choiceQuestion(source: string, fallback: string): string {
  const attr = /\.([a-z0-9_]+)$/i.exec(source)?.[1];
  const prefix = /^connection\[([^\]#]+)/.exec(source)?.[1];
  const name = attr ? CHOICE_NAMES[attr] : undefined;
  return name ? (prefix ? `${prefix}: ${name.toLowerCase()}` : name) : fallback;
}

export interface PacketFillInput {
  template: FormTemplate;
  account?: Account;
  /** The packet item; defaults to the template id. */
  itemId?: string;
  copy?: number;
}

export function prefillPacket(
  items: PacketFillInput[],
  scope: Omit<ResolveScope, 'account'>,
  values: Record<string, string>,
): FormFill[] {
  return items.map((it) => prefillForm(it.template, { ...scope, account: it.account }, values, { id: it.itemId, copy: it.copy }));
}

/**
 * How ready a form is before the advisor touches it: of the fields that will print
 * (anything filled, plus anything required), the share Folium filled on its own.
 */
export function prefillCoverage(template: FormTemplate, scope: ResolveScope): number {
  const fill = prefillForm(template, scope, {});
  const filled = fill.fields.filter((f) => f.origin !== 'signer' && f.value.trim()).length;
  const total = filled + fill.missingCount;
  return total ? Math.round((filled / total) * 100) : 100;
}

/**
 * Fields that need the advisor, de-duplicated across forms by key. `required` is true
 * when any form needs the value (or it's malformed); optional advisor fields come last.
 */
export function inputsNeeded(fills: FormFill[]): { key: string; fields: FieldState[]; required: boolean }[] {
  const byKey = new Map<string, FieldState[]>();
  for (const fill of fills) {
    for (const f of fill.fields) {
      if (f.origin === 'signer' || f.locked) continue;
      if (!(f.missing || f.formatError || sourceKind(f.mapping.source) === 'advisor')) continue;
      const list = byKey.get(f.key) ?? [];
      list.push(f);
      byKey.set(f.key, list);
    }
  }
  return [...byKey.entries()]
    .map(([key, fields]) => ({ key, fields, required: fields.some((f) => f.required || (f.formatError && f.value)) }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

// ---------------------------------------------------------------- Person blocks

/** Someone a person block (a beneficiary, a joint owner) can be filled from. */
export interface Person {
  /** Contact id, when the person is in Dynamics. */
  contactId?: string;
  name: string;
  /** Their relationship to the client ("Spouse", "Son"), or "Client" for the client. */
  role: string;
  contact?: Contact;
  sharePct?: number;
}

/** Who filled a block, kept with the packet and its draft. */
export interface PersonPick {
  contactId?: string;
  name: string;
  role: string;
}

/** The client and everyone connected to them, for "Fill from…" and signer pickers. */
export function relatedPeople(client: ClientRecord): Person[] {
  const me: Person = { contactId: client.contact.contactid, name: client.contact.fullname, role: 'Client', contact: client.contact };
  return [me, ...client.connections.map((c): Person => ({ contactId: c.contact.contactid, name: c.contact.fullname, role: c.role, contact: c.contact, sharePct: c.ev_sharepct }))];
}

/** The person blocks on some forms, in the order they first appear. */
export function personBlocks(fills: FormFill[]): string[] {
  return [...new Set(fills.flatMap((f) => f.fields.map((x) => x.mapping.person?.block).filter((b): b is string => !!b)))];
}

/** Where a block's pick is kept: per copy on an added copy of a form, like its values. */
export const blockKey = (block: string, fill: Pick<FormFill, 'itemId' | 'copy'>) => {
  const scope = copyScope({ id: fill.itemId, copy: fill.copy });
  return scope ? copyKey(scope, block) : block;
};

/**
 * The values that fill a person block from one person: each field in the block gets the
 * person's value for its `person.attr` (a contact column, `role` or `ev_sharepct`).
 * With no person ("Someone new"), the block is cleared for the advisor to type.
 */
export function fillBlockFromPerson(fills: FormFill[], block: string, person: Person | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fills.flatMap((x) => x.fields)) {
    const attr = f.mapping.person?.block === block ? f.mapping.person.attr : undefined;
    if (!attr || f.locked) continue;
    let v: unknown = '';
    if (person) v = attr === 'role' ? person.role : attr === 'ev_sharepct' ? person.sharePct : attr === 'fullname' ? person.name : person.contact?.[attr];
    out[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

// ---------------------------------------------------------------- Draft snapshots

const isSsn = (f: FieldState) => f.mapping.format === 'ssn' || f.mapping.format === 'ssnOrTin' || f.mapping.format === 'ssnLast4' || /ev_ssn|ssnLast4/.test(f.mapping.source);
const fromCrm = (f: FieldState) => {
  const kind = sourceKind(f.mapping.source);
  return (kind === 'crm' || kind === 'computed') && !f.mapping.source.includes('today') && !isSsn(f);
};

/** CRM-derived value per field key, for `SignatureRequest.prefillSnapshot`. SSNs are never included. */
export function prefillSnapshot(fills: FormFill[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fills.flatMap((x) => x.fields)) if (fromCrm(f) && !(f.key in out)) out[f.key] = f.crmBaseline ?? '';
  return out;
}

export interface SnapshotChange {
  key: string;
  label: string;
  saved: string;
  now: string;
}

/** CRM values that changed since the draft was saved. */
export function snapshotDiff(snapshot: Record<string, string> | undefined, fills: FormFill[]): SnapshotChange[] {
  if (!snapshot) return [];
  const out: SnapshotChange[] = [];
  const seen = new Set<string>();
  for (const f of fills.flatMap((x) => x.fields)) {
    if (seen.has(f.key) || !fromCrm(f) || !(f.key in snapshot)) continue;
    seen.add(f.key);
    const saved = snapshot[f.key];
    const now = f.crmBaseline ?? '';
    if (saved !== now) out.push({ key: f.key, label: f.label, saved, now });
  }
  return out;
}
