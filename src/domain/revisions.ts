import type { FieldMapping, FormTemplate, TemplateMapping } from './types';

export type FieldChange = 'unchanged' | 'new' | 'renamed' | 'removed';

export interface FieldDiffRow {
  pdfField: string;
  change: FieldChange;
  /** For renamed fields, the old name. */
  previousName?: string;
  /** Mapping carried over from the previous revision, when there is one. */
  mapping?: FieldMapping;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const tokens = (s: string) =>
  new Set(
    s
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/**
 * Similarity from 0 to 1: the better of edit distance on the normalised name and word
 * overlap, so reordered names (`Owner_Name_Full` → `Owner_FullName`) still match.
 */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / (new Set([...ta, ...tb]).size || 1);
  return Math.max(jaccard, editSimilarity(a, b));
}

function editSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x.length && !y.length) return 1;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[x.length][y.length] / Math.max(x.length, y.length);
}

/**
 * Compare the PDF field names of a new revision to the previous revision's mapping.
 * Unchanged names carry their mapping over; close matches are offered as renames;
 * everything else is flagged so a person maps it before the revision goes live.
 */
export function diffRevision(previous: TemplateMapping | undefined, newFieldNames: string[], threshold = 0.72): FieldDiffRow[] {
  const prevFields = previous?.fields ?? [];
  const prevByName = new Map(prevFields.map((f) => [f.pdfField, f]));
  const newSet = new Set(newFieldNames);
  const rows: FieldDiffRow[] = [];

  const unmatchedPrev = prevFields.filter((f) => !newSet.has(f.pdfField));
  const claimed = new Set<string>();

  for (const name of newFieldNames) {
    const same = prevByName.get(name);
    if (same) {
      rows.push({ pdfField: name, change: 'unchanged', mapping: same });
      continue;
    }
    let best: FieldMapping | undefined;
    let bestScore = 0;
    for (const p of unmatchedPrev) {
      if (claimed.has(p.pdfField)) continue;
      const s = similarity(p.pdfField, name);
      if (s > bestScore) {
        best = p;
        bestScore = s;
      }
    }
    if (best && bestScore >= threshold) {
      claimed.add(best.pdfField);
      rows.push({ pdfField: name, change: 'renamed', previousName: best.pdfField, mapping: { ...best, pdfField: name } });
    } else {
      rows.push({ pdfField: name, change: 'new' });
    }
  }

  for (const p of unmatchedPrev) {
    if (!claimed.has(p.pdfField)) rows.push({ pdfField: p.pdfField, change: 'removed', mapping: p });
  }
  return rows;
}

/** Build a draft mapping for the new revision from a diff, keeping signers/placements/checks. */
export function carryForward(previous: TemplateMapping | undefined, rows: FieldDiffRow[], revision: string, formNumber: string): TemplateMapping {
  const liveNames = new Set(rows.filter((r) => r.change !== 'removed').map((r) => r.pdfField));
  // Checks name PDF fields; follow renames so a rule survives its field being renamed.
  const renamed = new Map(rows.filter((r) => r.change === 'renamed' && r.previousName).map((r) => [r.previousName!, r.pdfField]));
  const rename = (f: string) => renamed.get(f) ?? f;
  return {
    formNumber,
    revision,
    fields: rows
      .filter((r) => r.change !== 'removed')
      .map((r) => r.mapping ?? { pdfField: r.pdfField, source: 'advisor', required: false }),
    signers: previous?.signers ?? [{ role: 'Owner' }],
    placements: previous?.placements ?? [],
    checks: (previous?.checks ?? [])
      .map((c) => ('fields' in c ? { ...c, fields: c.fields.map(rename) } : { ...c, field: rename(c.field) }))
      .filter((c) => ('fields' in c ? c.fields.every((f) => liveNames.has(f)) : liveNames.has(c.field))),
  };
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The revision advisors should use for a form number: the Live revision with the
 * latest effective date that has arrived. A revision published with a future
 * effective date takes over automatically on that day.
 */
export function latestLive(templates: FormTemplate[], formNumber: string, on = today()) {
  return templates
    .filter((t) => t.formNumber === formNumber && t.status === 'Live' && t.effectiveDate <= on)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
}

/** One current revision per form number. */
export function currentTemplates(templates: FormTemplate[], on = today()): FormTemplate[] {
  const nums = [...new Set(templates.map((t) => t.formNumber))];
  return nums.map((n) => latestLive(templates, n, on)).filter((t): t is FormTemplate => !!t);
}
