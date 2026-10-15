import { describe, expect, it } from 'vitest';
import { FIRMS, GROUPS, TEMPLATES, USERS } from '../services/demo/seed';
import { withDocuSignDefaults } from './docusign';
import type { FormFeedback } from './feedback';
import { DEFAULT_POLICY } from './policy';
import { advisorGaps, companyCoverage, firmGaps, formRanking, formRankingRows, pilotNumbers, policyDifferences, readinessChecks, readinessSummary, type ReadinessInput } from './readiness';
import type { FormTemplate } from './types';
import type { UsageEvent, UsageEventType } from './usage';

let n = 0;
const e = (type: UsageEventType, at: string, over: Partial<UsageEvent> = {}): UsageEvent => ({
  type,
  occurredOn: new Date(at).toISOString(),
  userId: 'u1',
  formNumber: 'EV-1120',
  revision: '03/2026',
  issuer: 'Everence Trust Company',
  batchId: `b${n}`,
  dedupeKey: `k${n++}`,
  ...over,
});

const tpl = (over: Partial<FormTemplate>): FormTemplate => ({ ...TEMPLATES[0], ...over });

const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  users: USERS,
  groups: GROUPS,
  firms: FIRMS,
  policy: DEFAULT_POLICY,
  docuSign: withDocuSignDefaults({ environment: 'production', accountId: '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f' }),
  templates: TEMPLATES,
  ...over,
});

const item = (items: ReturnType<typeof readinessChecks>, id: string) => items.find((i) => i.id === id)!;

describe('companyCoverage', () => {
  it('counts Live and in-progress templates per Laser App company, matching issuers ignoring case', () => {
    const templates = [
      tpl({ id: 'a', issuer: 'everence trust company', status: 'Live', states: ['IN'] }),
      tpl({ id: 'b', issuer: 'Everence Foundation', status: 'Live', states: undefined }),
      tpl({ id: 'c', issuer: 'Everence Trust Company', status: 'Needs mapping' }),
      tpl({ id: 'd', issuer: 'Everence Trust Company', status: 'Retired' }),
      tpl({ id: 'e', issuer: 'Praxis Mutual Funds', status: 'Draft' }),
    ];
    const usage = [e('form.added', '2026-10-01'), e('form.added', '2026-10-02', { issuer: 'Praxis Mutual Funds' }), e('pdf.print', '2026-10-02')];
    const [trust, , , praxis] = companyCoverage(templates, usage);
    expect(trust).toMatchObject({ name: 'Everence Trust Company and Foundation', live: 2, liveWithoutStates: 1, inProgress: 1, uses: 1 });
    expect(praxis).toMatchObject({ live: 0, inProgress: 1, uses: 1 });
  });
});

describe('formRanking', () => {
  it('ranks forms by form.added across revisions, with the current status', () => {
    const templates = [tpl({ id: 't1', formNumber: 'EV-1120', status: 'Live', name: 'Beneficiary change' }), tpl({ id: 't0', formNumber: 'EV-1120', status: 'Retired', effectiveDate: '2020-01-01' }), tpl({ id: 't2', formNumber: 'PX-310', status: 'Needs mapping', effectiveDate: '2026-01-01', name: 'Praxis' })];
    const usage = [
      e('form.added', '2026-10-01', { revision: '01/2020' }),
      e('form.added', '2026-10-02'),
      e('form.added', '2026-10-02', { formNumber: 'PX-310' }),
      e('form.added', '2026-10-03', { formNumber: 'ZZ-1', issuer: 'American Funds' }),
      e('request.sent', '2026-10-03'),
      e('form.added', '2026-09-01'),
    ];
    const ranked = formRanking(usage, templates, { from: '2026-10-01' });
    expect(ranked.map((r) => [r.formNumber, r.count, r.status])).toEqual([
      ['EV-1120', 2, 'Live'],
      ['PX-310', 1, 'Needs mapping'],
      ['ZZ-1', 1, undefined],
    ]);
    expect(ranked[2].issuer).toBe('American Funds');
    expect(formRankingRows(ranked)[3]).toEqual(['3', 'ZZ-1', '', 'American Funds', '1', 'Not in Folium']);
  });
});

describe('pilotNumbers', () => {
  it('counts presses and sends once per action, not per form row', () => {
    const usage = [
      e('send.blocked', '2026-10-01T09:00Z', { batchId: 'p1' }),
      e('send.blocked', '2026-10-01T09:00Z', { batchId: 'p1', formNumber: 'EV-1004' }),
      e('request.sent', '2026-10-01T10:00Z', { requestId: 'r1' }),
      e('request.sent', '2026-10-01T10:00Z', { requestId: 'r1', formNumber: 'EV-1004' }),
      e('request.signed', '2026-10-01T22:00Z', { requestId: 'r1' }),
      e('request.sent', '2026-10-02T10:00Z', { requestId: 'r2', userId: 'u2' }),
      e('request.inperson', '2026-10-03T10:00Z', { requestId: 'r3' }),
    ];
    const feedback = [{ kind: 'problem', status: 'new' }, { kind: 'problem', status: 'fixed' }, { kind: 'request', status: 'new' }] as FormFeedback[];
    const p = pilotNumbers(usage, feedback, new Date('2026-10-05'));
    expect(p).toMatchObject({ sends: 2, blockedPresses: 1, inPerson: 1, medianHoursToSign: 12, activeUsers30: 2, openProblems: 1 });
    expect(p.blockedRate).toBeCloseTo(1 / 3);
    expect(pilotNumbers([], undefined).blockedRate).toBeUndefined();
  });
});

describe('gaps', () => {
  it('finds advisors and firm profiles missing what forms print', () => {
    const users = [
      { ...USERS[0], role: 'User' as const, repCode: '', active: true },
      { ...USERS[0], systemuserid: 'x', role: 'User' as const, active: false, repCode: '' },
      { ...USERS[0], systemuserid: 'y', role: 'Assistant' as const, repCode: '' },
    ];
    expect(advisorGaps(users).map((u) => u.systemuserid)).toEqual([USERS[0].systemuserid]);
    const gaps = firmGaps([{ ...FIRMS[0], phone: ' ', disclosure: '', crd: '' }, FIRMS[1], { ...FIRMS[1], id: 'ok', firmNumber: '12345' }]);
    expect(gaps.map((g) => g.missing)).toEqual([['phone', 'disclosure', 'broker-dealer placeholder'], ['firm number placeholder']]);
  });

  it('names policy settings that differ from Laser App', () => {
    expect(policyDifferences(DEFAULT_POLICY)).toEqual([]);
    expect(policyDifferences({ sharing: 'anyone', repDataVisibility: 'groupMembers', pdfDownload: 'signedOnly' })).toHaveLength(3);
  });
});

describe('readinessChecks', () => {
  it('lists every section of the issue, with environment, pilot sign-off and cutover left to people', () => {
    const items = readinessChecks(input());
    expect(new Set(items.map((i) => i.section))).toEqual(new Set(['forms', 'platform', 'environment', 'pilot', 'signoff']));
    expect(items.filter((i) => i.section === 'environment' || i.section === 'signoff').every((i) => i.status === 'manual')).toBe(true);
    const s = readinessSummary(items);
    expect(s.done + s.todo + s.review + s.manual).toBe(items.length);
  });

  it('marks usage as unknown when it could not be read, and to do when nothing has been used', () => {
    expect(item(readinessChecks(input()), 'forms.usage').status).toBe('manual');
    expect(item(readinessChecks(input({ usage: [] })), 'forms.usage').status).toBe('todo');
    expect(item(readinessChecks(input({ usage: [e('form.added', '2026-10-01')] })), 'forms.usage').status).toBe('review');
    expect(item(readinessChecks(input({ usage: [e('form.added', '2026-10-01'), e('form.added', '2026-10-20')] })), 'forms.usage').status).toBe('done');
  });

  it('flags top companies with no Live forms', () => {
    const none = readinessChecks(input({ templates: [] }));
    expect(item(none, 'forms.top')).toMatchObject({ status: 'todo' });
    expect(item(none, 'forms.top').detail).toContain('Everence Trust Company and Foundation (51.5%)');
  });

  it('checks DocuSign, policy and the reports link', () => {
    expect(item(readinessChecks(input({ docuSign: withDocuSignDefaults(undefined) })), 'platform.docusign').status).toBe('todo');
    expect(item(readinessChecks(input({ docuSign: withDocuSignDefaults({ accountId: '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f' }) })), 'platform.docusign').status).toBe('review');
    expect(item(readinessChecks(input()), 'platform.docusign').status).toBe('done');
    expect(item(readinessChecks(input({ policy: { ...DEFAULT_POLICY, sharing: 'off' } })), 'platform.policy').status).toBe('review');
    const firms = FIRMS.map((f) => (f.isDefault ? { ...f, reportsUrl: 'javascript:alert(1)' } : f));
    expect(item(readinessChecks(input({ firms })), 'platform.reports').status).toBe('todo');
    const linked = FIRMS.map((f) => (f.isDefault ? { ...f, reportsUrl: 'https://app.powerbi.com/groups/x/reports/y' } : f));
    expect(item(readinessChecks(input({ firms: linked })), 'platform.reports').status).toBe('done');
  });

  it('flags people in no group and groups with no region', () => {
    const groups = [{ ...GROUPS[0], region: '', memberIds: [] }];
    const g = item(readinessChecks(input({ groups })), 'platform.groups');
    expect(g.status).toBe('review');
    expect(g.detail).toContain('in no group');
    expect(g.detail).toContain(`No region on ${GROUPS[0].name}`);
    expect(item(readinessChecks(input({ groups: [] })), 'platform.groups').status).toBe('todo');
  });

  it('needs every open problem looked at before the pilot passes', () => {
    const fb = (status: FormFeedback['status']) => [{ kind: 'problem', status }] as FormFeedback[];
    expect(item(readinessChecks(input({ feedback: fb('new') })), 'pilot.triage').status).toBe('todo');
    expect(item(readinessChecks(input({ feedback: fb('inProgress') })), 'pilot.triage').status).toBe('review');
    expect(item(readinessChecks(input({ feedback: fb('fixed') })), 'pilot.triage').status).toBe('done');
  });
});
