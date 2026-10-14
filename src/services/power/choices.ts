import type { ChoiceColumn } from './config';

// Dataverse returns choice columns as option numbers (2), with the display label
// only in a `@OData.Community.Display.V1.FormattedValue` annotation. Folium's domain
// works in words ('married'), so rows are decoded on the way in and changes encoded
// on the way out. See CHOICES in config.ts.

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

/** Column name → what Dataverse showed for an option Folium has no mapping for. */
export type Unrecognised = Record<string, { label: string; value: string }>;

/**
 * Replace mapped option numbers with their domain words. An option with no mapping
 * is dropped from the row (so no rule matches on a raw number), logged, and listed
 * under `unrecognisedChoices` for the screen to flag.
 */
export function decodeChoices<T extends Record<string, unknown>>(row: T, columns: Record<string, ChoiceColumn>, table: string): T {
  const out: Record<string, unknown> = { ...row };
  const unrecognised: Unrecognised = {};
  for (const [col, def] of Object.entries(columns)) {
    const raw = row[col];
    if (raw === undefined || raw === null || raw === '') continue;
    const word = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? def.options[Number(raw)] : Object.values(def.options).includes(String(raw)) ? String(raw) : undefined;
    if (word !== undefined) {
      out[col] = word;
      continue;
    }
    const shown = String(row[`${col}${FORMATTED}`] ?? raw);
    console.warn(`Folium: ${table}.${col} = ${String(raw)} (${shown}) has no mapping in CHOICES; add it to src/services/power/config.ts.`);
    delete out[col];
    unrecognised[col] = { label: def.label, value: shown };
  }
  if (Object.keys(unrecognised).length) out.unrecognisedChoices = unrecognised;
  return out as T;
}

/** Turn domain words in a change set back into option numbers. Empty clears the column. */
export function encodeChoices<T extends Record<string, unknown>>(changes: T, columns: Record<string, ChoiceColumn>, table: string): Record<string, unknown> {
  const { unrecognisedChoices: _u, ...out } = changes as Record<string, unknown>;
  for (const [col, def] of Object.entries(columns)) {
    if (!(col in out)) continue;
    const word = out[col];
    if (word === undefined || word === null || word === '') {
      out[col] = null;
      continue;
    }
    const entry = Object.entries(def.options).find(([, w]) => w === word);
    if (!entry) throw new Error(`${def.label} “${String(word)}” isn’t a ${table} option Folium knows.`);
    out[col] = Number(entry[0]);
  }
  return out;
}
