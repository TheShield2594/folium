import type { FirmProfile, UserProfile } from './types';
import type { UsageEvent, UsageEventType } from './usage';

// The reporting metrics, defined once. The Power BI report (docs/REPORTS.md) computes
// the same things in DAX over `ev_usageevent`; these are the reference definitions its
// numbers are checked against, and what the tests pin down.

/** The Reports link: Admins and people given the reporting role, once the firm has a report URL. */
export function canOpenReports(me: Pick<UserProfile, 'role' | 'canViewReports'> | undefined, firm: Pick<FirmProfile, 'reportsUrl'> | undefined): boolean {
  return !!me && !!firm?.reportsUrl?.trim() && (me.role === 'Admin' || !!me.canViewReports);
}

export interface Range {
  /** ISO, inclusive. */
  from?: string;
  /** ISO, exclusive. */
  to?: string;
}

const inRange = (e: Pick<UsageEvent, 'occurredOn'>, r: Range) => (!r.from || e.occurredOn >= r.from) && (!r.to || e.occurredOn < r.to);

export interface UsageCount {
  key: string;
  count: number;
}

/**
 * Form uses in a range, counted by `by`. A "use" is a `form.added` row by default (the
 * Laser App baseline, see #31); pass other types to count outputs instead.
 */
export function formUsage(events: UsageEvent[], by: 'issuer' | 'category' | 'form', range: Range = {}, types: UsageEventType[] = ['form.added']): UsageCount[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!types.includes(e.type) || !inRange(e, range) || !e.formNumber) continue;
    const key = by === 'issuer' ? (e.issuer ?? e.source ?? 'Unknown') : by === 'category' ? (e.category ?? 'Unknown') : `${e.formNumber} Rev ${e.revision ?? '?'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Nearest-rank percentile (p in 0–100) of numbers sorted ascending. The report uses the
 * same rule; DAX's PERCENTILE.INC interpolates and can differ on small samples.
 */
export function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export interface TimeToSign {
  /** Requests sent in the range that were signed. */
  count: number;
  medianHours?: number;
  p90Hours?: number;
}

/**
 * Hours from `request.sent` to `request.signed`, per request (not per form row), for
 * requests sent in the range.
 */
export function timeToSign(events: UsageEvent[], range: Range = {}): TimeToSign {
  const sent = new Map<string, string>();
  const signed = new Map<string, string>();
  for (const e of events) {
    if (!e.requestId) continue;
    if (e.type === 'request.sent' && inRange(e, range) && (!sent.has(e.requestId) || e.occurredOn < sent.get(e.requestId)!)) sent.set(e.requestId, e.occurredOn);
    if (e.type === 'request.signed' && (!signed.has(e.requestId) || e.occurredOn < signed.get(e.requestId)!)) signed.set(e.requestId, e.occurredOn);
  }
  const hours = [...sent]
    .filter(([id]) => signed.has(id))
    .map(([id, at]) => (new Date(signed.get(id)!).getTime() - new Date(at).getTime()) / 3_600_000)
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);
  return { count: hours.length, medianHours: percentile(hours, 50), p90Hours: percentile(hours, 90) };
}

export interface Funnel {
  sent: number;
  viewed: number;
  signed: number;
  declined: number;
  voided: number;
  expired: number;
}

/** Distinct requests at each step, for requests sent in the range. */
export function signatureFunnel(events: UsageEvent[], range: Range = {}): Funnel {
  const sentIds = new Set(events.filter((e) => e.type === 'request.sent' && e.requestId && inRange(e, range)).map((e) => e.requestId!));
  const reached = (t: UsageEventType) => new Set(events.filter((e) => e.type === t && e.requestId && sentIds.has(e.requestId)).map((e) => e.requestId)).size;
  return { sent: sentIds.size, viewed: reached('request.viewed'), signed: reached('request.signed'), declined: reached('request.declined'), voided: reached('request.voided'), expired: reached('request.expired') };
}

export interface BlockedRate {
  formNumber: string;
  blocked: number;
  attempts: number;
  /** blocked ÷ attempts, 0–1. */
  rate: number;
}

/**
 * Per form: `send.blocked` ÷ send attempts, where an attempt is a blocked press or a
 * send that went out (`request.sent`). Highest rate first.
 */
export function blockedSendRate(events: UsageEvent[], range: Range = {}): BlockedRate[] {
  const by = new Map<string, { blocked: number; sent: number }>();
  for (const e of events) {
    if ((e.type !== 'send.blocked' && e.type !== 'request.sent') || !e.formNumber || !inRange(e, range)) continue;
    const c = by.get(e.formNumber) ?? { blocked: 0, sent: 0 };
    if (e.type === 'send.blocked') c.blocked++;
    else c.sent++;
    by.set(e.formNumber, c);
  }
  return [...by]
    .map(([formNumber, c]) => ({ formNumber, blocked: c.blocked, attempts: c.blocked + c.sent, rate: c.blocked / (c.blocked + c.sent) }))
    .sort((a, b) => b.rate - a.rate || b.attempts - a.attempts || a.formNumber.localeCompare(b.formNumber));
}

/** The checks named most often on `send.blocked` rows. */
export function topBlockingChecks(events: UsageEvent[], range: Range = {}): UsageCount[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'send.blocked' || !inRange(e, range)) continue;
    const ids = e.detail?.blockingChecks;
    for (const id of Array.isArray(ids) ? ids : []) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** People with any event in the `days` before `now`. */
export function activeUsers(events: UsageEvent[], days: number, now: Date = new Date()): number {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  return new Set(events.filter((e) => e.occurredOn >= from && e.occurredOn <= now.toISOString()).map((e) => e.userId)).size;
}
