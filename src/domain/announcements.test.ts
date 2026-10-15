import { describe, expect, it } from 'vitest';
import { activeAnnouncements, announcementPhase, announcementProblems, canDismiss, cleanAnnouncement, messageParts, type Announcement } from './announcements';

const now = new Date('2026-10-15T12:00:00.000Z');
const a = (id: string, x: Partial<Announcement> = {}): Announcement => ({
  id,
  message: `Message ${id}`,
  severity: 'info',
  startsOn: '2026-10-15T08:00:00.000Z',
  dismissible: true,
  createdBy: 'Dana Yoder',
  createdOn: '2026-10-14T08:00:00.000Z',
  ...x,
});
const me = { systemuserid: 'u-1' };
const groups = [
  { id: 'g-goshen', memberIds: ['u-1'] },
  { id: 'g-va', memberIds: ['u-2'] },
];
const ids = (r: { shown: Announcement[] }) => r.shown.map((x) => x.id);

describe('activeAnnouncements', () => {
  it('shows only what is live now', () => {
    const list = [a('before', { startsOn: '2026-10-15T13:00:00.000Z' }), a('after', { startsOn: '2026-10-01T00:00:00.000Z', endsOn: '2026-10-15T11:59:00.000Z' }), a('open-ended', { startsOn: '2026-10-01T00:00:00.000Z' })];
    expect(ids(activeAnnouncements(list, me, groups, now))).toEqual(['open-ended']);
  });

  it('ends exactly at its end time and starts exactly at its start', () => {
    expect(announcementPhase({ startsOn: now.toISOString() }, now)).toBe('live');
    expect(announcementPhase({ startsOn: '2026-10-01T00:00:00.000Z', endsOn: now.toISOString() }, now)).toBe('past');
    expect(announcementPhase({ startsOn: '2026-10-16T00:00:00.000Z' }, now)).toBe('scheduled');
  });

  it('goes to the groups it names, or everyone', () => {
    const list = [a('mine', { groupIds: ['g-goshen'] }), a('theirs', { groupIds: ['g-va'] }), a('all')];
    expect(ids(activeAnnouncements(list, me, groups, now)).sort()).toEqual(['all', 'mine']);
    // Nobody signed in yet: only the ones for everyone.
    expect(ids(activeAnnouncements(list, undefined, groups, now))).toEqual(['all']);
  });

  it('leaves out dismissed ones, but never a critical one', () => {
    const list = [a('routine'), a('outage', { severity: 'critical', dismissible: true })];
    expect(ids(activeAnnouncements(list, me, groups, now, ['routine', 'outage']))).toEqual(['outage']);
    expect(canDismiss({ severity: 'critical', dismissible: true })).toBe(false);
    expect(canDismiss({ severity: 'warn', dismissible: false })).toBe(false);
  });

  it('puts critical first, then the newest, and shows two with a count of the rest', () => {
    const list = [
      a('old-info', { startsOn: '2026-10-10T00:00:00.000Z' }),
      a('new-info', { startsOn: '2026-10-15T09:00:00.000Z' }),
      a('warn', { severity: 'warn', startsOn: '2026-10-09T00:00:00.000Z' }),
      a('critical', { severity: 'critical', startsOn: '2026-10-01T00:00:00.000Z' }),
    ];
    const r = activeAnnouncements(list, me, groups, now);
    expect(ids(r)).toEqual(['critical', 'warn']);
    expect(r.more).toBe(2);
    expect(ids(activeAnnouncements(list.slice(0, 2), me, groups, now))).toEqual(['new-info', 'old-info']);
    expect(activeAnnouncements(list.slice(0, 2), me, groups, now).more).toBe(0);
  });
});

describe('saving an announcement', () => {
  it('limits the message to 1,000 characters', () => {
    expect(announcementProblems(a('x', { message: 'y'.repeat(1000) }))).toEqual({});
    expect(announcementProblems(a('x', { message: 'y'.repeat(1001) })).message).toMatch(/1,000/);
    expect(announcementProblems(a('x', { message: '   ' })).message).toBeTruthy();
    expect(() => cleanAnnouncement(a('x', { message: 'y'.repeat(1001) }))).toThrow(/1,000/);
  });

  it('needs the end after the start', () => {
    expect(announcementProblems(a('x', { endsOn: '2026-10-15T07:00:00.000Z' })).endsOn).toMatch(/after/);
  });

  it('stores it trimmed, with a critical one never dismissible and no empty audience', () => {
    const clean = cleanAnnouncement(a('x', { message: '  Hello  ', severity: 'critical', groupIds: [], endsOn: '' }));
    expect(clean.message).toBe('Hello');
    expect(clean.dismissible).toBe(false);
    expect('groupIds' in clean || 'endsOn' in clean).toBe(false);
  });
});

describe('messageParts', () => {
  it('links http(s) URLs and nothing else, leaving sentence punctuation outside', () => {
    expect(messageParts('See https://everence.com/forms. Or <b>call</b> javascript:alert(1)')).toEqual([
      { text: 'See ' },
      { href: 'https://everence.com/forms', text: 'https://everence.com/forms' },
      { text: '. Or <b>call</b> javascript:alert(1)' },
    ]);
    expect(messageParts('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([{ text: '(' }, { href: 'https://en.wikipedia.org/wiki/Foo_(bar)', text: 'https://en.wikipedia.org/wiki/Foo_(bar)' }, { text: ')' }]);
    expect(messageParts('No links here')).toEqual([{ text: 'No links here' }]);
  });
});
