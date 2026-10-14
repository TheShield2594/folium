import { prefillSnapshot, type FormFill } from '../domain/prefill';
import type { Attachment, AuditEvent, SignatureRequest, UserProfile } from '../domain/types';
import { fillPdf, mergePdfs } from '../pdf/fill';
import type { Services } from '../services/types';
import type { Packet } from './store';

export interface FilledDoc {
  templateId: string;
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
      name: f.template.name,
      fileName: `${f.template.formNumber} ${f.template.name}.pdf`,
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

export function audit(actor: UserProfile | undefined, action: string, detail?: string): AuditEvent {
  return { at: new Date().toISOString(), actor: actor?.fullname ?? 'Folium', action, detail };
}

/** Signer and email setup from the Send screen, kept with a draft. */
export type SendSetup = Partial<Pick<SignatureRequest, 'signers' | 'ccs' | 'subject' | 'message' | 'anyOrder' | 'reminderDays' | 'expiresInDays'>>;

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
}): Promise<SignatureRequest> {
  const { services, packet, fills, contactId, me, owner, existing } = opts;
  const folder = await services.drafts.folderUrl(contactId);
  if (opts.writePdfs) {
    const docs = await fillPacket(services, fills, 'fillable', true);
    for (const d of docs) await services.drafts.saveDraft(contactId, `DRAFT ${d.fileName}`, d.pdf);
  }
  const attachments = await storeAttachments(services, contactId, packet.attachments);
  const title = packet.title || (fills.length === 1 ? fills[0].template.name : `${fills[0]?.template.name ?? 'Forms'} + ${fills.length - 1} more`);
  const base: SignatureRequest = existing ?? {
    id: `new-${Date.now()}`,
    contactId,
    title,
    ownerId: owner.systemuserid,
    preparedById: me.systemuserid,
    preparedBy: me.fullname,
    sentBy: '',
    createdOn: new Date().toISOString(),
    provider: 'DocuSign',
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
  const req: SignatureRequest = {
    ...base,
    title,
    ...opts.sendSetup,
    documents: fills.map((f) => ({ templateId: f.template.id, name: f.template.name, formNumber: f.template.formNumber, revision: f.template.revision, accountId: f.account?.accountid })),
    values: { ...packet.values },
    prefillSnapshot: prefillSnapshot(fills),
    attachments,
    sharedWith: packet.sharedWith,
    draftFolderUrl: folder,
    audit: [...base.audit, audit(me, existing ? 'Draft updated' : 'Draft saved', me.systemuserid !== owner.systemuserid ? `on behalf of ${owner.fullname}` : undefined)],
  };
  return services.requests.save(req);
}
