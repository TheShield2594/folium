import { describe, expect, it } from 'vitest';
import { DIRECTORY, GROUPS, USERS } from '../services/demo/seed';
import { actableUsers, canShareWith } from './policy';
import type { UserProfile } from './types';
import { bulkSummary, lastAdminProblem, needsSeenStamp, parseCsv, parseUserImport, planBulk, planImport, toCsv, userStatus, usersCsv } from './users';

const now = new Date('2026-10-14T12:00:00.000Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const p = (x: Partial<UserProfile> = {}): UserProfile => ({ systemuserid: 'u1', fullname: 'Pat', email: 'pat@example.org', phone: '', repCode: '', branch: '', title: '', role: 'User', groupIds: [], ...x });

describe('userStatus', () => {
  it('is active within the threshold and dormant after it', () => {
    expect(userStatus(p({ lastSeenOn: daysAgo(2) }), undefined, now)).toBe('active');
    expect(userStatus(p({ lastSeenOn: daysAgo(90) }), undefined, now)).toBe('active');
    expect(userStatus(p({ lastSeenOn: daysAgo(91) }), undefined, now)).toBe('dormant');
    expect(userStatus(p({ lastSeenOn: daysAgo(31) }), undefined, now, 30)).toBe('dormant');
  });

  it('is disabled when the directory account is off, whatever the profile says', () => {
    expect(userStatus(p({ lastSeenOn: daysAgo(1) }), { disabled: true }, now)).toBe('disabled');
    expect(userStatus(p({ disabled: true }), undefined, now)).toBe('disabled');
    expect(userStatus(undefined, { disabled: true }, now)).toBe('disabled');
  });

  it('is noProfile for a directory member without a profile', () => {
    expect(userStatus(undefined, {}, now)).toBe('noProfile');
  });

  it('separates deactivated and never-signed-in profiles', () => {
    expect(userStatus(p({ active: false, lastSeenOn: daysAgo(1) }), undefined, now)).toBe('inactive');
    expect(userStatus(p(), undefined, now)).toBe('unused');
  });
});

describe('sign-in stamp', () => {
  it('is written at most once a day', () => {
    expect(needsSeenStamp(undefined, now)).toBe(true);
    expect(needsSeenStamp('2026-10-14T01:00:00.000Z', now)).toBe(false);
    expect(needsSeenStamp('2026-10-13T23:59:00.000Z', now)).toBe(true);
  });
});

describe('deactivated people', () => {
  const groups = GROUPS.map((g) => ({ ...g, memberIds: [...g.memberIds] }));
  const assistant = USERS.find((u) => u.role === 'Assistant')!;
  const taylor = USERS[0];

  it('drop out of acting-for and share lists', () => {
    expect(actableUsers(assistant, USERS, groups).map((u) => u.systemuserid)).toContain(taylor.systemuserid);
    const users = USERS.map((u) => (u.systemuserid === taylor.systemuserid ? { ...u, active: false } : u));
    expect(actableUsers(assistant, users, groups).map((u) => u.systemuserid)).not.toContain(taylor.systemuserid);
    expect(canShareWith(assistant, { ...taylor, active: false }, groups, undefined)).toBe(false);
    expect(canShareWith(assistant, { ...taylor, disabled: true }, groups, undefined)).toBe(false);
    expect(canShareWith(assistant, taylor, groups, undefined)).toBe(true);
  });
});

describe('the last administrator', () => {
  const admin = USERS.find((u) => u.role === 'Admin')!;

  it('can’t be demoted or deactivated', () => {
    expect(lastAdminProblem(USERS, [{ ...admin, role: 'User' }])).toMatch(/only active administrator/);
    expect(lastAdminProblem(USERS, [{ ...admin, active: false }])).toMatch(/only active administrator/);
  });

  it('can be once someone else is an administrator', () => {
    const users = [...USERS, p({ systemuserid: 'u9', role: 'Admin' })];
    expect(lastAdminProblem(users, [{ ...admin, active: false }])).toBeUndefined();
    // A disabled second admin doesn't count.
    expect(lastAdminProblem([...USERS, p({ systemuserid: 'u9', role: 'Admin', disabled: true })], [{ ...admin, role: 'User' }])).toBeDefined();
  });
});

describe('bulk changes', () => {
  const ids = USERS.slice(0, 3).map((u) => u.systemuserid);

  it('changes only the people it affects', () => {
    expect(planBulk(USERS, ids, { kind: 'role', role: 'User' }).map((u) => u.fullname)).toEqual(['Morgan Beachy']);
    const added = planBulk(USERS, ids, { kind: 'addGroup', groupId: 'grp-va' });
    expect(added.map((u) => u.fullname)).toEqual(['Taylor Brenneman', 'Morgan Beachy']);
    expect(added[0].groupIds).toEqual(['grp-goshen', 'grp-va']);
    expect(planBulk(USERS, ids, { kind: 'removeGroup', groupId: 'grp-va' }).map((u) => u.fullname)).toEqual(['Jesse Shenk']);
    const off = planBulk(USERS, ids, { kind: 'deactivate' });
    expect(off.every((u) => u.active === false && !u.groupIds.length)).toBe(true);
    expect(planBulk(off, ids, { kind: 'reactivate' })).toHaveLength(3);
  });

  it('summarises the change for the confirmation', () => {
    expect(bulkSummary({ kind: 'addGroup', groupId: 'grp-va' }, 12, GROUPS)).toBe('Add 12 people to Virginia');
    expect(bulkSummary({ kind: 'role', role: 'Assistant' }, 1, GROUPS)).toBe('Make 1 person Assistant');
    expect(bulkSummary({ kind: 'deactivate' }, 3, GROUPS)).toBe('Deactivate 3 people');
  });
});

describe('CSV', () => {
  it('reads quoted values with commas, quotes and line breaks', () => {
    expect(parseCsv('﻿a,b,c\r\n"Yoder, Dana","say ""hi""","two\nlines"\n\n x , ,z')).toEqual([
      ['a', 'b', 'c'],
      ['Yoder, Dana', 'say "hi"', 'two\nlines'],
      ['x', '', 'z'],
    ]);
  });

  it('writes CSV that round-trips and defuses formulas', () => {
    const csv = toCsv([['Name', 'Note'], ['Yoder, Dana', '=HYPERLINK("x")']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(parseCsv(csv)).toEqual([['Name', 'Note'], ['Yoder, Dana', `'=HYPERLINK("x")`]]);
  });

  it('exports the list with status and last sign-in', () => {
    const rows = parseCsv(usersCsv(USERS.slice(0, 1), GROUPS, () => 'active'));
    expect(rows[0]).toContain('Last sign-in');
    expect(rows[1]).toEqual(['Taylor Brenneman', 'taylor.brenneman@example.org', 'User', 'Active', '2026-10-13', 'Goshen advisors', 'EV4471', 'OSJ-0112', '801-56789', 'Goshen', 'Financial advisor']);
  });
});

describe('importing people', () => {
  const file = [
    'Email,Role,Groups,Rep Code,Branch',
    'TAYLOR.brenneman@example.org,User,Goshen advisors; Virginia,,',
    'avery.graber@example.org,advisor,"Ohio, North",EV5100,Newton',
    'nobody@example.org,User,,,',
    'morgan.beachy@example.org,Manager,,,',
    'not-an-email,User,,,',
    'dana.yoder@example.org,,,,',
    'avery.graber@example.org,User,,,',
  ].join('\n');

  it('parses rows, unknown roles, unknown groups and bad emails', () => {
    const { rows, problem } = parseUserImport(file, GROUPS);
    expect(problem).toBeUndefined();
    expect(rows[0]).toMatchObject({ line: 2, email: 'taylor.brenneman@example.org', role: 'User', groupIds: ['grp-goshen', 'grp-va'], unknownGroups: [] });
    expect(rows[1]).toMatchObject({ role: 'User', unknownGroups: ['Ohio, North'], repCode: 'EV5100', branch: 'Newton' });
    expect(rows[3].errors).toEqual(['Unknown role “Manager”']);
    expect(rows[4].errors[0]).toMatch(/isn’t an email/);
  });

  it('needs an email column', () => {
    expect(parseUserImport('name,role\nPat,User', GROUPS).problem).toMatch(/email/);
    expect(parseUserImport('', GROUPS).problem).toMatch(/empty/);
  });

  it('previews against the directory before anything is saved', () => {
    const { rows } = parseUserImport(file, GROUPS);
    const plan = planImport(rows, USERS, DIRECTORY, GROUPS);
    expect(plan.map((o) => o.kind)).toEqual(['changed', 'new', 'notFound', 'invalid', 'invalid', 'unchanged', 'invalid']);
    const taylor = plan[0];
    expect(taylor.kind === 'changed' && taylor.changes).toEqual(['Add to Virginia']);
    const avery = plan[1];
    expect(avery.kind === 'new' && avery.next).toMatchObject({ systemuserid: 'usr-advisor-4', fullname: 'Avery Graber', role: 'User', repCode: 'EV5100', branch: 'Newton' });
    expect(plan[6].row.errors[0]).toMatch(/more than once/);
  });
});
