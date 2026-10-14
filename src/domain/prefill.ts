import { formatValue, prettifyFieldName, validateFormat } from './format';
import { describeSource, evaluateCondition, resolvePath, sourceKind, type ResolveScope } from './paths';
import type { Account, FieldMapping, FormTemplate, TemplateMapping } from './types';

export type FieldOrigin = 'crm' | 'rep' | 'firm' | 'computed' | 'static' | 'edited' | 'advisor' | 'signer' | 'missing';

export interface FieldState {
  templateId: string;
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
}

export interface FormFill {
  template: FormTemplate;
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
 * form never leaks onto a form about another account.
 */
export function fieldKey(m: FieldMapping, t: Pick<FormTemplate, 'formNumber'>, accountId?: string): string {
  if (m.key) return m.key;
  const kind = sourceKind(m.source);
  if (kind === 'advisor' || kind === 'signer') return `${t.formNumber}:${m.pdfField}`;
  if (accountId && m.source.startsWith('account.')) return accountKey(accountId, m.source.slice('account.'.length));
  return m.source;
}

export const accountKey = (accountId: string, attr: string) => `account[${accountId}].${attr}`;

/** The account a form's `account.*` sources resolve against (see resolvePath). */
export const formAccountId = (scope: Pick<ResolveScope, 'account' | 'client'>) => (scope.account ?? scope.client.accounts[0])?.accountid;

/**
 * Values as conditions on one form see them: overrides for this form's account also
 * answer to the plain `account.<attr>` path, so `account.ev_accounttype == Roth IRA`
 * keeps working.
 */
export function valuesForAccount(values: Record<string, string>, accountId: string | undefined): Record<string, string> {
  if (!accountId) return values;
  const prefix = `account[${accountId}].`;
  const out = { ...values };
  for (const [k, v] of Object.entries(values)) if (k.startsWith(prefix)) out[`account.${k.slice(prefix.length)}`] = v;
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

/** Mapping problems worth flagging in the template editor. */
export function mappingWarnings(mapping: TemplateMapping): string[] {
  return mapping.fields
    .filter((m) => m.key && m.source.startsWith('account.'))
    .map((m) => `${m.pdfField} reads ${m.source} but has a fixed key (${m.key}), so its value is shared by every form in a packet, whichever account each is about.`);
}

export function prefillForm(
  template: FormTemplate,
  scope: ResolveScope,
  values: Record<string, string>,
): FormFill {
  const accountId = formAccountId(scope);
  const condValues = valuesForAccount(values, accountId);
  const fields = template.mapping.fields.map((m): FieldState => {
    const key = fieldKey(m, template, accountId);
    const kind = sourceKind(m.source);
    const crmValue = kind === 'advisor' || kind === 'signer' ? undefined : resolvePath(m.source, scope);
    const edited = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    const value = edited ?? crmValue ?? '';
    const required = m.required && evaluateCondition(m.requiredWhen, scope, condValues);

    let origin: FieldOrigin;
    if (kind === 'signer') origin = 'signer';
    else if (edited !== undefined && edited !== '' && crmValue !== undefined && edited !== crmValue) origin = 'edited';
    else if (edited !== undefined && edited !== '' && crmValue === undefined) origin = 'advisor';
    else if (value) origin = kind === 'advisor' ? 'advisor' : (kind as FieldOrigin);
    else origin = 'missing';

    const missing = kind !== 'signer' && required && !value.trim();
    return {
      templateId: template.id,
      mapping: m,
      key,
      label: m.label ?? prettifyFieldName(m.pdfField),
      value,
      display: m.format === 'checkbox' ? value : formatValue(value, m.format, m.limits),
      origin,
      sourceLabel: describeSource(m.source),
      crmValue: origin === 'edited' ? crmValue : undefined,
      crmBaseline: crmValue ?? '',
      required,
      missing,
      // CRM values are checked too, so bad data already in D365 surfaces here.
      formatError: validateFormat(value, m.format, m.limits, scope.today),
    };
  });

  const relevant = fields.filter((f) => f.origin !== 'signer');
  return {
    template,
    account: scope.account,
    accountId: template.mapping.fields.some((m) => m.source.startsWith('account.')) ? accountId : scope.account?.accountid,
    fields,
    filledCount: relevant.filter((f) => f.value.trim()).length,
    requiredCount: relevant.filter((f) => f.required).length,
    missingCount: fields.filter((f) => f.missing).length,
  };
}

export interface PacketFillInput {
  template: FormTemplate;
  account?: Account;
}

export function prefillPacket(
  items: PacketFillInput[],
  scope: Omit<ResolveScope, 'account'>,
  values: Record<string, string>,
): FormFill[] {
  return items.map((it) => prefillForm(it.template, { ...scope, account: it.account }, values));
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
      if (f.origin === 'signer') continue;
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
