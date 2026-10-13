import { formatValue, prettifyFieldName, validateFormat } from './format';
import { describeSource, evaluateCondition, resolvePath, sourceKind, type ResolveScope } from './paths';
import type { Account, FieldMapping, FormTemplate } from './types';

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
  required: boolean;
  missing: boolean;
  formatError?: string;
}

export interface FormFill {
  template: FormTemplate;
  account?: Account;
  fields: FieldState[];
  filledCount: number;
  requiredCount: number;
  missingCount: number;
}

/**
 * The canonical key for a field. Fields with the same key share one value across
 * every form in a packet — LaserApp's "enter once, use everywhere".
 */
export function fieldKey(m: FieldMapping, t: Pick<FormTemplate, 'formNumber'>): string {
  if (m.key) return m.key;
  const kind = sourceKind(m.source);
  if (kind === 'advisor' || kind === 'signer') return `${t.formNumber}:${m.pdfField}`;
  return m.source;
}

export function prefillForm(
  template: FormTemplate,
  scope: ResolveScope,
  values: Record<string, string>,
): FormFill {
  const fields = template.mapping.fields.map((m): FieldState => {
    const key = fieldKey(m, template);
    const kind = sourceKind(m.source);
    const crmValue = kind === 'advisor' || kind === 'signer' ? undefined : resolvePath(m.source, scope);
    const edited = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    const value = edited ?? crmValue ?? '';
    const required = m.required && evaluateCondition(m.requiredWhen, scope, values);

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
      display: m.format === 'checkbox' ? value : formatValue(value, m.format),
      origin,
      sourceLabel: describeSource(m.source),
      crmValue: origin === 'edited' ? crmValue : undefined,
      required,
      missing,
      formatError: validateFormat(value, m.format),
    };
  });

  const relevant = fields.filter((f) => f.origin !== 'signer');
  return {
    template,
    account: scope.account,
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
