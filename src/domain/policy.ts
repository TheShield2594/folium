import { retentionDays } from './requests';
import type { FirmPolicy, UserGroup, UserProfile } from './types';

// Firm-wide rules: who can share with whom, whose rep data can prefill a form, and which
// PDFs can leave Folium. Pure, so the screens and the tests agree on them. Dataverse
// security (#1) enforces sharing and rep-data access on the server; these decide the UI.

/** What a firm gets until an administrator changes something (Everence's Laser App setup). */
export const DEFAULT_POLICY: FirmPolicy = { sharing: 'groups', repDataVisibility: 'assistants', pdfDownload: 'all' };

/** A stored policy with defaults for anything missing or unknown (a missing row is all defaults). */
export function withPolicyDefaults(p: Partial<FirmPolicy> | undefined): FirmPolicy {
  const pick = <T,>(v: T | undefined, allowed: readonly T[], fallback: T) => (v !== undefined && allowed.includes(v) ? v : fallback);
  return {
    ...p,
    sharing: pick(p?.sharing, ['off', 'groups', 'anyone'], DEFAULT_POLICY.sharing),
    repDataVisibility: pick(p?.repDataVisibility, ['assistants', 'groupMembers'], DEFAULT_POLICY.repDataVisibility),
    pdfDownload: pick(p?.pdfDownload, ['all', 'signedOnly', 'none'], DEFAULT_POLICY.pdfDownload),
  };
}

const groupsOf = (userId: string, groups: UserGroup[]) => groups.filter((g) => g.memberIds.includes(userId));

/** Whether two people are in at least one group together. */
export function shareAGroup(a: string, b: string, groups: UserGroup[]): boolean {
  return groupsOf(a, groups).some((g) => g.memberIds.includes(b));
}

/** Whether drafts can be shared at all: sharing is on and the firm keeps drafts. */
export const sharingAllowed = (policy: FirmPolicy | undefined) => (policy?.sharing ?? DEFAULT_POLICY.sharing) !== 'off' && retentionDays(policy) > 0;

/** Whether `me` can share a draft with `target`. */
export function canShareWith(me: Pick<UserProfile, 'systemuserid'>, target: Pick<UserProfile, 'systemuserid'>, groups: UserGroup[], policy: FirmPolicy | undefined): boolean {
  if (me.systemuserid === target.systemuserid || !sharingAllowed(policy)) return false;
  if ((policy?.sharing ?? DEFAULT_POLICY.sharing) === 'anyone') return true;
  return shareAGroup(me.systemuserid, target.systemuserid, groups);
}

/**
 * The advisors whose book and rep data `me` can work in. Assistants: every User in their
 * groups. Users: themselves, plus the other Users in their groups when the firm allows
 * it (`groupMembers`). Admins: themselves.
 */
export function actableUsers(me: UserProfile, users: UserProfile[], groups: UserGroup[], policy: FirmPolicy | undefined = DEFAULT_POLICY): UserProfile[] {
  const ids = new Set(groupsOf(me.systemuserid, groups).flatMap((g) => g.memberIds));
  const groupUsers = users.filter((u) => u.role === 'User' && ids.has(u.systemuserid) && u.systemuserid !== me.systemuserid);
  if (me.role === 'Assistant') return groupUsers;
  if (me.role === 'User' && policy.repDataVisibility === 'groupMembers') return [me, ...groupUsers];
  return [me];
}

/** The ways a PDF leaves Folium. `signed`: the completed envelope from Requests. */
export type DownloadMode = 'fillable' | 'flatten' | 'print' | 'inPerson' | 'signed';

/** Whether the firm lets a PDF leave Folium this way. */
export function canDownload(mode: DownloadMode, policy: FirmPolicy | undefined): boolean {
  switch (policy?.pdfDownload ?? DEFAULT_POLICY.pdfDownload) {
    case 'all':
      return true;
    case 'signedOnly':
      return mode === 'signed';
    case 'none':
      return false;
  }
}
