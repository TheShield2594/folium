import { beforeEach, describe, expect, it } from 'vitest';
import { prefillPacket } from '../domain/prefill';
import { applyEnvelopeStatus } from '../domain/requests';
import type { ClientRecord, PacketItem, SignatureRequest } from '../domain/types';
import { createDemoServices, recordedUsage, resetDemo } from '../services/demo';
import { CLIENTS, FIRM, GROUPS, seedRequests, TEMPLATES, USERS } from '../services/demo/seed';
import type { Services } from '../services/types';
import { createUsageQueue } from '../services/usage';
import { saveDraft } from './actions';
import { track, trackStatus, useApp } from './store';

// The hook points in demo mode: each writes its event, and a usage outage never gets in
// the way of the work.

const client = structuredClone(CLIENTS['c-jordan']) as ClientRecord;
const [me, , assistant] = USERS;
const items: PacketItem[] = [{ id: 'pi-1', templateId: 'tpl-ev1120-0326', accountId: 'a-j1' }];
const fills = () => prefillPacket(items.map((i) => ({ template: TEMPLATES.find((t) => t.id === i.templateId)!, account: client.accounts.find((a) => a.accountid === i.accountId), itemId: i.id })), { client, advisor: me, firm: FIRM }, {});
let services: Services;

beforeEach(() => {
  resetDemo();
  services = createDemoServices();
  useApp.setState({ services, me, users: USERS, groups: GROUPS, actingForId: me.systemuserid, templates: TEMPLATES, client, contactId: 'c-jordan', packet: { items: [], values: {}, title: '', attachments: [], sharedWith: [] } });
});

const types = () => recordedUsage().map((e) => e.type);

describe('usage hook points (demo)', () => {
  it('records a form added to the packet, once per add', async () => {
    expect(useApp.getState().addToPacket('tpl-ev1120-0326')).toBe('added');
    expect(useApp.getState().addToPacket('tpl-ev1120-0326')).toBe('present');
    useApp.getState().addToPacket('tpl-ev1120-0326', undefined, { duplicate: true });
    await services.usage.flush();
    expect(recordedUsage()).toMatchObject([
      { type: 'form.added', formNumber: 'EV-1120', userId: 'usr-advisor-1', contactId: 'c-jordan', region: 'Goshen' },
      { type: 'form.added', formNumber: 'EV-1120' },
    ]);
  });

  it('records the Review downloads as pdf.fillable, pdf.flattened and pdf.print', async () => {
    const forms = fills().map((f) => f.template);
    track('pdf.fillable', forms, { detail: { mode: 'fillable' } });
    track('pdf.flattened', forms, { detail: { mode: 'flatten' } });
    track('pdf.print', forms, { detail: { mode: 'print' } });
    await services.usage.flush();
    expect(recordedUsage().map((e) => [e.type, e.detail?.mode])).toEqual([
      ['pdf.fillable', 'fillable'],
      ['pdf.flattened', 'flatten'],
      ['pdf.print', 'print'],
    ]);
  });

  it('records an Assistant’s work for the User', async () => {
    useApp.setState({ me: assistant, actingForId: me.systemuserid });
    track('request.inperson', [TEMPLATES[0]]);
    await services.usage.flush();
    expect(recordedUsage()[0]).toMatchObject({ userId: 'usr-assistant-1', actingForId: 'usr-advisor-1' });
  });

  it('records a draft the advisor saves, but not the save on the way to sending', async () => {
    const packet = { items, values: {}, title: 'Bene', attachments: [], sharedWith: [] };
    const saved = await saveDraft({ services, packet, fills: fills(), contactId: 'c-jordan', me, owner: me, trackUsage: true });
    await saveDraft({ services, packet, fills: fills(), contactId: 'c-jordan', me, owner: me, existing: saved });
    await services.usage.flush();
    expect(recordedUsage()).toMatchObject([{ type: 'draft.saved', requestId: saved.id, formNumber: 'EV-1120' }]);
  });

  it('records what Check status finds once, however often it is checked', async () => {
    const sent: SignatureRequest = { ...seedRequests().find((r) => r.status === 'Sent')!, viewedOn: undefined };
    const viewed = applyEnvelopeStatus(sent, { status: 'Viewed', viewedOn: '2026-10-12T10:00:00.000Z', recipients: [] }).next;
    const signed = applyEnvelopeStatus(viewed, { status: 'Signed', signedOn: '2026-10-12T11:00:00.000Z', recipients: [] }).next;
    trackStatus(sent, viewed);
    trackStatus(viewed, signed);
    // Another device (or the Connect flow) reports the same change.
    trackStatus(sent, signed);
    await services.usage.flush();
    const n = sent.documents.length;
    expect(types()).toEqual([...Array(n).fill('request.viewed'), ...Array(n).fill('request.signed')]);
    expect(recordedUsage()[0]).toMatchObject({ occurredOn: '2026-10-12T10:00:00.000Z', requestId: sent.id, userId: sent.preparedById ?? sent.ownerId });
  });

  it('never blocks or slows a save while usage writes are failing or hanging', async () => {
    let calls = 0;
    const down = createUsageQueue(() => {
      calls++;
      return new Promise<void>(() => undefined);
    }, { batchSize: 1, flushOnPageHide: false });
    const broken = { ...services, usage: down };
    useApp.setState({ services: broken });
    const packet = { items, values: {}, title: 'Bene', attachments: [], sharedWith: [] };
    const saved = await saveDraft({ services: broken, packet, fills: fills(), contactId: 'c-jordan', me, owner: me, trackUsage: true });
    expect(saved.status).toBe('Drafted');
    expect(useApp.getState().addToPacket('tpl-ev1004-0125')).toBe('added');
    // Both events were handed over; the hung write holds nothing up.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(down.pending()).toBe(1);
    down.dispose();

    const throwing = { ...services, usage: { track: () => { throw new Error('boom'); }, flush: async () => undefined } };
    useApp.setState({ services: throwing });
    expect(() => track('pdf.print', [TEMPLATES[0]])).not.toThrow();
    expect(() => useApp.getState().addToPacket('tpl-px310-0826')).not.toThrow();
  });
});
