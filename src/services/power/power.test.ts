import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../domain/types';
import { rolesForPacket } from '../../domain/signers';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../demo/seed';
import { decodeChoices, encodeChoices } from './choices';
import { CHOICES } from './config';

// A fake Dataverse: contacts as Dataverse stores them, with option numbers and the
// FormattedValue annotation the SDK requests by default.
const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const rows: Record<string, Record<string, unknown>> = {};
const updates: { table: string; id: string; data: Record<string, unknown> }[] = [];
const ok = <T,>(data: T) => ({ success: true, data });

vi.mock('@microsoft/power-apps/app', () => ({ getContext: vi.fn() }));
vi.mock('@microsoft/power-apps/data', () => ({
  getClient: () => ({
    retrieveRecordAsync: async (_t: string, id: string) => ok({ ...rows[id] }),
    retrieveMultipleRecordsAsync: async () => ok([]),
    updateRecordAsync: async (table: string, id: string, data: Record<string, unknown>) => {
      updates.push({ table, id, data });
      const next = { ...rows[id], ...data };
      next[`familystatuscode${FORMATTED}`] = { 1: 'Single', 2: 'Married', 3: 'Divorced', 4: 'Widowed' }[data.familystatuscode as number];
      rows[id] = next;
      return ok({});
    },
  }),
}));

const { createPowerServices } = await import('./index');
const contactChoices = CHOICES.contact;

beforeEach(() => {
  updates.length = 0;
  rows['c-1'] = { contactid: 'c-1', fullname: 'Jordan Miller', familystatuscode: 2, [`familystatuscode${FORMATTED}`]: 'Married' };
  rows['c-2'] = { contactid: 'c-2', fullname: 'Alex Kim', familystatuscode: 100000007, [`familystatuscode${FORMATTED}`]: 'Domestic partner' };
});

describe('choice columns', () => {
  it('getClient turns option numbers into the domain word', async () => {
    const { contact } = await createPowerServices().crm.getClient('c-1');
    expect(contact.familystatuscode).toBe('married');
    expect(contact.unrecognisedChoices).toBeUndefined();
  });

  it('updateContact writes the option number and reads back the word', async () => {
    const crm = createPowerServices().crm;
    const saved = await crm.updateContact('c-1', { familystatuscode: 'divorced' });
    expect(updates[0].data).toEqual({ familystatuscode: 3 });
    expect(saved.familystatuscode).toBe('divorced');
    await crm.updateContact('c-1', { familystatuscode: '' as Contact['familystatuscode'] });
    expect(updates[1].data).toEqual({ familystatuscode: null });
  });

  it('flags an unmapped option instead of passing the number through', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { contact } = await createPowerServices().crm.getClient('c-2');
    expect(contact.familystatuscode).toBeUndefined();
    expect(contact.unrecognisedChoices).toEqual({ familystatuscode: { label: 'Marital status', value: 'Domestic partner' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('contact.familystatuscode = 100000007'));
    warn.mockRestore();
  });

  it('a married client loaded from Dataverse gets the SpouseConsent signer', async () => {
    const base = CLIENTS['c-jordan'];
    const contact = decodeChoices({ ...base.contact, familystatuscode: 2 } as unknown as Contact, contactChoices, 'contact');
    const scope = { client: { ...base, contact }, advisor: USERS[0], firm: FIRM, today: new Date(2026, 9, 13) };
    const bene = TEMPLATES.find((t) => t.id === 'tpl-ev1120-0326')!;
    expect(rolesForPacket([bene], scope).map((n) => n.role)).toEqual(['Owner', 'SpouseConsent']);
  });

  it('leaves words alone and rejects an unknown word on save', () => {
    expect(decodeChoices({ familystatuscode: 'single' }, contactChoices, 'contact')).toEqual({ familystatuscode: 'single' });
    expect(() => encodeChoices({ familystatuscode: 'engaged' }, contactChoices, 'contact')).toThrow(/Marital status/);
    expect(encodeChoices({ firstname: 'Sam', unrecognisedChoices: {} }, contactChoices, 'contact')).toEqual({ firstname: 'Sam' });
  });
});
