import { describe, expect, it } from 'vitest';
import { actableUsers, canDownload, canShareWith, DEFAULT_POLICY, sharingAllowed, withPolicyDefaults, type DownloadMode } from './policy';
import type { FirmPolicy, UserGroup, UserProfile } from './types';

const person = (id: string, role: UserProfile['role'], groupIds: string[]): UserProfile => ({
  systemuserid: id,
  fullname: id,
  email: `${id}@example.org`,
  phone: '',
  repCode: '',
  branch: '',
  title: '',
  role,
  groupIds,
});
const ann = person('ann', 'User', ['g1']);
const bob = person('bob', 'User', ['g1']);
const cat = person('cat', 'User', ['g2']);
const asst = person('asst', 'Assistant', ['g1']);
const admin = person('admin', 'Admin', ['g1']);
const users = [ann, bob, cat, asst, admin];
const groups: UserGroup[] = [
  { id: 'g1', name: 'Goshen', memberIds: ['ann', 'bob', 'asst', 'admin'] },
  { id: 'g2', name: 'Virginia', memberIds: ['cat'] },
];
const policy = (p: Partial<FirmPolicy>): FirmPolicy => ({ ...DEFAULT_POLICY, ...p });

describe('firm policy', () => {
  it('fills defaults for a missing row and unknown values', () => {
    expect(withPolicyDefaults(undefined)).toEqual({ sharing: 'groups', repDataVisibility: 'assistants', pdfDownload: 'all' });
    expect(withPolicyDefaults({ sharing: 'nobody' as never, draftRetentionDays: 30 })).toMatchObject({ sharing: 'groups', draftRetentionDays: 30 });
  });

  it('shares only as the sharing mode allows', () => {
    const groupsOnly = policy({ sharing: 'groups' });
    expect(canShareWith(ann, bob, groups, groupsOnly)).toBe(true);
    // Outside your groups.
    expect(canShareWith(ann, cat, groups, groupsOnly)).toBe(false);
    expect(canShareWith(ann, ann, groups, groupsOnly)).toBe(false);
    expect(canShareWith(ann, cat, groups, policy({ sharing: 'anyone' }))).toBe(true);
    expect(canShareWith(ann, bob, groups, policy({ sharing: 'off' }))).toBe(false);
    expect(sharingAllowed(policy({ sharing: 'off' }))).toBe(false);
    // No drafts kept, so nothing to share.
    expect(canShareWith(ann, bob, groups, policy({ sharing: 'anyone', draftRetentionDays: 0 }))).toBe(false);
  });

  it('lets people work as others only as rep-data visibility allows', () => {
    const ids = (us: UserProfile[]) => us.map((u) => u.systemuserid);
    const assistantsOnly = policy({ repDataVisibility: 'assistants' });
    const members = policy({ repDataVisibility: 'groupMembers' });
    expect(ids(actableUsers(asst, users, groups, assistantsOnly))).toEqual(['ann', 'bob']);
    expect(ids(actableUsers(asst, users, groups, members))).toEqual(['ann', 'bob']);
    expect(ids(actableUsers(ann, users, groups, assistantsOnly))).toEqual(['ann']);
    expect(ids(actableUsers(ann, users, groups, members))).toEqual(['ann', 'bob']);
    // Nobody in Cat's groups but Cat.
    expect(ids(actableUsers(cat, users, groups, members))).toEqual(['cat']);
    expect(ids(actableUsers(admin, users, groups, members))).toEqual(['admin']);
  });

  it('allows downloads by mode and policy', () => {
    const modes: DownloadMode[] = ['fillable', 'flatten', 'print', 'inPerson', 'signed'];
    const allowed = (pdfDownload: FirmPolicy['pdfDownload']) => modes.filter((m) => canDownload(m, policy({ pdfDownload })));
    expect(allowed('all')).toEqual(modes);
    expect(allowed('signedOnly')).toEqual(['signed']);
    expect(allowed('none')).toEqual([]);
    expect(canDownload('print', undefined)).toBe(true);
  });
});
