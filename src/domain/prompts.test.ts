import { describe, expect, it } from 'vitest';
import { CLIENTS, TEMPLATES } from '../services/demo/seed';
import { clientPrompts, draftPrompt, greeting, requestPrompt, revisionPrompts, rmdAge, sortPrompts } from './prompts';
import { suggestPacket } from './startPacket';
import { currentTemplates } from './revisions';
import type { ClientRecord, SignatureRequest } from './types';

const today = new Date(2026, 9, 16);
const withBirthday = (client: ClientRecord, birthdate: string): ClientRecord => ({ ...client, contact: { ...client.contact, birthdate } });

describe('Today prompts', () => {
  it('knows when RMDs start', () => {
    expect(rmdAge(1950)).toBe(72);
    expect(rmdAge(1953)).toBe(73);
    expect(rmdAge(1960)).toBe(75);
  });

  it('prompts for the first RMD in the year a client with an IRA reaches RMD age', () => {
    const p = clientPrompts(CLIENTS['c-leon'], today);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'rmd', tone: 'info', title: 'Leon Martin turns 73 in December', action: 'Start packet', intent: 'RMD election' });
    expect(p[0].detail).toContain('due by Dec 31');
    // A birthday already behind them this year reads in the past tense.
    expect(clientPrompts(withBirthday(CLIENTS['c-leon'], '1953-03-02'), today)[0].title).toBe('Leon Martin turned 73 in March');
    // Not the year before or after.
    expect(clientPrompts(withBirthday(CLIENTS['c-leon'], '1954-12-04'), today)).toHaveLength(0);
  });

  it('skips the RMD prompt when the only retirement account is a Roth IRA', () => {
    const roth = { ...CLIENTS['c-grace'], contact: { ...CLIENTS['c-grace'].contact, birthdate: '1953-12-04' } };
    expect(clientPrompts(roth, today).some((p) => p.kind === 'rmd')).toBe(false);
  });

  it('flags an IRA with no beneficiary on file', () => {
    const p = clientPrompts(CLIENTS['c-grace'], today);
    expect(p.map((x) => x.kind)).toEqual(['beneficiary']);
    expect(p[0].intent).toBe('Update beneficiaries');
  });

  it('turns stuck drafts and requests into attention items', () => {
    const base = { id: 'r1', contactId: 'c-grace', title: 'Roth IRA update', status: 'Drafted', signers: [], documents: [], uploadedToOnBase: false } as unknown as SignatureRequest;
    expect(draftPrompt(base, 'Grace Nafziger', 0)).toBeUndefined();
    expect(draftPrompt(base, 'Grace Nafziger', 2)).toMatchObject({ tone: 'attention', action: 'Resume', detail: 'Draft, 2 items to fix before it’s in good order.' });
    const declined = { ...base, status: 'Declined', signers: [{ name: 'Grace Nafziger', status: 'declined' }] } as unknown as SignatureRequest;
    expect(requestPrompt(declined, 'Grace Nafziger', today)).toMatchObject({ title: 'Grace Nafziger · Grace Nafziger declined', action: 'Fix signer' });
    const signed = { ...base, status: 'Signed' } as SignatureRequest;
    expect(requestPrompt(signed, 'Grace Nafziger', today)?.action).toBe('File');
    expect(requestPrompt({ ...signed, uploadedToOnBase: true }, 'Grace Nafziger', today)).toBeUndefined();
    const expiring = { ...base, status: 'Sent', expiresOn: new Date(2026, 9, 19).toISOString() } as SignatureRequest;
    expect(requestPrompt(expiring, 'Grace Nafziger', today)?.title).toBe('Grace Nafziger · expires in 3 days');
  });

  it('warns about a new revision of a form in a saved packet', () => {
    const t = TEMPLATES.find((x) => x.status === 'Live')!;
    const next = { ...t, id: 'next', revision: '11/2026', effectiveDate: '2026-11-01' };
    const p = revisionPrompts([{ id: 'p', name: 'IRA rollover', templateIds: [t.id], shared: false, owner: 'me', createdOn: '', usedCount: 0 }], [t, next], today);
    expect(p).toHaveLength(1);
    expect(p[0].title).toBe(`${t.name} Rev 11/2026 takes effect Nov 1`);
    expect(revisionPrompts([{ id: 'p', name: 'x', templateIds: [t.id], shared: false, owner: 'me', createdOn: '', usedCount: 0 }], [t, { ...next, effectiveDate: '2027-03-01' }], today)).toHaveLength(0);
  });

  it('puts stuck work first and greets by time of day', () => {
    const list = sortPrompts([
      { id: 'a', kind: 'rmd', tone: 'info', title: '', detail: '', action: '' },
      { id: 'b', kind: 'draft', tone: 'attention', title: '', detail: '', action: '' },
    ]);
    expect(list.map((p) => p.id)).toEqual(['b', 'a']);
    expect(greeting(new Date(2026, 9, 16, 9))).toBe('Good morning');
    expect(greeting(new Date(2026, 9, 16, 14))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 9, 16, 19))).toBe('Good evening');
  });
});

describe('Start a packet', () => {
  const live = currentTemplates(TEMPLATES);
  const names = (text: string, client?: ClientRecord) => suggestPacket(text, live, client).map((s) => s.template.name);

  it('builds a rollover packet and says why each form is there', () => {
    const s = suggestPacket('Priya is rolling her Fidelity 401(k) into a Traditional IRA', live, CLIENTS['c-priya']);
    expect(s.map((x) => x.template.name)).toEqual(['Transfer of assets (incoming)', 'New account application', 'Beneficiary designation']);
    expect(s[0].reason).toBe('Transfer of assets (incoming) was added because Priya’s Dynamics 365 record lists a Fidelity 401(k).');
    expect(s[1].reason).toContain('no Traditional IRA');
  });

  it('skips the application when the client already holds the IRA the rollover goes into', () => {
    expect(names('Roll her 401(k) into her Roth IRA', CLIENTS['c-priya'])).toEqual(['Transfer of assets (incoming)']);
  });

  it('recognises the common requests', () => {
    expect(names('Update beneficiaries')).toEqual(['Beneficiary designation']);
    expect(names('Change of address')).toEqual(['Address and contact change']);
    expect(names('RMD election')).toEqual(['Required minimum distribution election']);
    expect(names('Set up monthly withdrawals')).toEqual(['Systematic withdrawal request']);
    expect(names('One-time distribution from her IRA')).toEqual(['IRA distribution request']);
  });

  it('falls back to matching words, and returns nothing for an empty description', () => {
    expect(names('roth conversion')).toEqual(['Roth conversion request']);
    expect(suggestPacket('   ', live)).toEqual([]);
    expect(suggestPacket('xyzzy plover', live)).toEqual([]);
  });
});
