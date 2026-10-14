import { getContext } from '@microsoft/power-apps/app';
import { getClient, type DataClient } from '@microsoft/power-apps/data';
import type { Account, Connection, Contact, FirmProfile, FormTemplate, SavedPacket, SignatureRequest, TemplateMapping, UserGroup, UserProfile } from '../../domain/types';
import { mapDocuSignStatus } from '../../domain/requests';
import { buildEnvelopeDefinition, ROLE_SEPARATOR } from '../docusign/tabs';
import { classifyError, FoliumError } from '../errors';
import type { CrmService, DirectoryService, DraftStore, IncomingFile, PacketStore, RequestStore, Services, SigningProvider, TemplateLibrary } from '../types';
import { decodeChoices, encodeChoices } from './choices';
import { CHOICES, CONNECTORS, DATAVERSE, DOCUSIGN, SHAREPOINT, SIGNATURE_STATUS_OPTIONS } from './config';
import { dataSourcesInfo } from './dataSourcesInfo';

// Power Platform implementations. Dataverse tables go through the SDK's data client;
// SharePoint and DocuSign go through connector operations. Every Dataverse row Folium
// owns keeps its structured payload in one JSON memo column (`ev_payload`) so the
// table schema stays small and the shape can evolve without solution upgrades.

interface OpResult<T> {
  success: boolean;
  data: T;
  error?: { message?: string; code?: string; status?: number };
}

/** The SDK reports failures as `{ success: false }`; turn them into classified errors. */
function unwrap<T>(r: OpResult<T>, what: string): T {
  if (!r.success) throw new FoliumError(classifyError(r.error), what, `${what} failed: ${r.error?.message ?? 'unknown error'}`, r.error);
  return r.data;
}

const esc = (s: string) => s.replace(/'/g, "''");

export function createPowerServices(): Services {
  const client: DataClient = getClient(dataSourcesInfo);

  async function connector<T>(tableName: string, operationName: string, parameters: Record<string, unknown>, what: string): Promise<T> {
    return unwrap(await client.executeAsync<Record<string, unknown>, T>({ connectorOperation: { tableName, operationName, parameters } }), what);
  }

  const payloadRow = <T,>(row: { ev_payload?: string }): T => JSON.parse(row.ev_payload ?? '{}') as T;

  // ---------------------------------------------------------------- Directory
  type ProfileRow = { ev_foliumprofileid: string; _ev_user_value: string; ev_payload: string };
  async function loadProfiles(): Promise<{ row: ProfileRow; profile: UserProfile }[]> {
    const rows = unwrap(await client.retrieveMultipleRecordsAsync<ProfileRow>(DATAVERSE.profile, {}), 'Load users');
    return rows.map((row) => ({ row, profile: payloadRow<UserProfile>(row) }));
  }

  const directory: DirectoryService = {
    async currentUser() {
      const ctx = await getContext();
      const users = unwrap(
        await client.retrieveMultipleRecordsAsync<Record<string, string>>(DATAVERSE.systemuser, {
          filter: `azureactivedirectoryobjectid eq ${ctx.user.objectId}`,
          select: ['systemuserid', 'fullname', 'internalemailaddress', 'address1_telephone1', 'title'],
          top: 1,
        }),
        'Load signed-in user',
      );
      const u = users[0] ?? {};
      const saved = (await loadProfiles()).find((p) => p.row._ev_user_value === u.systemuserid)?.profile;
      return {
        role: 'User',
        groupIds: [],
        repCode: '',
        branch: '',
        ...saved,
        systemuserid: u.systemuserid ?? '',
        fullname: u.fullname ?? ctx.user.fullName ?? '',
        email: saved?.email || u.internalemailaddress || ctx.user.userPrincipalName || '',
        phone: saved?.phone || u.address1_telephone1 || '',
        title: saved?.title || u.title || '',
      };
    },
    async listUsers() {
      return (await loadProfiles()).map((p) => p.profile);
    },
    async saveUser(u) {
      const existing = (await loadProfiles()).find((p) => p.row._ev_user_value === u.systemuserid);
      const row = { ev_name: u.fullname, ev_role: u.role, ev_payload: JSON.stringify(u) };
      if (existing) unwrap(await client.updateRecordAsync(DATAVERSE.profile, existing.row.ev_foliumprofileid, row), 'Save user');
      else unwrap(await client.createRecordAsync(DATAVERSE.profile, { ...row, 'ev_user@odata.bind': `/systemusers(${u.systemuserid})` }), 'Create user');
      return u;
    },
    async listGroups() {
      const rows = unwrap(await client.retrieveMultipleRecordsAsync<{ ev_foliumgroupid: string; ev_payload: string }>(DATAVERSE.group, {}), 'Load groups');
      return rows.map((r) => ({ ...payloadRow<UserGroup>(r), id: r.ev_foliumgroupid }));
    },
    async saveGroup(g) {
      const row = { ev_name: g.name, ev_region: g.region ?? null, ev_payload: JSON.stringify(g) };
      if (g.id && !g.id.startsWith('new-')) {
        unwrap(await client.updateRecordAsync(DATAVERSE.group, g.id, row), 'Save group');
        return g;
      }
      const created = unwrap(await client.createRecordAsync<typeof row, { ev_foliumgroupid: string }>(DATAVERSE.group, row), 'Create group');
      return { ...g, id: created.ev_foliumgroupid };
    },
    async removeGroup(id) {
      unwrap(await client.deleteRecordAsync(DATAVERSE.group, id), 'Delete group');
    },
    async getFirm() {
      const rows = unwrap(await client.retrieveMultipleRecordsAsync<{ ev_payload: string }>(DATAVERSE.settings, { top: 1 }), 'Load firm');
      return payloadRow<FirmProfile>(rows[0] ?? {});
    },
    async saveFirm(f) {
      const rows = unwrap(await client.retrieveMultipleRecordsAsync<{ ev_foliumsettingid: string }>(DATAVERSE.settings, { top: 1 }), 'Load firm');
      const row = { ev_name: 'Firm', ev_payload: JSON.stringify(f) };
      if (rows[0]) unwrap(await client.updateRecordAsync(DATAVERSE.settings, rows[0].ev_foliumsettingid, row), 'Save firm');
      else unwrap(await client.createRecordAsync(DATAVERSE.settings, row), 'Create firm');
      return f;
    },
  };

  // ---------------------------------------------------------------- CRM
  const contactChoices = CHOICES.contact ?? {};
  const toContact = (row: Contact) => decodeChoices(row, contactChoices, 'contact');

  const crm: CrmService = {
    async getClient(contactId) {
      const contact = toContact(unwrap(await client.retrieveRecordAsync<Contact>(DATAVERSE.contact, contactId), 'Load contact'));
      const accounts = unwrap(
        await client.retrieveMultipleRecordsAsync<Account>(DATAVERSE.account, { filter: `${DATAVERSE.accountContactLookup} eq ${contactId} and statecode eq 0` }),
        'Load accounts',
      );
      const conns = unwrap(
        await client.retrieveMultipleRecordsAsync<Record<string, string>>(DATAVERSE.connection, {
          filter: `_record1id_value eq ${contactId} and statecode eq 0`,
          select: ['_record2id_value', '_record2roleid_value', 'ev_sharepct'],
        }),
        'Load connections',
      );
      const connections: Connection[] = [];
      for (const c of conns) {
        const other = await client.retrieveRecordAsync<Contact>(DATAVERSE.contact, c._record2id_value);
        if (!other.success) continue;
        connections.push({
          role: c['_record2roleid_value@OData.Community.Display.V1.FormattedValue'] ?? 'Connection',
          contact: toContact(other.data),
          ev_sharepct: c.ev_sharepct ? Number(c.ev_sharepct) : undefined,
        });
      }
      return { contact, accounts, connections };
    },
    async updateContact(contactId, changes) {
      const { contactid: _id, fullname: _fn, ...writable } = changes;
      unwrap(await client.updateRecordAsync(DATAVERSE.contact, contactId, encodeChoices(writable, contactChoices, 'contact')), 'Update contact');
      return toContact(unwrap(await client.retrieveRecordAsync<Contact>(DATAVERSE.contact, contactId), 'Reload contact'));
    },
    async updateAccount(accountId, changes) {
      const { accountid: _id, ...writable } = changes;
      unwrap(await client.updateRecordAsync(DATAVERSE.account, accountId, writable), 'Update account');
      return unwrap(await client.retrieveRecordAsync<Account>(DATAVERSE.account, accountId), 'Reload account');
    },
    async searchContacts(q) {
      const s = esc(q.trim());
      return unwrap(
        await client.retrieveMultipleRecordsAsync<Contact>(DATAVERSE.contact, {
          filter: `contains(fullname,'${s}') or ev_clientid eq '${s}' or emailaddress1 eq '${s}'`,
          top: 25,
          orderBy: ['fullname asc'],
        }),
        'Search contacts',
      ).map(toContact);
    },
    async recentContacts() {
      return unwrap(await client.retrieveMultipleRecordsAsync<Contact>(DATAVERSE.contact, { top: 10, orderBy: ['modifiedon desc'] }), 'Recent contacts').map(toContact);
    },
  };

  // ---------------------------------------------------------------- Templates
  const templates: TemplateLibrary = {
    async list() {
      const rows = unwrap(await client.retrieveMultipleRecordsAsync<{ ev_formtemplateid: string; ev_payload: string }>(DATAVERSE.formTemplate, {}), 'Load templates');
      return rows.map((r) => ({ ...payloadRow<FormTemplate>(r), id: r.ev_formtemplateid }));
    },
    async getPdf(t) {
      const content = await connector<string | Uint8Array>(CONNECTORS.sharePoint, 'GetFileContent', { dataset: SHAREPOINT.templateSite, id: t.sharePointItemId }, 'Download template');
      return typeof content === 'string' ? Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0)) : content;
    },
    async listIncoming() {
      const known = new Set((await templates.list()).map((t) => t.sharePointItemId));
      const items = await connector<{ value: { ID: string; '{FilenameWithExtension}': string; '{Link}': string; Editor?: { DisplayName: string }; Modified: string; '{Size}'?: number }[] }>(
        CONNECTORS.sharePoint,
        'GetItems',
        { dataset: SHAREPOINT.templateSite, table: SHAREPOINT.templateLibrary, $orderby: 'Modified desc', $top: 200 },
        'List SharePoint library',
      );
      return items.value
        .filter((i) => !known.has(String(i.ID)))
        .map(
          (i): IncomingFile => ({
            itemId: String(i.ID),
            name: i['{FilenameWithExtension}'],
            url: i['{Link}'],
            uploadedBy: i.Editor?.DisplayName ?? 'Marketing',
            uploadedOn: i.Modified,
            sizeBytes: i['{Size}'] ?? 0,
            guessedFormNumber: /([A-Z]{2,3}-\d{3,4})/.exec(i['{FilenameWithExtension}'])?.[1],
          }),
        );
    },
    async saveMapping(id, mapping: TemplateMapping) {
      const t = (await templates.list()).find((x) => x.id === id);
      if (!t) throw new Error('Template not found');
      const next = { ...t, mapping, status: t.status === 'Needs mapping' && mapping.fields.length ? ('Draft' as const) : t.status, modifiedOn: new Date().toISOString() };
      unwrap(await client.updateRecordAsync(DATAVERSE.formTemplate, id, { ev_payload: JSON.stringify(next), ev_status: next.status }), 'Save mapping');
      return next;
    },
    async saveDetails(id, details) {
      const t = (await templates.list()).find((x) => x.id === id);
      if (!t) throw new Error('Template not found');
      const next: FormTemplate = { ...t, states: details.states?.length ? details.states : undefined, variantGroup: details.variantGroup?.trim() || undefined, modifiedOn: new Date().toISOString() };
      unwrap(await client.updateRecordAsync(DATAVERSE.formTemplate, id, { ev_payload: JSON.stringify(next) }), 'Save details');
      return next;
    },
    async setStatus(id, status, effectiveDate) {
      const all = await templates.list();
      const t = all.find((x) => x.id === id);
      if (!t) throw new Error('Template not found');
      const next = { ...t, status, effectiveDate: effectiveDate ?? t.effectiveDate };
      unwrap(await client.updateRecordAsync(DATAVERSE.formTemplate, id, { ev_payload: JSON.stringify(next), ev_status: status }), 'Update status');
      if (status === 'Live' && next.effectiveDate <= new Date().toISOString().slice(0, 10)) {
        for (const o of all.filter((x) => x.id !== id && x.formNumber === t.formNumber && x.status === 'Live' && x.effectiveDate <= next.effectiveDate)) {
          unwrap(await client.updateRecordAsync(DATAVERSE.formTemplate, o.id, { ev_payload: JSON.stringify({ ...o, status: 'Retired' }), ev_status: 'Retired' }), `Retire ${o.formNumber} Rev ${o.revision}`);
        }
      }
      return next;
    },
    async register(file, init) {
      const t = { ...init, sharePointItemId: file.itemId, sharePointUrl: file.url, status: 'Needs mapping', modifiedBy: file.uploadedBy, modifiedOn: new Date().toISOString() } as FormTemplate;
      const created = unwrap(
        await client.createRecordAsync<Record<string, unknown>, { ev_formtemplateid: string }>(DATAVERSE.formTemplate, { ev_name: t.name, ev_formnumber: t.formNumber, ev_status: t.status, ev_payload: JSON.stringify(t) }),
        'Register template',
      );
      return { ...t, id: created.ev_formtemplateid };
    },
    async requestForm(req) {
      unwrap(await client.createRecordAsync(DATAVERSE.formRequest, { ev_name: req.name, ev_issuer: req.issuer, ev_note: req.note, ev_requestedby: req.requestedBy }), 'Request form');
    },
  };

  // ---------------------------------------------------------------- Drafts
  const drafts: DraftStore = {
    async folderUrl(contactId) {
      const rows = unwrap(
        await client.retrieveMultipleRecordsAsync<{ absoluteurl?: string; relativeurl: string }>('sharepointdocumentlocations', { filter: `_regardingobjectid_value eq ${contactId}`, top: 1 }),
        'Find document location',
      );
      return rows[0]?.absoluteurl ?? `${SHAREPOINT.crmSite}/${SHAREPOINT.crmLibrary}/${rows[0]?.relativeurl ?? contactId}`;
    },
    async saveDraft(contactId, fileName, pdf) {
      const folder = await drafts.folderUrl(contactId);
      const folderPath = new URL(folder).pathname.replace(new URL(SHAREPOINT.crmSite).pathname, '');
      await connector(CONNECTORS.sharePoint, 'CreateFile', { dataset: SHAREPOINT.crmSite, folderPath, name: fileName, body: pdf }, 'Save draft');
      return { url: `${folder}/${encodeURIComponent(fileName)}` };
    },
    async saveAttachment(contactId, fileName, bytes) {
      const folder = `${await drafts.folderUrl(contactId)}/${SHAREPOINT.attachmentsFolder}`;
      const folderPath = new URL(folder).pathname.replace(new URL(SHAREPOINT.crmSite).pathname, '');
      const created = await connector<{ Id: string }>(CONNECTORS.sharePoint, 'CreateFile', { dataset: SHAREPOINT.crmSite, folderPath, name: fileName, body: bytes }, `Save ${fileName}`);
      return { itemId: created.Id, url: `${folder}/${encodeURIComponent(fileName)}` };
    },
    async getFile(itemId) {
      const content = await connector<string | Uint8Array>(CONNECTORS.sharePoint, 'GetFileContent', { dataset: SHAREPOINT.crmSite, id: itemId }, 'Download attachment');
      return typeof content === 'string' ? Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0)) : content;
    },
  };

  // ---------------------------------------------------------------- Requests & packets
  // Deletes are soft: the row is deactivated (statecode 1) and lists read active rows
  // only, so Undo reactivates the same row. Hard deletion comes with retention (#19).
  const ACTIVE = 'statecode eq 0';
  const deactivate = (table: string, id: string, what: string) => client.updateRecordAsync(table, id, { statecode: 1, statuscode: 2 }).then((r) => unwrap(r, what));
  const reactivate = (table: string, id: string, what: string) => client.updateRecordAsync(table, id, { statecode: 0, statuscode: 1 }).then((r) => unwrap(r, what));
  type Row = { ev_signaturerequestid: string; ev_payload: string };
  const toRow = (r: SignatureRequest) => ({
    ev_name: r.title,
    'ev_contact@odata.bind': `/contacts(${r.contactId})`,
    ev_status: SIGNATURE_STATUS_OPTIONS[r.status],
    ev_expireson: r.expiresOn ?? null,
    ev_envelopeid: r.envelopeId ?? null,
    ev_provider: r.provider,
    ev_senton: r.sentOn ?? null,
    ev_signedon: r.signedOn ?? null,
    ev_uploadedtoonbase: r.uploadedToOnBase,
    ev_payload: JSON.stringify(r),
  });

  const requests: RequestStore = {
    async listForContact(contactId) {
      const rows = unwrap(await client.retrieveMultipleRecordsAsync<Row>(DATAVERSE.signatureRequest, { filter: `_ev_contact_value eq ${contactId} and ${ACTIVE}`, orderBy: ['createdon desc'] }), 'Load requests');
      return rows.map((r) => ({ ...payloadRow<SignatureRequest>(r), id: r.ev_signaturerequestid }));
    },
    async listMine() {
      // Every request this user can see: their own, ones they prepared as an assistant,
      // and drafts shared with them. Dataverse security decides which rows those are
      // (issue #1); the screens then narrow by ownerId / preparedById / sharedWith.
      // Filtering on _createdby_value here would drop shared and acting-for rows.
      const rows = unwrap(await client.retrieveMultipleRecordsAsync<Row>(DATAVERSE.signatureRequest, { filter: ACTIVE, orderBy: ['modifiedon desc'], top: 500 }), 'Load my requests');
      return rows.map((r) => ({ ...payloadRow<SignatureRequest>(r), id: r.ev_signaturerequestid }));
    },
    async get(id) {
      const r = await client.retrieveRecordAsync<Row>(DATAVERSE.signatureRequest, id);
      return r.success ? { ...payloadRow<SignatureRequest>(r.data), id } : undefined;
    },
    async save(req) {
      if (req.id && !req.id.startsWith('new-')) {
        unwrap(await client.updateRecordAsync(DATAVERSE.signatureRequest, req.id, toRow(req)), 'Save request');
        return req;
      }
      const created = unwrap(await client.createRecordAsync<ReturnType<typeof toRow>, Row>(DATAVERSE.signatureRequest, toRow(req)), 'Create request');
      return { ...req, id: created.ev_signaturerequestid };
    },
    async remove(id) {
      await deactivate(DATAVERSE.signatureRequest, id, 'Delete draft');
    },
    async restore(id) {
      await reactivate(DATAVERSE.signatureRequest, id, 'Restore draft');
    },
  };

  const packets: PacketStore = {
    async list() {
      const rows = unwrap(await client.retrieveMultipleRecordsAsync<{ ev_formpacketid: string; ev_payload: string }>(DATAVERSE.packet, { filter: ACTIVE }), 'Load packets');
      return rows.map((r) => ({ ...payloadRow<SavedPacket>(r), id: r.ev_formpacketid }));
    },
    async save(p) {
      const row = { ev_name: p.name, ev_shared: p.shared, ev_payload: JSON.stringify(p) };
      if (p.id && !p.id.startsWith('new-')) {
        unwrap(await client.updateRecordAsync(DATAVERSE.packet, p.id, row), 'Save packet');
        return p;
      }
      const created = unwrap(await client.createRecordAsync<typeof row, { ev_formpacketid: string }>(DATAVERSE.packet, row), 'Create packet');
      return { ...p, id: created.ev_formpacketid };
    },
    async remove(id) {
      await deactivate(DATAVERSE.packet, id, 'Delete packet');
    },
    async restore(id) {
      await reactivate(DATAVERSE.packet, id, 'Restore packet');
    },
  };

  // ---------------------------------------------------------------- DocuSign (custom connector, see connectors/)
  const signing: SigningProvider = {
    name: 'DocuSign',
    async create(req) {
      // Created as a DocuSign draft: nothing reaches the signers until `release`.
      const env = buildEnvelopeDefinition(req, DOCUSIGN.idv, 'created');
      const res = await connector<{ envelopeId: string }>(CONNECTORS.docuSign, 'CreateEnvelope', { body: env }, 'Create envelope');
      return { envelopeId: res.envelopeId };
    },
    async release(envelopeId) {
      await connector(CONNECTORS.docuSign, 'UpdateEnvelope', { envelopeId, body: { status: 'sent' } }, 'Send envelope');
    },
    async getStatus(envelopeId) {
      const e = await connector<{ status: string; voidedReason?: string; expireDateTime?: string; deliveredDateTime?: string; completedDateTime?: string; recipients?: { signers: { roleName: string; email: string; status: string; signedDateTime?: string }[] } }>(
        CONNECTORS.docuSign,
        'GetEnvelope',
        { envelopeId, include: 'recipients' },
        'Envelope status',
      );
      return {
        status: mapDocuSignStatus(e.status, e.voidedReason),
        voidedReason: e.voidedReason,
        expiresOn: e.expireDateTime,
        viewedOn: e.deliveredDateTime,
        signedOn: e.completedDateTime,
        // A recipient signing for several roles reports once per role.
        recipients: (e.recipients?.signers ?? []).flatMap((s) =>
          s.roleName.split(ROLE_SEPARATOR).map((role) => ({ role, email: s.email, status: s.status as 'sent' | 'delivered' | 'completed' | 'declined', at: s.signedDateTime })),
        ),
      };
    },
    async downloadCompleted(envelopeId) {
      const toBytes = (x: string | Uint8Array) => (typeof x === 'string' ? Uint8Array.from(atob(x), (c) => c.charCodeAt(0)) : x);
      const pdf = await connector<string | Uint8Array>(CONNECTORS.docuSign, 'GetDocument', { envelopeId, documentId: 'combined' }, 'Download signed PDF');
      const certificate = await connector<string | Uint8Array>(CONNECTORS.docuSign, 'GetDocument', { envelopeId, documentId: 'certificate' }, 'Download certificate');
      return { pdf: toBytes(pdf), certificate: toBytes(certificate) };
    },
    async void(envelopeId, reason) {
      await connector(CONNECTORS.docuSign, 'UpdateEnvelope', { envelopeId, body: { status: 'voided', voidedReason: reason } }, 'Void envelope');
    },
    async resend(envelopeId) {
      await connector(CONNECTORS.docuSign, 'UpdateEnvelope', { envelopeId, resend_envelope: true, body: {} }, 'Resend envelope');
    },
    async signingUrl(envelopeId, role, returnUrl) {
      const e = await connector<{ recipients: { signers: { recipientId: string; roleName: string; name: string; email: string; clientUserId?: string }[] } }>(CONNECTORS.docuSign, 'GetEnvelope', { envelopeId, include: 'recipients' }, 'Envelope recipients');
      const r = e.recipients.signers.find((s) => s.roleName.split(ROLE_SEPARATOR).includes(role));
      if (!r) throw new Error(`No ${role} on this envelope`);
      if (!r.clientUserId) throw new Error('This signer was sent by email, not to sign in session.');
      const view = await connector<{ url: string }>(
        CONNECTORS.docuSign,
        'CreateRecipientView',
        { envelopeId, body: { userName: r.name, email: r.email, recipientId: r.recipientId, clientUserId: r.clientUserId, returnUrl, authenticationMethod: 'None' } },
        'Open signing',
      );
      return view.url;
    },
    // Only the fields being corrected are sent, so DocuSign keeps the access code and clientUserId.
    async correctRecipient(envelopeId, role, change) {
      const e = await connector<{ recipients: { signers: { recipientId: string; roleName: string }[] } }>(CONNECTORS.docuSign, 'GetEnvelope', { envelopeId, include: 'recipients' }, 'Envelope recipients');
      const r = e.recipients.signers.find((s) => s.roleName.split(ROLE_SEPARATOR).includes(role));
      if (!r) throw new Error(`No ${role} on this envelope`);
      await connector(CONNECTORS.docuSign, 'UpdateRecipients', { envelopeId, resend_envelope: true, body: { signers: [{ recipientId: r.recipientId, ...change }] } }, 'Correct recipient');
    },
  };

  return { mode: 'power', directory, crm, templates, drafts, requests, packets, signing, attachments: new Map() };
}
