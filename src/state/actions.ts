import type { FormFill } from '../domain/prefill';
import type { AuditEvent, SignatureRequest, UserProfile } from '../domain/types';
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
}): Promise<SignatureRequest> {
  const { services, packet, fills, contactId, me, owner, existing } = opts;
  const folder = await services.drafts.folderUrl(contactId);
  if (opts.writePdfs) {
    const docs = await fillPacket(services, fills, 'fillable', true);
    for (const d of docs) await services.drafts.saveDraft(contactId, `DRAFT ${d.fileName}`, d.pdf);
  }
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
    documents: fills.map((f) => ({ templateId: f.template.id, name: f.template.name, formNumber: f.template.formNumber, revision: f.template.revision })),
    values: { ...packet.values },
    attachments: packet.attachments,
    sharedWith: packet.sharedWith,
    draftFolderUrl: folder,
    audit: [...base.audit, audit(me, existing ? 'Draft updated' : 'Draft saved', me.systemuserid !== owner.systemuserid ? `on behalf of ${owner.fullname}` : undefined)],
  };
  return services.requests.save(req);
}
