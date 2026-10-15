import type { FirmProfile, FormTemplate, UserGroup, UserProfile } from './types';

// Firm profiles (#26). Everence forms come from several legal entities (the trust
// company, Everence Financial, Praxis…), each with its own name, address and numbers.
// Each entity is a profile; a form's `firm.*` fields fill from the profile for the
// entity that issues it. One profile is the default: it fills forms nothing else
// claims, and it carries the firm-wide settings (sending defaults, idle auto-save,
// the reports link) that predate profiles.

/** The id the profile from before profiles existed (the single "Firm" row) loads with. */
export const DEFAULT_FIRM_ID = 'firm-default';

/** Settings on a profile that are firm-wide, not per entity: they live on the default profile. */
export const FIRM_WIDE_KEYS = ['blockFillableWhenIncomplete', 'idleAutoSave', 'idleAutoSaveMinutes', 'sending', 'reportsUrl'] as const satisfies readonly (keyof FirmProfile)[];

/** The issuer a template's firm is matched on: its issuer, else its source ("Praxis"). */
export const templateIssuer = (t: Pick<FormTemplate, 'issuer' | 'source'>) => t.issuer?.trim() || t.source;

const sameIssuer = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The default profile: the one marked default, else the first. Undefined only when there are none. */
export function defaultFirm(firms: FirmProfile[]): FirmProfile | undefined {
  return firms.find((f) => f.isDefault) ?? firms[0];
}

/**
 * Profiles as stored, made whole: each has an id and an issuer list, and exactly one is
 * the default. The profile saved before profiles existed (no id) becomes the default
 * with no issuers, so nothing changes until an admin adds a second profile.
 */
export function normalizeFirms(rows: Partial<FirmProfile>[]): FirmProfile[] {
  const firms = rows.map((r, i): FirmProfile => ({
    ...(r as FirmProfile),
    id: r.id || (i === 0 ? DEFAULT_FIRM_ID : `firm-${i + 1}`),
    issuers: Array.isArray(r.issuers) ? r.issuers.filter((x) => typeof x === 'string' && x.trim()) : [],
  }));
  const def = firms.find((f) => f.isDefault) ?? firms.find((f) => f.id === DEFAULT_FIRM_ID) ?? firms[0];
  return firms.map((f) => ({ ...f, isDefault: f === def }));
}

/**
 * The profile a form's `firm.*` fields fill from:
 * 1. the template's explicit `firmId`
 * 2. a profile whose issuers include the template's issuer
 * 3. the group's `defaultFirmId`
 * 4. the default profile
 * An id that names no profile (one since removed) is passed over.
 */
export function firmFor(
  template: Pick<FormTemplate, 'firmId' | 'issuer' | 'source'>,
  firms: FirmProfile[],
  group?: Pick<UserGroup, 'defaultFirmId'>,
): FirmProfile | undefined {
  if (!firms.length) return undefined;
  const byId = (id?: string) => (id ? firms.find((f) => f.id === id) : undefined);
  const issuer = templateIssuer(template);
  return byId(template.firmId) ?? firms.find((f) => f.issuers.some((i) => sameIssuer(i, issuer))) ?? byId(group?.defaultFirmId) ?? defaultFirm(firms);
}

/** Why a template gets its profile, in the template editor's words. */
export function firmReason(template: Pick<FormTemplate, 'firmId' | 'issuer' | 'source'>, firms: FirmProfile[]): 'override' | 'issuer' | 'default' | undefined {
  if (!firms.length) return undefined;
  if (template.firmId && firms.some((f) => f.id === template.firmId)) return 'override';
  const issuer = templateIssuer(template);
  return firms.some((f) => f.issuers.some((i) => sameIssuer(i, issuer))) ? 'issuer' : 'default';
}

/** The first of this person's groups that names a default profile, for `firmFor`. */
export function firmGroup(user: Pick<UserProfile, 'systemuserid'> | undefined, groups: UserGroup[]): UserGroup | undefined {
  if (!user) return undefined;
  return groups.find((g) => g.memberIds.includes(user.systemuserid) && !!g.defaultFirmId);
}

/** Every issuer the library uses, for a profile's "Issuers" picker, sorted. */
export function templateIssuers(templates: Pick<FormTemplate, 'issuer' | 'source'>[]): string[] {
  const out = new Map<string, string>();
  for (const t of templates) {
    const i = templateIssuer(t);
    if (!out.has(i.toLowerCase())) out.set(i.toLowerCase(), i);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}

/** Current templates whose `firm.*` fields fill from this profile (ignoring any group default). */
export function templatesUsing<T extends Pick<FormTemplate, 'firmId' | 'issuer' | 'source'>>(firm: FirmProfile, templates: T[], firms: FirmProfile[]): T[] {
  return templates.filter((t) => firmFor(t, firms)?.id === firm.id);
}

/**
 * The disclosure an envelope carries: the default profile's, then any other profile's
 * in the packet that says something different, each once. (Compliance to confirm the
 * rule for an envelope that mixes entities.)
 */
export function envelopeDisclosure(def: Pick<FirmProfile, 'disclosure'> | undefined, packetFirms: (Pick<FirmProfile, 'disclosure'> | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [def, ...packetFirms]) {
    const d = f?.disclosure?.trim();
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out.join('\n\n');
}

/**
 * Make `id` the default profile. The firm-wide settings move with it, so changing which
 * entity is the default never changes how Folium behaves.
 */
export function setDefaultFirm(firms: FirmProfile[], id: string): FirmProfile[] {
  const from = defaultFirm(firms);
  if (!firms.some((f) => f.id === id) || from?.id === id) return firms;
  const wide = Object.fromEntries(FIRM_WIDE_KEYS.map((k) => [k, from?.[k]]));
  const cleared = Object.fromEntries(FIRM_WIDE_KEYS.map((k) => [k, undefined]));
  return firms.map((f) => (f.id === id ? { ...f, ...wide, isDefault: true } : { ...f, ...cleared, isDefault: false }));
}

/** A new, empty profile for "Add profile". */
export function blankFirm(id: string): FirmProfile {
  return { id, name: '', legalName: '', address1: '', city: '', state: '', zip: '', phone: '', website: '', brokerDealer: '', crd: '', disclosure: '', issuers: [] };
}

/** What's wrong with a profile before it's saved. Empty when it can be saved. */
export function firmProblems(f: FirmProfile, firms: FirmProfile[]): Partial<Record<'name' | 'issuers', string>> {
  const out: ReturnType<typeof firmProblems> = {};
  if (!f.name.trim()) out.name = 'Give the profile a name.';
  else if (firms.some((x) => x.id !== f.id && x.name.trim().toLowerCase() === f.name.trim().toLowerCase())) out.name = 'Another profile has this name.';
  const taken = f.issuers.filter((i) => firms.some((x) => x.id !== f.id && x.issuers.some((j) => sameIssuer(i, j))));
  if (taken.length) out.issuers = `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already on another profile. An issuer can be on one profile only.`;
  return out;
}

/** The value key of a `firm.*` field on a form that fills from a profile other than the default. */
export const firmKey = (firmId: string, attr: string) => `firm[${firmId}].${attr}`;
