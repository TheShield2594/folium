import type { FormTemplate } from './types';

// Form feedback (`ev_formrequest`): "Ask Marketing to add it" requests for forms that
// aren't in the library, and problem reports on forms that are. Rows say which form,
// revision and fields, never what was typed in them: values may be client data.

export type FeedbackKind = 'request' | 'problem';

export type FeedbackCategory = 'wrongValue' | 'missingField' | 'layout' | 'outdated' | 'signature' | 'other';

export const FEEDBACK_CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: 'wrongValue', label: 'Wrong value or box' },
  { value: 'missingField', label: 'Missing field' },
  { value: 'layout', label: 'Layout or text overlap' },
  { value: 'outdated', label: 'Outdated revision' },
  { value: 'signature', label: 'Signer or signature placement' },
  { value: 'other', label: 'Something else' },
];

export type FeedbackStatus = 'new' | 'inProgress' | 'fixed' | 'wontFix' | 'duplicate';

export const FEEDBACK_STATUSES: { value: FeedbackStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'inProgress', label: 'In progress' },
  { value: 'fixed', label: 'Fixed in revision' },
  { value: 'wontFix', label: 'Won’t fix' },
  { value: 'duplicate', label: 'Duplicate' },
];

/** Statuses Marketing still has to act on. */
export const OPEN_STATUSES: FeedbackStatus[] = ['new', 'inProgress'];

/** Context that helps Marketing reproduce a problem. Allow-listed: no names, numbers or values. */
export interface FeedbackDetail {
  /** Form numbers of the other forms in the packet. */
  otherForms?: string[];
  /** The account type the form was about (e.g. "Roth IRA"). */
  accountType?: string;
  /** How the template's PDF was built. */
  pdfKind?: string;
}

export interface FormFeedback {
  id: string;
  kind: FeedbackKind;
  /** The form's name (as typed, for a request; the template's, for a problem). */
  name: string;
  issuer?: string;
  /** Problems: the template revision, with its number and revision copied onto the row. */
  templateId?: string;
  formNumber?: string;
  revision?: string;
  category?: FeedbackCategory;
  /** Problems: the PDF field names the advisor picked. */
  fieldKeys?: string[];
  note?: string;
  /** systemuser who sent it. Empty on rows from before it was a lookup. */
  requestedById?: string;
  /** Their name as shown. Old rows have only this. */
  requestedBy: string;
  createdOn: string;
  status: FeedbackStatus;
  resolution?: string;
  resolvedOn?: string;
  /** `fixed` ("Fixed in revision"): the template revision that fixes it. */
  fixedInTemplateId?: string;
  detail?: FeedbackDetail;
}

/** What the advisor fills in on "Ask Marketing for a form". */
export interface FormRequestInput {
  name: string;
  issuer?: string;
  note?: string;
}

/** What the advisor fills in on "Report a problem". */
export interface ProblemInput {
  category: FeedbackCategory;
  fieldKeys?: string[];
  note?: string;
  detail?: Record<string, unknown>;
}

const MAX_NOTE = 2000;

function cleanFeedbackDetail(d: Record<string, unknown> | undefined): FeedbackDetail | undefined {
  if (!d) return undefined;
  const out: FeedbackDetail = {};
  if (Array.isArray(d.otherForms)) {
    const forms = d.otherForms.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 20).map((x) => x.slice(0, 40));
    if (forms.length) out.otherForms = forms;
  }
  if (typeof d.accountType === 'string' && d.accountType) out.accountType = d.accountType.slice(0, 80);
  if (typeof d.pdfKind === 'string' && d.pdfKind) out.pdfKind = d.pdfKind.slice(0, 20);
  return Object.keys(out).length ? out : undefined;
}

type Reporter = { systemuserid: string; fullname: string };

/** A request for a form that isn't in the library. */
export function formRequest(input: FormRequestInput, by: Reporter, now: Date = new Date()): Omit<FormFeedback, 'id'> {
  return {
    kind: 'request',
    name: input.name.trim(),
    ...(input.issuer?.trim() ? { issuer: input.issuer.trim() } : {}),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, MAX_NOTE) } : {}),
    requestedById: by.systemuserid || undefined,
    requestedBy: by.fullname,
    createdOn: now.toISOString(),
    status: 'new',
  };
}

/**
 * A problem with a form in the library. Fields are named by PDF field, and only fields
 * the template maps are kept. The payload has no field values: there's nowhere to put one.
 */
export function problemReport(template: Pick<FormTemplate, 'id' | 'name' | 'formNumber' | 'revision' | 'issuer' | 'source' | 'mapping'>, input: ProblemInput, by: Reporter, now: Date = new Date()): Omit<FormFeedback, 'id'> {
  const known = new Set(template.mapping.fields.map((f) => f.pdfField));
  const fieldKeys = [...new Set(input.fieldKeys ?? [])].filter((k) => known.has(k)).slice(0, 20);
  const detail = cleanFeedbackDetail(input.detail);
  return {
    kind: 'problem',
    name: template.name,
    issuer: template.issuer ?? template.source,
    templateId: template.id,
    formNumber: template.formNumber,
    revision: template.revision,
    category: input.category,
    ...(fieldKeys.length ? { fieldKeys } : {}),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, MAX_NOTE) } : {}),
    requestedById: by.systemuserid || undefined,
    requestedBy: by.fullname,
    createdOn: now.toISOString(),
    status: 'new',
    ...(detail ? { detail } : {}),
  };
}

export const isOpen = (f: Pick<FormFeedback, 'status'>) => OPEN_STATUSES.includes(f.status);

/** Open problem reports per template ID, for the template library and editor. */
export function openProblemCounts(list: FormFeedback[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of list) if (f.kind === 'problem' && f.templateId && isOpen(f)) out.set(f.templateId, (out.get(f.templateId) ?? 0) + 1);
  return out;
}

export interface FeedbackFilter {
  kind?: FeedbackKind;
  /** `open`: new or in progress. */
  status?: FeedbackStatus | 'open';
  issuer?: string;
  /** Matches the form number or name, any case. */
  form?: string;
}

/** Newest first, narrowed by the admin's filters. */
export function filterFeedback(list: FormFeedback[], f: FeedbackFilter): FormFeedback[] {
  const q = f.form?.trim().toLowerCase();
  return list
    .filter((x) => !f.kind || x.kind === f.kind)
    .filter((x) => !f.status || (f.status === 'open' ? isOpen(x) : x.status === f.status))
    .filter((x) => !f.issuer || x.issuer === f.issuer)
    .filter((x) => !q || x.name.toLowerCase().includes(q) || (x.formNumber ?? '').toLowerCase().includes(q))
    .sort((a, b) => b.createdOn.localeCompare(a.createdOn));
}

/**
 * Set a new status. Closing it (fixed, won't fix, duplicate) stamps `resolvedOn`;
 * reopening clears it. `fixed` keeps the revision that fixes it.
 */
export function resolveFeedback(f: FormFeedback, status: FeedbackStatus, opts: { resolution?: string; fixedInTemplateId?: string } = {}, now: Date = new Date()): FormFeedback {
  const open = OPEN_STATUSES.includes(status);
  const resolution = opts.resolution?.trim() ? opts.resolution.trim().slice(0, MAX_NOTE) : undefined;
  const { resolvedOn: _r, fixedInTemplateId: _f, resolution: _n, ...rest } = f;
  return {
    ...rest,
    status,
    ...(resolution ? { resolution } : {}),
    ...(open ? {} : { resolvedOn: f.status === status && f.resolvedOn ? f.resolvedOn : now.toISOString() }),
    ...(status === 'fixed' && opts.fixedInTemplateId ? { fixedInTemplateId: opts.fixedInTemplateId } : {}),
  };
}

/** Reports of mine that Marketing closed since I last looked. */
export function newlyResolved(list: FormFeedback[], userId: string, seen: string[]): FormFeedback[] {
  return list.filter((f) => f.requestedById === userId && (f.status === 'fixed' || f.status === 'wontFix') && !seen.includes(`${f.id}:${f.status}`));
}

export const categoryLabel = (c?: FeedbackCategory) => FEEDBACK_CATEGORIES.find((x) => x.value === c)?.label ?? '';
export const statusLabel = (s: FeedbackStatus) => FEEDBACK_STATUSES.find((x) => x.value === s)?.label ?? s;
