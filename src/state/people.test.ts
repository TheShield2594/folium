import { beforeEach, describe, expect, it } from 'vitest';
import { planBulk } from '../domain/users';
import { createDemoServices, resetDemo } from '../services/demo';
import { saveUserChanges } from './people';

beforeEach(() => resetDemo());

describe('saving changes to people', () => {
  it('applies a bulk group change to every selected person, in both the profile and the group', async () => {
    const { directory } = createDemoServices();
    const users = await directory.listUsers();
    const groups = await directory.listGroups();
    const ids = ['usr-advisor-1', 'usr-assistant-1'];
    const report = await saveUserChanges(directory, users, groups, planBulk(users, ids, { kind: 'addGroup', groupId: 'grp-va' }));
    expect(report).toEqual({ saved: ['Taylor Brenneman', 'Morgan Beachy'], failed: [] });
    const va = (await directory.listGroups()).find((g) => g.id === 'grp-va')!;
    expect(va.memberIds).toEqual(expect.arrayContaining(['usr-advisor-2', ...ids]));
    expect((await directory.listUsers()).find((u) => u.systemuserid === 'usr-assistant-1')!.groupIds).toContain('grp-va');
  });

  it('reports a failure against the person and still saves the rest', async () => {
    const demo = createDemoServices().directory;
    const directory = { ...demo, saveUser: async (u: Parameters<typeof demo.saveUser>[0]) => (u.systemuserid === 'usr-advisor-1' ? Promise.reject(new Error('Access denied')) : demo.saveUser(u)) };
    const users = await directory.listUsers();
    const groups = await directory.listGroups();
    const report = await saveUserChanges(directory, users, groups, planBulk(users, ['usr-advisor-1', 'usr-advisor-2'], { kind: 'role', role: 'Assistant' }));
    expect(report.saved).toEqual(['Jesse Shenk']);
    expect(report.failed).toEqual([{ name: 'Taylor Brenneman', error: 'Access denied' }]);
  });

  it('deactivates without losing anything: out of every group, still listed, then back', async () => {
    const { directory } = createDemoServices();
    const users = await directory.listUsers();
    const groups = await directory.listGroups();
    await saveUserChanges(directory, users, groups, planBulk(users, ['usr-advisor-2'], { kind: 'deactivate' }));
    const after = await directory.listUsers();
    const jesse = after.find((u) => u.systemuserid === 'usr-advisor-2')!;
    expect(jesse.active).toBe(false);
    expect(jesse.groupIds).toEqual([]);
    expect((await directory.listGroups()).some((g) => g.memberIds.includes('usr-advisor-2'))).toBe(false);
    await saveUserChanges(directory, after, await directory.listGroups(), planBulk(after, ['usr-advisor-2'], { kind: 'reactivate' }));
    expect((await directory.listUsers()).find((u) => u.systemuserid === 'usr-advisor-2')!.active).toBeUndefined();
  });
});

describe('demo directory', () => {
  it('merges the directory under each profile and stores only overrides', async () => {
    const { directory } = createDemoServices();
    const taylor = (await directory.listUsers())[0];
    expect(taylor.office?.city).toBe('Goshen');
    expect(taylor.middleName).toBe('Jo');
    expect((await directory.listUsers()).find((u) => u.systemuserid === 'usr-advisor-3')!.disabled).toBe(true);
    await directory.saveUser({ ...taylor, fax: '574-555-0000' });
    const again = (await directory.listUsers())[0];
    expect(again.fax).toBe('574-555-0000');
    expect(again.directory?.fax).toBe('574-555-0199');
    expect(await directory.lookupDirectory(['AVERY.graber@example.org'])).toMatchObject([{ systemuserid: 'usr-advisor-4' }]);
  });

  it('records the sign-in once a day', async () => {
    const { directory } = createDemoServices();
    const first = await directory.currentUser();
    expect(first.lastSeenOn?.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    const second = await directory.currentUser();
    expect(second.lastSeenOn).toBe(first.lastSeenOn);
  });
});
