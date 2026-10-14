import { prettifyFieldName } from './format';
import { sourceKind } from './paths';
import { copyScope, fieldKey, type FormFill } from './prefill';
import { diffRevision, latestLive } from './revisions';
import type { FieldMapping, FormTemplate, PacketItem, RequestDocument, SignatureRequest } from './types';

// Names for drafts and saved packets. Pure, so the clash rules are easy to test.

/** What a draft is called when the advisor doesn't name it. */
export function defaultDraftTitle(fills: Pick<FormFill, 'template'>[]): string {
  if (fills.length === 1) return fills[0].template.name;
  return `${fills[0]?.template.name ?? 'Forms'} + ${fills.length - 1} more`;
}

/** Trimmed, whitespace collapsed, case ignored: "IRA  Distribution " matches "ira distribution". */
export const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** The existing item a name clashes with, if any (`exceptId` is the item being renamed). */
export function findNameClash<T extends { id: string; name: string }>(name: string, existing: T[], exceptId?: string): T | undefined {
  const n = normalizeName(name);
  return n ? existing.find((x) => x.id !== exceptId && normalizeName(x.name) === n) : undefined;
}

/** "IRA distribution" → "IRA distribution (2)", or the next number not taken. */
export function nextFreeName(name: string, existingNames: string[]): string {
  const base = name.trim().replace(/\s+/g, ' ').replace(/\s*\(\d+\)$/, '');
  const taken = new Set(existingNames.map(normalizeName));
  if (!taken.has(normalizeName(base))) return base;
  for (let i = 2; ; i++) {
    const next = `${base} (${i})`;
    if (!taken.has(normalizeName(next))) return next;
  }
}

/** A short, stable tag for a draft, used in its SharePoint file names (8 characters of the row ID). */
export const shortDraftId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase();

// ---------------------------------------------------------------- Out-of-date drafts

/**
 * Where one saved form stands against the library today.
 * - `current`: still the revision advisors should use.
 * - `newer`: a later Live revision has taken over (or the saved one was retired or
 *   deleted and a Live revision of the form exists). Upgrading swaps to it.
 * - `retired`: retired with no Live successor. It has to be removed.
 * - `missing`: the template row is gone and no Live revision of the form number exists.
 */
export type DocFreshness = 'current' | 'newer' | 'retired' | 'missing';

export interface DocFreshnessRow {
  templateId: string;
  state: DocFreshness;
  /** The revision to upgrade to, for `newer`. */
  latest?: FormTemplate;
}

export interface DraftFreshness {
  /** `partial`: some forms changed; `outdated`: every form did. */
  state: 'current' | 'partial' | 'outdated';
  documents: DocFreshnessRow[];
  /** Forms that aren't current. */
  changed: number;
}

function docFreshness(templateId: string, formNumber: string | undefined, templates: FormTemplate[], on?: string): DocFreshnessRow {
  const t = templates.find((x) => x.id === templateId);
  const number = t?.formNumber ?? formNumber;
  const latest = number ? latestLive(templates, number, on) : undefined;
  if (!t) return latest ? { templateId, state: 'newer', latest } : { templateId, state: 'missing' };
  // A Live revision whose effective date is still ahead isn't "older" than the current one.
  if (latest && latest.id !== t.id && !(t.status === 'Live' && t.effectiveDate > latest.effectiveDate)) return { templateId, state: 'newer', latest };
  if (t.status === 'Retired') return { templateId, state: 'retired' };
  return { templateId, state: 'current' };
}

/** How a draft's forms compare with the library's current revisions. A future-dated revision isn't newer until its date. */
export function draftFreshness(req: Pick<SignatureRequest, 'documents'>, templates: FormTemplate[], on?: string): DraftFreshness {
  const documents = req.documents.map((d) => docFreshness(d.templateId, d.formNumber, templates, on));
  const changed = documents.filter((d) => d.state !== 'current').length;
  return { state: changed === 0 ? 'current' : changed === documents.length ? 'outdated' : 'partial', documents, changed };
}

/** What upgrading did, or would do, to one form. */
export interface FormUpgrade {
  /** The packet item, so Review can point at it. */
  itemId?: string;
  name: string;
  formNumber: string;
  from: string;
  /** The revision it moves to; undefined for `retired` and `missing`. */
  to?: string;
  state: Exclude<DocFreshness, 'current'>;
  /** Labels of entered values that carry over (renamed fields included). */
  carried: string[];
  /** Entered values whose field is gone in the new revision. They're discarded. */
  dropped: { label: string; value: string }[];
  /** Required fields new in this revision that nobody has filled yet. */
  newRequired: string[];
  /** Who signs changed, so the Send screen will reassign signers. */
  signersChanged: boolean;
}

export interface UpgradeReport {
  /** One entry per form that isn't current, in packet order. */
  forms: FormUpgrade[];
}

interface FormRef {
  templateId: string;
  formNumber?: string;
  name?: string;
  revision?: string;
  itemId?: string;
  copy?: number;
}

const labelOf = (m: FieldMapping) => m.label ?? prettifyFieldName(m.pdfField);
const roles = (t: FormTemplate) => [...new Set([...t.mapping.signers.map((s) => s.role), ...t.mapping.placements.map((p) => p.role)])].sort().join('|');

/**
 * Upgrade forms to their current revisions, carrying entered values across: a field the
 * new revision renamed (found the same way as the admin mapping editor, `diffRevision`)
 * moves its value to the new name. Keys from a CRM source or an explicit `key` don't
 * change. Values for fields the new revision dropped are reported, then discarded.
 */
function upgradeRefs(refs: FormRef[], values: Record<string, string>, templates: FormTemplate[], on?: string) {
  const next = { ...values };
  const forms: FormUpgrade[] = [];
  const swapped: (FormTemplate | undefined)[] = [];
  for (const ref of refs) {
    const f = docFreshness(ref.templateId, ref.formNumber, templates, on);
    const from = templates.find((t) => t.id === ref.templateId);
    const base = { itemId: ref.itemId, name: from?.name ?? ref.name ?? ref.formNumber ?? 'Form', formNumber: from?.formNumber ?? ref.formNumber ?? '', from: from?.revision ?? ref.revision ?? '' };
    const empty = { carried: [], dropped: [], newRequired: [], signersChanged: false };
    if (f.state === 'current') {
      swapped.push(undefined);
      continue;
    }
    if (f.state !== 'newer' || !f.latest) {
      swapped.push(undefined);
      forms.push({ ...base, state: f.state, ...empty });
      continue;
    }
    const to = f.latest;
    swapped.push(to);
    const report: FormUpgrade = { ...base, to: to.revision, state: 'newer', ...empty, signersChanged: !!from && roles(from) !== roles(to) };
    forms.push(report);
    // The template row is gone: nothing to compare fields with, so values stay as they are.
    if (!from) continue;
    const copyId = copyScope({ id: ref.itemId, copy: ref.copy });
    const keyIn = (m: FieldMapping, t: FormTemplate) => fieldKey(m, t, undefined, copyId);
    const newKeys = new Set(to.mapping.fields.map((m) => keyIn(m, to)));
    for (const row of diffRevision(from.mapping, to.mapping.fields.map((m) => m.pdfField))) {
      const newM = to.mapping.fields.find((m) => m.pdfField === row.pdfField);
      const oldM = row.change === 'renamed' ? from.mapping.fields.find((m) => m.pdfField === row.previousName) : row.change === 'new' ? undefined : from.mapping.fields.find((m) => m.pdfField === row.pdfField);
      if (row.change === 'new') {
        if (newM?.required && sourceKind(newM.source) === 'advisor' && !(keyIn(newM, to) in next)) report.newRequired.push(labelOf(newM));
        continue;
      }
      if (!oldM) continue;
      const a = keyIn(oldM, from);
      if (!(a in next)) continue;
      if (row.change === 'removed') {
        // Only the form's own entry goes (`FORM:field`). CRM overrides and explicit keys are shared with other forms.
        const own = !oldM.key && (sourceKind(oldM.source) === 'advisor' || sourceKind(oldM.source) === 'signer');
        if (own && !newKeys.has(a)) {
          report.dropped.push({ label: labelOf(oldM), value: next[a] });
          delete next[a];
        }
        continue;
      }
      const b = newM ? keyIn(newM, to) : a;
      if (a !== b) {
        if (!(b in next)) next[b] = next[a];
        delete next[a];
      }
      report.carried.push(labelOf(newM ?? oldM));
    }
  }
  return { swapped, values: next, report: { forms } };
}

/**
 * Move a draft's out-of-date forms to the current revisions, keeping each form's place,
 * account and copy. Retired forms with no successor and forms whose template is gone
 * stay in `documents` and in the report, so the advisor sees them; nothing is dropped
 * silently.
 */
export function upgradeDraft(req: Pick<SignatureRequest, 'documents' | 'values'>, templates: FormTemplate[], on?: string): { documents: RequestDocument[]; values: Record<string, string>; report: UpgradeReport } {
  const { swapped, values, report } = upgradeRefs(req.documents, req.values, templates, on);
  const documents = req.documents.map((d, i) => {
    const to = swapped[i];
    return to ? { ...d, templateId: to.id, name: to.name, formNumber: to.formNumber, revision: to.revision } : d;
  });
  return { documents, values, report };
}

/** The same upgrade for the packet open in Review. */
export function upgradePacketItems(items: PacketItem[], values: Record<string, string>, templates: FormTemplate[], on?: string): { items: PacketItem[]; values: Record<string, string>; report: UpgradeReport } {
  const refs = items.map((i) => ({ templateId: i.templateId, itemId: i.id, copy: i.copy, ...(i.missing ?? {}) }));
  const { swapped, values: next, report } = upgradeRefs(refs, values, templates, on);
  return { items: items.map((i, k) => (swapped[k] ? { ...i, templateId: swapped[k]!.id, missing: undefined } : i)), values: next, report };
}

/** One line per form, for the sheet and the audit trail. */
export function describeFormUpgrade(f: FormUpgrade): string {
  if (f.state === 'missing') return 'No longer in the library – remove it to continue';
  if (f.state === 'retired') return 'No longer available – remove it to continue';
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return [
    `Rev ${f.from} → ${f.to}`,
    f.carried.length ? `${n(f.carried.length, 'value', 'values')} carried` : '',
    f.newRequired.length ? n(f.newRequired.length, 'new required field', 'new required fields') : '',
    f.dropped.length ? `${n(f.dropped.length, 'value', 'values')} no longer used` : '',
    f.signersChanged ? 'signers changed' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The audit detail for an upgrade: the revision changes only. */
export function upgradeAuditDetail(report: UpgradeReport): string {
  return report.forms
    .filter((f) => f.state === 'newer')
    .map((f) => `${f.formNumber} Rev ${f.from} → ${f.to}`)
    .join('; ');
}
