import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PacketItem } from '../domain/types';
import { createDemoServices, resetDemo } from '../services/demo';
import { CLIENTS, TEMPLATES } from '../services/demo/seed';
import { ago, clearJournal, newerThanDraft, readJournal, redactPacket, sensitiveKeys, writeJournal } from './journal';
import { startJournal, useApp, type Packet } from './store';

const items: PacketItem[] = [{ id: 'pi-1', templateId: 'tpl-ev1120-0326' }, { id: 'pi-2', templateId: 'tpl-px310-0826', accountId: 'a-j3' }];
const values = { 'bene.Prim.1.pct': '100', 'withholding.federal': '10', 'contact.ev_ssn': '412-55-0193', 'bene.Prim.1.ssn': '123-45-6789', 'own.tin': '12-3456789' };
const packet = (p: Partial<Packet> = {}): Packet => ({ items, values: {}, title: '', attachments: [], sharedWith: [], ...p });

let stop: (() => void) | undefined;

beforeEach(() => {
  resetDemo();
  sessionStorage.clear();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  useApp.setState({ pendingRestore: undefined, leavePrompt: undefined, packet: packet({ items: [] }) });
});

describe('packet journal', () => {
  it('keeps SSNs and tax IDs out of the browser', () => {
    const r = redactPacket(packet({ values }));
    expect(r.values).toEqual({ 'bene.Prim.1.pct': '100', 'withholding.federal': '10' });
  });

  it('leaves out values of SSN, EIN and TIN fields whatever their key is called', () => {
    const t = {
      ...TEMPLATES[0],
      id: 'tpl-tax',
      mapping: {
        ...TEMPLATES[0].mapping,
        fields: [
          { pdfField: 'Owner_TaxID', source: 'advisor', required: false, key: 'ownerTaxId', format: 'ein' as const },
          { pdfField: 'Acct_TIN', source: 'account.ev_tin', required: false, format: 'ssnOrTin' as const },
          { pdfField: 'Note', source: 'advisor', required: false, key: 'note' },
        ],
      },
    };
    const sensitive = sensitiveKeys([t]);
    expect(sensitive('ownerTaxId')).toBe(true);
    expect(sensitive('account[a-j1].ev_tin')).toBe(true);
    expect(sensitive('note')).toBe(false);
    // The form is no longer in the packet, but the value it left behind is still left out.
    const p = packet({ items: [{ id: 'pi-1', templateId: 'tpl-ev1120-0326' }], values: { ownerTaxId: '12-3456789', 'account[a-j1].ev_tin': '12-3456789', note: 'hello' }, snapshot: { ownerTaxId: '98-7654321', 'contact.fullname': 'Jordan' } });
    writeJournal({ userId: 'u', contactId: 'c', packet: { ...p, dirty: true }, sensitive });
    const saved = readJournal('u')!.packet;
    expect(saved.values).toEqual({ note: 'hello' });
    expect(saved.snapshot).toEqual({ 'contact.fullname': 'Jordan' });
  });

  it('keeps the restore offer when the client can’t be opened', async () => {
    const services = createDemoServices();
    const offer = { v: 1 as const, userId: 'u', contactId: 'c-missing', packet: packet({ dirty: true }), savedAt: new Date().toISOString() };
    useApp.setState({ services, contactId: 'c-jordan', pendingRestore: offer, packet: packet({ items: [] }) });
    await expect(useApp.getState().restoreJournal()).rejects.toBeTruthy();
    expect(useApp.getState().pendingRestore).toBe(offer);
  });

  it('keeps the current client and packet when the restore’s client fails to load', async () => {
    const services = createDemoServices();
    const offer = { v: 1 as const, userId: 'u', contactId: 'c-missing', packet: packet({ dirty: true }), savedAt: new Date().toISOString() };
    const current = packet({ values: { x: '1' }, dirty: false });
    useApp.setState({ services, contactId: 'c-jordan', client: CLIENTS['c-jordan'], pendingRestore: offer, packet: current });
    await expect(useApp.getState().restoreJournal()).rejects.toBeTruthy();
    expect(useApp.getState().packet).toBe(current);
    expect(useApp.getState().contactId).toBe('c-jordan');
    expect(useApp.getState().client).toBe(CLIENTS['c-jordan']);
    expect(useApp.getState().clientLoading).toBe(false);
    expect(useApp.getState().pendingRestore).toBe(offer);
  });

  it('asks before a restore replaces unsaved work, and Cancel keeps both', async () => {
    const services = createDemoServices();
    const offer = { v: 1 as const, userId: 'u', contactId: 'c-priya', packet: packet({ dirty: true }), savedAt: new Date().toISOString() };
    const current = packet({ values: { x: '1' }, dirty: true });
    useApp.setState({ services, contactId: 'c-jordan', pendingRestore: offer, packet: current });
    const restoring = useApp.getState().restoreJournal();
    await vi.waitFor(() => expect(useApp.getState().leavePrompt).toBeTruthy());
    useApp.getState().leavePrompt!.resolve('cancel');
    await restoring;
    expect(useApp.getState().packet).toBe(current);
    expect(useApp.getState().contactId).toBe('c-jordan');
    expect(useApp.getState().pendingRestore).toBe(offer);
  });

  it('round-trips: save → reload → restore → discard', async () => {
    vi.useFakeTimers();
    const services = createDemoServices();
    const me = await services.directory.currentUser();
    useApp.setState({ services, me, contactId: 'c-jordan', client: CLIENTS['c-jordan'], templates: TEMPLATES, packet: packet({ title: 'Beneficiary update' }) });
    stop = startJournal();

    for (const [k, v] of Object.entries(values)) useApp.getState().setValue(k, v);
    expect(useApp.getState().packet.dirty).toBe(true);
    // Debounced: nothing yet, then written a second after the last change.
    expect(readJournal(me.systemuserid)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    const saved = readJournal(me.systemuserid)!;
    expect(saved.contactId).toBe('c-jordan');
    expect(saved.contactName).toBe('Jordan A. Miller');
    expect(saved.packet.items).toEqual(items);

    // "Reload": the in-memory packet is gone; boot finds the journal and offers it.
    stop();
    stop = undefined;
    useApp.setState({ packet: packet({ items: [] }), pendingRestore: undefined });
    vi.useRealTimers();
    await useApp.getState().boot(services, 'c-jordan');
    expect(useApp.getState().pendingRestore?.savedAt).toBe(saved.savedAt);

    await useApp.getState().restoreJournal();
    const back = useApp.getState().packet;
    expect(back.items).toEqual(items);
    expect(back.title).toBe('Beneficiary update');
    expect(back.values).toEqual({ 'bene.Prim.1.pct': '100', 'withholding.federal': '10' });
    expect(back.dirty).toBe(true);
    expect(useApp.getState().pendingRestore).toBeUndefined();

    // Discarding an offered copy removes it from storage.
    useApp.setState({ pendingRestore: readJournal(me.systemuserid) });
    useApp.getState().discardJournal();
    expect(readJournal(me.systemuserid)).toBeUndefined();
  });

  it('clears itself once the packet is saved or sent', async () => {
    vi.useFakeTimers();
    const services = createDemoServices();
    const me = await services.directory.currentUser();
    useApp.setState({ services, me, contactId: 'c-jordan', client: CLIENTS['c-jordan'], templates: TEMPLATES, packet: packet() });
    stop = startJournal();
    useApp.getState().setValue('withholding.federal', '10');
    await vi.advanceTimersByTimeAsync(1000);
    expect(readJournal(me.systemuserid)).toBeTruthy();
    useApp.getState().setPacket({ requestId: 'r1', dirty: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(readJournal(me.systemuserid)).toBeUndefined();

    // A send in flight is kept even when the work itself is saved.
    useApp.getState().setPacket({ send: { phase: 'created', envelopeId: 'env-1', at: new Date().toISOString() } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(readJournal(me.systemuserid)?.packet.send?.envelopeId).toBe('env-1');
    useApp.getState().clearPacket();
    await vi.advanceTimersByTimeAsync(1000);
    expect(readJournal(me.systemuserid)).toBeUndefined();
  });

  it('isn’t offered when the draft was saved after it', () => {
    writeJournal({ userId: 'u', contactId: 'c', packet: packet({ dirty: true }), savedAt: '2026-10-14T10:00:00Z' });
    const j = readJournal('u')!;
    expect(newerThanDraft(j, '2026-10-14T09:59:00Z')).toBe(true);
    expect(newerThanDraft(j, '2026-10-14T10:05:00Z')).toBe(false);
    expect(newerThanDraft(j, undefined)).toBe(true);
    clearJournal('u');
    expect(readJournal('u')).toBeUndefined();
    expect(ago('2026-10-14T10:00:00Z', Date.parse('2026-10-14T10:04:10Z'))).toBe('4 min ago');
  });

  it('ignores another user’s journal and junk', () => {
    sessionStorage.setItem('folium.journal.u', '{not json');
    expect(readJournal('u')).toBeUndefined();
    writeJournal({ userId: 'someone-else', contactId: 'c', packet: packet({ dirty: true }) });
    expect(readJournal('u')).toBeUndefined();
  });
});

describe('unsaved-work guards', () => {
  it('marks edits dirty but not bookkeeping', () => {
    useApp.setState({ packet: packet() });
    useApp.getState().setPacket({ requestId: 'r1', snapshot: {} });
    expect(useApp.getState().packet.dirty).toBeFalsy();
    useApp.getState().setPacket({ attachments: [] });
    expect(useApp.getState().packet.dirty).toBe(true);
    useApp.getState().setPacket({ dirty: false });
    useApp.getState().moveInPacket('pi-2', -1);
    expect(useApp.getState().packet.dirty).toBe(true);
  });

  it('asks before switching clients with unsaved work, and Cancel keeps it', async () => {
    const services = createDemoServices();
    useApp.setState({ services, contactId: 'c-jordan', client: CLIENTS['c-jordan'], templates: TEMPLATES, packet: packet({ values: { x: '1' }, dirty: true }) });

    const cancelled = useApp.getState().openContact('c-priya');
    await vi.waitFor(() => expect(useApp.getState().leavePrompt?.reason).toBe('switch'));
    useApp.getState().leavePrompt!.resolve('cancel');
    expect(await cancelled).toBe(false);
    expect(useApp.getState().contactId).toBe('c-jordan');
    expect(useApp.getState().packet.values).toEqual({ x: '1' });

    const discarded = useApp.getState().openContact('c-priya');
    await vi.waitFor(() => expect(useApp.getState().leavePrompt).toBeTruthy());
    useApp.getState().leavePrompt!.resolve('discard');
    expect(await discarded).toBe(true);
    expect(useApp.getState().contactId).toBe('c-priya');
    expect(useApp.getState().packet.items).toEqual([]);
  });

  it('doesn’t ask when nothing is unsaved', async () => {
    useApp.setState({ services: createDemoServices(), contactId: 'c-jordan', packet: packet({ dirty: false }) });
    expect(await useApp.getState().openContact('c-priya')).toBe(true);
    expect(useApp.getState().leavePrompt).toBeUndefined();
  });

  it('restores a send in progress from a reopened draft row', () => {
    useApp.setState({ templates: TEMPLATES, client: CLIENTS['c-jordan'] });
    useApp.getState().loadRequest({
      id: 'r1',
      contactId: 'c-jordan',
      title: 't',
      sentBy: '',
      createdOn: '2026-10-14T10:00:00Z',
      provider: 'DocuSign',
      envelopeId: 'env-9',
      envelopePhase: 'created',
      status: 'Drafted',
      documents: [],
      signers: [],
      ccs: [],
      subject: '',
      message: '',
      anyOrder: false,
      uploadedToOnBase: false,
      values: {},
      attachments: [],
      audit: [],
    });
    expect(useApp.getState().packet.send).toEqual({ phase: 'created', envelopeId: 'env-9', at: '2026-10-14T10:00:00Z' });
    expect(useApp.getState().packet.dirty).toBe(false);
  });
});
