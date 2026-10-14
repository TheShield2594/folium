import { beforeEach, describe, expect, it } from 'vitest';
import { findNameClash, nextFreeName } from '../domain/drafts';
import { prefillPacket, snapshotDiff, prefillSnapshot } from '../domain/prefill';
import type { ClientRecord, PacketItem, SignatureRequest } from '../domain/types';
import { createDemoServices, resetDemo } from '../services/demo';
import { removedFiles } from '../services/demo/index';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import { attachmentBytes, deleteDraft, fillPacket, saveDraft, unreachableAttachments } from './actions';
import { PACKET_LIMIT, useApp, type Packet } from './store';

const client = structuredClone(CLIENTS['c-jordan']) as ClientRecord;
const me = USERS[0];
const scope = { client, advisor: me, firm: FIRM, today: new Date(2026, 9, 13) };
const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
// Two forms about two different IRAs, in a non-default order.
const items: PacketItem[] = [
  { id: 'pi-1', templateId: 'tpl-px310-0826', accountId: 'a-j3' },
  { id: 'pi-2', templateId: 'tpl-ev1004-0125', accountId: 'a-j1' },
];
const fillsFor = (c: ClientRecord, its: PacketItem[], values: Record<string, string> = {}) =>
  prefillPacket(its.map((i) => ({ template: tpl(i.templateId), account: c.accounts.find((a) => a.accountid === i.accountId), itemId: i.id, copy: i.copy })), { ...scope, client: c }, values);
const packet = (p: Partial<Packet> = {}): Packet => ({ items, values: {}, title: '', attachments: [], sharedWith: [], ...p });

beforeEach(() => {
  resetDemo();
  useApp.setState({ templates: TEMPLATES, client, packet: packet() });
});

describe('resuming a draft', () => {
  it('reopens each form on the account it was saved with, in order', async () => {
    const services = createDemoServices();
    const saved = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me });
    expect(saved.documents.map((d) => [d.templateId, d.accountId])).toEqual(items.map((i) => [i.templateId, i.accountId]));
    useApp.getState().loadRequest(saved);
    expect(useApp.getState().packet.items).toEqual(items);
  });

  it('falls back to a suggestion and flags it when the saved account is gone', async () => {
    const services = createDemoServices();
    const saved = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me });
    useApp.setState({ client: { ...client, accounts: client.accounts.filter((a) => a.accountid !== 'a-j3') } });
    useApp.getState().loadRequest(saved);
    const [first, second] = useApp.getState().packet.items;
    expect(first.accountReplaced).toBe(true);
    expect(first.accountId).not.toBe('a-j3');
    expect(second).toEqual(items[1]);
    // Picking an account clears the flag.
    useApp.getState().setPacketAccount(first.id, 'a-j1');
    expect(useApp.getState().packet.items[0]).toEqual({ id: first.id, templateId: first.templateId, accountId: 'a-j1' });
  });

  it('saves the account a form fell back to when none was picked', async () => {
    const services = createDemoServices();
    const unpicked: PacketItem[] = [{ id: 'pi-u', templateId: 'tpl-px310-0826' }];
    const saved = await saveDraft({ services, packet: packet({ items: unpicked }), fills: fillsFor(client, unpicked), contactId: 'c-jordan', me, owner: me });
    expect(saved.documents[0].accountId).toBe(client.accounts[0].accountid);
  });

  it('hands back the saved row before writing PDFs, so a failed write can be retried on it', async () => {
    const demo = createDemoServices();
    const failing = async (): Promise<{ url: string }> => {
      throw new Error('SharePoint unavailable');
    };
    const services = { ...demo, drafts: { ...demo.drafts, saveDraft: failing } };
    let row: SignatureRequest | undefined;
    await expect(saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, writePdfs: true, onSaved: (r) => (row = r) })).rejects.toThrow(/SharePoint/);
    expect(row && (await services.requests.get(row.id))?.title).toBe(row?.title);
  });

  it('keeps send setup with the draft', async () => {
    const services = createDemoServices();
    const signers = [{ role: 'Owner', name: 'Jordan Miller', email: 'j@example.com', order: 1, auth: 'email' as const }];
    const sendSetup = { signers, ccs: [], subject: 'Sign please', message: 'Hi', anyOrder: true, reminderDays: 0, expiresInDays: 120 };
    const saved = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, sendSetup });
    const reread = (await services.requests.get(saved.id))!;
    expect({ signers: reread.signers, ccs: reread.ccs, subject: reread.subject, message: reread.message, anyOrder: reread.anyOrder, reminderDays: reread.reminderDays, expiresInDays: reread.expiresInDays }).toEqual(sendSetup);
  });

  it('stores attachments with the draft so they survive a reload', async () => {
    const services = createDemoServices();
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const meta = { id: 'att-1', name: 'Driver licence.pdf', size: 4, addedOn: '2026-10-14' };
    services.attachments.set(meta.id, { meta, bytes });
    const saved = await saveDraft({ services, packet: packet({ attachments: [meta] }), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me });
    expect(saved.attachments[0].storedAt?.itemId).toBeTruthy();

    // A fresh session (reload, or a colleague) has no bytes in memory.
    const later = createDemoServices();
    later.attachments.clear();
    expect(unreachableAttachments(later, saved.attachments)).toEqual([]);
    expect(await attachmentBytes(later, saved.attachments[0])).toEqual(bytes);
    // An attachment never stored and not in memory can't be sent.
    const lost = { ...meta, id: 'att-2', name: 'Statement.pdf' };
    expect(unreachableAttachments(later, [lost])).toEqual([lost]);
    await expect(attachmentBytes(later, lost)).rejects.toThrow(/Re-attach Statement.pdf/);
  });
});

describe('snapshotDiff', () => {
  const its: PacketItem[] = [{ id: 'pi-b', templateId: 'tpl-ev1120-0326' }];

  it('lists CRM values that changed, including ones now empty, and never SSNs', () => {
    const snap = prefillSnapshot(fillsFor(client, its));
    expect(Object.keys(snap).some((k) => k.includes('ev_ssn'))).toBe(false);
    expect(snapshotDiff(snap, fillsFor(client, its))).toEqual([]);

    const moved = structuredClone(client);
    moved.contact.address1_city = 'Elkhart';
    moved.contact.emailaddress1 = undefined;
    moved.contact.ev_ssn = '999-99-9999';
    const diff = snapshotDiff(snap, fillsFor(moved, its));
    const byKey = Object.fromEntries(diff.map((d) => [d.key, d]));
    expect(byKey['contact.address1_city']).toMatchObject({ saved: 'Goshen', now: 'Elkhart' });
    expect(byKey['contact.emailaddress1']).toMatchObject({ now: '' });
    expect(diff.some((d) => d.key.includes('ssn'))).toBe(false);
  });

  it('ignores an advisor override or a cleared field: the diff is about what CRM says', () => {
    expect(prefillSnapshot(fillsFor(client, its, { 'contact.address1_city': 'Somewhere' }))['contact.address1_city']).toBe('Goshen');
    const cleared = prefillSnapshot(fillsFor(client, its, { 'contact.address1_city': '' }));
    expect(cleared['contact.address1_city']).toBe('Goshen');
    expect(snapshotDiff(cleared, fillsFor(client, its, { 'contact.address1_city': '' }))).toEqual([]);
  });
});

describe('draft and packet names', () => {
  const list = [
    { id: '1', name: 'IRA distribution' },
    { id: '2', name: 'Shared  Rollover set' },
  ];

  it('finds clashes ignoring case and spacing, across own and shared items', () => {
    expect(findNameClash('  ira   DISTRIBUTION ', list)?.id).toBe('1');
    expect(findNameClash('shared rollover set', list)?.id).toBe('2');
    expect(findNameClash('IRA distribution', list, '1')).toBeUndefined();
    expect(findNameClash('Roth conversion', list)).toBeUndefined();
    expect(findNameClash('   ', list)).toBeUndefined();
  });

  it('suggests the next free name', () => {
    expect(nextFreeName('Roth', ['IRA distribution'])).toBe('Roth');
    expect(nextFreeName('IRA distribution', ['IRA distribution'])).toBe('IRA distribution (2)');
    expect(nextFreeName('IRA distribution', ['ira distribution', 'IRA distribution (2)'])).toBe('IRA distribution (3)');
    expect(nextFreeName('IRA distribution (2)', ['IRA distribution', 'IRA distribution (2)'])).toBe('IRA distribution (3)');
  });
});

describe('deleting drafts and packets', () => {
  it('soft-deletes a draft and Undo brings back the same row', async () => {
    const services = createDemoServices();
    const saved = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me });
    await services.requests.remove(saved.id);
    expect((await services.requests.listForContact('c-jordan')).some((r) => r.id === saved.id)).toBe(false);
    await services.requests.restore(saved.id);
    expect((await services.requests.get(saved.id))?.title).toBe(saved.title);
  });

  it('restores a deleted packet with its ID', async () => {
    const services = createDemoServices();
    const [p] = await services.packets.list();
    await services.packets.remove(p.id);
    expect((await services.packets.list()).some((x) => x.id === p.id)).toBe(false);
    await services.packets.restore(p.id);
    expect((await services.packets.list()).find((x) => x.id === p.id)?.name).toBe(p.name);
  });

  it('gives two drafts with the same form different SharePoint file names', async () => {
    const services = createDemoServices();
    const one = await saveDraft({ services, packet: packet({ title: 'IRA distribution' }), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, writePdfs: true });
    const two = await saveDraft({ services, packet: packet({ title: 'IRA distribution' }), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, writePdfs: true });
    expect(one.draftFiles).toHaveLength(2);
    expect(one.draftFiles![0].name).toMatch(/^DRAFT PX-310 IRA distribution – \w{8}\.pdf$/);
    const names = new Set([...one.draftFiles!, ...two.draftFiles!].map((f) => f.name));
    expect(names.size).toBe(4);
  });
});

describe('copies of a form', () => {
  const empty = () => useApp.setState({ packet: packet({ items: [] }) });

  it('adds a copy on the next unused account, starting from the last copy’s values', () => {
    empty();
    expect(useApp.getState().addToPacket('tpl-px310-0826')).toBe('added');
    const first = useApp.getState().packet.items[0];
    expect(useApp.getState().addToPacket('tpl-px310-0826')).toBe('present');
    useApp.getState().setValue('swp.amount', '500');
    expect(useApp.getState().addToPacket('tpl-px310-0826', undefined, { duplicate: true })).toBe('added');
    const [, second] = useApp.getState().packet.items;
    expect(second).toMatchObject({ templateId: 'tpl-px310-0826', copy: 2 });
    expect(second.id).not.toBe(first.id);
    // Praxis' own IRA first, then the other Traditional IRA.
    expect([first.accountId, second.accountId]).toEqual(['a-j3', 'a-j1']);
    expect(useApp.getState().packet.values[`${second.id}/swp.amount`]).toBe('500');
  });

  it('removes, moves and re-accounts one copy only', () => {
    empty();
    const add = () => useApp.getState().addToPacket('tpl-px310-0826', undefined, { duplicate: true });
    add();
    add();
    add();
    const [a, b, c] = useApp.getState().packet.items;
    useApp.getState().setValue(`${b.id}/swp.amount`, '1');
    useApp.getState().setPacketAccount(c.id, 'a-j2');
    useApp.getState().moveInPacket(c.id, -1);
    expect(useApp.getState().packet.items.map((i) => i.id)).toEqual([a.id, c.id, b.id]);
    expect(useApp.getState().packet.items.map((i) => i.accountId)).toEqual([a.accountId, 'a-j2', b.accountId]);
    useApp.getState().removeFromPacket(b.id);
    expect(useApp.getState().packet.items.map((i) => i.id)).toEqual([a.id, c.id]);
    expect(Object.keys(useApp.getState().packet.values).some((k) => k.startsWith(b.id))).toBe(false);
    expect(useApp.getState().packet.items[1].copy).toBe(3);
  });

  it('refuses a 21st form', () => {
    empty();
    for (let i = 0; i < PACKET_LIMIT; i++) expect(useApp.getState().addToPacket('tpl-ev1120-0326', undefined, { duplicate: true })).toBe('added');
    expect(useApp.getState().addToPacket('tpl-px310-0826')).toBe('full');
    expect(useApp.getState().packet.items).toHaveLength(PACKET_LIMIT);
  });

  it('resumes a draft with the same copies, accounts and values', async () => {
    const services = createDemoServices();
    const its: PacketItem[] = [
      { id: 'pi-a', templateId: 'tpl-px310-0826', accountId: 'a-j3' },
      { id: 'pi-b', templateId: 'tpl-px310-0826', accountId: 'a-j1', copy: 2 },
    ];
    const values = { 'swp.amount': '500', 'pi-b/swp.amount': '750' };
    const fills = fillsFor(client, its, values);
    const saved = await saveDraft({ services, packet: packet({ items: its, values }), fills, contactId: 'c-jordan', me, owner: me });
    expect(saved.documents.map((d) => [d.itemId, d.copy])).toEqual([['pi-a', undefined], ['pi-b', 2]]);
    useApp.getState().loadRequest(saved);
    expect(useApp.getState().packet.items).toEqual(its);
    expect(useApp.getState().packet.values).toEqual(values);
    const docs = await fillPacket(services, fills, 'fillable');
    expect(new Set(docs.map((d) => d.fileName)).size).toBe(2);
  });

  it('suggests different replacement accounts for copies whose accounts closed', async () => {
    const services = createDemoServices();
    const its: PacketItem[] = [
      { id: 'pi-a', templateId: 'tpl-px310-0826', accountId: 'a-gone-1' },
      { id: 'pi-b', templateId: 'tpl-px310-0826', accountId: 'a-gone-2', copy: 2 },
    ];
    const saved = await saveDraft({ services, packet: packet({ items: its }), fills: fillsFor(client, its), contactId: 'c-jordan', me, owner: me });
    // Both accounts have since closed.
    useApp.getState().loadRequest({ ...saved, documents: saved.documents.map((d, i) => ({ ...d, accountId: `a-gone-${i}` })) });
    const [a, b] = useApp.getState().packet.items;
    expect(a.accountReplaced && b.accountReplaced).toBe(true);
    expect(a.accountId).not.toBe(b.accountId);
  });

  it('gives older drafts item ids', () => {
    useApp.getState().loadRequest({ ...({} as SignatureRequest), id: 'r-old', title: 'Old', values: {}, attachments: [], audit: [], status: 'Drafted', createdOn: '', documents: [{ templateId: 'tpl-ev1120-0326', name: 'x', formNumber: 'EV-1120', revision: '03/2026' }] });
    const [item] = useApp.getState().packet.items;
    expect(item.id).toMatch(/^pi-/);
    expect(item.copy).toBeUndefined();
  });
});

describe('packet state', () => {
  it('adds the version of a form for the packet’s state, and round-trips the state', async () => {
    useApp.setState({ packet: packet({ items: [] }) });
    useApp.getState().addToPacket('tpl-sa310-0726');
    expect(useApp.getState().packet.items[0].templateId).toBe('tpl-sa310-0726');
    useApp.setState({ packet: packet({ items: [], state: 'VA' }) });
    useApp.getState().addToPacket('tpl-sa310-0726');
    expect(useApp.getState().packet.items[0].templateId).toBe('tpl-sa310va-0726');
    // Another version of a form already in the packet counts as present.
    expect(useApp.getState().addToPacket('tpl-sa310-0726')).toBe('present');

    const services = createDemoServices();
    const p = useApp.getState().packet;
    const saved = await saveDraft({ services, packet: p, fills: fillsFor(client, p.items), contactId: 'c-jordan', me, owner: me });
    useApp.getState().loadRequest(saved);
    expect(useApp.getState().packet.state).toBe('VA');
  });
});

describe('person blocks on a draft', () => {
  it('resumes knowing who filled each block', async () => {
    const services = createDemoServices();
    const its: PacketItem[] = [{ id: 'pi-b', templateId: 'tpl-ev1120-0326' }];
    const personBlocks = { 'Primary beneficiary 2': { contactId: 'c-ruth', name: 'Ruth Miller', role: 'Trusted contact' } };
    const saved = await saveDraft({ services, packet: packet({ items: its, personBlocks }), fills: fillsFor(client, its), contactId: 'c-jordan', me, owner: me });
    useApp.getState().loadRequest((await services.requests.get(saved.id))!);
    expect(useApp.getState().packet.personBlocks).toEqual(personBlocks);
  });
});

describe('draft retention', () => {
  it('sets the expiry from the firm’s retention at every save', async () => {
    const services = createDemoServices();
    const before = Date.now();
    const saved = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, retentionDays: 30 });
    const days = (new Date(saved.expiresOn!).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
    const again = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, existing: saved, retentionDays: 7 });
    expect(new Date(again.expiresOn!).getTime()).toBeLessThan(new Date(saved.expiresOn!).getTime());
  });

  it('leaves rows the clean-up never deletes without a draft expiry', async () => {
    const services = createDemoServices();
    const printed = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, existing: { ...(await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me })), inPerson: true, expiresOn: undefined } });
    expect(printed.expiresOn).toBeUndefined();
    const off = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, retentionDays: 0 });
    expect(off.expiresOn).toBeUndefined();
  });

  it('records a forms update in the audit trail at the next save', async () => {
    const services = createDemoServices();
    const saved = await saveDraft({ services, packet: packet({ formsUpdated: 'EV-1120 Rev 03/25 → 03/2026' }), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me });
    expect(saved.audit.map((a) => a.action)).toEqual(['Forms updated', 'Draft saved']);
    expect(saved.audit[0].detail).toBe('EV-1120 Rev 03/25 → 03/2026');
  });

  it('deletes a draft’s SharePoint PDFs with the row', async () => {
    const services = createDemoServices();
    const saved = await saveDraft({ services, packet: packet({ title: 'To delete' }), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me, writePdfs: true });
    removedFiles.length = 0;
    expect(await deleteDraft(services, saved)).toEqual([]);
    expect(removedFiles).toEqual(saved.draftFiles!.map((f) => f.url));
    expect((await services.requests.listForContact('c-jordan')).some((r) => r.id === saved.id)).toBe(false);
    await services.requests.restore(saved.id);
    expect((await services.requests.get(saved.id))?.draftFiles).toBeUndefined();
  });

  it('names a form whose template is gone instead of dropping it', async () => {
    const services = createDemoServices();
    const saved = await saveDraft({ services, packet: packet(), fills: fillsFor(client, items), contactId: 'c-jordan', me, owner: me });
    useApp.setState({ templates: TEMPLATES.filter((t) => t.id !== 'tpl-px310-0826' && t.formNumber !== 'PX-310') });
    useApp.getState().loadRequest(saved);
    const first = useApp.getState().packet.items[0];
    expect(first.templateId).toBe('tpl-px310-0826');
    expect(first.missing).toMatchObject({ formNumber: 'PX-310' });
  });
});
