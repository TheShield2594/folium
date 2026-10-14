import type { Advisor, FirmPolicy, OfficeAddress, RepDataChange, UserProfile } from './types';

// The advisor details forms print (`rep.*`): directory first, Folium profile on top.
//
// Name, middle name, email, phones and title come from the advisor's `systemuser` row
// (synced from Entra ID), so they stay current when IT updates the directory. A value
// saved in Folium overrides the directory only while it differs from it, and a blank
// one never hides it. The office address, extension and email on forms are set in
// Folium only. Rep, OSJ and RIA numbers live only in the Folium profile too, and only
// an Admin sets them.

/** Advisor fields the directory can supply. */
export const DIRECTORY_FIELDS = ['middleName', 'email', 'phone', 'fax', 'mobile', 'title'] as const;
export type DirectoryField = (typeof DIRECTORY_FIELDS)[number];

/** What the directory holds for one person (the `systemuser` row). */
export interface DirectoryUser extends Partial<Pick<Advisor, DirectoryField>> {
  systemuserid: string;
  fullname: string;
  /** `systemuser.isdisabled`: the account is turned off (usually: they've left). */
  disabled?: boolean;
}

/** Compliance identifiers: Admin-only, even for people allowed to edit their own rep data. */
export const REP_IDENTIFIERS = ['repCode', 'osjNumber', 'riaNumber'] as const;

/** Everything about an advisor that prints on forms, with the label Settings and the audit list use. */
export const REP_FIELDS: { field: keyof Advisor; label: string }[] = [
  { field: 'middleName', label: 'Middle name' },
  { field: 'title', label: 'Title' },
  { field: 'email', label: 'Email' },
  { field: 'formEmail', label: 'Email on forms' },
  { field: 'phone', label: 'Phone' },
  { field: 'phoneExt', label: 'Extension' },
  { field: 'mobile', label: 'Mobile' },
  { field: 'fax', label: 'Fax' },
  { field: 'office', label: 'Office address' },
  { field: 'branch', label: 'Branch' },
  { field: 'repCode', label: 'Rep code' },
  { field: 'osjNumber', label: 'OSJ number' },
  { field: 'riaNumber', label: 'RIA number' },
];

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (typeof v === 'object' && !(v as OfficeAddress).line1?.trim());
const same = (a: unknown, b: unknown) => (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);

/** A `systemuser` row as a DirectoryUser. */
export function fromSystemUser(row: Record<string, unknown>): DirectoryUser {
  const s = (k: string) => (typeof row[k] === 'string' && (row[k] as string).trim() ? (row[k] as string).trim() : undefined);
  const out: DirectoryUser = {
    systemuserid: String(row.systemuserid ?? ''),
    fullname: s('fullname') ?? '',
    middleName: s('middlename'),
    email: s('internalemailaddress'),
    phone: s('address1_telephone1'),
    fax: s('address1_fax'),
    mobile: s('mobilephone'),
    title: s('title'),
    disabled: row.isdisabled === true || row.isdisabled === 1 || row.isdisabled === 'true' ? true : undefined,
  };
  for (const k of Object.keys(out) as (keyof DirectoryUser)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** The `systemuser` columns `fromSystemUser` reads. */
export const SYSTEMUSER_COLUMNS = [
  'systemuserid',
  'fullname',
  'middlename',
  'internalemailaddress',
  'address1_telephone1',
  'address1_fax',
  'mobilephone',
  'title',
  'isdisabled',
];

/**
 * The advisor a form uses: the saved profile, with the directory filling every field
 * the profile leaves blank. The result keeps the directory values (`directory`) so
 * Settings can say where each value came from and reset an override.
 */
export function mergeAdvisor(directory: DirectoryUser | undefined, saved: UserProfile): UserProfile {
  if (!directory) return saved;
  const out: UserProfile = { ...saved, fullname: directory.fullname || saved.fullname, directory: { ...directory } };
  for (const f of DIRECTORY_FIELDS) {
    if (!blank(saved[f]) || blank(directory[f])) continue;
    (out as unknown as Record<string, unknown>)[f] = directory[f];
  }
  if (directory.disabled) out.disabled = true;
  return out;
}

/** Where a field's value comes from: the directory, or set in Folium over (or without) it. */
export function fieldOrigin(u: UserProfile, f: DirectoryField): 'directory' | 'override' | 'folium' | undefined {
  const d = u.directory?.[f];
  if (blank(u[f])) return undefined;
  if (blank(d)) return 'folium';
  return same(u[f], d) ? 'directory' : 'override';
}

/**
 * The profile as stored in `ev_foliumprofile`: values equal to the directory's are
 * dropped (the directory supplies them, and keeps them current), as are the read-only
 * extras the services add when loading.
 */
export function profileToSave(u: UserProfile): UserProfile {
  const { directory, disabled: _d, active: _a, ...out } = u;
  if (directory) {
    for (const f of DIRECTORY_FIELDS) {
      if (same(out[f], directory[f]) || blank(out[f])) {
        if (f === 'email' || f === 'phone' || f === 'title') out[f] = '';
        else delete out[f];
      }
    }
  }
  return out;
}

/** Whether `editor` may change `field` on `target`'s profile. */
export function canEditRepField(editor: Pick<UserProfile, 'systemuserid' | 'role' | 'canEditRepData'>, target: Pick<UserProfile, 'systemuserid'>, field: keyof Advisor, policy?: Pick<FirmPolicy, 'repDataSelfEdit'>): boolean {
  if (editor.role === 'Admin') return true;
  if (editor.systemuserid !== target.systemuserid) return false;
  if ((REP_IDENTIFIERS as readonly string[]).includes(field)) return false;
  return editor.canEditRepData ?? policy?.repDataSelfEdit ?? true;
}

/** How a field's value reads in the audit list. */
export function showRepValue(v: unknown): string {
  if (blank(v)) return '';
  if (typeof v === 'object') {
    const o = v as OfficeAddress;
    return [o.line1, o.suite, [o.city, [o.state, o.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
  }
  return String(v);
}

/** Most entries kept in a profile's audit list; the oldest go first. */
export const REP_AUDIT_LIMIT = 100;

/**
 * Record who changed which rep field on a profile, and when, comparing the effective
 * values (so resetting to the directory value is a change, and saving unchanged
 * isn't). The entries are appended to the profile's `repDataAudit`.
 */
export function withRepAudit(before: UserProfile | undefined, after: UserProfile, by: string, at = new Date().toISOString()): UserProfile {
  const changes: RepDataChange[] = [];
  for (const { field } of REP_FIELDS) {
    const from = before?.[field];
    const to = after[field];
    if (same(from, to)) continue;
    changes.push({ at, by, field, from: showRepValue(from) || undefined, to: showRepValue(to) || undefined });
  }
  if (before && (before.canEditRepData ?? null) !== (after.canEditRepData ?? null)) {
    changes.push({ at, by, field: 'canEditRepData', from: before.canEditRepData === undefined ? undefined : String(before.canEditRepData), to: after.canEditRepData === undefined ? undefined : String(after.canEditRepData) });
  }
  if (!changes.length) return after;
  return { ...after, repDataAudit: [...(after.repDataAudit ?? []), ...changes].slice(-REP_AUDIT_LIMIT) };
}

/** `rep.*` values worked out from the profile: middle initial, office lines, email on forms. */
export function repComputed(a: Advisor, attr: string): string | undefined {
  const o = a.office && a.office.line1?.trim() ? a.office : undefined;
  switch (attr) {
    case 'middleInitial':
      return a.middleName?.trim() ? a.middleName.trim()[0].toUpperCase() : undefined;
    case 'officeStreet':
      return o ? [o.line1, o.suite].filter((x) => x?.trim()).join(', ') : undefined;
    case 'officeLine1':
      return o?.line1;
    case 'officeSuite':
      return o?.suite || undefined;
    case 'officeCity':
      return o?.city || undefined;
    case 'officeState':
      return o?.state || undefined;
    case 'officeZip':
      return o?.zip || undefined;
    case 'officeCityStateZip': {
      if (!o) return undefined;
      const parts = [o.city, [o.state, o.zip].filter(Boolean).join(' ')].filter(Boolean);
      return parts.length ? parts.join(', ') : undefined;
    }
    case 'formEmail':
      return a.formEmail?.trim() || a.email || undefined;
    default:
      return undefined;
  }
}
