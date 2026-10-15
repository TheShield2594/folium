import { describe, expect, it } from 'vitest';
import { draftExpiry, draftExpiryInfo, draftsAllowed, expiresOnFrom, expiryInfo, isFinished, isRetainable, mapDocuSignStatus, retentionDays } from './requests';

describe('mapDocuSignStatus', () => {
  it('maps every known DocuSign status', () => {
    expect(mapDocuSignStatus('created')).toBe('Drafted');
    expect(mapDocuSignStatus('sent')).toBe('Sent');
    expect(mapDocuSignStatus('delivered')).toBe('Viewed');
    expect(mapDocuSignStatus('completed')).toBe('Signed');
    expect(mapDocuSignStatus('declined')).toBe('Declined');
    expect(mapDocuSignStatus('Completed')).toBe('Signed');
  });

  it('tells an expired envelope from one the advisor voided', () => {
    expect(mapDocuSignStatus('voided', 'Envelope has expired.')).toBe('Expired');
    expect(mapDocuSignStatus('voided', 'The envelope expired')).toBe('Expired');
    expect(mapDocuSignStatus('voided', 'Sent to an old email address')).toBe('Voided');
    expect(mapDocuSignStatus('voided')).toBe('Voided');
  });

  it('returns nothing for a status it does not know, so the stored one is kept', () => {
    expect(mapDocuSignStatus('signed')).toBeUndefined();
    expect(mapDocuSignStatus('timedout')).toBeUndefined();
    expect(mapDocuSignStatus(undefined)).toBeUndefined();
  });
});

describe('expiryInfo', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const sent = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();

  it('works out the date on send and counts the days left', () => {
    expect(expiresOnFrom('2026-10-01T09:00:00.000Z', 60)).toBe('2026-11-30T09:00:00.000Z');
    expect(expiresOnFrom(undefined, 60)).toBeUndefined();
    const e = expiryInfo({ status: 'Sent', sentOn: sent(10), expiresInDays: 60 }, now)!;
    expect(e).toMatchObject({ daysLeft: 50, soon: false, pastDue: false });
  });

  it('prefers the date DocuSign reported', () => {
    const e = expiryInfo({ status: 'Viewed', sentOn: sent(10), expiresInDays: 60, expiresOn: '2026-10-20T12:00:00Z' }, now)!;
    expect(e.expiresOn).toBe('2026-10-20T12:00:00Z');
    expect(e.daysLeft).toBe(6);
  });

  it('is soon at 7 days or fewer', () => {
    expect(expiryInfo({ status: 'Sent', sentOn: sent(53), expiresInDays: 60 }, now)!.soon).toBe(true);
    expect(expiryInfo({ status: 'Sent', sentOn: sent(52), expiresInDays: 60 }, now)!.soon).toBe(false);
    expect(expiryInfo({ status: 'Sent', sentOn: sent(59.9), expiresInDays: 60 }, now)).toMatchObject({ daysLeft: 1, soon: true, pastDue: false });
  });

  it('is past due once the date passes while Folium still has it open', () => {
    expect(expiryInfo({ status: 'Viewed', sentOn: sent(61), expiresInDays: 60 }, now)).toMatchObject({ soon: false, pastDue: true });
  });

  it('says nothing for finished requests or without a date', () => {
    expect(expiryInfo({ status: 'Signed', sentOn: sent(61), expiresInDays: 60 }, now)).toBeUndefined();
    expect(expiryInfo({ status: 'Expired', sentOn: sent(61), expiresInDays: 60 }, now)).toBeUndefined();
    expect(expiryInfo({ status: 'Sent', sentOn: sent(1) }, now)).toBeUndefined();
  });

  it('counts Expired as finished', () => {
    expect(isFinished({ status: 'Expired', uploadedToOnBase: false })).toBe(true);
    expect(isFinished({ status: 'Signed', uploadedToOnBase: false })).toBe(false);
  });
});

describe('demo DocuSign', () => {
  it('reports an envelope past its expiry as Expired, keeping who had signed', async () => {
    const { createDemoServices } = await import('../services/demo');
    const st = await createDemoServices().signing.get('docusign:main').getStatus('5c9e0d3a-81b2-4e6f-a7d4-0b3f2c1e9a55');
    expect(st.status).toBe('Expired');
    expect(st.voidedReason).toMatch(/expired/i);
    expect(st.recipients.find((r) => r.role === 'Owner')?.status).toBe('completed');
    expect(st.recipients.find((r) => r.role === 'SpouseConsent')?.status).toBe('sent');
  });
});

describe('draft retention', () => {
  const saved = '2026-10-01T12:00:00.000Z';

  it('counts each retention option from the last save', () => {
    for (const days of [90, 60, 30, 10, 7]) {
      expect(draftExpiry(saved, days)).toBe(new Date(Date.parse(saved) + days * 86_400_000).toISOString());
    }
    expect(draftExpiry(saved, 0)).toBeUndefined();
    expect(retentionDays(undefined)).toBe(90);
    expect(retentionDays({ draftRetentionDays: 0 })).toBe(0);
    expect(retentionDays({ draftRetentionDays: 45 })).toBe(90);
    expect(draftsAllowed({ draftRetentionDays: 0 })).toBe(false);
  });

  it('says a draft is expiring soon at 7 days or fewer', () => {
    const now = new Date(saved);
    const at = (days: number) => ({ status: 'Drafted' as const, expiresOn: new Date(now.getTime() + days * 86_400_000).toISOString() });
    expect(draftExpiryInfo(at(8), now)).toMatchObject({ daysLeft: 8, soon: false });
    expect(draftExpiryInfo(at(7), now)).toMatchObject({ daysLeft: 7, soon: true });
    expect(draftExpiryInfo(at(1), now)?.soon).toBe(true);
    expect(draftExpiryInfo({ status: 'Drafted' }, now)).toBeUndefined();
  });

  it('never expires printed packets, sends in progress or sent requests', () => {
    expect(isRetainable({ status: 'Drafted' })).toBe(true);
    expect(isRetainable({ status: 'Drafted', inPerson: true })).toBe(false);
    expect(isRetainable({ status: 'Drafted', envelopeId: 'e-1' })).toBe(false);
    expect(isRetainable({ status: 'Sent' })).toBe(false);
    expect(isRetainable({ status: 'Signed' })).toBe(false);
    expect(draftExpiryInfo({ status: 'Sent', expiresOn: saved })).toBeUndefined();
  });
});
