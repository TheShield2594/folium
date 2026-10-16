import { describe, expect, it } from 'vitest';
import { CLIENTS, DIRECTORY, FIRM, USERS } from '../services/demo/seed';
import { canEditRepField, fieldOrigin, fromSystemUser, mergeAdvisor, profileFromDirectory, profileToSave, REP_AUDIT_LIMIT, withRepAudit, type DirectoryUser } from './advisor';
import { describeSource, resolvePath } from './paths';
import type { UserProfile } from './types';
import { KNOWN_SOURCES } from '../screens/admin/sources';

const dir: DirectoryUser = {
  systemuserid: 'u1',
  fullname: 'Taylor Brenneman',
  middleName: 'Jo',
  email: 'taylor@example.org',
  phone: '574-555-0142',
  fax: '574-555-0199',
  title: 'Financial advisor',
};
const saved: UserProfile = { systemuserid: 'u1', fullname: '', email: '', phone: '', title: '', repCode: 'EV4471', branch: 'Goshen', role: 'User', groupIds: [] };

describe('mergeAdvisor', () => {
  it('uses the directory value when the profile has none', () => {
    const a = mergeAdvisor(dir, saved);
    expect(a.phone).toBe('574-555-0142');
    expect(a.fullname).toBe('Taylor Brenneman');
    expect(fieldOrigin(a, 'phone')).toBe('directory');
  });

  it('lets a saved value override the directory', () => {
    const a = mergeAdvisor(dir, { ...saved, phone: '574-555-0000', title: 'Senior advisor' });
    expect(a.phone).toBe('574-555-0000');
    expect(a.title).toBe('Senior advisor');
    expect(fieldOrigin(a, 'phone')).toBe('override');
    expect(fieldOrigin(a, 'fax')).toBe('directory');
  });

  it('never lets a blank override hide a directory value', () => {
    const a = mergeAdvisor(dir, { ...saved, phone: '  ' });
    expect(a.phone).toBe('574-555-0142');
  });

  it('keeps the office address in Folium only', () => {
    const office = { line1: '1110 N Main St', suite: 'Suite 200', city: 'Goshen', state: 'IN', zip: '46528' };
    const a = mergeAdvisor(dir, { ...saved, office });
    expect(a.office).toEqual(office);
    expect(profileToSave(a).office).toEqual(office);
    expect(mergeAdvisor(dir, saved).office).toBeUndefined();
  });

  it('stores only overrides, so a reset to the directory value removes the override', () => {
    const a = mergeAdvisor(dir, { ...saved, phone: '574-555-0000' });
    expect(profileToSave(a).phone).toBe('574-555-0000');
    const reset = { ...a, phone: dir.phone! };
    const stored = profileToSave(reset);
    expect(stored.phone).toBe('');
    expect(stored.directory).toBeUndefined();
    // …and the directory supplies it again on the next load, even after the directory changes.
    expect(mergeAdvisor({ ...dir, phone: '574-555-1111' }, stored).phone).toBe('574-555-1111');
  });

  it('flags a disabled directory account', () => {
    expect(mergeAdvisor({ ...dir, disabled: true }, saved).disabled).toBe(true);
    expect(profileToSave(mergeAdvisor({ ...dir, disabled: true }, saved)).disabled).toBeUndefined();
  });

  it('reads a systemuser row', () => {
    // An address on the systemuser row is ignored: the office is set in Folium.
    const d = fromSystemUser({ systemuserid: 'u1', fullname: 'Taylor Brenneman', middlename: 'Jo', internalemailaddress: 'taylor@example.org', address1_telephone1: '574-555-0142', address1_line1: '1 Elsewhere Rd', isdisabled: false, mobilephone: '' });
    expect(d).toEqual({ systemuserid: 'u1', fullname: 'Taylor Brenneman', middleName: 'Jo', email: 'taylor@example.org', phone: '574-555-0142' });
    expect(fromSystemUser({ systemuserid: 'u2', fullname: 'Riley', isdisabled: true }).disabled).toBe(true);
  });
});

describe('rep sources', () => {
  const advisor = mergeAdvisor(DIRECTORY[0], USERS[0]);
  const scope = { client: CLIENTS['c-jordan'], advisor, firm: FIRM };

  it('resolves the new rep attributes and computed values', () => {
    expect(resolvePath('rep.middleInitial', scope)).toBe('J');
    expect(resolvePath('rep.officeStreet', scope)).toBe('1110 N Main St, Suite 200');
    expect(resolvePath('rep.officeCityStateZip', scope)).toBe('Goshen, IN 46528');
    expect(resolvePath('rep.officeZip', scope)).toBe('46528');
    expect(resolvePath('rep.office', scope)).toBe('1110 N Main St, Suite 200');
    expect(resolvePath('rep.fax', scope)).toBe('574-555-0199');
    expect(resolvePath('rep.mobile', scope)).toBe('574-555-0177');
    expect(resolvePath('rep.phoneExt', scope)).toBe('214');
    expect(resolvePath('rep.osjNumber', scope)).toBe('OSJ-0112');
    expect(resolvePath('rep.riaNumber', scope)).toBe('801-56789');
    expect(describeSource('rep.osjNumber')).toBe('Advisor profile');
    for (const src of ['rep.middleInitial', 'rep.osjNumber', 'rep.riaNumber', 'rep.officeStreet', 'rep.officeCityStateZip', 'rep.fax', 'rep.mobile', 'rep.formEmail']) expect(KNOWN_SOURCES.has(src)).toBe(true);
  });

  it('prints the sign-in email on forms unless a form email is set', () => {
    expect(resolvePath('rep.formEmail', scope)).toBe('taylor.brenneman@example.org');
    expect(resolvePath('rep.formEmail', { ...scope, advisor: { ...advisor, formEmail: 'forms@example.org' } })).toBe('forms@example.org');
  });

  it('is empty when there is no office or middle name', () => {
    const bare = { ...scope, advisor: { ...USERS[4] } };
    expect(resolvePath('rep.middleInitial', bare)).toBeUndefined();
    expect(resolvePath('rep.officeCityStateZip', bare)).toBeUndefined();
  });
});

describe('who may edit rep data', () => {
  const advisor = USERS[0];
  const admin = USERS[3];
  const assistant = USERS[2];

  it('lets admins edit anything on anyone', () => {
    expect(canEditRepField(admin, advisor, 'repCode')).toBe(true);
    expect(canEditRepField(admin, advisor, 'phone')).toBe(true);
  });

  it('keeps rep, OSJ and RIA numbers admin-only, even with the flag set', () => {
    const allowed = { ...advisor, canEditRepData: true };
    expect(canEditRepField(allowed, allowed, 'repCode')).toBe(false);
    expect(canEditRepField(allowed, allowed, 'osjNumber')).toBe(false);
    expect(canEditRepField(allowed, allowed, 'riaNumber')).toBe(false);
    expect(canEditRepField(allowed, allowed, 'phone')).toBe(true);
  });

  it('follows the flag, then the firm', () => {
    expect(canEditRepField({ ...advisor, canEditRepData: false }, advisor, 'phone')).toBe(false);
    expect(canEditRepField(advisor, advisor, 'phone', { repDataSelfEdit: false })).toBe(false);
    expect(canEditRepField({ ...advisor, canEditRepData: true }, advisor, 'phone', { repDataSelfEdit: false })).toBe(true);
    expect(canEditRepField(advisor, advisor, 'phone')).toBe(true);
  });

  it('never lets an assistant edit an advisor’s rep data', () => {
    expect(canEditRepField({ ...assistant, canEditRepData: true }, advisor, 'phone')).toBe(false);
  });
});

describe('rep data audit', () => {
  const before = mergeAdvisor(DIRECTORY[0], USERS[0]);

  it('records who changed which field, from what to what', () => {
    const after = withRepAudit(before, { ...before, phone: '574-555-0000', office: { ...before.office!, suite: 'Suite 310' } }, 'Dana Yoder', '2026-10-14T12:00:00.000Z');
    expect(after.repDataAudit).toEqual([
      { at: '2026-10-14T12:00:00.000Z', by: 'Dana Yoder', field: 'phone', from: '574-555-0142', to: '574-555-0000' },
      { at: '2026-10-14T12:00:00.000Z', by: 'Dana Yoder', field: 'office', from: '1110 N Main St, Suite 200, Goshen, IN 46528', to: '1110 N Main St, Suite 310, Goshen, IN 46528' },
    ]);
  });

  it('records nothing when nothing changed, and keeps the newest entries', () => {
    expect(withRepAudit(before, { ...before }, 'Dana').repDataAudit).toBeUndefined();
    const full = { ...before, repDataAudit: Array.from({ length: REP_AUDIT_LIMIT }, (_, i) => ({ at: String(i), by: 'x', field: 'phone' })) };
    const next = withRepAudit(full, { ...full, fax: '1' }, 'Dana');
    expect(next.repDataAudit).toHaveLength(REP_AUDIT_LIMIT);
    expect(next.repDataAudit!.at(-1)!.field).toBe('fax');
    expect(next.repDataAudit![0].at).toBe('1');
  });

  it('records the edit permission changing', () => {
    expect(withRepAudit(before, { ...before, canEditRepData: false }, 'Dana').repDataAudit?.[0]).toMatchObject({ field: 'canEditRepData', to: 'false' });
  });
});

describe('profileFromDirectory', () => {
  it('starts a User with no groups, showing the directory details and storing none of them', () => {
    const u = profileFromDirectory({ systemuserid: 'su-9', fullname: 'Avery Graber', email: 'avery@example.org', phone: '316-555-0120', title: 'Financial advisor', city: 'Newton' });
    expect(u).toMatchObject({ systemuserid: 'su-9', fullname: 'Avery Graber', email: 'avery@example.org', phone: '316-555-0120', title: 'Financial advisor', branch: 'Newton', role: 'User', groupIds: [] });
    expect(fieldOrigin(u, 'title')).toBe('directory');
    const stored = profileToSave(u);
    expect(stored).toMatchObject({ email: '', phone: '', title: '', branch: 'Newton' });
    expect(stored.directory).toBeUndefined();
  });

  it('reads the city from the systemuser', () => {
    expect(fromSystemUser({ systemuserid: 'u', fullname: 'X', address1_city: ' Goshen ' }).city).toBe('Goshen');
  });
});
