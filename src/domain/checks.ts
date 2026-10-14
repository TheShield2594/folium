import { toNumber } from './format';
import { evaluateCondition, type ResolveScope } from './paths';
import { valuesForAccount, type FormFill } from './prefill';
import type { Check, FormTemplate } from './types';

export type CheckLevel = 'pass' | 'warn' | 'block';

export interface CheckResult {
  id: string;
  level: CheckLevel;
  title: string;
  detail?: string;
  templateId?: string;
  /** Field key to jump to when the advisor clicks the check. */
  fieldKey?: string;
}

export interface CheckContext {
  scope: Omit<ResolveScope, 'account'>;
  values: Record<string, string>;
  /** Latest Live revision for a form number, to catch stale drafts. */
  latestFor: (formNumber: string) => FormTemplate | undefined;
}

function valueOf(fill: FormFill, pdfField: string): string | undefined {
  return fill.fields.find((f) => f.mapping.pdfField === pdfField)?.value;
}

function keyOf(fill: FormFill, pdfField: string): string | undefined {
  return fill.fields.find((f) => f.mapping.pdfField === pdfField)?.key;
}

function runTemplateCheck(check: Check, fill: FormFill, ctx: CheckContext, idx: number): CheckResult {
  const t = fill.template;
  const id = `${t.id}:check:${idx}`;
  switch (check.type) {
    case 'sumEquals': {
      const filled = check.fields.filter((f) => (valueOf(fill, f) ?? '').trim() !== '');
      const total = check.fields.reduce((s, f) => s + toNumber(valueOf(fill, f)), 0);
      const ok = Math.abs(total - check.value) < 0.001;
      return {
        id,
        level: ok ? 'pass' : 'block',
        title: check.label ?? `Shares must total ${check.value}%`,
        detail: ok ? `${t.name}: totals ${total}%.` : `${t.name}: now ${total}%${filled.length ? '' : ' (nothing entered yet)'}.`,
        templateId: t.id,
        fieldKey: keyOf(fill, check.fields[0]),
      };
    }
    case 'requiredIf': {
      const applies = evaluateCondition(check.when, { ...ctx.scope, account: fill.account }, valuesForAccount(ctx.values, fill.account?.accountid ?? ctx.scope.client.accounts[0]?.accountid));
      const v = valueOf(fill, check.field);
      const ok = !applies || !!v?.trim();
      return {
        id,
        level: ok ? 'pass' : 'block',
        title: check.label ?? `${check.field} is required`,
        detail: `${t.name}`,
        templateId: t.id,
        fieldKey: keyOf(fill, check.field),
      };
    }
    case 'oneOf': {
      const n = check.fields.filter((f) => !!valueOf(fill, f)?.trim() && valueOf(fill, f) !== 'false').length;
      return {
        id,
        level: n === 1 ? 'pass' : 'block',
        title: check.label ?? 'Choose exactly one option',
        detail: `${t.name}: ${n === 0 ? 'none chosen' : n === 1 ? 'one chosen' : `${n} chosen`}.`,
        templateId: t.id,
        fieldKey: keyOf(fill, check.fields[0]),
      };
    }
    case 'pattern': {
      const v = valueOf(fill, check.field) ?? '';
      let re: RegExp;
      try {
        re = new RegExp(check.pattern);
      } catch {
        // A typo in an admin-authored rule shouldn't break review; flag it instead.
        return { id, level: 'warn', title: `${check.label ?? check.field}: rule can’t be checked`, detail: `${t.name}: the template’s pattern is invalid. Ask an administrator to fix it.`, templateId: t.id };
      }
      const ok = !v || re.test(v);
      return { id, level: ok ? 'pass' : 'block', title: check.label ?? `${check.field} format`, detail: t.name, templateId: t.id, fieldKey: keyOf(fill, check.field) };
    }
  }
}

/** Pre-send checks ("not in good order" catches) for a whole packet. */
export function runChecks(fills: FormFill[], ctx: CheckContext): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. Every form is the current revision in the SharePoint library.
  const stale = fills.filter((f) => {
    const latest = ctx.latestFor(f.template.formNumber);
    return f.template.status === 'Retired' || (latest && latest.id !== f.template.id);
  });
  results.push({
    id: 'current-revisions',
    level: stale.length ? 'block' : 'pass',
    title: stale.length ? `${stale.length} form${stale.length > 1 ? 's are' : ' is'} out of date` : 'Every form is the current version',
    detail: stale.length ? stale.map((s) => `${s.template.name} (${s.template.revision})`).join(', ') : 'Checked against the Marketing library in SharePoint.',
    templateId: stale[0]?.template.id,
  });

  // 2. Required fields.
  for (const fill of fills) {
    const missing = fill.fields.filter((f) => f.missing);
    if (missing.length) {
      results.push({
        id: `${fill.template.id}:required`,
        level: 'block',
        title: `${missing.length} required field${missing.length > 1 ? 's' : ''} on ${fill.template.name}`,
        detail: missing.map((m) => m.label).join(', '),
        templateId: fill.template.id,
        fieldKey: missing[0].key,
      });
    }
  }
  if (!results.some((r) => r.id.endsWith(':required'))) {
    results.push({ id: 'required', level: 'pass', title: 'All required fields are filled' });
  }

  // 3. Field formats.
  const badFormat = fills.flatMap((f) => f.fields.filter((x) => x.formatError && x.value));
  const seen = new Set<string>();
  for (const f of badFormat) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    results.push({ id: `format:${f.key}`, level: 'block', title: `${f.label}: ${f.formatError}`, templateId: f.templateId, fieldKey: f.key });
  }

  // 4. Template-specific rules (beneficiary totals, etc.).
  fills.forEach((fill) => fill.template.mapping.checks.forEach((c, i) => results.push(runTemplateCheck(c, fill, ctx, i))));

  // 5. Flat / XFA PDFs need overlay fields before they can be filled.
  for (const fill of fills) {
    if (fill.template.pdfKind !== 'fillable') {
      results.push({
        id: `${fill.template.id}:kind`,
        level: 'warn',
        title: `${fill.template.name} is a ${fill.template.pdfKind === 'xfa' ? 'XFA' : 'scanned'} PDF`,
        detail: 'Values are drawn on as overlay text. Look it over before sending.',
        templateId: fill.template.id,
      });
    }
  }

  return results;
}

export function summarize(results: CheckResult[]) {
  return {
    blocking: results.filter((r) => r.level === 'block').length,
    warnings: results.filter((r) => r.level === 'warn').length,
    passed: results.filter((r) => r.level === 'pass').length,
  };
}
