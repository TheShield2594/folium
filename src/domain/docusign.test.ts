import { describe, expect, it } from 'vitest';
import { consentUrl, docuSignProblems, docuSignReady, methodSetUp, withDocuSignDefaults } from './docusign';

const ACCOUNT = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('DocuSign setup', () => {
  it('defaults to the sandbox with nothing set', () => {
    expect(withDocuSignDefaults(undefined)).toEqual({ environment: 'demo', accountId: undefined, integrationKey: undefined, redirectUrl: undefined, idv: { sms: undefined, phone: undefined, kba: undefined } });
    expect(withDocuSignDefaults({ environment: 'nonsense' as never }).environment).toBe('demo');
  });

  it('trims what was typed and drops blanks', () => {
    const s = withDocuSignDefaults({ accountId: `  ${ACCOUNT} `, idv: { sms: ' ', kba: KEY } });
    expect(s.accountId).toBe(ACCOUNT);
    expect(s.idv).toEqual({ sms: undefined, phone: undefined, kba: KEY });
  });

  it('is ready to send once the account ID is a GUID', () => {
    expect(docuSignReady(withDocuSignDefaults({}))).toBe(false);
    expect(docuSignReady(withDocuSignDefaults({ accountId: '12345678' }))).toBe(false);
    expect(docuSignReady(withDocuSignDefaults({ accountId: ACCOUNT }))).toBe(true);
  });

  it('catches the short account number and malformed IDs', () => {
    const p = docuSignProblems(withDocuSignDefaults({ accountId: '12345678', integrationKey: 'abc', redirectUrl: 'http://x', idv: { phone: 'nope' } }));
    expect(Object.keys(p).sort()).toEqual(['accountId', 'integrationKey', 'phone', 'redirectUrl']);
    expect(docuSignProblems(withDocuSignDefaults({ accountId: ACCOUNT, integrationKey: KEY, idv: { sms: KEY } }))).toEqual({});
  });

  it('knows which verification methods are set up', () => {
    const s = withDocuSignDefaults({ idv: { sms: KEY } });
    expect(methodSetUp(s, 'email')).toBe(true);
    expect(methodSetUp(s, 'sms')).toBe(true);
    expect(methodSetUp(s, 'kba')).toBe(false);
  });

  it('builds the consent link for the environment', () => {
    expect(consentUrl(withDocuSignDefaults({}))).toBeUndefined();
    const demo = new URL(consentUrl(withDocuSignDefaults({ integrationKey: KEY }))!);
    expect(demo.host).toBe('account-d.docusign.com');
    expect(demo.searchParams.get('client_id')).toBe(KEY);
    expect(demo.searchParams.get('scope')).toBe('signature');
    expect(demo.searchParams.get('redirect_uri')).toBe('https://global.consent.azure-apim.net/redirect');
    const prod = new URL(consentUrl(withDocuSignDefaults({ environment: 'production', integrationKey: KEY, redirectUrl: 'https://global.consent.azure-apim.net/redirect/folium' }))!);
    expect(prod.host).toBe('account.docusign.com');
    expect(prod.searchParams.get('redirect_uri')).toBe('https://global.consent.azure-apim.net/redirect/folium');
  });
});
