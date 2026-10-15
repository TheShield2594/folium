import { docuSignReady, type DocuSignSetup } from './docusign';
import { isOpen, type FormFeedback } from './feedback';
import { defaultFirm, templateIssuer } from './firms';
import { DEFAULT_POLICY } from './policy';
import { activeUsers, isReportUrl, timeToSign, type Range, type UsageCount } from './reports';
import type { FirmPolicy, FirmProfile, FormTemplate, UserGroup, UserProfile } from './types';
import type { UsageEvent } from './usage';
import { isActiveUser } from './users';

// Replacement readiness (#35): what has to be true before Folium replaces Laser App.
// Administration › Readiness shows what Folium can check from its own data, and lists the
// rest (environment, pilot, sign-off) to be checked by hand. Pure, so the screen and the
// tests agree.

export const READINESS_ISSUE = 35;

/**
 * Laser App's top companies over the last 12 months (55,374 form uses; these seven are
 * 98.6%), with the Folium issuer names each covers. The names are matched to template
 * issuers ignoring case; confirm them with Marketing when the templates are loaded.
 */
export const LASER_APP_TOP_COMPANIES: { name: string; share: number; issuers: string[] }[] = [
  { name: 'Everence Trust Company and Foundation', share: 51.5, issuers: ['Everence Trust Company', 'Everence Foundation'] },
  { name: 'Everence Health', share: 25.4, issuers: ['Everence Health'] },
  { name: 'Everence Annuity', share: 11.3, issuers: ['Everence Annuity'] },
  { name: 'Praxis', share: 4.2, issuers: ['Praxis Mutual Funds', 'Praxis'] },
  { name: 'Everence Financial Planning', share: 2.6, issuers: ['Everence Financial Planning', 'Everence Financial'] },
  { name: 'American Funds', share: 2.3, issuers: ['American Funds'] },
  { name: 'Everence Corporate', share: 1.8, issuers: ['Everence Corporate'] },
];

/** Laser App's users when the switch was planned (#2). */
export const LASER_APP_USERS = 169;

/** Everence's Laser App settings (#28): sharing within groups, rep data for Assistants only, PDF download on. */
export const LASER_APP_POLICY: Pick<FirmPolicy, 'sharing' | 'repDataVisibility' | 'pdfDownload'> = {
  sharing: DEFAULT_POLICY.sharing,
  repDataVisibility: DEFAULT_POLICY.repDataVisibility,
  pdfDownload: DEFAULT_POLICY.pdfDownload,
};

/**
 * - `done`: Folium's data says it's in place.
 * - `todo`: Folium's data says it isn't.
 * - `review`: partly in place, or needs someone to judge the numbers.
 * - `manual`: Folium can't tell; check it by hand and tick it on the issue.
 */
export type ReadinessStatus = 'done' | 'todo' | 'review' | 'manual';

export type ReadinessSection = 'forms' | 'platform' | 'environment' | 'pilot' | 'signoff';

export const SECTION_TITLES: Record<ReadinessSection, string> = {
  forms: 'Forms people actually use',
  platform: 'Platform setup',
  environment: 'Verified against the real environment',
  pilot: 'Pilot',
  signoff: 'Sign-off and cutover',
};

export interface ReadinessItem {
  id: string;
  section: ReadinessSection;
  title: string;
  status: ReadinessStatus;
  /** What Folium found, or what to check. */
  detail: string;
  /** GitHub issues that track it. */
  issues?: number[];
  /** Where in Folium to fix it. */
  to?: string;
}

export interface ReadinessInput {
  users: UserProfile[];
  groups: UserGroup[];
  firms: FirmProfile[];
  policy: FirmPolicy;
  docuSign: DocuSignSetup;
  templates: FormTemplate[];
  /** Usage since the start of the window; undefined while loading or when it can't be read. */
  usage?: UsageEvent[];
  feedback?: FormFeedback[];
  now?: Date;
}

const norm = (s: string) => s.trim().toLowerCase();
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const list = (names: string[], max = 4) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);

/** Whether a template's issuer is one of a Laser App company's. */
export const coversCompany = (t: Pick<FormTemplate, 'issuer' | 'source'>, company: { issuers: string[] }) => company.issuers.map(norm).includes(norm(templateIssuer(t)));

export interface CompanyCoverage {
  name: string;
  share: number;
  live: number;
  /** Live templates with no approved states recorded (every state). */
  liveWithoutStates: number;
  /** Templates still being mapped (Draft or Needs mapping). */
  inProgress: number;
  /** Form uses in Folium in the window, when usage is known. */
  uses?: number;
}

/** Live and in-progress templates per Laser App top company. */
export function companyCoverage(templates: FormTemplate[], usage?: UsageEvent[]): CompanyCoverage[] {
  return LASER_APP_TOP_COMPANIES.map((c) => {
    const mine = templates.filter((t) => coversCompany(t, c));
    const live = mine.filter((t) => t.status === 'Live');
    const issuers = c.issuers.map(norm);
    return {
      name: c.name,
      share: c.share,
      live: live.length,
      liveWithoutStates: live.filter((t) => !t.states?.length).length,
      inProgress: mine.filter((t) => t.status === 'Draft' || t.status === 'Needs mapping').length,
      ...(usage ? { uses: usage.filter((e) => e.type === 'form.added' && issuers.includes(norm(e.issuer ?? e.source ?? ''))).length } : {}),
    };
  });
}

export interface FormRank extends UsageCount {
  formNumber: string;
  name?: string;
  issuer?: string;
  /** The current template for the form number: Live, or the newest otherwise. */
  status?: FormTemplate['status'];
  templateId?: string;
}

/**
 * Forms by use in the window (`form.added`, every revision together), with each form's
 * current status, so the mapping list (#4) can start from the top.
 */
export function formRanking(usage: UsageEvent[], templates: FormTemplate[], range: Range = {}): FormRank[] {
  const byForm = new Map<string, number>();
  for (const e of usage) {
    if (e.type !== 'form.added' || !e.formNumber) continue;
    if ((range.from && e.occurredOn < range.from) || (range.to && e.occurredOn >= range.to)) continue;
    byForm.set(e.formNumber, (byForm.get(e.formNumber) ?? 0) + 1);
  }
  const lastIssuer = new Map(usage.filter((e) => e.formNumber).map((e) => [e.formNumber!, e.issuer ?? e.source]));
  return [...byForm]
    .map(([formNumber, count]) => {
      const same = templates.filter((t) => t.formNumber === formNumber);
      const current = same.find((t) => t.status === 'Live') ?? [...same].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
      return {
        key: formNumber,
        count,
        formNumber,
        ...(current ? { name: current.name, issuer: templateIssuer(current), status: current.status, templateId: current.id } : { issuer: lastIssuer.get(formNumber) }),
      };
    })
    .sort((a, b) => b.count - a.count || a.formNumber.localeCompare(b.formNumber));
}

export interface PilotNumbers {
  formUses: number;
  sends: number;
  blockedPresses: number;
  /** blocked ÷ (blocked + sent), 0–1; undefined with no attempts. */
  blockedRate?: number;
  inPerson: number;
  medianHoursToSign?: number;
  activeUsers30: number;
  /** Open problem reports (NIGO and mapping problems advisors found). */
  openProblems?: number;
}

/** The pilot's numbers (#35 §4) from usage in the window. */
export function pilotNumbers(usage: UsageEvent[], feedback: FormFeedback[] | undefined, now: Date = new Date()): PilotNumbers {
  const count = (t: UsageEvent['type']) => usage.filter((e) => e.type === t).length;
  const requests = (t: UsageEvent['type']) => new Set(usage.filter((e) => e.type === t).map((e) => e.requestId ?? e.batchId)).size;
  // Per press and per send, not per form row: a blocked press on a 3-form packet is one press.
  const blockedPresses = new Set(usage.filter((e) => e.type === 'send.blocked').map((e) => e.batchId)).size;
  const sends = requests('request.sent');
  return {
    formUses: count('form.added'),
    sends,
    blockedPresses,
    blockedRate: blockedPresses + sends ? blockedPresses / (blockedPresses + sends) : undefined,
    inPerson: requests('request.inperson'),
    medianHoursToSign: timeToSign(usage).medianHours,
    activeUsers30: activeUsers(usage, 30, now),
    ...(feedback ? { openProblems: feedback.filter((f) => f.kind === 'problem' && isOpen(f)).length } : {}),
  };
}

/** Advisor data forms print (#25): rep code, phone and office address. */
export function advisorGaps(users: UserProfile[]): UserProfile[] {
  return users.filter((u) => u.role === 'User' && isActiveUser(u) && (!u.repCode?.trim() || !u.phone?.trim() || !u.office?.line1?.trim()));
}

/** The firm profile fields every entity needs on forms and envelopes (#26). CRD and broker-dealer don't apply to every entity. */
const FIRM_FIELDS: { key: keyof FirmProfile; label: string }[] = [
  { key: 'legalName', label: 'legal name' },
  { key: 'address1', label: 'address' },
  { key: 'city', label: 'city' },
  { key: 'state', label: 'state' },
  { key: 'zip', label: 'ZIP' },
  { key: 'phone', label: 'phone' },
  { key: 'disclosure', label: 'disclosure' },
];

const FIRM_LABELS: Partial<Record<keyof FirmProfile, string>> = {
  ...Object.fromEntries(FIRM_FIELDS.map((f) => [f.key, f.label])),
  name: 'name',
  brokerDealer: 'broker-dealer',
  crd: 'CRD',
  firmNumber: 'firm number',
  branchNumber: 'branch number',
  osjName: 'OSJ name',
  riaName: 'RIA name',
  email: 'email',
  fax: 'fax',
  website: 'website',
};

/** Text still holding a stand-in such as `[TRUST CO. #]` or `[DISTRIBUTOR NAME]`. */
const PLACEHOLDER = /\[[A-Z0-9 .#&/-]{2,}\]/;

/** Profiles missing a required field or still holding a `[PLACEHOLDER]`, with what to fill. */
export function firmGaps(firms: FirmProfile[]): { firm: FirmProfile; missing: string[] }[] {
  return firms
    .map((firm) => {
      const missing = FIRM_FIELDS.filter((f) => !String(firm[f.key] ?? '').trim()).map((f) => f.label);
      for (const [key, label] of Object.entries(FIRM_LABELS)) {
        const v = firm[key as keyof FirmProfile];
        if (typeof v === 'string' && PLACEHOLDER.test(v)) missing.push(`${label} placeholder`);
      }
      return { firm, missing };
    })
    .filter((g) => g.missing.length);
}

/** Policy settings that differ from Everence's Laser App setup, as readable sentences. */
export function policyDifferences(policy: FirmPolicy): string[] {
  const out: string[] = [];
  if (policy.sharing !== LASER_APP_POLICY.sharing) out.push(policy.sharing === 'off' ? 'Sharing is off (Laser App shares within groups)' : 'Sharing is with anyone (Laser App shares within groups)');
  if (policy.repDataVisibility !== LASER_APP_POLICY.repDataVisibility) out.push('Users can work as other advisors in their groups (Laser App: Assistants only)');
  if (policy.pdfDownload !== LASER_APP_POLICY.pdfDownload) out.push(policy.pdfDownload === 'none' ? 'PDF download is off (Laser App: on)' : 'Only signed PDFs can be downloaded (Laser App: all)');
  return out;
}

/** Days between the first and last event, or 0. */
function spanDays(usage: UsageEvent[]): number {
  if (!usage.length) return 0;
  let min = usage[0].occurredOn;
  let max = min;
  for (const e of usage) {
    if (e.occurredOn < min) min = e.occurredOn;
    if (e.occurredOn > max) max = e.occurredOn;
  }
  return Math.floor((new Date(max).getTime() - new Date(min).getTime()) / 86_400_000);
}

/** Every item on the readiness list, in the issue's order. */
export function readinessChecks(input: ReadinessInput): ReadinessItem[] {
  const { users, groups, firms, policy, docuSign, templates, usage, feedback } = input;
  const items: ReadinessItem[] = [];
  const add = (item: ReadinessItem) => items.push(item);

  // ------------------------------------------------------------ 1. Forms
  const uses = usage?.filter((e) => e.type === 'form.added') ?? [];
  const forms = new Set(uses.map((e) => e.formNumber).filter(Boolean)).size;
  add({
    id: 'forms.usage',
    section: 'forms',
    title: 'Usage by form',
    issues: [4, 31],
    status: !usage ? 'manual' : uses.length && spanDays(uses) >= 14 ? 'done' : uses.length ? 'review' : 'todo',
    detail: !usage
      ? 'Usage isn’t loaded. If it doesn’t load, Admins need Read on ev_usageevent; the Power BI report has the same numbers.'
      : uses.length
        ? `${plural(uses.length, 'form use')} across ${plural(forms, 'form')} over ${plural(spanDays(uses), 'day')}.${spanDays(uses) < 14 ? ' Let the pilot run at least two weeks before ranking forms.' : ''} Ranked below under Forms by use.`
        : 'No forms added in Folium yet. Usage events are recorded as advisors use Folium (#31); the pilot fills this in.',
  });

  const coverage = companyCoverage(templates);
  const uncovered = coverage.filter((c) => !c.live);
  const thin = coverage.filter((c) => c.live && c.inProgress);
  add({
    id: 'forms.top',
    section: 'forms',
    title: 'Top companies’ forms are Live',
    issues: [4, 13],
    to: '/admin/templates',
    status: uncovered.length ? 'todo' : thin.length ? 'review' : 'done',
    detail: uncovered.length
      ? `No Live forms yet for ${list(uncovered.map((c) => `${c.name} (${c.share}%)`))}.`
      : thin.length
        ? `Every top company has Live forms. Still being mapped: ${list(thin.map((c) => `${c.name} (${c.inProgress})`))}.`
        : 'Every top company has Live forms, and none are waiting on mapping.',
  });

  const noStates = coverage.reduce((n, c) => n + c.liveWithoutStates, 0);
  add({
    id: 'forms.states',
    section: 'forms',
    title: 'Approved states recorded',
    issues: [13],
    to: '/admin/templates',
    status: noStates ? 'review' : 'done',
    detail: noStates
      ? `${plural(noStates, 'Live form')} from the top companies ${noStates === 1 ? 'has' : 'have'} no states recorded, so ${noStates === 1 ? 'it is' : 'they are'} offered in every state. Confirm that's right.`
      : 'Every Live form from the top companies lists its approved states.',
  });

  const openRequests = feedback?.filter((f) => f.kind === 'request' && isOpen(f)) ?? [];
  add({
    id: 'forms.rare',
    section: 'forms',
    title: 'Agreed with Marketing what happens to rarely used forms',
    issues: [33],
    to: '/admin/feedback',
    status: 'manual',
    detail: feedback
      ? `Map on request through Form feedback, or not at all. ${plural(openRequests.length, 'form request')} open now.`
      : 'Map on request through Form feedback, or not at all.',
  });

  // ------------------------------------------------------------ 2. Platform
  add({ id: 'platform.security', section: 'platform', title: 'Dataverse security: roles, group teams, sharing and field security', issues: [1], status: 'manual', detail: 'Including the admin-route and profile-exposure gaps noted on the issue.' });

  const active = users.filter(isActiveUser);
  const assistants = active.filter((u) => u.role === 'Assistant').length;
  add({
    id: 'platform.users',
    section: 'platform',
    title: 'Laser App’s users loaded',
    issues: [2, 27],
    to: '/admin/people',
    status: active.length >= LASER_APP_USERS ? 'done' : active.length ? 'review' : 'todo',
    detail: `${plural(active.length, 'active person', 'active people')} of Laser App’s ${LASER_APP_USERS} (${plural(assistants, 'Assistant')}). Users from Entra ID and access from Entra groups are checked by hand.`,
  });

  const ungrouped = active.filter((u) => u.role !== 'Admin' && !groups.some((g) => g.memberIds.includes(u.systemuserid)));
  const noRegion = groups.filter((g) => !g.region?.trim());
  add({
    id: 'platform.groups',
    section: 'platform',
    title: 'Regional groups set up',
    issues: [2],
    to: '/admin/people',
    status: !groups.length ? 'todo' : ungrouped.length || noRegion.length ? 'review' : 'done',
    detail: !groups.length
      ? 'No groups yet. Load Laser App’s regional groups.'
      : [
          `${plural(groups.length, 'group')}.`,
          ungrouped.length ? `${plural(ungrouped.length, 'person', 'people')} in no group: ${list(ungrouped.map((u) => u.fullname))}.` : 'Everyone is in a group.',
          noRegion.length ? `No region on ${list(noRegion.map((g) => g.name))}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
  });

  add({ id: 'platform.host', section: 'platform', title: 'Folium hosted on the Contact form', issues: [3], status: 'manual', detail: 'Open Folium from a contact in Dynamics and check it opens on that client.' });

  add({
    id: 'platform.docusign',
    section: 'platform',
    title: 'DocuSign connected',
    issues: [5],
    to: '/admin/settings',
    status: !docuSignReady(docuSign) ? 'todo' : docuSign.environment !== 'production' ? 'review' : 'done',
    detail: !docuSignReady(docuSign)
      ? 'No DocuSign account set in Administration › Settings, so nothing can be sent.'
      : docuSign.environment !== 'production'
        ? 'Set up against the developer sandbox. Switch to production before the pilot.'
        : `Production account set. Verification workflows: ${(['sms', 'phone', 'kba'] as const).filter((k) => docuSign.idv[k]).map((k) => k.toUpperCase()).join(', ') || 'none (email only)'}. The Connect status flow is checked by hand.`,
  });

  const diffs = policyDifferences(policy);
  add({
    id: 'platform.policy',
    section: 'platform',
    title: 'Firm-wide policy matches Laser App',
    issues: [28],
    to: '/admin/settings',
    status: diffs.length ? 'review' : 'done',
    detail: diffs.length ? `${diffs.join('. ')}. Fine if that was decided; otherwise change it.` : 'Sharing within groups, rep data for Assistants only, PDF download on.',
  });

  const advisors = active.filter((u) => u.role === 'User');
  const gaps = advisorGaps(users);
  add({
    id: 'platform.advisors',
    section: 'platform',
    title: 'Advisor data filled',
    issues: [25],
    to: '/admin/people',
    status: !advisors.length ? 'todo' : gaps.length ? 'review' : 'done',
    detail: gaps.length
      ? `${plural(gaps.length, 'advisor')} of ${advisors.length} missing a rep code, phone or office address: ${list(gaps.map((u) => u.fullname))}.`
      : `All ${plural(advisors.length, 'advisor')} have a rep code, phone and office address.`,
  });

  const fg = firmGaps(firms);
  const unclaimed = LASER_APP_TOP_COMPANIES.filter((c) => !firms.some((f) => f.issuers.map(norm).some((i) => c.issuers.map(norm).includes(i))));
  const def = defaultFirm(firms);
  add({
    id: 'platform.firms',
    section: 'platform',
    title: 'Firm data filled for every entity on forms',
    issues: [26],
    to: '/admin/firm',
    status: !firms.length ? 'todo' : fg.length ? 'todo' : unclaimed.length ? 'review' : 'done',
    detail: !firms.length
      ? 'No firm profile yet.'
      : [
          fg.length ? `To fill: ${fg.map((g) => `${g.firm.name || 'Untitled'} (${g.missing.join(', ')})`).join('; ')}.` : `${plural(firms.length, 'profile')}, all filled.`,
          unclaimed.length ? `No profile names ${list(unclaimed.map((c) => c.name))}, so their forms fill from ${def?.name || 'the default profile'}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
  });

  const reporters = active.filter((u) => u.role === 'Admin' || u.canViewReports).length;
  add({
    id: 'platform.reports',
    section: 'platform',
    title: 'Reports link set',
    issues: [32],
    to: '/admin/firm',
    status: isReportUrl(def?.reportsUrl) ? 'done' : 'todo',
    detail: isReportUrl(def?.reportsUrl) ? `${plural(reporters, 'person', 'people')} can open it.` : 'No https link to the Power BI report in Firm profile › Reports. The pilot’s numbers are below until it exists.',
  });

  // ------------------------------------------------------------ 3. Environment
  add({ id: 'env.choices', section: 'environment', title: 'Choice columns read correctly', issues: [14], status: 'manual', detail: 'Spousal consent appears for a married test client.' });
  add({
    id: 'env.packets',
    section: 'environment',
    title: 'End-to-end test packet for each top company',
    status: 'manual',
    detail: 'Prefill, checks, Review, Download, Save draft and resume, Send to DocuSign, sign, status updates by Connect, signed PDF and certificate.',
  });
  add({ id: 'env.unseen', section: 'environment', title: 'What Laser App never showed working', issues: [23], status: 'manual', detail: 'A real send through to completion, status updates, and session expiry and recovery.' });

  // ------------------------------------------------------------ 4. Pilot
  const pilotUsers = usage ? new Set(usage.map((e) => e.userId)).size : 0;
  const pilotRegions = usage ? new Set(usage.map((e) => e.region).filter(Boolean)).size : 0;
  add({
    id: 'pilot.run',
    section: 'pilot',
    title: 'Advisors and assistants from different regions run real packets',
    issues: [31],
    status: !usage ? 'manual' : pilotUsers && pilotRegions > 1 && spanDays(usage) >= 14 ? 'done' : pilotUsers ? 'review' : 'todo',
    detail: usage
      ? `${plural(pilotUsers, 'person', 'people')} from ${plural(pilotRegions, 'region')} over ${plural(spanDays(usage), 'day')}. Suggested: 2–4 weeks alongside Laser App.`
      : 'Suggested: 2–4 weeks alongside Laser App.',
  });
  const problems = feedback?.filter((f) => f.kind === 'problem' && isOpen(f)) ?? [];
  add({
    id: 'pilot.triage',
    section: 'pilot',
    title: 'Every pilot problem filed and triaged',
    issues: [33],
    to: '/admin/feedback',
    status: !feedback ? 'manual' : problems.some((f) => f.status === 'new') ? 'todo' : problems.length ? 'review' : 'done',
    detail: !feedback
      ? 'Bar to pass: no open bug that loses work, sends wrong data, or blocks a common form.'
      : `${plural(problems.length, 'open problem report')}, ${problems.filter((f) => f.status === 'new').length} not looked at yet. Bar to pass: no open bug that loses work, sends wrong data, or blocks a common form.`,
  });

  // ------------------------------------------------------------ 5. Sign-off
  add({
    id: 'signoff.compliance',
    section: 'signoff',
    title: 'Compliance review',
    issues: [19, 23, 17],
    status: 'manual',
    detail: `Draft retention (${policy.draftRetentionDays ?? 90} days), browser autosave of entered values, access codes and identity verification, firm disclosure text, audit trail.`,
  });
  add({ id: 'signoff.training', section: 'signoff', title: 'Training notes for advisors and assistants', issues: [33], status: 'manual', detail: 'What’s different from Laser App, and how to report a form problem.' });
  add({
    id: 'signoff.cutover',
    section: 'signoff',
    title: 'Cutover plan',
    issues: [32],
    status: 'manual',
    detail: 'Freeze new Laser App drafts on a set date (they expire after 90 days anyway), let envelopes already sent finish there, and export Laser App’s reports for history.',
  });
  add({ id: 'signoff.subscription', section: 'signoff', title: 'Laser App subscription end date confirmed', status: 'manual', detail: 'With overlap for the pilot and cutover.' });

  return items;
}

/** Counts by status, for the summary line. */
export function readinessSummary(items: ReadinessItem[]): Record<ReadinessStatus, number> {
  const out: Record<ReadinessStatus, number> = { done: 0, todo: 0, review: 0, manual: 0 };
  for (const i of items) out[i.status]++;
  return out;
}

/** Forms by use as CSV rows, for Marketing's mapping list. */
export function formRankingRows(ranking: FormRank[]): string[][] {
  return [['Rank', 'Form number', 'Name', 'Company', 'Uses', 'Status in Folium'], ...ranking.map((r, i) => [String(i + 1), r.formNumber, r.name ?? '', r.issuer ?? '', String(r.count), r.status ?? 'Not in Folium'])];
}
