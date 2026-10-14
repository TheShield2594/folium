import type { SignatureRequest, SignatureStatus } from './types';

// Signature request status and expiry, kept pure so the power and demo services, the
// request cards and the DocuSign Connect flow (#5) agree on them.

/** DocuSign voids an envelope that lapses and says so in `voidedReason` ("Envelope has expired"). */
export const isExpiryReason = (reason: string | undefined) => !!reason && /expir/i.test(reason);

/**
 * A DocuSign envelope status as Folium's. A voided envelope whose reason is expiry is
 * `Expired`, not `Voided`. Unknown statuses give `undefined`, so the caller keeps the
 * status it has instead of guessing.
 */
export function mapDocuSignStatus(status: string | undefined, voidedReason?: string): SignatureStatus | undefined {
  switch (status?.toLowerCase()) {
    case 'created':
      return 'Drafted';
    case 'sent':
      return 'Sent';
    case 'delivered':
      return 'Viewed';
    case 'completed':
      return 'Signed';
    case 'declined':
      return 'Declined';
    case 'voided':
      return isExpiryReason(voidedReason) ? 'Expired' : 'Voided';
    default:
      return undefined;
  }
}

const DAY = 86_400_000;

/** When an envelope sent on `sentOn` lapses, from the days chosen on the Send screen. */
export function expiresOnFrom(sentOn: string | undefined, expiresInDays: number | undefined): string | undefined {
  if (!sentOn || !expiresInDays) return undefined;
  return new Date(new Date(sentOn).getTime() + expiresInDays * DAY).toISOString();
}

export interface ExpiryInfo {
  expiresOn: string;
  /** Whole days until expiry, rounded up; 0 or less once it's past. */
  daysLeft: number;
  /** 7 days or fewer left, matching DocuSign's own warning to the signer. */
  soon: boolean;
  /** Past expiry, but Folium still has it as Sent or Viewed: the status needs checking. */
  pastDue: boolean;
}

const OPEN: SignatureStatus[] = ['Sent', 'Viewed'];

/** Expiry for an open request; undefined once it's finished or when the date isn't known. */
export function expiryInfo(req: Pick<SignatureRequest, 'status' | 'expiresOn' | 'sentOn' | 'expiresInDays'>, now: Date = new Date()): ExpiryInfo | undefined {
  if (!OPEN.includes(req.status)) return undefined;
  const expiresOn = req.expiresOn ?? expiresOnFrom(req.sentOn, req.expiresInDays);
  if (!expiresOn) return undefined;
  const ms = new Date(expiresOn).getTime() - now.getTime();
  const daysLeft = Math.ceil(ms / DAY);
  return { expiresOn, daysLeft, soon: ms > 0 && daysLeft <= 7, pastDue: ms <= 0 };
}

/** Requests that are finished: nothing more will happen to them in DocuSign. */
export const isFinished = (r: Pick<SignatureRequest, 'status' | 'uploadedToOnBase'>) =>
  (r.status === 'Signed' && r.uploadedToOnBase) || r.status === 'Voided' || r.status === 'Declined' || r.status === 'Expired';

/** What DocuSign said about an envelope (the provider-neutral `EnvelopeStatus`). */
export interface StatusReport {
  status?: SignatureStatus;
  voidedReason?: string;
  expiresOn?: string;
  viewedOn?: string;
  signedOn?: string;
  recipients: { role: string; status: 'sent' | 'delivered' | 'completed' | 'declined'; at?: string }[];
}

export interface StatusUpdate {
  next: SignatureRequest;
  /** Status or a signer changed (an expiry date alone doesn't count). */
  changed: boolean;
  /** For the toast. */
  message: string;
}

/**
 * Fold a status report into a request: signer progress, audit entries for what's new,
 * and the expiry date. An unknown status keeps the stored one.
 */
export function applyEnvelopeStatus(r: SignatureRequest, st: StatusReport, now: Date = new Date()): StatusUpdate {
  const status = st.status ?? r.status;
  const expiresOn = st.expiresOn ?? r.expiresOn;
  // One signer can finish while the envelope is still "Sent", so compare signers too.
  const signers = r.signers.map((s) => {
    const rec = st.recipients.find((x) => x.role === s.role);
    if (!rec) return s;
    const next = rec.status === 'completed' ? 'signed' : rec.status === 'delivered' ? 'viewed' : rec.status === 'declined' ? 'declined' : 'sent';
    return { ...s, status: next, signedOn: rec.at ?? s.signedOn } as typeof s;
  });
  const signersChanged = signers.some((s, i) => s.status !== r.signers[i].status);
  if (status === r.status && !signersChanged) return { next: { ...r, expiresOn }, changed: false, message: 'No change yet' };

  const at = now.toISOString();
  const events = [...r.audit];
  for (const s of signers) if (s.status === 'signed' && r.signers.find((x) => x.role === s.role)?.status !== 'signed') events.push({ at: s.signedOn ?? at, actor: s.name, action: 'Signed' });
  if (st.viewedOn && !r.viewedOn) events.push({ at: st.viewedOn, actor: r.signers[0]?.name ?? 'Signer', action: 'Viewed' });
  if (status === 'Signed' && r.status !== 'Signed') events.push({ at: st.signedOn ?? at, actor: 'DocuSign', action: 'Completed', detail: 'All signers signed' });
  const signedCount = signers.filter((s) => s.status === 'signed').length;
  if (status === 'Expired' && r.status !== 'Expired') events.push({ at: expiresOn ?? at, actor: 'DocuSign', action: 'Expired', detail: `${signedCount} of ${signers.length} signed before it lapsed` });
  return {
    next: {
      ...r,
      status,
      expiresOn,
      voidedReason: status === 'Voided' || status === 'Expired' ? (st.voidedReason ?? r.voidedReason) : r.voidedReason,
      viewedOn: st.viewedOn ?? r.viewedOn,
      signedOn: st.signedOn ?? r.signedOn,
      signers,
      audit: events,
    },
    changed: true,
    message: status === r.status ? `${signedCount} of ${signers.length} signed` : status === 'Expired' ? 'The envelope expired before everyone signed' : `Now: ${status.toLowerCase()}`,
  };
}

// ---------------------------------------------------------------- In-session signing

/** Where DocuSign sends an in-session signer back to: Folium's own signing-return route. */
export function signingReturnUrl(appUrl: string, envelopeId: string, role: string): string {
  return `${appUrl.split('#')[0]}#/signing-return?${new URLSearchParams({ envelope: envelopeId, role })}`;
}

/** Add `event=` the way DocuSign does, after whatever query the URL already has. */
export function withSigningEvent(url: string, event: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}event=${encodeURIComponent(event)}`;
}

/** What DocuSign's return `event` means, for the advisor and the audit trail. */
export function signingEventMessage(event: string | undefined, name: string): { done: boolean; text: string; audit: string } {
  switch (event) {
    case 'signing_complete':
      return { done: true, text: `${name} signed.`, audit: 'Signed in session' };
    case 'decline':
      return { done: true, text: `${name} declined to sign.`, audit: 'Declined in session' };
    case 'cancel':
      return { done: false, text: `${name} stopped before finishing. Use “Sign now” to open it again.`, audit: 'In-session signing stopped' };
    case 'ttl_expired':
    case 'session_timeout':
      return { done: false, text: 'The signing link timed out. Use “Sign now” for a fresh one.', audit: 'In-session signing timed out' };
    case 'access_code_failed':
    case 'id_check_failed':
      return { done: false, text: `${name} couldn’t be verified, so DocuSign stopped.`, audit: 'In-session verification failed' };
    default:
      return { done: false, text: `DocuSign came back with “${event ?? 'no result'}”.`, audit: 'In-session signing ended' };
  }
}

// ---------------------------------------------------------------- Draft retention

/** How long the firm may keep an unsent draft, in days after its last save. 0 turns drafts off. */
export const RETENTION_OPTIONS = [90, 60, 30, 10, 7, 0] as const;
export const DEFAULT_RETENTION_DAYS = 90;

/** The firm's retention period, falling back to the default for a missing or unknown value. */
export function retentionDays(firm: { draftRetentionDays?: number } | undefined): number {
  const d = firm?.draftRetentionDays;
  return d !== undefined && (RETENTION_OPTIONS as readonly number[]).includes(d) ? d : DEFAULT_RETENTION_DAYS;
}

/** Whether advisors can save and share drafts at all (retention isn't 0). */
export const draftsAllowed = (firm: { draftRetentionDays?: number } | undefined) => retentionDays(firm) > 0;

/**
 * When a draft saved on `savedOn` expires. Every save restarts the clock. Undefined
 * when retention is 0 (nothing is kept as a draft).
 */
export function draftExpiry(savedOn: string | Date, days: number): string | undefined {
  if (!days) return undefined;
  return new Date(new Date(savedOn).getTime() + days * DAY).toISOString();
}

/**
 * Whether the retention clean-up may delete a request: only unsent drafts. A packet
 * downloaded to sign in person is a record of what was printed, and a draft whose
 * envelope DocuSign already holds is halfway through a send; neither expires.
 */
export const isRetainable = (r: Pick<SignatureRequest, 'status' | 'inPerson' | 'envelopeId'>) => r.status === 'Drafted' && !r.inPerson && !r.envelopeId;

export interface DraftExpiryInfo {
  expiresOn: string;
  /** Whole days left, rounded up; 0 or less once it's past. */
  daysLeft: number;
  /** 7 days or fewer left: the reminder email has gone out. */
  soon: boolean;
}

/** Expiry for a draft the clean-up will delete; undefined for anything else or when no date is set. */
export function draftExpiryInfo(req: Pick<SignatureRequest, 'status' | 'inPerson' | 'envelopeId' | 'expiresOn'>, now: Date = new Date()): DraftExpiryInfo | undefined {
  if (!isRetainable(req) || !req.expiresOn) return undefined;
  const ms = new Date(req.expiresOn).getTime() - now.getTime();
  const daysLeft = Math.ceil(ms / DAY);
  return { expiresOn: req.expiresOn, daysLeft, soon: daysLeft <= 7 };
}
