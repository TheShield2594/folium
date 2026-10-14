import type { FormFill } from './prefill';

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
