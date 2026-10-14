import { ID_SOURCE_OPTIONS } from '../../domain/idDocuments';
import { CHOICES } from '../../services/power/config';

/** Fill-from choices for the mapping editor, grouped like the Dataverse schema. */
export const SOURCE_GROUPS: { label: string; options: [string, string][] }[] = [
  {
    label: 'Entered at review or signing',
    options: [
      ['advisor', 'Advisor enters at review'],
      ['signer', 'Signer completes in DocuSign'],
    ],
  },
  {
    label: 'Contact',
    options: [
      ['contact.fullname', 'Full name'],
      ['contact.firstname', 'First name'],
      ['contact.lastname', 'Last name'],
      ['contact.birthdate', 'Date of birth'],
      ['contact.ev_ssn', 'SSN'],
      ['computed.ssnLast4', 'SSN last 4'],
      ['contact.emailaddress1', 'Email'],
      ['computed.phone', 'Best phone'],
      ['contact.mobilephone', 'Mobile phone'],
      ['computed.streetAddress', 'Street address'],
      ['contact.address1_city', 'City'],
      ['contact.address1_stateorprovince', 'State'],
      ['contact.address1_postalcode', 'ZIP'],
      ['computed.cityStateZip', 'City, State ZIP'],
      ['contact.ev_clientid', 'Client ID'],
      ['contact.ev_employer', 'Employer'],
      ['contact.familystatuscode', 'Marital status'],
      ['contact.gendercode', 'Gender'],
    ],
  },
  {
    label: 'Account on the form',
    options: [
      ['account.ev_accountno', 'Account number'],
      ['account.ev_accounttype', 'Account type'],
      ['account.ev_custodian', 'Custodian'],
      ['account.name', 'Account name'],
    ],
  },
  {
    label: 'Related people',
    options: [
      ['connection[Spouse].fullname', 'Spouse name'],
      ['connection[Spouse].birthdate', 'Spouse date of birth'],
      ['connection[Spouse].ev_ssn', 'Spouse SSN'],
      ['connection[Joint owner].fullname', 'Joint owner name'],
      ['connection[Joint owner].birthdate', 'Joint owner date of birth'],
      ['connection[Joint owner].ev_ssn', 'Joint owner SSN'],
      ['connection[Trusted contact].fullname', 'Trusted contact name'],
      ['connection[Trusted contact].mobilephone', 'Trusted contact phone'],
    ],
  },
  {
    label: 'ID documents (from CRM, or entered once per packet)',
    options: ID_SOURCE_OPTIONS,
  },
  {
    label: 'Advisor & firm',
    options: [
      ['rep.fullname', 'Advisor name'],
      ['rep.middleInitial', 'Advisor middle initial'],
      ['rep.title', 'Advisor title'],
      ['rep.repCode', 'Rep code'],
      ['rep.osjNumber', 'OSJ number'],
      ['rep.riaNumber', 'RIA number'],
      ['rep.phone', 'Advisor phone'],
      ['rep.phoneExt', 'Advisor phone extension'],
      ['rep.mobile', 'Advisor mobile'],
      ['rep.fax', 'Advisor fax'],
      ['rep.email', 'Advisor email (sign-in)'],
      ['rep.formEmail', 'Advisor email (as on forms)'],
      ['rep.officeStreet', 'Office street and suite'],
      ['rep.officeCity', 'Office city'],
      ['rep.officeState', 'Office state'],
      ['rep.officeZip', 'Office ZIP'],
      ['rep.officeCityStateZip', 'Office city, state ZIP'],
      ['rep.branch', 'Branch'],
      ['firm.legalName', 'Firm legal name'],
      ['firm.brokerDealer', 'Broker-dealer'],
      ['firm.crd', 'Firm CRD'],
      ['firm.phone', 'Firm phone'],
    ],
  },
  {
    label: 'Other',
    options: [
      ['computed.today', 'Today’s date'],
      ['static:Yes', 'Always checked / “Yes”'],
    ],
  },
];

export const KNOWN_SOURCES = new Set(SOURCE_GROUPS.flatMap((g) => g.options.map((o) => o[0])));

/**
 * The words a Dynamics choice column holds (see CHOICES), for "Checked when" and radio
 * options: `contact.familystatuscode` → single, married, divorced, widowed. Connections
 * are contacts too.
 */
export function choiceWords(source: string): string[] {
  const attr = /^(?:contact|connection\[[^\]]+\])\.([a-z0-9_]+)$/i.exec(source)?.[1];
  const def = attr ? CHOICES.contact?.[attr] : undefined;
  return def ? Object.values(def.options) : [];
}
