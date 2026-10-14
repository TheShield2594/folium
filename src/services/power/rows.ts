import type { FeedbackCategory, FeedbackKind, FeedbackStatus, FormFeedback } from '../../domain/feedback';
import type { SignatureRequest } from '../../domain/types';
import type { UsageEvent } from '../../domain/usage';
import { FEEDBACK_KIND_OPTIONS, FEEDBACK_STATUS_OPTIONS, SIGNATURE_STATUS_OPTIONS, USAGE_EVENT_OPTIONS } from './config';

// Dataverse rows for Folium's records, kept apart from the data client so they can be
// tested on their own. Columns other than `ev_payload` are what views, flows and the
// Power BI report (docs/REPORTS.md) read.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `{ 'col@odata.bind': '/set(id)' }`, or nothing when there's no ID (Dataverse rejects a bind to a non-GUID). */
export function bind(column: string, entitySet: string, id: string | undefined): Record<string, string> {
  return id && GUID.test(id) ? { [`${column}@odata.bind`]: `/${entitySet}(${id})` } : {};
}

/** `ev_signaturerequest`: the indexed columns, the promoted reporting columns and the payload. */
export function requestRow(r: SignatureRequest) {
  return {
    ev_name: r.title,
    'ev_contact@odata.bind': `/contacts(${r.contactId})`,
    ev_status: SIGNATURE_STATUS_OPTIONS[r.status],
    ev_expireson: r.expiresOn ?? null,
    ev_envelopeid: r.envelopeId ?? null,
    ev_provider: r.provider,
    ev_senton: r.sentOn ?? null,
    ev_signedon: r.signedOn ?? null,
    ev_uploadedtoonbase: r.uploadedToOnBase,
    // Promoted for reporting: who it's for, who did the work, and how it went.
    ...bind('ev_owner', 'systemusers', r.ownerId),
    ...bind('ev_preparedby', 'systemusers', r.preparedById),
    ev_viewedon: r.viewedOn ?? null,
    ev_inperson: !!r.inPerson,
    ev_formcount: r.documents.length,
    ev_payload: JSON.stringify(r),
  };
}

/** `ev_usageevent`: one row per event per form. No payload; `ev_detail` is the allow-listed detail. */
export function usageRow(e: UsageEvent) {
  return {
    ev_name: [e.type, e.formNumber].filter(Boolean).join(' '),
    ev_eventtype: USAGE_EVENT_OPTIONS[e.type],
    ev_occurredon: e.occurredOn,
    ...bind('ev_user', 'systemusers', e.userId),
    ...bind('ev_actingfor', 'systemusers', e.actingForId),
    ...bind('ev_template', 'ev_formtemplates', e.templateId),
    ev_formnumber: e.formNumber ?? null,
    ev_revision: e.revision ?? null,
    ev_source: e.source ?? null,
    ev_issuer: e.issuer ?? null,
    ev_category: e.category ?? null,
    ev_region: e.region ?? null,
    ev_groups: e.groups?.slice(0, 400) ?? null,
    ...bind('ev_contact', 'contacts', e.contactId),
    ...bind('ev_request', 'ev_signaturerequests', e.requestId),
    ev_batchid: e.batchId,
    ev_dedupekey: e.dedupeKey,
    ev_detail: e.detail ? JSON.stringify(e.detail).slice(0, 2000) : null,
  };
}

/** Dataverse refuses a second row with the same alternate key: that event is already recorded. */
export function isDuplicateKeyError(err: { code?: string; message?: string } | undefined): boolean {
  return err?.code === '0x80060892' || /duplicate|same key|already exists/i.test(err?.message ?? '');
}

/** `ev_formrequest`: requests and problem reports. */
export function feedbackRow(f: Omit<FormFeedback, 'id'> & { id?: string }) {
  const { id: _id, ...payload } = f;
  return {
    ev_name: f.name,
    ev_issuer: f.issuer ?? null,
    ev_note: f.note ?? null,
    // Kept for older views; the lookup is what counts.
    ev_requestedby: f.requestedBy,
    ...bind('ev_requester', 'systemusers', f.requestedById),
    ev_kind: FEEDBACK_KIND_OPTIONS[f.kind],
    ev_status: FEEDBACK_STATUS_OPTIONS[f.status],
    ...bind('ev_template', 'ev_formtemplates', f.templateId),
    ev_formnumber: f.formNumber ?? null,
    ev_revision: f.revision ?? null,
    ev_category: f.category ?? null,
    ev_resolvedon: f.resolvedOn ?? null,
    ev_payload: JSON.stringify(payload),
  };
}

export type FeedbackRowIn = {
  ev_formrequestid: string;
  ev_name?: string;
  ev_issuer?: string;
  ev_note?: string;
  ev_requestedby?: string;
  _ev_requester_value?: string;
  ev_kind?: number;
  ev_status?: number;
  ev_category?: string;
  createdon?: string;
  ev_payload?: string;
};

const reverse = <K extends string>(m: Record<K, number>, n: number | undefined): K | undefined => (Object.keys(m) as K[]).find((k) => m[k] === n);

/**
 * A feedback row as Folium shows it. Rows from before feedback had a payload are
 * requests named in text; the status column wins over the payload, so a flow or a
 * model-driven view can change it.
 */
export function fromFeedbackRow(row: FeedbackRowIn): FormFeedback {
  const payload = row.ev_payload ? (JSON.parse(row.ev_payload) as Partial<FormFeedback>) : {};
  return {
    ...payload,
    id: row.ev_formrequestid,
    kind: payload.kind ?? reverse<FeedbackKind>(FEEDBACK_KIND_OPTIONS, row.ev_kind) ?? 'request',
    name: payload.name ?? row.ev_name ?? '',
    issuer: payload.issuer ?? row.ev_issuer ?? undefined,
    note: payload.note ?? row.ev_note ?? undefined,
    category: payload.category ?? (row.ev_category as FeedbackCategory | undefined) ?? undefined,
    requestedById: payload.requestedById ?? row._ev_requester_value ?? undefined,
    requestedBy: payload.requestedBy ?? row.ev_requestedby ?? '',
    createdOn: payload.createdOn ?? row.createdon ?? new Date(0).toISOString(),
    status: reverse<FeedbackStatus>(FEEDBACK_STATUS_OPTIONS, row.ev_status) ?? payload.status ?? 'new',
  };
}
