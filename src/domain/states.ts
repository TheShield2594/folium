import type { FormTemplate } from './types';

// Where a form may be used. Carriers often approve a form only in some states, or
// publish one version per state. Laser App filters these out of the catalog silently;
// Folium keeps them findable and says why they don't fit.

/** USPS codes for the 50 states and DC, in order. */
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

const CODES = new Set<string>(US_STATES);

const NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/**
 * A USPS code for what Dynamics holds in a state column: a code in any case ("in") or
 * a full name ("Indiana"). Undefined when it isn't a US state.
 */
export function normalizeState(v: string | undefined): string | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  if (CODES.has(s.toUpperCase())) return s.toUpperCase();
  return NAMES[s.toLowerCase().replace(/\s+/g, ' ')];
}

/** Whether a form may be used in a state. No states on the form means every state; no state means we can't tell, so yes. */
export function availableIn(t: Pick<FormTemplate, 'states'>, state: string | undefined): boolean {
  if (!t.states?.length) return true;
  const s = normalizeState(state);
  return !s || t.states.includes(s);
}

/** "AZ, CO, GA" or "All states", for labels. Long lists are cut: "AZ, CO, GA and 12 more". */
export function describeStates(states: string[] | undefined, max = 8): string {
  if (!states?.length) return 'All states';
  if (states.length <= max) return states.join(', ');
  return `${states.slice(0, max).join(', ')} and ${states.length - max} more`;
}

/**
 * The states a carrier's form title lists, as in "Adv Select App [AZ-CO-GA-WV]" or
 * "Annuity disclosure (AZ, CO)". Only groups made entirely of real USPS codes count, so
 * "(IRA)" or "[NEW]" are ignored. Sorted in US_STATES order, without repeats.
 */
export function parseStatesFromTitle(name: string): string[] {
  const found = new Set<string>();
  for (const m of name.matchAll(/[[(]([^\])]+)[\])]/g)) {
    const parts = m[1].split(/[\s,;/-]+/).filter(Boolean);
    // Capitals only: lower-case "in" or "or" are English words, not codes.
    if (parts.length && parts.every((p) => /^[A-Z]{2}$/.test(p) && CODES.has(p))) parts.forEach((p) => found.add(p));
  }
  return US_STATES.filter((s) => found.has(s));
}

/**
 * The version of a form for a state, from templates sharing a variant group: the one
 * approved there, preferring a version limited to that state over one for every state.
 * Undefined when no version fits (or the group has no templates).
 */
export function pickVariant<T extends Pick<FormTemplate, 'variantGroup' | 'states'>>(templates: T[], variantGroup: string, state: string | undefined): T | undefined {
  const group = templates.filter((t) => t.variantGroup === variantGroup);
  const s = normalizeState(state);
  if (!s) return undefined;
  return group.find((t) => t.states?.includes(s)) ?? group.find((t) => !t.states?.length);
}
