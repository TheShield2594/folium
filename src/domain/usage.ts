import type { FormTemplate, SignatureRequest, UserGroup, UserProfile } from './types';

// Usage events (`ev_usageevent`): one row per event per form, so "uses of EV-1120" is a
// plain count. Kept pure: the screens say what happened, this builds the rows. It never
// takes field values, and `detail` keeps only the allow-listed keys below.

export type UsageEventType =
  | 'form.added'
  | 'pdf.fillable'
  | 'pdf.flattened'
  | 'pdf.print'
  | 'draft.saved'
  | 'send.blocked'
  | 'request.sent'
  | 'request.viewed'
  | 'request.signed'
  | 'request.declined'
  | 'request.voided'
  | 'request.expired'
  | 'request.inperson'
  | 'user.noprofile';

export const USAGE_EVENT_TYPES: UsageEventType[] = [
  'form.added',
  'pdf.fillable',
  'pdf.flattened',
  'pdf.print',
  'draft.saved',
  'send.blocked',
  'request.sent',
  'request.viewed',
  'request.signed',
  'request.declined',
  'request.voided',
  'request.expired',
  'request.inperson',
  'user.noprofile',
];

/** Events DocuSign reports. Both Check status and the Connect flow write them, so they're deduplicated. */
export const STATUS_EVENT_TYPES: UsageEventType[] = ['request.viewed', 'request.signed', 'request.declined', 'request.voided', 'request.expired'];

/**
 * Someone opened Folium without a Folium profile (at most one row a day each, by its
 * dedupe key), so Users & groups can list them for an administrator to give a role.
 */
export function noProfileEvent(userId: string, at: Date = new Date()): UsageEvent[] {
  const day = at.toISOString().slice(0, 10);
  return usageEvents('user.noprofile', { user: { systemuserid: userId, groupIds: [] }, at, batchId: `noprofile|${userId}|${day}` }, []);
}

/**
 * The only `detail` keys a row may carry: how a PDF was made, how many signers and how
 * they verify, and the IDs of the checks that blocked a send. Nothing about the client.
 */
export const DETAIL_KEYS = ['mode', 'signerCount', 'auth', 'blockingChecks'] as const;
export type UsageDetailKey = (typeof DETAIL_KEYS)[number];
export type UsageDetail = Partial<Record<UsageDetailKey, string | number | string[]>>;

export interface UsageEvent {
  type: UsageEventType;
  /** ISO. The device's clock for app events, DocuSign's time for status events. */
  occurredOn: string;
  /** systemuser who did it. */
  userId: string;
  /** The User an Assistant (or a colleague) worked for, only when that's someone else. */
  actingForId?: string;
  templateId?: string;
  /** Copied from the template, so a retired revision still reports. */
  formNumber?: string;
  revision?: string;
  source?: string;
  issuer?: string;
  category?: string;
  /** The user's region and group names at the time. */
  region?: string;
  groups?: string;
  contactId?: string;
  /** The request, once saved. */
  requestId?: string;
  /** Rows written by one action share it. */
  batchId: string;
  /** Unique per row (Dataverse alternate key): the same event recorded twice keeps one row. */
  dedupeKey: string;
  detail?: UsageDetail;
}

export interface UsageContext {
  user: Pick<UserProfile, 'systemuserid' | 'region' | 'groupIds'>;
  actingFor?: Pick<UserProfile, 'systemuserid'>;
  groups?: Pick<UserGroup, 'id' | 'name' | 'region'>[];
  contactId?: string;
  requestId?: string;
  /** Defaults to now. */
  at?: Date | string;
  /** Defaults to a new random ID. Pass one to make the rows (and their dedupe keys) reproducible. */
  batchId?: string;
}

const MAX_DETAIL_TEXT = 200;
const MAX_DETAIL_ITEMS = 20;

/** Keep only allow-listed keys with plain values (short text, numbers, short lists of text). */
export function cleanDetail(detail: Record<string, unknown> | undefined): UsageDetail | undefined {
  if (!detail) return undefined;
  const out: UsageDetail = {};
  for (const key of DETAIL_KEYS) {
    const v = detail[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'string' && v) out[key] = v.slice(0, MAX_DETAIL_TEXT);
    else if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === 'string' && !!x).slice(0, MAX_DETAIL_ITEMS).map((x) => x.slice(0, 80));
      if (list.length) out[key] = list;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function newBatchId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * `<scope>|<event>|<template>|<position>`. A status event's scope is its request, so it
 * reads the same whoever records it (Check status or the Connect flow, which builds the
 * key from the request's documents in order). Any other event's scope is its batch.
 */
export function dedupeKey(type: UsageEventType, batchId: string, templateId: string | undefined, index: number, requestId?: string): string {
  const scope = requestId && STATUS_EVENT_TYPES.includes(type) ? requestId : batchId;
  return `${scope}|${type}|${templateId ?? '-'}|${index}`;
}

/**
 * The rows for one thing that happened: one per form in `templates` (a form added twice
 * as copies counts twice). With no forms, one row without a template.
 */
export function usageEvents(
  type: UsageEventType,
  ctx: UsageContext,
  templates: Pick<FormTemplate, 'id' | 'formNumber' | 'revision' | 'source' | 'issuer' | 'category'>[],
  extra: { detail?: Record<string, unknown> } = {},
): UsageEvent[] {
  const at = ctx.at === undefined ? new Date().toISOString() : typeof ctx.at === 'string' ? ctx.at : ctx.at.toISOString();
  const batchId = ctx.batchId ?? newBatchId();
  const mine = (ctx.groups ?? []).filter((g) => ctx.user.groupIds?.includes(g.id));
  const region = ctx.user.region || mine.find((g) => g.region)?.region;
  const groups = mine.map((g) => g.name).join('; ') || undefined;
  const actingForId = ctx.actingFor && ctx.actingFor.systemuserid !== ctx.user.systemuserid ? ctx.actingFor.systemuserid : undefined;
  const requestId = ctx.requestId || undefined;
  const detail = cleanDetail(extra.detail);
  const forms = templates.length ? templates : [undefined];
  return forms.map((t, i) => ({
    type,
    occurredOn: at,
    userId: ctx.user.systemuserid,
    ...(actingForId ? { actingForId } : {}),
    ...(t ? { templateId: t.id, formNumber: t.formNumber, revision: t.revision, source: t.source, issuer: t.issuer, category: t.category } : {}),
    ...(region ? { region } : {}),
    ...(groups ? { groups } : {}),
    ...(ctx.contactId ? { contactId: ctx.contactId } : {}),
    ...(requestId ? { requestId } : {}),
    batchId,
    dedupeKey: dedupeKey(type, batchId, t?.id, i, requestId),
    ...(detail ? { detail } : {}),
  }));
}

/**
 * The status events a change from `prev` to `next` reports, each with when DocuSign says
 * it happened. Recording the same change again gives the same dedupe keys.
 */
export function statusEvents(prev: Pick<SignatureRequest, 'status' | 'viewedOn'>, next: Pick<SignatureRequest, 'status' | 'viewedOn' | 'signedOn' | 'expiresOn'>, now: Date = new Date()): { type: UsageEventType; at: string }[] {
  const out: { type: UsageEventType; at: string }[] = [];
  const at = now.toISOString();
  const opened = next.viewedOn && !prev.viewedOn;
  // Viewed is reported once, whether DocuSign gave a time or the status jumped past it.
  if (opened || (next.status === 'Viewed' && prev.status === 'Sent')) out.push({ type: 'request.viewed', at: next.viewedOn ?? at });
  if (next.status !== prev.status) {
    if (next.status === 'Signed') out.push({ type: 'request.signed', at: next.signedOn ?? at });
    if (next.status === 'Declined') out.push({ type: 'request.declined', at });
    if (next.status === 'Voided') out.push({ type: 'request.voided', at });
    if (next.status === 'Expired') out.push({ type: 'request.expired', at: next.expiresOn ?? at });
  }
  return out;
}

/**
 * A check's ID without the packet item it ran on, so the same check on the same form
 * reads the same in every packet (`pi-1a2b3c4d:required` → `required`).
 */
export function stableCheckId(id: string): string {
  return id.replace(/pi-[A-Za-z0-9]+[:/]/g, '');
}
