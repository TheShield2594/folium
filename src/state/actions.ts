import { defaultDraftTitle, shortDraftId } from '../domain/drafts';
import { formLabel } from '../domain/checks';
import { DEFAULT_RETENTION_DAYS, draftExpiry, isRetainable } from '../domain/requests';
import { DOCUSIGN_MAIN } from '../domain/signing';
import { prefillSnapshot, type FormFill } from '../domain/prefill';
import type { Attachment, AuditEvent, SignatureRequest, UserProfile } from '../domain/types';
import { fillPdf, mergePdfs } from '../pdf/fill';
import type { Services, SigningProvider } from '../services/types';
import { track, type Packet } from './store';

export interface FilledDoc {
  templateId: string;
  itemId: string;
  name: string;
  fileName: string;
  pdf: Uint8Array;
  placements: FormFill['template']['mapping']['placements'];
}

/**
 * Fill every form in the packet with pdf-lib.
 * - `fillable`: keep AcroForm fields editable (LaserApp-style "download a fillable PDF")
 * - `flatten`: lock prefilled values, for e-signature and in-person signing
 */
export async function fillPacket(services: Services, fills: FormFill[], mode: 'fillable' | 'flatten', draftMark = false): Promise<FilledDoc[]> {
  const out: FilledDoc[] = [];
  for (const f of fills) {
    const blank = await services.templates.getPdf(f.template);
    const { pdf } = await fillPdf(blank, f.fields, { kind: f.template.pdfKind, flatten: mode === 'flatten', draftMark });
    out.push({
      templateId: f.template.id,
      itemId: f.itemId,
      name: formLabel(f),
      // Copies get their own file name, so the envelope doesn't hold two of the same name.
      fileName: `${f.template.formNumber} ${formLabel(f)}.pdf`,
      pdf,
      placements: f.template.mapping.placements,
    });
  }
  return out;
}

export async function packetAsOnePdf(services: Services, fills: FormFill[], mode: 'fillable' | 'flatten', draftMark = false) {
  const docs = await fillPacket(services, fills, mode, draftMark);
  return docs.length === 1 ? docs[0].pdf : mergePdfs(docs.map((d) => d.pdf));
}

/**
 * Step 2 of a send: release the envelope the provider holds as a draft. When resuming after
 * a lost reply, ask DocuSign first, so an envelope that already went out never goes twice.
 * If the status can't be read, release anyway: releasing a sent envelope doesn't resend it.
 */
export async function releaseEnvelope(signing: SigningProvider, envelopeId: string, resuming: boolean): Promise<'released' | 'already sent'> {
  const status = resuming ? (await signing.getStatus(envelopeId).catch(() => undefined))?.status : 'Drafted';
  if (status !== 'Drafted' && status !== undefined) return 'already sent';
  await signing.release(envelopeId);
  return 'released';
}

export function audit(actor: UserProfile | undefined, action: string, detail?: string): AuditEvent {
  return { at: new Date().toISOString(), actor: actor?.fullname ?? 'Folium', action, detail };
}

/** Signer and email setup from the Send screen, kept with a draft. */
export type SendSetup = Partial<Pick<SignatureRequest, 'signers' | 'ccs' | 'subject' | 'message' | 'anyOrder' | 'reminderDays' | 'expiresInDays' | 'provider'>>;

/** Attachments whose bytes Folium can't reach (not attached this session, not stored with a draft). */
export function unreachableAttachments(services: Services, attachments: Attachment[]): Attachment[] {
  return attachments.filter((a) => !services.attachments.has(a.id) && !a.storedAt);
}

/** Bytes for an attachment: from this session, or from where the draft stored it. */
export async function attachmentBytes(services: Services, a: Attachment): Promise<Uint8Array> {
  const local = services.attachments.get(a.id);
  if (local) return local.bytes;
  if (!a.storedAt) throw new Error(`Re-attach ${a.name}`);
  const bytes = await services.drafts.getFile(a.storedAt.itemId);
  services.attachments.set(a.id, { meta: a, bytes });
  return bytes;
}

/** Store attachments that only exist in this session next to the draft, so a reload or a colleague can use them. */
async function storeAttachments(services: Services, contactId: string, attachments: Attachment[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const a of attachments) {
    const local = services.attachments.get(a.id);
    if (a.storedAt || !local) {
      out.push(a);
      continue;
    }
    const storedAt = await services.drafts.saveAttachment(contactId, `${a.id.slice(0, 8)} ${a.name}`, local.bytes);
    const next = { ...a, storedAt };
    services.attachments.set(a.id, { meta: next, bytes: local.bytes });
    out.push(next);
  }
  return out;
}

/** Save the packet as a Drafted signature request (and its PDFs to the contact's SharePoint folder). */
export async function saveDraft(opts: {
  services: Services;
  packet: Packet;
  fills: FormFill[];
  contactId: string;
  me: UserProfile;
  owner: UserProfile;
  existing?: SignatureRequest;
  writePdfs?: boolean;
  sendSetup?: SendSetup;
  /** Extra detail for the audit entry, e.g. why the draft was saved automatically. */
  auditNote?: string;
  /** The firm's draft retention (`retentionDays(firm)`): a retainable draft expires this many days after this save. Default 90. */
  retentionDays?: number;
  /** Called once the row is saved, before the draft PDFs are written, so a failed write can be retried against the same row. */
  onSaved?: (req: SignatureRequest) => void;
  /** Record a `draft.saved` usage event: the advisor saved a draft (not a save on the way to sending). */
  trackUsage?: boolean;
}): Promise<SignatureRequest> {
  const { services, packet, fills, contactId, me, owner, existing } = opts;
  const folder = await services.drafts.folderUrl(contactId);
  const attachments = await storeAttachments(services, contactId, packet.attachments);
  const title = packet.title || existing?.title || defaultDraftTitle(fills);
  const base: SignatureRequest = existing ?? {
    id: `new-${Date.now()}`,
    contactId,
    title,
    ownerId: owner.systemuserid,
    preparedById: me.systemuserid,
    preparedBy: me.fullname,
    sentBy: '',
    createdOn: new Date().toISOString(),
    provider: DOCUSIGN_MAIN,
    status: 'Drafted',
    documents: [],
    signers: [],
    ccs: [],
    subject: '',
    message: '',
    anyOrder: false,
    uploadedToOnBase: false,
    values: {},
    attachments: [],
    audit: [],
  };
  const now = new Date().toISOString();
  const req: SignatureRequest = {
    ...base,
    title,
    ...opts.sendSetup,
    documents: fills.map((f) => ({ templateId: f.template.id, name: f.template.name, formNumber: f.template.formNumber, revision: f.template.revision, accountId: f.accountId, itemId: f.itemId, ...(f.copy ? { copy: f.copy } : {}) })),
    values: { ...packet.values },
    state: packet.state,
    personBlocks: packet.personBlocks,
    prefillSnapshot: prefillSnapshot(fills),
    attachments,
    sharedWith: packet.sharedWith,
    draftFolderUrl: folder,
    audit: [
      ...base.audit,
      // An upgrade to current form revisions (made since the last save) is recorded with it.
      ...(packet.formsUpdated ? [audit(me, 'Forms updated', packet.formsUpdated)] : []),
      audit(me, existing ? 'Draft updated' : 'Draft saved', [me.systemuserid !== owner.systemuserid ? `on behalf of ${owner.fullname}` : '', opts.auditNote ?? ''].filter(Boolean).join(' · ') || undefined),
    ],
  };
  // Every save restarts the retention clock. Rows the clean-up never deletes (printed to
  // sign in person, mid-send) keep whatever date they have: an envelope's own expiry.
  if (isRetainable(req)) req.expiresOn = draftExpiry(now, opts.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const saved = await services.requests.save(req);
  opts.onSaved?.(saved);
  if (opts.trackUsage) track('draft.saved', fills.map((f) => f.template), { requestId: saved.id });
  if (!opts.writePdfs) return saved;
  // File names carry the draft's title and a short ID, so two drafts never overwrite each other.
  const docs = await fillPacket(services, fills, 'fillable', true);
  const draftFiles: { name: string; url: string }[] = [];
  for (const [i, d] of docs.entries()) {
    const name = `DRAFT ${fills[i].template.formNumber}${fills[i].copy ? ` (copy ${fills[i].copy})` : ''} ${title} – ${shortDraftId(saved.id)}.pdf`.replace(/[\\/:*?"<>|#%]/g, '-');
    draftFiles.push({ name, ...(await services.drafts.saveDraft(contactId, name, d.pdf)) });
  }
  return services.requests.save({ ...saved, draftFiles: [...(existing?.draftFiles ?? []).filter((f) => !draftFiles.some((x) => x.name === f.name)), ...draftFiles] });
}

/**
 * Delete a draft: its PDFs in SharePoint, then the row (a soft delete, so Undo brings the
 * row back; the PDFs are rewritten at its next Save draft). Attachments stay until the
 * retention flow deletes the row for good, so Undo still has them. Returns the PDFs that
 * couldn't be deleted.
 */
export async function deleteDraft(services: Services, req: SignatureRequest): Promise<{ name: string; url: string }[]> {
  const failed: { name: string; url: string }[] = [];
  for (const f of req.draftFiles ?? []) await services.drafts.removeFile(f.url).catch(() => failed.push(f));
  if (req.draftFiles?.length) await services.requests.save({ ...req, draftFiles: failed.length ? failed : undefined });
  await services.requests.remove(req.id);
  return failed;
}
