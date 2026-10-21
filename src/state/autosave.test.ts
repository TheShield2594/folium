import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '../domain/policy';
import { prefillPacket } from '../domain/prefill';
import type { ClientRecord, PacketItem, SignatureRequest } from '../domain/types';
import { createDemoServices, resetDemo } from '../services/demo';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import type { Services } from '../services/types';
import { audit, AUTOSAVED, saveDraft } from './actions';
import { AUTOSAVE_MS, autosaveNow, packetFills, rowFills, startAutosave } from './autosave';
import { useApp, type Packet } from './store';
import { forgetRows, noteRow, withRowVersions } from './versions';

const me = USERS[0];
const colleague = USERS[1];
const client = structuredClone(CLIENTS['c-jordan']) as ClientRecord;
const items: PacketItem[] = [{ id: 'pi-1', templateId: 'tpl-ev1120-0326' }];
const packet = (p: Partial<Packet> = {}): Packet => ({ items, values: {}, title: '', attachments: [], sharedWith: [], ...p });

let raw: Services;
let stop: (() => void) | undefined;

beforeEach(() => {
  resetDemo();
  forgetRows();
  raw = createDemoServices();
  useApp.setState({
    services: withRowVersions(raw),
    me,
    users: USERS,
    groups: [],
    firms: [FIRM],
    firm: FIRM,
    actingForId: me.systemuserid,
    templates: TEMPLATES,
    policy: DEFAULT_POLICY,
    contactId: 'c-jordan',
    client,
    requests: [],
    packet: packet(),
    autosave: { phase: 'idle' },
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

/** Type a value into the open packet, as Review does. */
const type = (key: string, value: string) => useApp.getState().setValue(key, value);
const row = async (id = useApp.getState().packet.requestId!) => (await raw.requests.get(id))!;

describe('autosave', () => {
  it('saves a new packet to a draft row a few seconds after the last edit, without PDFs', async () => {
    vi.useFakeTimers();
    stop = startAutosave();
    type('bene.Prim.1.pct', '100');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 500);
    // Still typing: the clock starts again.
    type('bene.Prim.1.pct', '60');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 500);
    expect(useApp.getState().packet.requestId).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(useApp.getState().packet.requestId).toBeDefined());

    const p = useApp.getState().packet;
    expect(p).toMatchObject({ dirty: false, autoNamed: true, pdfsBehind: true });
    const saved = await row();
    expect(saved.values['bene.Prim.1.pct']).toBe('60');
    expect(saved.title).toBe(p.title);
    expect(saved.draftFiles ?? []).toEqual([]);
    expect(saved.audit.map((a) => a.action)).toEqual([AUTOSAVED]);
    // Each save restarts the retention clock, autosave included.
    expect(saved.expiresOn).toBeDefined();
    expect(useApp.getState().autosave.phase).toBe('saved');
  });

  it('keeps one audit entry for a run of autosaves, and a Save draft after it is its own', async () => {
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    type('bene.Prim.1.pct', '90');
    await autosaveNow();
    type('bene.Prim.1.pct', '80');
    await autosaveNow();
    const saved = await row();
    expect(saved.values['bene.Prim.1.pct']).toBe('80');
    expect(saved.audit.map((a) => a.action)).toEqual([AUTOSAVED]);

    const s = useApp.getState();
    const manual = await saveDraft({ services: s.services!, packet: s.packet, fills: packetFills(s)!, contactId: 'c-jordan', me, owner: me, existing: saved });
    expect(manual.audit.map((a) => a.action)).toEqual([AUTOSAVED, 'Draft updated']);
  });

  it('does nothing when the firm keeps no drafts', async () => {
    useApp.setState({ policy: { ...DEFAULT_POLICY, draftRetentionDays: 0 } });
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    expect(useApp.getState().packet.dirty).toBe(true);
    expect(useApp.getState().packet.requestId).toBeUndefined();
    expect((await raw.requests.listForContact('c-jordan')).some((r) => r.audit.some((a) => a.action === AUTOSAVED))).toBe(false);
  });

  it('leaves a send in flight alone', async () => {
    useApp.getState().setPacket({ send: { phase: 'created', envelopeId: 'env-1', at: new Date().toISOString() } });
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    expect(useApp.getState().packet.requestId).toBeUndefined();
  });

  it('keeps edits made while it was saving as unsaved, and saves them next', async () => {
    // The advisor types while the row is being written.
    const save = raw.requests.save;
    useApp.setState({ services: withRowVersions({ ...raw, requests: { ...raw.requests, save: (r) => (type('withholding.federal', '10'), save(r)) } }) });
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    useApp.setState({ services: withRowVersions(raw) });
    expect(useApp.getState().packet).toMatchObject({ dirty: true, values: { 'bene.Prim.1.pct': '100', 'withholding.federal': '10' } });
    await autosaveNow();
    expect((await row()).values['withholding.federal']).toBe('10');
    expect(useApp.getState().packet.dirty).toBe(false);
  });

  it('stops and asks when a colleague saved the shared draft since', async () => {
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    const id = useApp.getState().packet.requestId!;
    // A colleague saves the draft from their own session.
    const theirs = await row(id);
    await raw.requests.save({ ...theirs, values: { ...theirs.values, 'bene.Prim.1.pct': '50' }, audit: [...theirs.audit, audit(colleague, 'Draft updated')] });

    type('bene.Prim.1.pct', '75');
    await autosaveNow();
    const status = useApp.getState().autosave;
    expect(status.phase).toBe('conflict');
    expect(status.conflict).toMatchObject({ reason: 'changed', row: { id } });
    // Their save stands, and this tab's edit is still unsaved.
    expect((await row(id)).values['bene.Prim.1.pct']).toBe('50');
    expect(useApp.getState().packet.dirty).toBe(true);

    // "Keep mine": write over it.
    noteRow((status.conflict as { row: SignatureRequest }).row);
    await autosaveNow();
    expect((await row(id)).values['bene.Prim.1.pct']).toBe('75');
    expect(useApp.getState().autosave.phase).toBe('saved');
  });

  it('notices its own saves from other screens, so they are not taken for a colleague’s', async () => {
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    const s = useApp.getState();
    // Save draft in Review goes through the same services.
    await saveDraft({ services: s.services!, packet: { ...s.packet, title: 'Named' }, fills: packetFills(s)!, contactId: 'c-jordan', me, owner: me, existing: await row() });
    type('bene.Prim.1.pct', '40');
    await autosaveNow();
    expect(useApp.getState().autosave.phase).toBe('saved');
    expect((await row()).values['bene.Prim.1.pct']).toBe('40');
  });

  it('says so when the draft was deleted, or sent, elsewhere', async () => {
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    const id = useApp.getState().packet.requestId!;
    await raw.requests.save({ ...(await row(id)), status: 'Sent' });
    type('bene.Prim.1.pct', '90');
    await autosaveNow();
    expect(useApp.getState().autosave.conflict).toMatchObject({ reason: 'changed', row: { status: 'Sent' } });

    await raw.requests.remove(id);
    await autosaveNow();
    expect(useApp.getState().autosave.conflict).toEqual({ reason: 'gone' });
  });

  it('writes the draft PDFs once the advisor moves on from the packet', async () => {
    stop = startAutosave();
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    const id = useApp.getState().packet.requestId!;
    expect((await row(id)).draftFiles ?? []).toEqual([]);
    useApp.getState().clearPacket();
    await vi.waitFor(async () => expect((await row(id)).draftFiles?.length).toBe(1), { timeout: 5000 });
  });

  it('builds a Save draft queued behind it on the draft it just created, not a second one', async () => {
    type('bene.Prim.1.pct', '100');
    const before = useApp.getState();
    const auto = autosaveNow();
    // Save draft clicked while the autosave is in flight, with the packet as it was.
    const manual = saveDraft({ services: before.services!, packet: { ...before.packet, title: 'Beneficiaries' }, fills: packetFills(before)!, contactId: 'c-jordan', me, owner: me });
    await auto;
    const saved = await manual;
    expect(saved.id).toBe(useApp.getState().packet.requestId);
    expect(saved.audit.map((a) => a.action)).toEqual([AUTOSAVED, 'Draft updated']);
  });
});

describe('autosave, after review', () => {
  it('keeps the CRM values "Changed in Dynamics" compares against until each is settled', async () => {
    useApp.getState().setPacket({ snapshot: { 'contact.fullname': 'Jordan Miller (old)', 'contact.emailaddress1': 'old@example.com' } });
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    expect(useApp.getState().packet.snapshot).toMatchObject({ 'contact.fullname': 'Jordan Miller (old)', 'contact.emailaddress1': 'old@example.com' });
    expect((await row()).prefillSnapshot).toMatchObject({ 'contact.fullname': 'Jordan Miller (old)' });
    // Settling one (Review drops it from the snapshot) takes the current value at the next autosave.
    const { 'contact.fullname': _settled, ...rest } = useApp.getState().packet.snapshot!;
    useApp.getState().setPacket({ snapshot: rest });
    type('bene.Prim.1.pct', '90');
    await autosaveNow();
    expect(useApp.getState().packet.snapshot?.['contact.fullname']).not.toBe('Jordan Miller (old)');
    expect(useApp.getState().packet.snapshot?.['contact.emailaddress1']).toBe('old@example.com');
  });

  it('fills left-behind PDFs from the saved row, not edits discarded on the way out', async () => {
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    const saved = await row();
    // Edit and add a form, then Discard at the leave prompt (it only clears dirty).
    type('bene.Prim.1.pct', '5');
    useApp.getState().addToPacket('tpl-ev1004-0125');
    useApp.getState().setPacket({ dirty: false });
    const fills = rowFills(useApp.getState(), saved)!;
    expect(fills.map((f) => f.itemId)).toEqual(['pi-1']);
    expect(fills[0].fields.find((x) => x.key === 'bene.Prim.1.pct')?.value).toBe('100');
  });

  it('saves into the packet’s draft even when the caller’s list doesn’t have it', async () => {
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    const s = useApp.getState();
    const saved = await saveDraft({ services: s.services!, packet: { ...s.packet, autoNamed: undefined }, fills: packetFills(s)!, contactId: 'c-jordan', me, owner: me });
    expect(saved.id).toBe(s.packet.requestId);
  });

  it('keeps the listed copy of the draft current', async () => {
    type('bene.Prim.1.pct', '100');
    await autosaveNow();
    const id = useApp.getState().packet.requestId!;
    useApp.setState({ requests: [await row(id)] });
    type('bene.Prim.1.pct', '90');
    await autosaveNow();
    expect(useApp.getState().requests.find((r) => r.id === id)?.values['bene.Prim.1.pct']).toBe('90');
  });
});

describe('packetFills', () => {
  it('fills the packet as Review does', () => {
    const s = useApp.getState();
    const t = TEMPLATES.find((x) => x.id === items[0].templateId)!;
    const expected = prefillPacket([{ template: t, itemId: 'pi-1', account: undefined, copy: undefined }], { client, advisor: me, firm: FIRM, firms: [FIRM], firmGroup: undefined }, {});
    expect(packetFills(s)?.map((f) => f.fields.map((x) => [x.key, x.value]))).toEqual(expected.map((f) => f.fields.map((x) => [x.key, x.value])));
  });
});
