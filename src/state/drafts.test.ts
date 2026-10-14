import { beforeEach, describe, expect, it } from 'vitest';
import { prefillPacket, snapshotDiff, prefillSnapshot } from '../domain/prefill';
import type { ClientRecord, PacketItem } from '../domain/types';
import { createDemoServices, resetDemo } from '../services/demo';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import { attachmentBytes, saveDraft, unreachableAttachments } from './actions';
import { useApp, type Packet } from './store';

const client = structuredClone(CLIENTS['c-jordan']) as ClientRecord;
const me = USERS[0];
const scope = { client, advisor: me, firm: FIRM, today: new Date(2026, 9, 13) };
const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
// Two forms about two different IRAs, in a non-default order.
const items: PacketItem[] = [
  { templateId: 'tpl-px310-0826', accountId: 'a-j3' },
  { templateId: 'tpl-ev1004-0125', accountId: 'a-j1' },
];
const fillsFor = (c: ClientRecord, its: PacketItem[], values: Record<string, string> = {}) =>
  prefillPacket(its.map((i) => ({ template: tpl(i.templateId), account: c.accounts.find((a) => a.accountid === i.accountId) })), { ...scope, client: c }, values);
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
    useApp.getState().setPacketAccount(first.templateId, 'a-j1');
    expect(useApp.getState().packet.items[0]).toEqual({ templateId: first.templateId, accountId: 'a-j1' });
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
  const its: PacketItem[] = [{ templateId: 'tpl-ev1120-0326' }];

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

  it('ignores an advisor override: the diff is about what CRM says', () => {
    const snap = prefillSnapshot(fillsFor(client, its, { 'contact.address1_city': 'Somewhere' }));
    expect(snap['contact.address1_city']).toBe('Goshen');
  });
});
