import type { Check, FormCategory, FormSource, PdfKind, SignerRule, TemplateStatus } from '../../domain/types';
import type { SpecField, SpecSection } from '../../pdf/layout';

// Demo template library. Each spec is both the blueprint for a generated PDF and the
// mapping Folium uses to prefill it. Real templates come from Marketing's SharePoint
// library; these stand in for them in demo mode.

export interface FormSpec {
  id: string;
  name: string;
  formNumber: string;
  source: FormSource;
  issuer: string;
  category: FormCategory;
  revision: string;
  effectiveDate: string;
  status: TemplateStatus;
  pdfKind: PdfKind;
  appliesTo?: string[];
  states?: string[];
  variantGroup?: string;
  keywords?: string[];
  description: string;
  intro?: string;
  supersedesId?: string;
  sections: SpecSection[];
  signers: SignerRule[];
  checks: Check[];
  modifiedBy?: string;
}

// ---- reusable blocks -------------------------------------------------------

const owner = (prefix = 'Owner'): SpecField[] => [
  { name: `${prefix}_Name_Full`, label: 'Owner name', span: 6, source: 'contact.fullname', required: true },
  { name: `${prefix}_DOB`, label: 'Date of birth', span: 3, source: 'contact.birthdate', required: true, format: 'date', limits: { dateMin: '-120y', dateMax: 'today' } },
  { name: `${prefix}_SSN`, label: 'Social Security number', span: 3, source: 'contact.ev_ssn', required: true, format: 'ssn' },
  { name: `${prefix}_Address`, label: 'Street address', span: 6, source: 'computed.streetAddress', required: true },
  { name: `${prefix}_City`, label: 'City', span: 3, source: 'contact.address1_city', required: true },
  { name: `${prefix}_State`, label: 'State', span: 1, source: 'contact.address1_stateorprovince', required: true },
  { name: `${prefix}_Zip`, label: 'ZIP', span: 2, source: 'contact.address1_postalcode', required: true, format: 'zip' },
  { name: `${prefix}_Phone`, label: 'Phone', span: 4, source: 'computed.phone', format: 'phone' },
  { name: `${prefix}_Email`, label: 'Email', span: 8, source: 'contact.emailaddress1', format: 'email' },
];

const account = (label = 'Account number'): SpecField[] => [
  { name: 'Acct_Number', label, span: 4, source: 'account.ev_accountno', required: true },
  { name: 'Acct_Type', label: 'Account type', span: 4, source: 'account.ev_accounttype' },
  { name: 'Acct_Custodian', label: 'Custodian', span: 4, source: 'account.ev_custodian' },
];

const rep: SpecField[] = [
  { name: 'Rep_Name', label: 'Advisor name', span: 5, source: 'rep.fullname', required: true },
  { name: 'Rep_Code', label: 'Rep code', span: 3, source: 'rep.repCode', required: true },
  { name: 'Rep_Phone', label: 'Advisor phone', span: 4, source: 'rep.phone', format: 'phone' },
];

const bene = (kind: 'Prim' | 'Cont', n: number, fromConn?: string): SpecField[] => {
  const p = `${kind === 'Prim' ? 'Bene' : 'ContBene'}${n}`;
  const conn = fromConn ? `connection[${fromConn}]` : undefined;
  const who = `${kind === 'Prim' ? 'Primary' : 'Contingent'} beneficiary ${n}`;
  return [
    { name: `${p}_Name`, label: 'Beneficiary name', uiLabel: `${who} · name`, span: 4, source: conn ? `${conn}.fullname` : 'advisor', required: n === 1 && kind === 'Prim', key: `bene.${kind}.${n}.name` },
    { name: `${p}_Relationship`, label: 'Relationship', uiLabel: `${who} · relationship`, span: 2, source: conn ? `${conn}.role` : 'advisor', key: `bene.${kind}.${n}.rel` },
    { name: `${p}_DOB`, label: 'Date of birth', uiLabel: `${who} · date of birth`, span: 2, source: conn ? `${conn}.birthdate` : 'advisor', format: 'date', limits: { dateMin: '-120y', dateMax: 'today' }, key: `bene.${kind}.${n}.dob` },
    { name: `${p}_SSN`, label: 'SSN / Tax ID', uiLabel: `${who} · SSN / Tax ID`, span: 2, source: conn ? `${conn}.ev_ssn` : 'advisor', format: 'ssnOrTin', key: `bene.${kind}.${n}.ssn` },
    { name: `${p}_Pct`, label: 'Share %', uiLabel: `${who} · share %`, span: 2, source: conn ? `${conn}.ev_sharepct` : 'advisor', format: 'percent', required: n === 1 && kind === 'Prim', key: `bene.${kind}.${n}.pct` },
  ];
};

const bank: SpecField[] = [
  { name: 'Bank_Name', label: 'Bank name', span: 6, source: 'signer' },
  { name: 'Bank_Routing', label: 'Routing number', span: 3, source: 'signer' },
  { name: 'Bank_Account', label: 'Bank account number', span: 3, source: 'signer' },
  { name: 'Bank_Checking', label: 'Checking', span: 2, source: 'signer', type: 'checkbox' },
  { name: 'Bank_Savings', label: 'Savings', span: 2, source: 'signer', type: 'checkbox' },
];

const withholding: SpecField[] = [
  { name: 'Withholding_Fed_Pct', label: 'Federal withholding %', span: 4, source: 'advisor', required: true, format: 'percent', key: 'withholding.federal', help: 'Use 10% unless the client elected otherwise on a W-4R.', lockWhen: 'withholding.none' },
  { name: 'Withholding_State_Pct', label: 'State withholding %', span: 4, source: 'advisor', format: 'percent', key: 'withholding.state' },
  { name: 'Withholding_None', label: 'Elect no federal withholding', span: 4, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'withholding.none' },
];

const ownerSig = { role: 'Owner', label: 'Owner' };

// ---- the library ------------------------------------------------------------

export const SPECS: FormSpec[] = [
  {
    id: 'tpl-ev1120-0326',
    name: 'Beneficiary designation',
    formNumber: 'EV-1120',
    source: 'Everence',
    issuer: 'Everence Financial',
    category: 'Beneficiary',
    revision: '03/2026',
    effectiveDate: '2026-03-01',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Traditional IRA', 'Roth IRA', 'Brokerage', 'Annuity'],
    keywords: ['beneficiary', 'bene', 'change beneficiary', 'primary', 'contingent', 'TOD'],
    description: 'Name or change primary and contingent beneficiaries on an Everence account.',
    intro: 'Use this form to name or change beneficiaries. This designation replaces any prior designation for the account below.',
    sections: [
      { title: 'Section 1 · Account owner', fields: [...owner(), ...account()] },
      { title: 'Section 2 · Primary beneficiaries', note: 'Shares must total 100%.', fields: [...bene('Prim', 1, 'Spouse'), ...bene('Prim', 2), ...bene('Prim', 3)] },
      { title: 'Section 3 · Contingent beneficiaries', fields: [...bene('Cont', 1), ...bene('Cont', 2)] },
      {
        title: 'Section 4 · Signatures',
        note: 'Spousal consent is required in community property states and for qualified plans when the spouse is not the sole primary beneficiary.',
        signatures: [ownerSig, { role: 'SpouseConsent', label: 'Spouse (consent)', optional: true }],
      },
    ],
    signers: [{ role: 'Owner' }, { role: 'SpouseConsent', condition: 'contact.familystatuscode == married' }],
    checks: [{ type: 'sumEquals', fields: ['Bene1_Pct', 'Bene2_Pct', 'Bene3_Pct'], value: 100, label: 'Primary shares total 100%' }],
  },
  {
    id: 'tpl-ev1004-0125',
    name: 'Address and contact change',
    formNumber: 'EV-1004',
    source: 'Everence',
    issuer: 'Everence Financial',
    category: 'Account maintenance',
    revision: '01/2025',
    effectiveDate: '2025-01-15',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Traditional IRA', 'Roth IRA', 'Brokerage', 'Life policy', 'Annuity', 'Checking'],
    keywords: ['address', 'move', 'phone', 'email', 'name change', 'contact info'],
    description: 'Update mailing address, phone or email across all accounts.',
    supersedesId: 'tpl-ev1004-0619',
    sections: [
      { title: 'Section 1 · Current information', fields: owner() },
      {
        title: 'Section 2 · New information',
        note: 'Leave a line blank if it isn’t changing.',
        fields: [
          { name: 'New_Address', label: 'New street address', span: 6, source: 'advisor', key: 'new.address', required: true },
          { name: 'New_City', label: 'City', span: 3, source: 'advisor', key: 'new.city', required: true },
          { name: 'New_State', label: 'State', span: 1, source: 'advisor', key: 'new.state', required: true },
          { name: 'New_Zip', label: 'ZIP', span: 2, source: 'advisor', key: 'new.zip', format: 'zip', required: true },
          { name: 'New_Phone', label: 'New phone', span: 4, source: 'advisor', key: 'new.phone', format: 'phone' },
          { name: 'New_Email', label: 'New email', span: 8, source: 'advisor', key: 'new.email', format: 'email' },
          { name: 'Apply_All', label: 'Apply to all of my accounts', span: 6, source: 'static:Yes', type: 'checkbox', format: 'checkbox' },
          { name: 'Effective_Date', label: 'Effective date', span: 3, source: 'computed.today', format: 'date' },
        ],
      },
      { title: 'Section 3 · Signatures', signatures: [ownerSig, { role: 'JointOwner', label: 'Joint owner', optional: true }] },
    ],
    signers: [{ role: 'Owner' }, { role: 'JointOwner', condition: 'connection[Joint owner].fullname' }],
    checks: [],
  },
  {
    id: 'tpl-ev1004-0619',
    name: 'Address and contact change',
    formNumber: 'EV-1004',
    source: 'Everence',
    issuer: 'Everence Financial',
    category: 'Account maintenance',
    revision: '06/2019',
    effectiveDate: '2019-06-01',
    status: 'Retired',
    pdfKind: 'fillable',
    description: 'Retired. Replaced by Rev 01/2025.',
    sections: [{ title: 'Section 1 · Owner', fields: owner() }, { title: 'Section 2 · Signature', signatures: [ownerSig] }],
    signers: [{ role: 'Owner' }],
    checks: [],
  },
  {
    id: 'tpl-px310-0826',
    name: 'Systematic withdrawal request',
    formNumber: 'PX-310',
    source: 'Praxis',
    issuer: 'Praxis Mutual Funds',
    category: 'Distributions',
    revision: '08/2026',
    effectiveDate: '2026-08-01',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Traditional IRA', 'Roth IRA', 'Brokerage'],
    keywords: ['SWP', 'systematic', 'monthly withdrawal', 'income', 'periodic'],
    description: 'Set up recurring withdrawals from a Praxis fund account.',
    sections: [
      { title: 'Section 1 · Account owner', fields: [...owner(), ...account('Praxis account number')] },
      {
        title: 'Section 2 · Withdrawal',
        fields: [
          { name: 'SWP_Amount', label: 'Amount per withdrawal', span: 4, source: 'advisor', required: true, format: 'currency', key: 'swp.amount' },
          { name: 'SWP_Start', label: 'Start date', span: 4, source: 'advisor', required: true, format: 'date', key: 'swp.start', help: 'Must be at least 5 business days out.' },
          { name: 'SWP_Fund', label: 'From fund', span: 4, source: 'advisor', key: 'swp.fund', help: 'Leave blank to withdraw pro rata.' },
          { name: 'SWP_Monthly', label: 'Monthly', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'swp.monthly' },
          { name: 'SWP_Quarterly', label: 'Quarterly', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'swp.quarterly' },
          { name: 'SWP_Annually', label: 'Annually', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'swp.annually' },
        ],
      },
      { title: 'Section 3 · Tax withholding', note: 'IRA accounts only.', fields: withholding },
      { title: 'Section 4 · Deliver to my bank (EFT)', note: 'The client completes this section when signing.', fields: bank },
      { title: 'Section 5 · Signature', signatures: [ownerSig] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [{ type: 'oneOf', fields: ['SWP_Monthly', 'SWP_Quarterly', 'SWP_Annually'], label: 'Pick one withdrawal frequency' }],
  },
  {
    id: 'tpl-px305-0825',
    name: 'IRA distribution request',
    formNumber: 'PX-305',
    source: 'Praxis',
    issuer: 'Praxis Mutual Funds',
    category: 'Distributions',
    revision: '08/2025',
    effectiveDate: '2025-08-01',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Traditional IRA', 'Roth IRA'],
    keywords: ['distribution', 'withdrawal', 'one-time', 'IRA', 'RMD'],
    description: 'One-time or recurring distribution from a Praxis IRA.',
    sections: [
      { title: 'Section 1 · IRA owner', fields: [...owner(), ...account('IRA account number')] },
      {
        title: 'Section 2 · Distribution',
        fields: [
          { name: 'Dist_Amount', label: 'Gross amount', span: 4, source: 'advisor', required: true, format: 'currency', key: 'dist.amount' },
          { name: 'Dist_Reason_Normal', label: 'Normal (59½ or older)', span: 4, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'dist.normal' },
          { name: 'Dist_Reason_Early', label: 'Early (under 59½)', span: 4, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'dist.early' },
        ],
      },
      { title: 'Section 3 · Tax withholding', fields: withholding },
      { title: 'Section 4 · Signature', signatures: [ownerSig] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [{ type: 'oneOf', fields: ['Dist_Reason_Normal', 'Dist_Reason_Early'], label: 'Pick a distribution reason' }],
  },
  {
    id: 'tpl-px305-1026',
    name: 'IRA distribution request',
    formNumber: 'PX-305',
    source: 'Praxis',
    issuer: 'Praxis Mutual Funds',
    category: 'Distributions',
    revision: '10/2026',
    effectiveDate: '2026-11-01',
    status: 'Needs mapping',
    pdfKind: 'fillable',
    appliesTo: ['Traditional IRA', 'Roth IRA'],
    keywords: ['distribution', 'withdrawal', 'one-time', 'IRA', 'RMD'],
    description: 'New revision from Marketing. Adds a state withholding election and renames owner fields.',
    supersedesId: 'tpl-px305-0825',
    modifiedBy: 'Marketing · Dana Yoder',
    sections: [
      {
        title: 'Section 1 · IRA owner',
        fields: [
          { name: 'Owner_FullName', label: 'Owner name', span: 6, source: 'contact.fullname', required: true },
          { name: 'Owner_DOB', label: 'Date of birth', span: 3, source: 'contact.birthdate', format: 'date', limits: { dateMin: '-120y', dateMax: 'today' } },
          { name: 'Owner_SSN', label: 'SSN', span: 3, source: 'contact.ev_ssn', format: 'ssn' },
          { name: 'Owner_Address', label: 'Street address', span: 6, source: 'computed.streetAddress' },
          { name: 'Owner_City', label: 'City', span: 3, source: 'contact.address1_city' },
          { name: 'Owner_State', label: 'State', span: 1, source: 'contact.address1_stateorprovince' },
          { name: 'Owner_Zip', label: 'ZIP', span: 2, source: 'contact.address1_postalcode' },
          ...account('IRA account number'),
        ],
      },
      {
        title: 'Section 2 · Distribution',
        fields: [
          { name: 'Dist_Amount', label: 'Gross amount', span: 4, source: 'advisor', format: 'currency' },
          { name: 'Dist_Reason_Normal', label: 'Normal (59½ or older)', span: 4, source: 'advisor', type: 'checkbox' },
          { name: 'Dist_Reason_Early', label: 'Early (under 59½)', span: 4, source: 'advisor', type: 'checkbox' },
          { name: 'Dist_Reason_QCD', label: 'Qualified charitable distribution', span: 6, source: 'advisor', type: 'checkbox' },
          { name: 'QCD_Charity_Name', label: 'Charity name (QCD only)', span: 6, source: 'advisor' },
        ],
      },
      { title: 'Section 3 · Tax withholding (W-4R)', fields: [...withholding, { name: 'Withholding_State_Code', label: 'State', span: 2, source: 'advisor' }] },
      { title: 'Section 4 · Signature', signatures: [ownerSig] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [],
  },
  {
    id: 'tpl-ev2210-0626',
    name: 'Transfer of assets (incoming)',
    formNumber: 'EV-2210',
    source: 'Everence',
    issuer: 'Everence Trust Company',
    category: 'Transfers',
    revision: '06/2026',
    effectiveDate: '2026-06-01',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Traditional IRA', 'Roth IRA', 'Brokerage'],
    keywords: ['TOA', 'ACAT', 'transfer in', 'rollover', 'move assets'],
    description: 'Move assets from another firm into an Everence account.',
    sections: [
      { title: 'Section 1 · Receiving account', fields: [...owner(), ...account('Everence account number')] },
      {
        title: 'Section 2 · Delivering firm',
        fields: [
          { name: 'From_Firm', label: 'Delivering firm', span: 6, source: 'advisor', required: true, key: 'toa.firm' },
          { name: 'From_Account', label: 'Account number there', span: 3, source: 'advisor', required: true, key: 'toa.acct' },
          { name: 'From_Type', label: 'Account type there', span: 3, source: 'advisor', key: 'toa.type' },
          { name: 'Transfer_All', label: 'Transfer everything', span: 4, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'toa.all' },
          { name: 'Transfer_Partial', label: 'Partial amount', span: 4, source: 'advisor', format: 'currency', key: 'toa.partial', lockWhen: 'toa.all' },
          { name: 'Transfer_InKind', label: 'Transfer in kind', span: 4, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'toa.inkind' },
        ],
      },
      { title: 'Section 3 · Advisor', fields: rep },
      { title: 'Section 4 · Signatures', note: 'A medallion guarantee may be required by the delivering firm for amounts over $250,000.', signatures: [ownerSig, { role: 'Advisor', label: 'Advisor' }] },
    ],
    signers: [{ role: 'Owner' }, { role: 'Advisor' }],
    checks: [{ type: 'oneOf', fields: ['Transfer_All', 'Transfer_InKind'], label: 'Choose full cash or in-kind transfer' }],
  },
  {
    id: 'tpl-ev1300-0226',
    name: 'New account application',
    formNumber: 'EV-1300',
    source: 'Everence',
    issuer: 'Everence Financial',
    category: 'New accounts',
    revision: '02/2026',
    effectiveDate: '2026-02-01',
    status: 'Live',
    pdfKind: 'fillable',
    keywords: ['open account', 'new IRA', 'brokerage application', 'application'],
    description: 'Open an individual, joint or IRA account.',
    sections: [
      { title: 'Section 1 · Primary owner', fields: owner() },
      {
        title: 'Section 2 · Joint owner',
        fields: [
          { name: 'Joint_Name', label: 'Joint owner name', span: 6, source: 'connection[Joint owner].fullname' },
          { name: 'Joint_DOB', label: 'Date of birth', span: 3, source: 'connection[Joint owner].birthdate', format: 'date', limits: { dateMin: '-120y', dateMax: 'today' } },
          { name: 'Joint_SSN', label: 'SSN', span: 3, source: 'connection[Joint owner].ev_ssn', format: 'ssn' },
        ],
      },
      {
        title: 'Section 3 · Account type',
        fields: [
          { name: 'Type_Individual', label: 'Individual', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'newacct.individual' },
          { name: 'Type_Joint', label: 'Joint (JTWROS)', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'newacct.joint' },
          { name: 'Type_TradIRA', label: 'Traditional IRA', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'newacct.trad' },
          { name: 'Type_RothIRA', label: 'Roth IRA', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'newacct.roth' },
          { name: 'Initial_Deposit', label: 'Initial deposit', span: 4, source: 'advisor', format: 'currency', required: true, key: 'newacct.deposit' },
          { name: 'Employer', label: 'Employer', span: 8, source: 'contact.ev_employer', required: true },
        ],
      },
      { title: 'Section 4 · Advisor', fields: rep },
      { title: 'Section 5 · Signatures', signatures: [ownerSig, { role: 'JointOwner', label: 'Joint owner', optional: true }] },
    ],
    signers: [{ role: 'Owner' }, { role: 'JointOwner', condition: 'connection[Joint owner].fullname' }],
    checks: [{ type: 'oneOf', fields: ['Type_Individual', 'Type_Joint', 'Type_TradIRA', 'Type_RothIRA'], label: 'Pick one account type' }],
  },
  {
    id: 'tpl-ev1410-0126',
    name: 'Trusted contact designation',
    formNumber: 'EV-1410',
    source: 'Everence',
    issuer: 'Everence Financial',
    category: 'Account maintenance',
    revision: '01/2026',
    effectiveDate: '2026-01-01',
    status: 'Live',
    pdfKind: 'fillable',
    keywords: ['trusted contact', 'FINRA 4512', 'elder', 'emergency contact'],
    description: 'Name a trusted contact person (FINRA Rule 4512).',
    sections: [
      { title: 'Section 1 · Account owner', fields: owner().slice(0, 3) },
      {
        title: 'Section 2 · Trusted contact',
        fields: [
          { name: 'TC_Name', label: 'Trusted contact name', span: 6, source: 'connection[Trusted contact].fullname', required: true },
          { name: 'TC_Relationship', label: 'Relationship', span: 6, source: 'advisor', key: 'tc.rel', required: true },
          { name: 'TC_Phone', label: 'Phone', span: 4, source: 'connection[Trusted contact].mobilephone', format: 'phone', required: true },
          { name: 'TC_Email', label: 'Email', span: 8, source: 'connection[Trusted contact].emailaddress1', format: 'email' },
        ],
      },
      { title: 'Section 3 · Signature', signatures: [ownerSig] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [],
  },
  {
    id: 'tpl-ev1610-0425',
    name: 'Electronic funds transfer authorization',
    formNumber: 'EV-1610',
    source: 'Everence',
    issuer: 'Everence Federal Credit Union',
    category: 'Banking',
    revision: '04/2025',
    effectiveDate: '2025-04-01',
    status: 'Live',
    pdfKind: 'fillable',
    keywords: ['EFT', 'ACH', 'bank', 'direct deposit', 'automatic investment'],
    description: 'Link a bank account for contributions or withdrawals.',
    sections: [
      { title: 'Section 1 · Account owner', fields: [...owner().slice(0, 3), ...account()] },
      { title: 'Section 2 · Bank', note: 'The client completes this section when signing.', fields: bank },
      { title: 'Section 3 · Signature', signatures: [ownerSig] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [],
  },
  {
    id: 'tpl-px120-0526',
    name: 'Roth conversion request',
    formNumber: 'PX-120',
    source: 'Praxis',
    issuer: 'Praxis Mutual Funds',
    category: 'Distributions',
    revision: '05/2026',
    effectiveDate: '2026-05-01',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Traditional IRA'],
    keywords: ['Roth conversion', 'convert', 'backdoor'],
    description: 'Convert all or part of a traditional IRA to a Roth IRA.',
    sections: [
      { title: 'Section 1 · IRA owner', fields: [...owner().slice(0, 7), ...account('Traditional IRA number')] },
      {
        title: 'Section 2 · Conversion',
        fields: [
          { name: 'Conv_Amount', label: 'Amount to convert', span: 4, source: 'advisor', required: true, format: 'currency', key: 'roth.amount' },
          { name: 'Conv_RothAcct', label: 'Receiving Roth IRA number', span: 4, source: 'advisor', required: true, key: 'roth.acct', help: 'Open a Roth first with EV-1300 if the client has none.' },
        ],
      },
      { title: 'Section 3 · Tax withholding', fields: withholding },
      { title: 'Section 4 · Signature', signatures: [ownerSig] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [],
  },
  {
    id: 'tpl-px410-0126',
    name: 'Required minimum distribution election',
    formNumber: 'PX-410',
    source: 'Praxis',
    issuer: 'Praxis Mutual Funds',
    category: 'Distributions',
    revision: '01/2026',
    effectiveDate: '2026-01-01',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Traditional IRA'],
    keywords: ['RMD', 'required minimum', '73', 'annual distribution'],
    description: 'Elect how and when to take this year’s RMD.',
    sections: [
      { title: 'Section 1 · IRA owner', fields: [...owner().slice(0, 3), ...account('IRA account number')] },
      {
        title: 'Section 2 · Timing',
        fields: [
          { name: 'RMD_Monthly', label: 'Monthly', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'rmd.monthly' },
          { name: 'RMD_Annual', label: 'Once a year', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'rmd.annual' },
          { name: 'RMD_Date', label: 'Distribution date', span: 6, source: 'advisor', format: 'date', limits: { dateMin: 'today' }, required: true, key: 'rmd.date' },
        ],
      },
      { title: 'Section 3 · Tax withholding', fields: withholding },
      { title: 'Section 4 · Signature', signatures: [ownerSig] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [{ type: 'oneOf', fields: ['RMD_Monthly', 'RMD_Annual'], label: 'Pick RMD timing' }],
  },
  {
    id: 'tpl-ev1720-0926',
    name: 'Change of ownership',
    formNumber: 'EV-1720',
    source: 'Everence',
    issuer: 'Everence Financial',
    category: 'Account maintenance',
    revision: '09/2026',
    effectiveDate: '2026-09-15',
    status: 'Live',
    pdfKind: 'fillable',
    keywords: ['ownership', 're-register', 'trust', 'retitle'],
    description: 'Re-register an account to a new owner or trust.',
    sections: [
      { title: 'Section 1 · Current owner', fields: [...owner().slice(0, 3), ...account()] },
      {
        title: 'Section 2 · New owner',
        fields: [
          { name: 'NewOwner_Name', label: 'New owner or trust name', span: 8, source: 'advisor', required: true, key: 'own.name' },
          { name: 'NewOwner_TIN', label: 'SSN / TIN', span: 4, source: 'advisor', required: true, format: 'ssnOrTin', key: 'own.tin' },
          { name: 'Trust_Date', label: 'Trust date (if a trust)', span: 4, source: 'advisor', format: 'date', limits: { dateMax: 'today' }, key: 'own.trustdate' },
        ],
      },
      { title: 'Section 3 · Signatures', signatures: [ownerSig, { role: 'JointOwner', label: 'Joint owner', optional: true }] },
    ],
    signers: [{ role: 'Owner' }, { role: 'JointOwner', condition: 'connection[Joint owner].fullname' }],
    checks: [],
  },
  {
    id: 'tpl-sl200-0226',
    name: 'Policy change request',
    // Approved only where Sample Life writes business.
    states: ['IL', 'IN', 'KS', 'MI', 'OH', 'PA'],
    formNumber: 'SL-200',
    source: 'Carrier',
    issuer: 'Sample Life Insurance Co.',
    category: 'Insurance service',
    revision: '02/2026',
    effectiveDate: '2026-02-01',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Life policy'],
    keywords: ['policy service', 'carrier', 'life insurance', 'owner change', 'beneficiary'],
    description: 'Carrier form for owner, payor or beneficiary changes on a life policy.',
    sections: [
      { title: 'Section 1 · Policy', fields: [{ name: 'Policy_Number', label: 'Policy number', span: 4, source: 'account.ev_accountno', required: true }, { name: 'Insured_Name', label: 'Insured', span: 8, source: 'contact.fullname', required: true }] },
      { title: 'Section 2 · Owner', fields: owner().slice(0, 9) },
      {
        title: 'Section 3 · Requested change',
        fields: [
          { name: 'Chg_Beneficiary', label: 'Beneficiary', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'pol.bene' },
          { name: 'Chg_Payor', label: 'Payor', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'pol.payor' },
          { name: 'Chg_Address', label: 'Address', span: 3, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'pol.addr' },
          { name: 'Chg_Detail', label: 'Describe the change', span: 12, source: 'advisor', required: true, key: 'pol.detail' },
        ],
      },
      { title: 'Section 4 · Signatures', signatures: [ownerSig, { role: 'Insured', label: 'Insured (if not owner)', optional: true }] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [],
  },
  {
    id: 'tpl-sa310-0726',
    // Carriers often put the approved states in the title, as here.
    name: 'Annuity partial withdrawal [IN-KS-OH-PA]',
    states: ['IN', 'KS', 'OH', 'PA'],
    variantGroup: 'sa-310-withdrawal',
    formNumber: 'SA-310',
    source: 'Carrier',
    issuer: 'Sample Annuity Co.',
    category: 'Insurance service',
    revision: '07/2026',
    effectiveDate: '2026-07-01',
    status: 'Live',
    pdfKind: 'fillable',
    appliesTo: ['Annuity'],
    keywords: ['annuity', 'withdrawal', 'surrender', 'carrier'],
    description: 'Request a partial withdrawal from a deferred annuity.',
    sections: [
      { title: 'Section 1 · Contract', fields: [{ name: 'Contract_Number', label: 'Contract number', span: 4, source: 'account.ev_accountno', required: true }, ...owner().slice(0, 3)] },
      {
        title: 'Section 2 · Withdrawal',
        fields: [
          { name: 'WD_Amount', label: 'Gross amount', span: 4, source: 'advisor', required: true, format: 'currency', key: 'ann.amount', help: 'Amounts over the free-withdrawal allowance may carry a surrender charge.' },
          { name: 'WD_Net', label: 'Treat as net amount', span: 4, source: 'advisor', type: 'checkbox', format: 'checkbox', key: 'ann.net' },
        ],
      },
      { title: 'Section 3 · Tax withholding', fields: withholding },
      { title: 'Section 4 · Signature', signatures: [ownerSig] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [],
  },
  {
    id: 'tpl-ev0990-1225',
    name: 'Charitable gift annuity application',
    formNumber: 'EV-0990',
    source: 'Everence',
    issuer: 'Everence Foundation',
    category: 'New accounts',
    revision: '12/2025',
    effectiveDate: '2025-12-01',
    status: 'Needs mapping',
    pdfKind: 'flat',
    keywords: ['charitable', 'gift annuity', 'CGA', 'foundation', 'giving'],
    description: 'Scanned form. Needs overlay fields before it can be prefilled.',
    modifiedBy: 'Marketing · Dana Yoder',
    sections: [
      { title: 'Section 1 · Donor', fields: owner().slice(0, 7) },
      {
        title: 'Section 2 · Gift',
        fields: [
          { name: 'Gift_Amount', label: 'Gift amount', span: 4, source: 'advisor' },
          { name: 'Gift_Asset', label: 'Asset given', span: 8, source: 'advisor' },
        ],
      },
      { title: 'Section 3 · Signature', signatures: [{ role: 'Owner', label: 'Donor' }] },
    ],
    signers: [{ role: 'Owner' }],
    checks: [],
  },
];

// Sample Annuity's Virginia version of SA-310: a state variant of the same form.
const sa310 = SPECS.find((s) => s.id === 'tpl-sa310-0726')!;
SPECS.push({
  ...sa310,
  id: 'tpl-sa310va-0726',
  name: 'Annuity partial withdrawal (VA)',
  formNumber: 'SA-310-VA',
  states: ['VA'],
  description: 'Virginia version of SA-310, with the state’s free-look and replacement notices.',
});
