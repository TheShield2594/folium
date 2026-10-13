import type { Advisor, ClientRecord, Contact, FirmProfile, FormTemplate, SavedPacket, SignatureRequest, UserGroup, UserProfile } from '../../domain/types';
import { layoutSpec } from '../../pdf/layout';
import { SPECS, type FormSpec } from './specs';

export const ADVISOR: Advisor = {
  systemuserid: 'usr-advisor-1',
  fullname: 'Taylor Brenneman',
  email: 'taylor.brenneman@example.org',
  phone: '574-555-0142',
  repCode: 'EV4471',
  branch: 'Goshen',
  title: 'Financial advisor',
};

export const USERS: UserProfile[] = [
  { ...ADVISOR, role: 'User', groupIds: ['grp-goshen'], region: 'Goshen', defaultAuth: 'sms', defaultReminderDays: 3 },
  { systemuserid: 'usr-advisor-2', fullname: 'Jesse Shenk', email: 'jesse.shenk@example.org', phone: '540-555-0161', repCode: 'EV3302', branch: 'Harrisonburg', title: 'Financial advisor', role: 'User', groupIds: ['grp-goshen', 'grp-va'], region: 'Harrisonburg', defaultAuth: 'email', defaultReminderDays: 5 },
  { systemuserid: 'usr-assistant-1', fullname: 'Morgan Beachy', email: 'morgan.beachy@example.org', phone: '574-555-0150', repCode: '', branch: 'Goshen', title: 'Client service associate', role: 'Assistant', groupIds: ['grp-goshen'], region: 'Goshen' },
  { systemuserid: 'usr-admin-1', fullname: 'Dana Yoder', email: 'dana.yoder@example.org', phone: '574-555-0100', repCode: '', branch: 'Home office', title: 'Forms & operations', role: 'Admin', groupIds: ['grp-ops'], region: 'Home office' },
];

export const GROUPS: UserGroup[] = [
  { id: 'grp-goshen', name: 'Goshen advisors', description: 'Advisors and assistants in the Goshen office.', region: 'Goshen', memberIds: ['usr-advisor-1', 'usr-advisor-2', 'usr-assistant-1'] },
  { id: 'grp-va', name: 'Virginia', description: 'Harrisonburg and Richmond.', region: 'Virginia', memberIds: ['usr-advisor-2'] },
  { id: 'grp-ops', name: 'Operations', description: 'Home-office forms and operations staff.', region: 'Home office', memberIds: ['usr-admin-1'] },
];

export const FIRM: FirmProfile = {
  name: 'Everence Financial',
  legalName: 'Everence Financial Advisors, Inc.',
  address1: '1110 N. Main St.',
  city: 'Goshen',
  state: 'IN',
  zip: '46528',
  phone: '800-348-7468',
  website: 'everence.com',
  brokerDealer: '[BROKER-DEALER NAME]',
  crd: '[CRD #]',
  disclosure: 'Securities offered through [BROKER-DEALER NAME], member FINRA/SIPC.',
};

const c = (x: Partial<Contact> & Pick<Contact, 'contactid' | 'firstname' | 'lastname' | 'ev_clientid'>): Contact => ({
  fullname: [x.firstname, x.middlename, x.lastname].filter(Boolean).join(' '),
  ...x,
});

const jordan = c({
  contactid: 'c-jordan', ownerid: 'usr-advisor-1',
  firstname: 'Jordan',
  middlename: 'A.',
  lastname: 'Miller',
  ev_clientid: 'C-0048213',
  birthdate: '1961-04-18',
  ev_ssn: '412-55-0193',
  emailaddress1: 'jordan.miller@example.com',
  mobilephone: '574-555-0118',
  address1_line1: '1408 Riverbend Ln',
  address1_city: 'Goshen',
  address1_stateorprovince: 'IN',
  address1_postalcode: '46526',
  familystatuscode: 'married',
  ev_region: 'Goshen',
  ev_employer: 'Retired',
});
const sam = c({ contactid: 'c-sam', firstname: 'Sam', lastname: 'Miller', ev_clientid: 'C-0048214', birthdate: '1963-09-02', ev_ssn: '409-21-7781', emailaddress1: 'sam.miller@example.com', mobilephone: '574-555-0177', address1_line1: '1408 Riverbend Ln', address1_city: 'Goshen', address1_stateorprovince: 'IN', address1_postalcode: '46526', familystatuscode: 'married' });
const ruth = c({ contactid: 'c-ruth', firstname: 'Ruth', lastname: 'Miller-Kauffman', ev_clientid: 'C-0051177', emailaddress1: 'ruth.mk@example.com', mobilephone: '260-555-0190' });

const priya = c({ contactid: 'c-priya', ownerid: 'usr-advisor-1', firstname: 'Priya', lastname: 'Hostetler', ev_clientid: 'C-0039920', birthdate: '1984-01-27', ev_ssn: '318-44-2290', emailaddress1: 'priya.h@example.com', mobilephone: '717-555-0101', address1_line1: '22 Orchard Way', address1_city: 'Lancaster', address1_stateorprovince: 'PA', address1_postalcode: '17602', familystatuscode: 'single', ev_region: 'Lancaster', ev_employer: 'Lancaster General Health' });
const eli = c({ contactid: 'c-eli', ownerid: 'usr-advisor-2', firstname: 'Eli', lastname: 'Yoder', ev_clientid: 'C-0012004', birthdate: '1952-11-30', emailaddress1: 'eli.yoder@example.com', address1_line1: '5 Mill Race Rd', address1_city: 'Harrisonburg', address1_stateorprovince: 'VA', address1_postalcode: '22801', familystatuscode: 'widowed', ev_region: 'Harrisonburg' });
const grace = c({ contactid: 'c-grace', ownerid: 'usr-advisor-1', firstname: 'Grace', lastname: 'Nafziger', ev_clientid: 'C-0060318', birthdate: '1990-06-12', ev_ssn: '511-30-8842', emailaddress1: 'grace.n@example.com', mobilephone: '316-555-0133', address1_line1: '310 Main St', address1_line2: 'Apt 4', address1_city: 'Newton', address1_stateorprovince: 'KS', address1_postalcode: '67114', familystatuscode: 'married', ev_region: 'Newton', ev_employer: 'Bethel College' });

export const CLIENTS: Record<string, ClientRecord> = {
  'c-jordan': {
    contact: jordan,
    accounts: [
      { accountid: 'a-j1', name: 'Jordan Miller Traditional IRA', ev_accountno: 'IRA-22-4471', ev_accounttype: 'Traditional IRA', ev_custodian: 'Everence Trust Company', ev_balance: 412880, ev_openedon: '2009-03-14' },
      { accountid: 'a-j2', name: 'Miller Joint Brokerage', ev_accountno: 'BRK-31-0920', ev_accounttype: 'Brokerage', ev_custodian: 'Everence Financial', ev_balance: 186210, ev_openedon: '2014-07-01' },
      { accountid: 'a-j3', name: 'Praxis Growth Index (IRA)', ev_accountno: 'PX-7712-0045', ev_accounttype: 'Traditional IRA', ev_custodian: 'Praxis Mutual Funds', ev_balance: 98400, ev_openedon: '2018-02-12' },
      { accountid: 'a-j4', name: 'Term life — Jordan', ev_accountno: 'SL-0098812', ev_accounttype: 'Life policy', ev_custodian: 'Sample Life Insurance Co.', ev_openedon: '2004-05-20' },
    ],
    connections: [
      { role: 'Spouse', contact: sam },
      { role: 'Joint owner', contact: sam },
      { role: 'Trusted contact', contact: ruth },
    ],
  },
  'c-priya': {
    contact: priya,
    accounts: [
      { accountid: 'a-p1', name: 'Priya Hostetler Roth IRA', ev_accountno: 'ROTH-40-1182', ev_accounttype: 'Roth IRA', ev_custodian: 'Everence Trust Company', ev_balance: 64210, ev_openedon: '2016-04-02' },
      { accountid: 'a-p2', name: 'Praxis Impact Bond', ev_accountno: 'PX-8820-1191', ev_accounttype: 'Brokerage', ev_custodian: 'Praxis Mutual Funds', ev_balance: 21900, ev_openedon: '2020-09-15' },
    ],
    connections: [],
  },
  'c-eli': {
    contact: eli,
    accounts: [
      { accountid: 'a-e1', name: 'Eli Yoder Traditional IRA', ev_accountno: 'IRA-08-3310', ev_accounttype: 'Traditional IRA', ev_custodian: 'Everence Trust Company', ev_balance: 702400, ev_openedon: '1998-01-10' },
      { accountid: 'a-e2', name: 'Fixed annuity', ev_accountno: 'SA-55-20019', ev_accounttype: 'Annuity', ev_custodian: 'Sample Annuity Co.', ev_balance: 150000, ev_openedon: '2012-08-08' },
    ],
    connections: [],
  },
  'c-grace': {
    contact: grace,
    accounts: [{ accountid: 'a-g1', name: 'Grace Nafziger Roth IRA', ev_accountno: 'ROTH-52-0071', ev_accounttype: 'Roth IRA', ev_custodian: 'Everence Trust Company', ev_balance: 18800, ev_openedon: '2021-03-30' }],
    connections: [],
  },
};

export function specToTemplate(spec: FormSpec): FormTemplate {
  const layout = layoutSpec(spec.sections);
  const rectByName = new Map(layout.fields.map((f) => [f.field.name, f.rect]));
  return {
    id: spec.id,
    name: spec.name,
    formNumber: spec.formNumber,
    source: spec.source,
    issuer: spec.issuer,
    category: spec.category,
    revision: spec.revision,
    effectiveDate: spec.effectiveDate,
    status: spec.status,
    pdfKind: spec.pdfKind,
    pageCount: layout.pageCount,
    sharePointItemId: `sp-${spec.id}`,
    sharePointUrl: `https://everence.sharepoint.com/sites/Marketing/Forms/${spec.formNumber}_${spec.revision.replace('/', '-')}.pdf`,
    supersedesId: spec.supersedesId,
    appliesTo: spec.appliesTo,
    keywords: spec.keywords,
    description: spec.description,
    modifiedOn: `${spec.effectiveDate}T09:00:00Z`,
    modifiedBy: spec.modifiedBy ?? 'Marketing · Forms team',
    mapping: {
      formNumber: spec.formNumber,
      revision: spec.revision,
      // A brand-new revision arrives with an empty mapping; Admin diffs it against the previous one.
      fields:
        spec.status === 'Needs mapping'
          ? []
          : layout.fields.map(({ field }) => ({
              pdfField: field.name,
              source: field.source,
              required: !!field.required,
              label: field.uiLabel ?? field.label,
              key: field.key,
              format: field.format ?? (field.type === 'checkbox' ? 'checkbox' : undefined),
              help: field.help,
              requiredWhen: field.requiredWhen,
              rect: spec.pdfKind === 'flat' ? rectByName.get(field.name) : undefined,
            })),
      signers: spec.signers,
      placements: spec.status === 'Needs mapping' ? [] : layout.placements,
      checks: spec.checks,
    },
  };
}

export const TEMPLATES: FormTemplate[] = SPECS.map(specToTemplate);

const daysAgo = (n: number, h = 10, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

export function seedRequests(): SignatureRequest[] {
  return [
    {
      id: 'req-1001',
      contactId: 'c-jordan',
      title: 'Beneficiary and address update',
      ownerId: ADVISOR.systemuserid,
      preparedById: ADVISOR.systemuserid,
      preparedBy: ADVISOR.fullname,
      sentBy: ADVISOR.fullname,
      createdOn: daysAgo(6, 14, 58),
      sentOn: daysAgo(6, 15, 1),
      provider: 'DocuSign',
      envelopeId: '7f3c2a10-5be1-4c55-9d1e-2a61c0e4b9a1',
      status: 'Signed',
      documents: [
        { templateId: 'tpl-ev1120-0326', name: 'Beneficiary designation', formNumber: 'EV-1120', revision: '03/2026' },
        { templateId: 'tpl-ev1004-0125', name: 'Address and contact change', formNumber: 'EV-1004', revision: '01/2025' },
      ],
      signers: [
        { role: 'Owner', name: 'Jordan A. Miller', email: 'jordan.miller@example.com', phone: '574-555-0118', order: 1, auth: 'sms', status: 'signed', signedOn: daysAgo(5, 8, 9) },
        { role: 'SpouseConsent', name: 'Sam Miller', email: 'sam.miller@example.com', order: 2, auth: 'email', status: 'signed', signedOn: daysAgo(5, 8, 12) },
      ],
      ccs: [{ name: ADVISOR.fullname, email: ADVISOR.email }],
      subject: 'Forms to sign: beneficiary and address updates',
      message: 'Hi Jordan, here are the forms we talked about.',
      reminderDays: 3,
      anyOrder: false,
      draftFolderUrl: 'https://everence.sharepoint.com/sites/CRM/contact/Jordan Miller_C-0048213',
      viewedOn: daysAgo(6, 18, 40),
      signedOn: daysAgo(5, 8, 12),
      uploadedToOnBase: false,
      values: {},
      attachments: [],
      audit: [
        { at: daysAgo(6, 14, 58), actor: ADVISOR.fullname, action: 'Drafted', detail: '2 forms prefilled from CRM' },
        { at: daysAgo(6, 15, 1), actor: ADVISOR.fullname, action: 'Sent with DocuSign' },
        { at: daysAgo(6, 18, 40), actor: 'Jordan A. Miller', action: 'Viewed' },
        { at: daysAgo(5, 8, 9), actor: 'Jordan A. Miller', action: 'Signed', detail: 'SMS code verified' },
        { at: daysAgo(5, 8, 12), actor: 'Sam Miller', action: 'Signed', detail: 'Email verified' },
      ],
    },
    {
      id: 'req-1002',
      contactId: 'c-jordan',
      title: 'Transfer of assets (incoming)',
      ownerId: ADVISOR.systemuserid,
      preparedById: ADVISOR.systemuserid,
      preparedBy: ADVISOR.fullname,
      sentBy: ADVISOR.fullname,
      createdOn: daysAgo(3, 9, 30),
      sentOn: daysAgo(3, 9, 41),
      provider: 'DocuSign',
      envelopeId: 'b81d4e22-90f0-4b8a-a2c1-55e6d0a7f310',
      status: 'Sent',
      documents: [{ templateId: 'tpl-ev2210-0626', name: 'Transfer of assets (incoming)', formNumber: 'EV-2210', revision: '06/2026' }],
      signers: [
        { role: 'Owner', name: 'Jordan A. Miller', email: 'jordan.miller@example.com', phone: '574-555-0118', order: 1, auth: 'sms', status: 'sent' },
        { role: 'Advisor', name: ADVISOR.fullname, email: ADVISOR.email, order: 2, auth: 'email', status: 'pending' },
      ],
      ccs: [],
      subject: 'Transfer paperwork to sign',
      message: 'Hi Jordan, this moves your old 401(k) over to us.',
      reminderDays: 3,
      anyOrder: false,
      uploadedToOnBase: false,
      lastReminderOn: daysAgo(0, 9, 41),
      values: {},
      attachments: [],
      audit: [
        { at: daysAgo(3, 9, 30), actor: ADVISOR.fullname, action: 'Drafted' },
        { at: daysAgo(3, 9, 41), actor: ADVISOR.fullname, action: 'Sent with DocuSign' },
        { at: daysAgo(0, 9, 41), actor: 'DocuSign', action: 'Reminder sent' },
      ],
    },
    {
      id: 'req-0950',
      contactId: 'c-jordan',
      title: 'Trusted contact designation',
      ownerId: ADVISOR.systemuserid,
      preparedById: ADVISOR.systemuserid,
      preparedBy: ADVISOR.fullname,
      sentBy: ADVISOR.fullname,
      createdOn: daysAgo(40),
      sentOn: daysAgo(40),
      provider: 'DocuSign',
      envelopeId: '1aa0c7e4-2f6b-4b0f-8d0d-9f1d6b3c2e77',
      status: 'Signed',
      documents: [{ templateId: 'tpl-ev1410-0126', name: 'Trusted contact designation', formNumber: 'EV-1410', revision: '01/2026' }],
      signers: [{ role: 'Owner', name: 'Jordan A. Miller', email: 'jordan.miller@example.com', order: 1, auth: 'email', status: 'signed', signedOn: daysAgo(39) }],
      ccs: [],
      subject: 'Trusted contact form',
      message: '',
      anyOrder: false,
      signedOn: daysAgo(39),
      viewedOn: daysAgo(39),
      uploadedToOnBase: true,
      uploadedBy: ADVISOR.fullname,
      uploadedOn: daysAgo(38),
      values: {},
      attachments: [],
      audit: [
        { at: daysAgo(40), actor: ADVISOR.fullname, action: 'Sent with DocuSign' },
        { at: daysAgo(39), actor: 'Jordan A. Miller', action: 'Signed' },
        { at: daysAgo(38), actor: ADVISOR.fullname, action: 'Marked as uploaded to OnBase' },
      ],
    },
    {
      id: 'req-1003',
      contactId: 'c-priya',
      title: 'Roth IRA beneficiary',
      ownerId: ADVISOR.systemuserid,
      preparedById: ADVISOR.systemuserid,
      preparedBy: ADVISOR.fullname,
      sentBy: ADVISOR.fullname,
      createdOn: daysAgo(1, 16, 5),
      provider: 'DocuSign',
      status: 'Drafted',
      documents: [{ templateId: 'tpl-ev1120-0326', name: 'Beneficiary designation', formNumber: 'EV-1120', revision: '03/2026' }],
      signers: [],
      ccs: [],
      subject: '',
      message: '',
      anyOrder: false,
      uploadedToOnBase: false,
      values: { 'bene.Prim.1.name': 'Anil Hostetler', 'bene.Prim.1.rel': 'Brother', 'bene.Prim.1.pct': '100' },
      attachments: [],
      audit: [{ at: daysAgo(1, 16, 5), actor: ADVISOR.fullname, action: 'Draft saved' }],
    },
    {
      id: 'req-0998',
      contactId: 'c-eli',
      title: 'Required minimum distribution',
      ownerId: 'usr-advisor-2',
      preparedById: 'usr-advisor-2',
      preparedBy: 'Jesse Shenk',
      sentBy: 'Jesse Shenk',
      createdOn: daysAgo(9),
      sentOn: daysAgo(9),
      provider: 'DocuSign',
      envelopeId: 'e2f1b6a0-7c3d-4c2e-8b11-3a9d4f6e8c20',
      status: 'Viewed',
      documents: [{ templateId: 'tpl-px410-0126', name: 'Required minimum distribution election', formNumber: 'PX-410', revision: '01/2026' }],
      signers: [{ role: 'Owner', name: 'Eli Yoder', email: 'eli.yoder@example.com', order: 1, auth: 'email', status: 'viewed' }],
      ccs: [],
      subject: 'Your RMD election',
      message: '',
      reminderDays: 5,
      anyOrder: false,
      viewedOn: daysAgo(8),
      uploadedToOnBase: false,
      values: {},
      attachments: [],
      audit: [
        { at: daysAgo(9), actor: ADVISOR.fullname, action: 'Sent with DocuSign' },
        { at: daysAgo(8), actor: 'Eli Yoder', action: 'Viewed' },
      ],
    },
  ];
}

export function seedPackets(): SavedPacket[] {
  return [
    { id: 'pk-1', name: 'Address change, everything', description: 'Address change plus a fresh trusted contact.', templateIds: ['tpl-ev1004-0125', 'tpl-ev1410-0126'], shared: true, owner: 'Operations', createdOn: daysAgo(120), usedCount: 48 },
    { id: 'pk-2', name: 'New IRA with transfer', description: 'Open the IRA, bring assets over, name beneficiaries.', templateIds: ['tpl-ev1300-0226', 'tpl-ev2210-0626', 'tpl-ev1120-0326'], shared: true, owner: 'Operations', createdOn: daysAgo(200), usedCount: 112 },
    { id: 'pk-3', name: 'Retirement income set-up', templateIds: ['tpl-px310-0826', 'tpl-ev1610-0425'], shared: false, owner: ADVISOR.fullname, createdOn: daysAgo(30), usedCount: 6 },
  ];
}
