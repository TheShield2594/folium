import { describe, expect, it } from 'vitest';
import { demoUsage } from '../services/demo';
import { activeUsers, blockedSendRate, canOpenReports, formUsage, percentile, signatureFunnel, timeToSign, topBlockingChecks } from './reports';
import type { UsageEvent, UsageEventType } from './usage';

let n = 0;
const e = (type: UsageEventType, at: string, over: Partial<UsageEvent> = {}): UsageEvent => ({
  type,
  occurredOn: new Date(at).toISOString(),
  userId: 'u1',
  formNumber: 'EV-1120',
  revision: '03/2026',
  issuer: 'Everence Financial',
  category: 'Beneficiary',
  batchId: `b${n}`,
  dedupeKey: `k${n++}`,
  ...over,
});

// A hand-built month: three requests, worked out by hand below.
//   r1: sent Oct 1 09:00, signed Oct 1 21:00 → 12 h (two forms: two rows each)
//   r2: sent Oct 2 09:00, signed Oct 4 09:00 → 48 h
//   r3: sent Oct 3 09:00, viewed, expired → not signed
//   r0: sent in September, signed in October → outside the range
const sample: UsageEvent[] = [
  e('request.sent', '2026-10-01T09:00Z', { requestId: 'r1' }),
  e('request.sent', '2026-10-01T09:00Z', { requestId: 'r1', formNumber: 'EV-1004', revision: '01/2025', category: 'Account maintenance' }),
  e('request.signed', '2026-10-01T21:00Z', { requestId: 'r1' }),
  e('request.signed', '2026-10-01T21:00Z', { requestId: 'r1', formNumber: 'EV-1004' }),
  e('request.sent', '2026-10-02T09:00Z', { requestId: 'r2' }),
  e('request.viewed', '2026-10-03T09:00Z', { requestId: 'r2' }),
  e('request.signed', '2026-10-04T09:00Z', { requestId: 'r2' }),
  e('request.sent', '2026-10-03T09:00Z', { requestId: 'r3', formNumber: 'PX-310', issuer: 'Praxis', category: 'Distributions' }),
  e('request.viewed', '2026-10-05T09:00Z', { requestId: 'r3', formNumber: 'PX-310' }),
  e('request.expired', '2026-12-02T09:00Z', { requestId: 'r3', formNumber: 'PX-310' }),
  e('request.sent', '2026-09-28T09:00Z', { requestId: 'r0' }),
  e('request.signed', '2026-10-02T09:00Z', { requestId: 'r0' }),
  // Blocked sends: EV-1120 blocked twice (sent twice: r1, r2), PX-310 once (sent once).
  e('send.blocked', '2026-10-01T08:50Z', { detail: { blockingChecks: ['required', 'check:0'] } }),
  e('send.blocked', '2026-10-02T08:55Z', { detail: { blockingChecks: ['check:0'] } }),
  e('send.blocked', '2026-10-03T08:58Z', { formNumber: 'PX-310', detail: { blockingChecks: ['state'] } }),
  // Form uses.
  e('form.added', '2026-10-01T08:00Z'),
  e('form.added', '2026-10-01T08:01Z', { formNumber: 'EV-1004', revision: '01/2025', category: 'Account maintenance' }),
  e('form.added', '2026-10-02T08:00Z', { userId: 'u2' }),
  e('form.added', '2026-10-03T08:00Z', { userId: 'u2', formNumber: 'PX-310', revision: '08/2026', issuer: 'Praxis', category: 'Distributions' }),
  e('form.added', '2026-11-01T08:00Z', { userId: 'u3' }),
];
const october = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };

describe('reporting metrics on a hand-built sample', () => {
  it('times to sign per request: median 12 h of [12, 48]; 90th 48 h', () => {
    expect(timeToSign(sample, october)).toEqual({ count: 2, medianHours: 12, p90Hours: 48 });
    // Without the range, r0 (96 h) counts too: [12, 48, 96].
    expect(timeToSign(sample)).toEqual({ count: 3, medianHours: 48, p90Hours: 96 });
  });

  it('blocked-send rate by form: EV-1120 2 of 4, PX-310 1 of 2, EV-1004 0 of 1', () => {
    expect(blockedSendRate(sample, october)).toEqual([
      { formNumber: 'EV-1120', blocked: 2, attempts: 4, rate: 0.5 },
      { formNumber: 'PX-310', blocked: 1, attempts: 2, rate: 0.5 },
      { formNumber: 'EV-1004', blocked: 0, attempts: 1, rate: 0 },
    ]);
  });

  it('ranks the checks that block most', () => {
    expect(topBlockingChecks(sample)).toEqual([
      { key: 'check:0', count: 2 },
      { key: 'required', count: 1 },
      { key: 'state', count: 1 },
    ]);
  });

  it('counts the funnel per request, not per form row', () => {
    expect(signatureFunnel(sample, october)).toEqual({ sent: 3, viewed: 2, signed: 2, declined: 0, voided: 0, expired: 1 });
  });

  it('matches a direct count of form.added rows', () => {
    const direct = sample.filter((x) => x.type === 'form.added' && x.occurredOn >= october.from && x.occurredOn < october.to);
    const byForm = formUsage(sample, 'form', october);
    expect(byForm.reduce((a, b) => a + b.count, 0)).toBe(direct.length);
    expect(byForm).toEqual([
      { key: 'EV-1120 Rev 03/2026', count: 2 },
      { key: 'EV-1004 Rev 01/2025', count: 1 },
      { key: 'PX-310 Rev 08/2026', count: 1 },
    ]);
    expect(formUsage(sample, 'issuer', october)).toEqual([
      { key: 'Everence Financial', count: 3 },
      { key: 'Praxis', count: 1 },
    ]);
    expect(formUsage(sample, 'category', october).map((x) => x.key)).toEqual(['Beneficiary', 'Account maintenance', 'Distributions']);
  });

  it('counts active people', () => {
    expect(activeUsers(sample, 7, new Date('2026-10-04T12:00Z'))).toBe(2);
    expect(activeUsers(sample, 7, new Date('2026-11-02T00:00Z'))).toBe(1);
  });

  it('uses nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 90)).toBe(5);
  });
});

describe('the demo’s seeded year', () => {
  it('has a year of every kind of event for the report to show', () => {
    const all = demoUsage();
    const types = new Set(all.map((x) => x.type));
    for (const t of ['form.added', 'send.blocked', 'request.sent', 'request.viewed', 'request.signed', 'request.inperson', 'draft.saved'] as const) expect(types.has(t)).toBe(true);
    const days = (Date.parse(all.at(-1)!.occurredOn) - Date.parse(all[0].occurredOn)) / 86_400_000;
    expect(days).toBeGreaterThan(300);
    expect(new Set(all.map((x) => x.dedupeKey)).size).toBe(all.length);
    expect(timeToSign(all).count).toBeGreaterThan(50);
  });
});

describe('canOpenReports', () => {
  const firm = { reportsUrl: 'https://app.powerbi.com/x' };
  it('is Admins and the reporting role, once there is a report', () => {
    expect(canOpenReports({ role: 'Admin' }, firm)).toBe(true);
    expect(canOpenReports({ role: 'User', canViewReports: true }, firm)).toBe(true);
    expect(canOpenReports({ role: 'User' }, firm)).toBe(false);
    expect(canOpenReports({ role: 'Assistant' }, firm)).toBe(false);
    expect(canOpenReports({ role: 'Admin' }, { reportsUrl: ' ' })).toBe(false);
    expect(canOpenReports(undefined, firm)).toBe(false);
  });
});
