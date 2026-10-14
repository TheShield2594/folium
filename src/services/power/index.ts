import { getContext } from '@microsoft/power-apps/app';
import { getClient, type DataClient } from '@microsoft/power-apps/data';
import type { Account, Connection, Contact, FirmPolicy, FirmProfile, FormTemplate, SavedPacket, SignatureRequest, TemplateMapping, UserGroup, UserProfile } from '../../domain/types';
import { fromSystemUser, mergeAdvisor, profileToSave, SYSTEMUSER_COLUMNS, type DirectoryUser } from '../../domain/advisor';
import { readIdDocuments } from '../../domain/idDocuments';
import { needsSeenStamp } from '../../domain/users';
import { withPolicyDefaults } from '../../domain/policy';
import { docuSignReady, withDocuSignDefaults, type DocuSignSetup } from '../../domain/docusign';
import { mapDocuSignStatus } from '../../domain/requests';
import { buildEnvelopeDefinition, ROLE_SEPARATOR } from '../docusign/tabs';
import { classifyError, FoliumError } from '../errors';
import type { CrmService, DirectoryService, DraftStore, FeedbackStore, IncomingFile, PacketStore, RequestStore, Services, SigningProvider, TemplateLibrary } from '../types';
import { createUsageQueue } from '../usage';
import { decodeChoices, encodeChoices } from './choices';
import { CHOICES, CONNECTORS, DATAVERSE, ID_DOCUMENT_COLUMNS, SHAREPOINT } from './config';
import { dataSourcesInfo } from './dataSourcesInfo';
import { feedbackRow, fromFeedbackRow, isDuplicateKeyError, requestRow, usageRow, type FeedbackRowIn } from './rows';

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
  // `ev_foliumprofile.statecode` 1 is a deactivated profile: it stays (requests keep
  // their owner) but drops out of groups, acting-for and share lists.
  type ProfileRow = { ev_foliumprofileid: string; _ev_user_value: string; ev_payload: string; statecode?: number };
  async function loadProfiles(): Promise<{ row: ProfileRow; profile: UserProfile }[]> {
    const rows = unwrap(await client.retrieveMultipleRecordsAsync<ProfileRow>(DATAVERSE.profile, {}), 'Load users');
    return rows.map((row) => ({ row, profile: { ...payloadRow<UserProfile>(row), systemuserid: row._ev_user_value, ...(row.statecode === 1 ? { active: false } : {}) } }));
  }

  /** `systemuser` rows matching an OData filter, in batches so the URL stays short. */
  async function systemUsers(clauses: string[], what: string): Promise<DirectoryUser[]> {
    const out: DirectoryUser[] = [];
    for (let i = 0; i < clauses.length; i += 40) {
      const rows = unwrap(
        await client.retrieveMultipleRecordsAsync<Record<string, unknown>>(DATAVERSE.systemuser, { filter: clauses.slice(i, i + 40).join(' or '), select: SYSTEMUSER_COLUMNS }),
        what,
      );
      out.push(...rows.map(fromSystemUser));
    }
    return out;
  }

  // `ev_foliumsetting` holds one row per kind of setting, named by `ev_name`: "Firm"
  // (the firm profile), "Policy" (firm-wide rules) and "DocuSign" (the account).
  type SettingRow = { ev_foliumsettingid: string; ev_payload?: string };
  async function settingRow(name: string, what: string): Promise<SettingRow | undefined> {
    const rows = unwrap(await client.retrieveMultipleRecordsAsync<SettingRow>(DATAVERSE.settings, { filter: `ev_name eq '${name}'`, top: 1 }), what);
    return rows[0];
  }
  async function readSetting<T>(name: string, what: string): Promise<T | undefined> {
    const row = await settingRow(name, what);
    return row ? payloadRow<T>(row) : undefined;
  }
  async function writeSetting(name: string, value: unknown, what: string) {
    const existing = await settingRow(name, what);
    const row = { ev_name: name, ev_payload: JSON.stringify(value) };
    if (existing) unwrap(await client.updateRecordAsync(DATAVERSE.settings, existing.ev_foliumsettingid, row), what);
    else unwrap(await client.createRecordAsync(DATAVERSE.settings, row), what);
  }

  const blankProfile = (id: string): UserProfile => ({ systemuserid: id, fullname: '', email: '', phone: '', title: '', role: 'User', groupIds: [], repCode: '', branch: '' });

  const directory: DirectoryService = {
    async currentUser() {
      const ctx = await getContext();
      const [u] = await systemUsers([`azureactivedirectoryobjectid eq ${ctx.user.objectId}`], 'Load signed-in user');
      const found = u ? (await loadProfiles()).find((p) => p.row._ev_user_value === u.systemuserid) : undefined;
      const now = new Date();
      if (found && needsSeenStamp(found.profile.lastSeenOn, now)) {
        // Best effort: a failed stamp mustn't stop anyone signing in.
        const stamped = { ...found.profile, lastSeenOn: now.toISOString() };
        const r = await client.updateRecordAsync(DATAVERSE.profile, found.row.ev_foliumprofileid, { ev_payload: JSON.stringify(profileToSave(stamped)) });
        if (r.success) found.profile = stamped;
      }
      const dir: DirectoryUser = u ?? { systemuserid: '', fullname: ctx.user.fullName ?? '', email: ctx.user.userPrincipalName ?? undefined };
      return mergeAdvisor(dir, { ...blankProfile(dir.systemuserid), ...found?.profile, systemuserid: dir.systemuserid });
    },
    async listUsers() {
      const profiles = await loadProfiles();
      const ids = [...new Set(profiles.map((p) => p.row._ev_user_value).filter(Boolean))];
      const dir = await systemUsers(ids.map((id) => `systemuserid eq ${id}`), 'Load directory details');
      return profiles.map((p) => mergeAdvisor(dir.find((d) => d.systemuserid === p.row._ev_user_value), p.profile));
    },
    async saveUser(u) {
      const existing = (await loadProfiles()).find((p) => p.row._ev_user_value === u.systemuserid);
      const row = { ev_name: u.fullname, ev_role: u.role, ev_payload: JSON.stringify(profileToSave(u)) };
      if (existing) unwrap(await client.updateRecordAsync(DATAVERSE.profile, existing.row.ev_foliumprofileid, row), 'Save user');
      else unwrap(await client.createRecordAsync(DATAVERSE.profile, { ...row, 'ev_user@odata.bind': `/systemusers(${u.systemuserid})` }), 'Create user');
      return u;
    },
    async setActive(id, active) {
      const existing = (await loadProfiles()).find((p) => p.row._ev_user_value === id);
      if (!existing) throw new Error('That person has no Folium profile.');
      if (!active) {
        for (const g of (await directory.listGroups()).filter((x) => x.memberIds.includes(id))) await directory.saveGroup({ ...g, memberIds: g.memberIds.filter((m) => m !== id) });
      }
      const payload = active ? existing.profile : { ...existing.profile, groupIds: [] };
      unwrap(
        await client.updateRecordAsync(DATAVERSE.profile, existing.row.ev_foliumprofileid, { statecode: active ? 0 : 1, statuscode: active ? 1 : 2, ev_payload: JSON.stringify(profileToSave(payload)) }),
        active ? 'Reactivate user' : 'Deactivate user',
      );
    },
    async lookupDirectory(emails) {
      const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
      return systemUsers(clean.map((e) => `internalemailaddress eq '${esc(e)}'`), 'Look up people');
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
      return (await readSetting<FirmProfile>('Firm', 'Load firm')) ?? ({} as FirmProfile);
    },
    async saveFirm(f) {
      await writeSetting('Firm', f, 'Save firm');
      return f;
    },
    async getPolicy() {
      return withPolicyDefaults(await readSetting<Partial<FirmPolicy>>('Policy', 'Load settings'));
    },
    async savePolicy(p) {
      await writeSetting('Policy', p, 'Save settings');
      return p;
    },
    async getDocuSign() {
      return withDocuSignDefaults(await readSetting<Partial<DocuSignSetup>>('DocuSign', 'Load DocuSign settings'));
    },
    async saveDocuSign(d) {
      await writeSetting('DocuSign', d, 'Save DocuSign settings');
      docuSignSetup = undefined;
      return d;
    },
  };

  // Read once per session (and again after an admin saves it), not before every call.
  let docuSignSetup: Promise<DocuSignSetup> | undefined;
  async function docuSign(op: string): Promise<DocuSignSetup> {
    const s = await (docuSignSetup ??= directory.getDocuSign().catch((e) => {
      docuSignSetup = undefined;
      throw e;
    }));
    if (!docuSignReady(s)) throw new FoliumError('unknown', op, 'DocuSign isn’t set up yet. An administrator adds the DocuSign account in Administration › Settings.');
    return s;
  }
  /** A DocuSign operation, on the firm's account, through the signed-in person's own connection. */
  async function ds<T>(operationName: string, parameters: Record<string, unknown>, what: string, setup?: DocuSignSetup): Promise<T> {
    const { accountId } = setup ?? (await docuSign(what));
    return connector<T>(CONNECTORS.docuSign, operationName, { accountId, ...parameters }, what);
  }

  // ---------------------------------------------------------------- CRM
  const contactChoices = CHOICES.contact ?? {};
  const toContact = (row: Contact): Contact => {
    const contact = decodeChoices(row, contactChoices, 'contact');
    const idDocuments = readIdDocuments(row, ID_DOCUMENT_COLUMNS);
    return idDocuments ? { ...contact, idDocuments } : contact;
  };

  const crm: CrmService = {
    async getClient(contactId) {
      const contact = toContact(unwrap(await client.retrieveRecordAsync<Contact>(DATAVERSE.contact, contactId), 'Load contact'));
      const accounts = unwrap(
        await client.retrieveMultipleRecordsAsync<Account>(DATAVERSE.account, { filter: `${DATAVERSE.accountContactLookup} eq ${contactId} and statecode eq 0` }),
        'Load accounts',
      );
      // Connections in both directions: where the client is record 1 (the other person's
      // role is record 2's) and where they're record 2. Dataverse often keeps a reciprocal
      // row too, so the same person in the same role is listed once.
      const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
      const sides = [
        { me: '_record1id_value', other: '_record2id_value', role: '_record2roleid_value' },
        { me: '_record2id_value', other: '_record1id_value', role: '_record1roleid_value' },
      ];
      const connections: Connection[] = [];
      const seen = new Set<string>();
      for (const side of sides) {
        const conns = unwrap(
          await client.retrieveMultipleRecordsAsync<Record<string, string>>(DATAVERSE.connection, {
            filter: `${side.me} eq ${contactId} and statecode eq 0`,
            select: [side.other, side.role, 'ev_sharepct'],
          }),
          'Load connections',
        );
        for (const c of conns) {
          const role = c[`${side.role}${FORMATTED}`] ?? 'Connection';
          const id = c[side.other];
          if (!id || id === contactId || seen.has(`${id}|${role.toLowerCase()}`)) continue;
          const other = await client.retrieveRecordAsync<Contact>(DATAVERSE.contact, id);
          if (!other.success) continue;
          seen.add(`${id}|${role.toLowerCase()}`);
          connections.push({ role, contact: toContact(other.data), ev_sharepct: c.ev_sharepct ? Number(c.ev_sharepct) : undefined });
        }
      }
      return { contact, accounts, connections };
    },
    async updateContact(contactId, changes) {
      const { contactid: _id, fullname: _fn, idDocuments: _ids, ...writable } = changes;
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
  };

  // ---------------------------------------------------------------- Form feedback
  const FEEDBACK_COLUMNS = ['ev_formrequestid', 'ev_name', 'ev_issuer', 'ev_note', 'ev_requestedby', '_ev_requester_value', 'ev_kind', 'ev_status', 'ev_category', 'createdon', 'ev_payload'];
  const feedback: FeedbackStore = {
    async submit(f) {
      const created = unwrap(await client.createRecordAsync<ReturnType<typeof feedbackRow>, { ev_formrequestid: string }>(DATAVERSE.formRequest, feedbackRow(f)), f.kind === 'problem' ? 'Report a problem' : 'Request form');
      return { ...f, id: created.ev_formrequestid };
    },
    async list() {
      const rows = unwrap(await client.retrieveMultipleRecordsAsync<FeedbackRowIn>(DATAVERSE.formRequest, { select: FEEDBACK_COLUMNS, orderBy: ['createdon desc'], top: 500 }), 'Load form feedback');
      return rows.map(fromFeedbackRow);
    },
    async listMine(userId) {
      if (!userId) return [];
      const rows = unwrap(
        await client.retrieveMultipleRecordsAsync<FeedbackRowIn>(DATAVERSE.formRequest, { filter: `_ev_requester_value eq ${userId}`, select: FEEDBACK_COLUMNS, orderBy: ['createdon desc'], top: 100 }),
        'Load your form reports',
      );
      return rows.map(fromFeedbackRow);
    },
    async update(f) {
      unwrap(await client.updateRecordAsync(DATAVERSE.formRequest, f.id, feedbackRow(f)), 'Update form feedback');
      return f;
    },
  };

  // ---------------------------------------------------------------- Usage events
  // One row at a time, so a row that's already there (same `ev_dedupekey`, the table's
  // alternate key) is skipped without losing the rest of the batch.
  const usage = createUsageQueue(async (events) => {
    for (const e of events) {
      const r = await client.createRecordAsync(DATAVERSE.usageEvent, usageRow(e));
      if (!r.success && !isDuplicateKeyError(r.error)) unwrap(r, 'Record usage');
    }
  });

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
    async removeFile(url) {
      const path = decodeURIComponent(new URL(url).pathname.replace(new URL(SHAREPOINT.crmSite).pathname, ''));
      const meta = await client.executeAsync<Record<string, unknown>, { Id: string }>({ connectorOperation: { tableName: CONNECTORS.sharePoint, operationName: 'GetFileMetadataByPath', parameters: { dataset: SHAREPOINT.crmSite, path } } });
      if (!meta.success) {
        // Already gone (deleted by hand or by the retention flow): nothing to do. Anything
        // else (throttling, auth) throws, so the caller keeps the file on record.
        const err = meta.error as { status?: unknown; message?: string } | undefined;
        if (err?.status === 404 || err?.status === '404' || /\b404\b|not found/i.test(err?.message ?? '')) return;
        unwrap(meta, 'Find draft PDF');
      }
      await connector(CONNECTORS.sharePoint, 'DeleteFile', { dataset: SHAREPOINT.crmSite, id: meta.data.Id }, 'Delete draft PDF');
    },
    async getFile(itemId) {
      const content = await connector<string | Uint8Array>(CONNECTORS.sharePoint, 'GetFileContent', { dataset: SHAREPOINT.crmSite, id: itemId }, 'Download attachment');
      return typeof content === 'string' ? Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0)) : content;
    },
  };

  // ---------------------------------------------------------------- Requests & packets
  // Deletes are soft: the row is deactivated (statecode 1) and lists read active rows
  // only, so Undo reactivates the same row. The retention flow (DEPLOY.md) deletes expired
  // drafts for good.
  const ACTIVE = 'statecode eq 0';
  const deactivate = (table: string, id: string, what: string) => client.updateRecordAsync(table, id, { statecode: 1, statuscode: 2 }).then((r) => unwrap(r, what));
  const reactivate = (table: string, id: string, what: string) => client.updateRecordAsync(table, id, { statecode: 0, statuscode: 1 }).then((r) => unwrap(r, what));
  type Row = { ev_signaturerequestid: string; ev_payload: string };
  const toRow = requestRow;

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
    async checkConnection(setup) {
      const s = setup ?? (await docuSign('Check DocuSign'));
      if (!docuSignReady(s)) throw new FoliumError('unknown', 'Check DocuSign', 'Enter the API Account ID first.');
      const a = await ds<{ accountName?: string; accountIdGuid?: string }>('GetAccount', {}, 'Check DocuSign', s);
      return { accountId: a.accountIdGuid ?? s.accountId!, accountName: a.accountName ?? 'DocuSign account' };
    },
    async create(req) {
      // Created as a DocuSign draft: nothing reaches the signers until `release`.
      const setup = await docuSign('Create envelope');
      const env = buildEnvelopeDefinition(req, setup.idv, 'created');
      const res = await ds<{ envelopeId: string }>('CreateEnvelope', { body: env }, 'Create envelope', setup);
      return { envelopeId: res.envelopeId };
    },
    async release(envelopeId) {
      await ds('UpdateEnvelope', { envelopeId, body: { status: 'sent' } }, 'Send envelope');
    },
    async getStatus(envelopeId) {
      const e = await ds<{ status: string; voidedReason?: string; expireDateTime?: string; deliveredDateTime?: string; completedDateTime?: string; recipients?: { signers: { roleName: string; email: string; status: string; signedDateTime?: string }[] } }>(
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
      const pdf = await ds<string | Uint8Array>('GetDocument', { envelopeId, documentId: 'combined' }, 'Download signed PDF');
      const certificate = await ds<string | Uint8Array>('GetDocument', { envelopeId, documentId: 'certificate' }, 'Download certificate');
      return { pdf: toBytes(pdf), certificate: toBytes(certificate) };
    },
    async void(envelopeId, reason) {
      await ds('UpdateEnvelope', { envelopeId, body: { status: 'voided', voidedReason: reason } }, 'Void envelope');
    },
    async resend(envelopeId) {
      await ds('UpdateEnvelope', { envelopeId, resend_envelope: true, body: {} }, 'Resend envelope');
    },
    async signingUrl(envelopeId, role, returnUrl) {
      const e = await ds<{ recipients: { signers: { recipientId: string; roleName: string; name: string; email: string; clientUserId?: string }[] } }>('GetEnvelope', { envelopeId, include: 'recipients' }, 'Envelope recipients');
      const r = e.recipients.signers.find((s) => s.roleName.split(ROLE_SEPARATOR).includes(role));
      if (!r) throw new Error(`No ${role} on this envelope`);
      if (!r.clientUserId) throw new Error('This signer was sent by email, not to sign in session.');
      const view = await ds<{ url: string }>(
        'CreateRecipientView',
        { envelopeId, body: { userName: r.name, email: r.email, recipientId: r.recipientId, clientUserId: r.clientUserId, returnUrl, authenticationMethod: 'None' } },
        'Open signing',
      );
      return view.url;
    },
    // Only the fields being corrected are sent, so DocuSign keeps the access code and clientUserId.
    async correctRecipient(envelopeId, role, change) {
      const e = await ds<{ recipients: { signers: { recipientId: string; roleName: string }[] } }>('GetEnvelope', { envelopeId, include: 'recipients' }, 'Envelope recipients');
      const r = e.recipients.signers.find((s) => s.roleName.split(ROLE_SEPARATOR).includes(role));
      if (!r) throw new Error(`No ${role} on this envelope`);
      await ds('UpdateRecipients', { envelopeId, resend_envelope: true, body: { signers: [{ recipientId: r.recipientId, ...change }] } }, 'Correct recipient');
    },
  };

  return { mode: 'power', directory, crm, templates, drafts, requests, packets, signing, feedback, usage, attachments: new Map() };
}
