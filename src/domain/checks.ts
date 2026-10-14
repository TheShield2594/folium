import { fitsBox } from '../pdf/layout';
import { toNumber } from './format';
import { evaluateCondition, type ResolveScope } from './paths';
import { copyScope, valuesForAccount, type FormFill } from './prefill';
import type { Check, FormTemplate } from './types';

export type CheckLevel = 'pass' | 'warn' | 'block';

export interface CheckResult {
  id: string;
  level: CheckLevel;
  title: string;
  detail?: string;
  templateId?: string;
  /** The packet item (form instance) the check is about, when it's about one form. */
  itemId?: string;
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

function displayOf(fill: FormFill, pdfField: string): string {
  return fill.fields.find((f) => f.mapping.pdfField === pdfField)?.display ?? '';
}

function lockedOn(fill: FormFill, pdfField: string): boolean {
  return !!fill.fields.find((f) => f.mapping.pdfField === pdfField)?.locked;
}

function keyOf(fill: FormFill, pdfField: string): string | undefined {
  return fill.fields.find((f) => f.mapping.pdfField === pdfField)?.key;
}

function runTemplateCheck(check: Check, fill: FormFill, ctx: CheckContext, idx: number): CheckResult {
  const t = fill.template;
  const id = `${fill.itemId}:check:${idx}`;
  const at = { templateId: t.id, itemId: fill.itemId };
  const name = formLabel(fill);
  switch (check.type) {
    case 'sumEquals': {
      const filled = check.fields.filter((f) => (valueOf(fill, f) ?? '').trim() !== '');
      const total = check.fields.reduce((s, f) => s + toNumber(valueOf(fill, f)), 0);
      const ok = Math.abs(total - check.value) < 0.001;
      return {
        id,
        level: ok ? 'pass' : 'block',
        title: check.label ?? `Shares must total ${check.value}%`,
        detail: ok ? `${name}: totals ${total}%.` : `${name}: now ${total}%${filled.length ? '' : ' (nothing entered yet)'}.`,
        ...at,
        fieldKey: keyOf(fill, check.fields[0]),
      };
    }
    case 'requiredIf': {
      const applies = evaluateCondition(check.when, { ...ctx.scope, account: fill.account }, valuesForAccount(ctx.values, fill.account?.accountid ?? ctx.scope.client.accounts[0]?.accountid, copyScope({ id: fill.itemId, copy: fill.copy })));
      const v = valueOf(fill, check.field);
      // A locked field prints blank by design, so it can't be required.
      const ok = !applies || lockedOn(fill, check.field) || !!v?.trim();
      return {
        id,
        level: ok ? 'pass' : 'block',
        title: check.label ?? `${check.field} is required`,
        detail: `${name}`,
        ...at,
        fieldKey: keyOf(fill, check.field),
      };
    }
    case 'oneOf': {
      // `display` is what prints: a box mapped with `checkedWhen` holds the CRM word as its value.
      const n = check.fields.filter((f) => !!displayOf(fill, f).trim() && displayOf(fill, f) !== 'false').length;
      return {
        id,
        level: n === 1 ? 'pass' : 'block',
        title: check.label ?? 'Choose exactly one option',
        detail: `${name}: ${n === 0 ? 'none chosen' : n === 1 ? 'one chosen' : `${n} chosen`}.`,
        ...at,
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
        return { id, level: 'warn', title: `${check.label ?? check.field}: rule can’t be checked`, detail: `${name}: the template’s pattern is invalid. Ask an administrator to fix it.`, ...at };
      }
      const ok = !v || re.test(v);
      return { id, level: ok ? 'pass' : 'block', title: check.label ?? `${check.field} format`, detail: name, ...at, fieldKey: keyOf(fill, check.field) };
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
        id: `${fill.itemId}:required`,
        level: 'block',
        title: `${missing.length} required field${missing.length > 1 ? 's' : ''} on ${formLabel(fill)}`,
        detail: missing.map((m) => m.label).join(', '),
        templateId: fill.template.id,
        itemId: fill.itemId,
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
    results.push({ id: `format:${f.key}`, level: 'block', title: `${f.label}: ${f.formatError}`, templateId: f.templateId, itemId: f.itemId, fieldKey: f.key });
  }

  // 4. Template-specific rules (beneficiary totals, etc.).
  fills.forEach((fill) => fill.template.mapping.checks.forEach((c, i) => results.push(runTemplateCheck(c, fill, ctx, i))));

  // 5. Flat / XFA PDFs need overlay fields before they can be filled.
  for (const fill of fills) {
    if (fill.template.pdfKind !== 'fillable') {
      // Overlay text shrinks to fit; past 6pt it runs out of the box. Warn, don't block:
      // the advisor may know the carrier accepts it.
      for (const f of fill.fields) {
        const r = f.mapping.rect;
        if (!r || f.origin === 'signer' || !f.display || f.mapping.format === 'checkbox' || fitsBox(f.display, r)) continue;
        results.push({ id: `${fill.itemId}:fit:${f.key}`, level: 'warn', title: `${f.label}: may not fit on the form`, detail: `${formLabel(fill)}. Shorten it if the carrier is strict.`, templateId: fill.template.id, itemId: fill.itemId, fieldKey: f.key });
      }
      results.push({
        id: `${fill.itemId}:kind`,
        level: 'warn',
        title: `${formLabel(fill)} is a ${fill.template.pdfKind === 'xfa' ? 'XFA' : 'scanned'} PDF`,
        detail: 'Values are drawn on as overlay text. Look it over before sending.',
        templateId: fill.template.id,
        itemId: fill.itemId,
      });
    }
  }

  // 6. Two copies of one form about the same account is almost always a slip.
  const byForm = new Map<string, FormFill[]>();
  for (const f of fills) if (f.accountId) byForm.set(`${f.template.id}|${f.accountId}`, [...(byForm.get(`${f.template.id}|${f.accountId}`) ?? []), f]);
  for (const [k, same] of byForm) {
    if (same.length < 2) continue;
    const account = ctx.scope.client.accounts.find((a) => a.accountid === same[0].accountId);
    results.push({
      id: `same-account:${k}`,
      level: 'warn',
      title: `${same.length} copies of ${same[0].template.name} are about the same account`,
      detail: `${account ? `${account.name} · ${account.ev_accountno}` : 'One account'}. Pick a different account for each copy if that’s not intended.`,
      templateId: same[1].template.id,
      itemId: same[1].itemId,
    });
  }

  return results;
}

/** A form's name as the packet shows it, with "(copy 2)" on an added copy. */
export function formLabel(fill: Pick<FormFill, 'template' | 'copy'>): string {
  return fill.copy ? `${fill.template.name} (copy ${fill.copy})` : fill.template.name;
}

export function summarize(results: CheckResult[]) {
  return {
    blocking: results.filter((r) => r.level === 'block').length,
    warnings: results.filter((r) => r.level === 'warn').length,
    passed: results.filter((r) => r.level === 'pass').length,
  };
}

export type OutputMode = 'send' | 'flatten' | 'print' | 'fillable' | 'draft';

export interface OutputGate {
  allowed: boolean;
  /** The blocking checks, in the order review lists them. */
  blockers: CheckResult[];
  /** Stamp "DRAFT — NOT FOR SIGNATURE" on the output. */
  draftMark: boolean;
}

/**
 * Whether a packet may leave Folium in a given form. Anything a client could sign
 * (send, flattened PDF, print) needs every blocking check cleared. The editable PDF
 * stays available so an advisor can finish a form by hand, but carries the draft mark
 * while checks are open, unless the firm opts into blocking it too. Drafts are always
 * allowed and always marked. Warnings never block.
 */
export function outputGate(results: CheckResult[], mode: OutputMode, opts: { blockFillable?: boolean } = {}): OutputGate {
  const blockers = results.filter((r) => r.level === 'block');
  const open = blockers.length > 0;
  switch (mode) {
    case 'draft':
      return { allowed: true, blockers, draftMark: true };
    case 'fillable':
      return { allowed: !(open && opts.blockFillable), blockers, draftMark: open };
    default:
      return { allowed: !open, blockers, draftMark: false };
  }
}
