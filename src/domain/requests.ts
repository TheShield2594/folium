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
