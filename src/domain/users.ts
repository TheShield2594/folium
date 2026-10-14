import type { DirectoryUser } from './advisor';
import type { FirmPolicy, UserGroup, UserProfile, UserRole } from './types';

// The user lifecycle in Users & groups: who is active, dormant or gone, what a bulk
// change will do, and moving the list in and out as CSV. Access itself comes from
// Entra ID (membership of the security group the app is shared with), so there are
// no seats or expiry dates here.

/**
 * - `active`: signed in within the dormant threshold.
 * - `dormant`: hasn't signed in for longer than the threshold.
 * - `unused`: has a profile but has never opened Folium.
 * - `inactive`: deactivated in Folium (the profile is kept, and so are their requests).
 * - `disabled`: their directory account is turned off, usually because they left.
 * - `noProfile`: in the directory, but with no Folium profile yet.
 */
export type UserStatus = 'active' | 'dormant' | 'unused' | 'inactive' | 'disabled' | 'noProfile';

export const STATUS_LABEL: Record<UserStatus, string> = {
  active: 'Active',
  dormant: 'Dormant',
  unused: 'Never signed in',
  inactive: 'Deactivated',
  disabled: 'Left Everence',
  noProfile: 'No profile',
};

export const DEFAULT_DORMANT_DAYS = 90;
const DAY = 86_400_000;

export const dormantDays = (policy: Pick<FirmPolicy, 'dormantAfterDays'> | undefined) => policy?.dormantAfterDays ?? DEFAULT_DORMANT_DAYS;

/** Where someone stands, from their profile (if any) and their directory row (if any). */
export function userStatus(profile: UserProfile | undefined, directory: Pick<DirectoryUser, 'disabled'> | undefined, now: Date, dormantAfterDays = DEFAULT_DORMANT_DAYS): UserStatus {
  if (directory?.disabled || profile?.disabled) return 'disabled';
  if (!profile) return 'noProfile';
  if (profile.active === false) return 'inactive';
  if (!profile.lastSeenOn) return 'unused';
  const seen = Date.parse(profile.lastSeenOn);
  if (Number.isNaN(seen)) return 'unused';
  return now.getTime() - seen > dormantAfterDays * DAY ? 'dormant' : 'active';
}

/** Whether someone can be worked for, shared with or picked: not deactivated, not disabled. */
export const isActiveUser = (u: Pick<UserProfile, 'active' | 'disabled'>) => u.active !== false && !u.disabled;

/** Whether `currentUser()` should record today's sign-in: never recorded, or last recorded on an earlier day. */
export function needsSeenStamp(lastSeenOn: string | undefined, now: Date): boolean {
  if (!lastSeenOn) return true;
  return lastSeenOn.slice(0, 10) !== now.toISOString().slice(0, 10);
}

/** Admins who can still sign in and administer Folium. */
export const activeAdmins = (users: UserProfile[]) => users.filter((u) => u.role === 'Admin' && isActiveUser(u));

/**
 * Why a change can't be saved, if it would leave Folium with no active Admin (someone
 * has to be able to fix roles). `changed` are the profiles as they would be saved.
 */
export function lastAdminProblem(users: UserProfile[], changed: UserProfile[]): string | undefined {
  if (!activeAdmins(users).length) return undefined;
  const byId = new Map(changed.map((u) => [u.systemuserid, u]));
  const after = users.map((u) => byId.get(u.systemuserid) ?? u);
  if (activeAdmins(after).length) return undefined;
  const last = activeAdmins(users)[0];
  return `${last.fullname} is the only active administrator. Make someone else an administrator first.`;
}

// ---------------------------------------------------------------- Bulk changes

export type BulkAction =
  | { kind: 'role'; role: UserRole }
  | { kind: 'addGroup'; groupId: string }
  | { kind: 'removeGroup'; groupId: string }
  | { kind: 'deactivate' }
  | { kind: 'reactivate' };

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const ROLE_NAME: Record<UserRole, string> = { User: 'User', Assistant: 'Assistant', Admin: 'Administrator' };

/** The confirmation line: "Add 12 people to Ohio". */
export function bulkSummary(action: BulkAction, count: number, groups: UserGroup[]): string {
  const g = 'groupId' in action ? (groups.find((x) => x.id === action.groupId)?.name ?? 'the group') : '';
  switch (action.kind) {
    case 'role':
      return `Make ${people(count)} ${ROLE_NAME[action.role]}${count === 1 ? '' : 's'}`;
    case 'addGroup':
      return `Add ${people(count)} to ${g}`;
    case 'removeGroup':
      return `Remove ${people(count)} from ${g}`;
    case 'deactivate':
      return `Deactivate ${people(count)}`;
    case 'reactivate':
      return `Reactivate ${people(count)}`;
  }
}

/**
 * Each selected person as they would be after the action, leaving out anyone it
 * doesn't change (already in the group, already that role…).
 */
export function planBulk(users: UserProfile[], ids: string[], action: BulkAction): UserProfile[] {
  const out: UserProfile[] = [];
  for (const u of users.filter((x) => ids.includes(x.systemuserid))) {
    switch (action.kind) {
      case 'role':
        if (u.role !== action.role) out.push({ ...u, role: action.role });
        break;
      case 'addGroup':
        if (!u.groupIds.includes(action.groupId) && isActiveUser(u)) out.push({ ...u, groupIds: [...u.groupIds, action.groupId] });
        break;
      case 'removeGroup':
        if (u.groupIds.includes(action.groupId)) out.push({ ...u, groupIds: u.groupIds.filter((g) => g !== action.groupId) });
        break;
      case 'deactivate':
        if (u.active !== false) out.push({ ...u, active: false, groupIds: [] });
        break;
      case 'reactivate':
        if (u.active === false) out.push({ ...u, active: true });
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 rows: quoted values may hold commas, quotes ("") and line breaks. A BOM is ignored. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell.trim()) {
      quoted = true;
      cell = '';
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((c) => c)) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) rows.push(row);
  return rows;
}

const quote = (v: string) => (/[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);

/** CSV text Excel opens directly (with a BOM so names with accents survive). Cells that look like formulas are defused. */
export function toCsv(rows: string[][]): string {
  return `﻿${rows.map((r) => r.map((c) => quote(c ?? '')).join(',')).join('\r\n')}\r\n`;
}

/** The list as shown, for Compliance: one row per person. */
export function usersCsv(users: UserProfile[], groups: UserGroup[], statusOf: (u: UserProfile) => UserStatus): string {
  const groupNames = (u: UserProfile) => groups.filter((g) => g.memberIds.includes(u.systemuserid) || u.groupIds.includes(g.id)).map((g) => g.name).join('; ');
  return toCsv([
    ['Name', 'Email', 'Role', 'Status', 'Last sign-in', 'Groups', 'Rep code', 'OSJ number', 'RIA number', 'Branch', 'Title'],
    ...users.map((u) => [u.fullname, u.email, u.role, STATUS_LABEL[statusOf(u)], u.lastSeenOn?.slice(0, 10) ?? '', groupNames(u), u.repCode, u.osjNumber ?? '', u.riaNumber ?? '', u.branch, u.title]),
  ]);
}

export interface ImportRow {
  line: number;
  email: string;
  role?: UserRole;
  groupIds: string[];
  /** Group names in the file that match no group. */
  unknownGroups: string[];
  repCode?: string;
  branch?: string;
  errors: string[];
}

const ROLE_WORDS: Record<string, UserRole> = { user: 'User', advisor: 'User', assistant: 'Assistant', admin: 'Admin', administrator: 'Admin' };

/**
 * Read an import file with the columns `email, role, groups, repCode, branch` (any
 * order, any case; only email is required). Groups are separated by `;` or `|` and
 * matched by name.
 */
export function parseUserImport(text: string, groups: UserGroup[]): { rows: ImportRow[]; problem?: string } {
  const [header, ...body] = parseCsv(text);
  if (!header) return { rows: [], problem: 'The file is empty.' };
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h.toLowerCase().replace(/[\s_-]/g, '')));
  const at = { email: col('email', 'emailaddress'), role: col('role'), groups: col('groups', 'group'), repCode: col('repcode', 'rep'), branch: col('branch') };
  if (at.email < 0) return { rows: [], problem: 'The first row must name the columns, including “email”.' };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const rows = body.map((r, i): ImportRow => {
    const errors: string[] = [];
    const email = get(r, at.email).toLowerCase();
    if (!email) errors.push('No email');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`“${email}” isn’t an email address`);
    const roleWord = get(r, at.role);
    const role = roleWord ? ROLE_WORDS[roleWord.toLowerCase()] : undefined;
    if (roleWord && !role) errors.push(`Unknown role “${roleWord}”`);
    const names = get(r, at.groups).split(/[;|]/).map((g) => g.trim()).filter(Boolean);
    const groupIds: string[] = [];
    const unknownGroups: string[] = [];
    for (const n of names) {
      const g = groups.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (g) groupIds.push(g.id);
      else unknownGroups.push(n);
    }
    return { line: i + 2, email, role, groupIds, unknownGroups, repCode: get(r, at.repCode) || undefined, branch: get(r, at.branch) || undefined, errors };
  });
  return { rows };
}

export type ImportOutcome =
  | { kind: 'new'; row: ImportRow; next: UserProfile; changes: string[] }
  | { kind: 'changed'; row: ImportRow; next: UserProfile; changes: string[] }
  | { kind: 'unchanged'; row: ImportRow }
  | { kind: 'notFound'; row: ImportRow }
  | { kind: 'invalid'; row: ImportRow };

/**
 * What saving an import would do, row by row, before anything is written. Each email
 * is matched to a person in the directory: no match means no profile is created (so a
 * typo can't make a ghost account). Existing profiles keep anything the file leaves blank.
 */
export function planImport(rows: ImportRow[], users: UserProfile[], directory: DirectoryUser[], groups: UserGroup[]): ImportOutcome[] {
  const seen = new Set<string>();
  return rows.map((row): ImportOutcome => {
    if (row.errors.length) return { kind: 'invalid', row };
    if (seen.has(row.email)) return { kind: 'invalid', row: { ...row, errors: [`${row.email} is in the file more than once`] } };
    seen.add(row.email);
    const dir = directory.find((d) => d.email?.toLowerCase() === row.email);
    const existing = users.find((u) => u.email.toLowerCase() === row.email || (dir && u.systemuserid === dir.systemuserid));
    if (!dir && !existing) return { kind: 'notFound', row };
    const base: UserProfile = existing ?? { systemuserid: dir!.systemuserid, fullname: dir!.fullname, email: dir!.email ?? row.email, phone: dir!.phone ?? '', title: dir!.title ?? '', repCode: '', branch: '', role: 'User', groupIds: [] };
    const next: UserProfile = {
      ...base,
      role: row.role ?? base.role,
      groupIds: row.groupIds.length ? [...new Set([...base.groupIds, ...row.groupIds])] : base.groupIds,
      repCode: row.repCode ?? base.repCode,
      branch: row.branch ?? base.branch,
    };
    const name = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
    const changes = [
      ...(next.role !== base.role || !existing ? [`Role: ${next.role}`] : []),
      ...next.groupIds.filter((g) => !base.groupIds.includes(g)).map((g) => `Add to ${name(g)}`),
      ...(next.repCode !== base.repCode ? [`Rep code: ${next.repCode}`] : []),
      ...(next.branch !== base.branch ? [`Branch: ${next.branch}`] : []),
    ];
    if (!existing) return { kind: 'new', row, next, changes };
    return changes.length ? { kind: 'changed', row, next, changes } : { kind: 'unchanged', row };
  });
}
