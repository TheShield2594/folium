import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../domain/types';
import { rolesForPacket } from '../../domain/signers';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../demo/seed';
import { decodeChoices, encodeChoices } from './choices';
import { CHOICES, SIGNATURE_STATUS_OPTIONS } from './config';
import { seedRequests } from '../demo/seed';

// A fake Dataverse: contacts as Dataverse stores them, with option numbers and the
// FormattedValue annotation the SDK requests by default.
const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const rows: Record<string, Record<string, unknown>> = {};
const updates: { table: string; id: string; data: Record<string, unknown> }[] = [];
const queries: { table: string; filter?: string }[] = [];
/** Connection rows a query returns, by the column its filter is on. */
const connectionRows: Record<string, Record<string, unknown>[]> = {};
const ok = <T,>(data: T) => ({ success: true, data });
/** `ev_foliumsetting` rows, by ID. */
const settingRows: Record<string, Record<string, unknown>> = {};
/** What the SharePoint connector answers to a file lookup, and the files it was asked to delete. */
let fileLookup: { success: boolean; data?: { Id: string }; error?: Record<string, unknown> } = { success: true, data: { Id: 'item-1' } };
const deletedFiles: string[] = [];

vi.mock('@microsoft/power-apps/app', () => ({ getContext: vi.fn() }));
vi.mock('@microsoft/power-apps/data', () => ({
  getClient: () => ({
    retrieveRecordAsync: async (_t: string, id: string) => ok({ ...rows[id] }),
    retrieveMultipleRecordsAsync: async (table: string, opts: { filter?: string }) => {
      queries.push({ table, filter: opts?.filter });
      if (table === 'ev_foliumsettings') {
        const name = /ev_name eq '([^']+)'/.exec(opts?.filter ?? '')?.[1];
        return ok(Object.values(settingRows).filter((r) => !name || r.ev_name === name));
      }
      return ok(table === 'connections' ? (connectionRows[opts?.filter?.split(' ')[0] ?? ''] ?? []) : []);
    },
    executeAsync: async (req: { connectorOperation: { operationName: string; parameters: { id?: string } } }) => {
      const { operationName, parameters } = req.connectorOperation;
      if (operationName === 'GetFileMetadataByPath') return fileLookup;
      if (operationName === 'DeleteFile') return deletedFiles.push(parameters.id ?? ''), ok({});
      throw new Error(`Unexpected connector call ${operationName}`);
    },
    createRecordAsync: async (table: string, data: Record<string, unknown>) => {
      if (table !== 'ev_foliumsettings') throw new Error(`Unexpected create on ${table}`);
      const id = `set-${Object.keys(settingRows).length + 1}`;
      settingRows[id] = { ...data, ev_foliumsettingid: id };
      return ok({ ev_foliumsettingid: id });
    },
    deleteRecordAsync: async () => {
      throw new Error('Folium never hard-deletes');
    },
    updateRecordAsync: async (table: string, id: string, data: Record<string, unknown>) => {
      updates.push({ table, id, data });
      if (settingRows[id]) return (settingRows[id] = { ...settingRows[id], ...data }), ok({});
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

describe('connections', () => {
  it('loads related people in both directions, once each', async () => {
    rows['c-3'] = { contactid: 'c-3', fullname: 'Ben Miller' };
    connectionRows._record1id_value = [{ _record2id_value: 'c-2', [`_record2roleid_value${FORMATTED}`]: 'Spouse' }];
    connectionRows._record2id_value = [
      { _record1id_value: 'c-3', [`_record1roleid_value${FORMATTED}`]: 'Son', ev_sharepct: '50' },
      // The reciprocal row Dataverse keeps for the spouse.
      { _record1id_value: 'c-2', [`_record1roleid_value${FORMATTED}`]: 'Spouse' },
    ];
    try {
      const { connections } = await createPowerServices().crm.getClient('c-1');
      expect(connections.map((c) => [c.role, c.contact.contactid, c.ev_sharepct])).toEqual([
        ['Spouse', 'c-2', undefined],
        ['Son', 'c-3', 50],
      ]);
    } finally {
      delete connectionRows._record1id_value;
      delete connectionRows._record2id_value;
    }
  });
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

describe('soft delete', () => {
  it('deactivates and reactivates the same packet row, so Undo works', async () => {
    const { packets, requests } = createPowerServices();
    await packets.remove('pk-1');
    await packets.restore('pk-1');
    await requests.remove('rq-1');
    expect(updates.map((u) => [u.table, u.id, u.data.statecode])).toEqual([
      ['ev_formpackets', 'pk-1', 1],
      ['ev_formpackets', 'pk-1', 0],
      ['ev_signaturerequests', 'rq-1', 1],
    ]);
  });

  it('lists active rows only', async () => {
    const { packets, requests } = createPowerServices();
    queries.length = 0;
    await packets.list();
    await requests.listMine();
    await requests.listForContact('c-1');
    expect(queries.every((q) => q.filter?.includes('statecode eq 0'))).toBe(true);
  });
});

describe('signature request rows', () => {
  it('writes ev_status as the choice option and the expiry date to its own column', async () => {
    const { requests } = createPowerServices();
    const r = seedRequests().find((x) => x.id === 'req-0940')!;
    await requests.save({ ...r, id: 'rq-9', status: 'Expired' });
    const row = updates.find((u) => u.id === 'rq-9')!.data;
    expect(row.ev_status).toBe(SIGNATURE_STATUS_OPTIONS.Expired);
    expect(row.ev_expireson).toBe(r.expiresOn);
    expect(new Set(Object.values(SIGNATURE_STATUS_OPTIONS)).size).toBe(Object.keys(SIGNATURE_STATUS_OPTIONS).length);
  });
});

describe('firm policy row', () => {
  it('reads defaults until a Policy row exists, then round-trips it beside the Firm row', async () => {
    for (const k of Object.keys(settingRows)) delete settingRows[k];
    const { directory } = createPowerServices();
    expect(await directory.getPolicy()).toEqual({ sharing: 'groups', repDataVisibility: 'assistants', pdfDownload: 'all' });
    await directory.saveFirm(FIRM);
    const policy = { sharing: 'off' as const, repDataVisibility: 'groupMembers' as const, pdfDownload: 'signedOnly' as const, draftRetentionDays: 30, lockMessage: true };
    await directory.savePolicy(policy);
    expect(Object.values(settingRows).map((r) => r.ev_name).sort()).toEqual(['Firm', 'Policy']);
    expect(await directory.getPolicy()).toEqual(policy);
    // The firm profile still reads its own row.
    expect((await directory.getFirm()).name).toBe(FIRM.name);
    // Saving again updates the same row.
    await directory.savePolicy({ ...policy, sharing: 'anyone' });
    expect(Object.keys(settingRows)).toHaveLength(2);
    expect((await directory.getPolicy()).sharing).toBe('anyone');
  });
});

describe('deleting draft PDFs', () => {
  const url = 'https://everence.sharepoint.com/sites/CRM/contact/Jordan/DRAFT%20EV-1120.pdf';

  it('deletes the file it finds, and treats a missing file as already deleted', async () => {
    const { drafts } = createPowerServices();
    deletedFiles.length = 0;
    fileLookup = { success: true, data: { Id: 'item-1' } };
    await drafts.removeFile(url);
    expect(deletedFiles).toEqual(['item-1']);
    fileLookup = { success: false, error: { status: 404, message: 'File not found' } };
    await expect(drafts.removeFile(url)).resolves.toBeUndefined();
  });

  it('reports any other lookup failure, so the file stays on record', async () => {
    const { drafts } = createPowerServices();
    fileLookup = { success: false, error: { status: 429, message: 'Too many requests' } };
    await expect(drafts.removeFile(url)).rejects.toThrow();
  });
});
