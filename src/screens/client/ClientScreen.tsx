import { useEffect, useMemo, useState } from 'react';
import { formatValue, maskValue, validateFormat } from '../../domain/format';
import { resolvePath } from '../../domain/paths';
import type { Account, Contact, FieldFormat } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp, useScope } from '../../state/store';
import { Avatar, Badge, Button, Field, IconButton, Select, Sheet, TextInput, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { NoClient } from '../common/NoClient';
import { usePacketView } from '../common/usePacket';

interface Def {
  attr: keyof Contact & string;
  label: string;
  format?: FieldFormat;
  span?: 2;
  type?: 'date' | 'email' | 'tel';
  sensitive?: boolean;
}

const SECTIONS: { title: string; fields: Def[] }[] = [
  {
    title: 'Personal',
    fields: [
      { attr: 'firstname', label: 'First name' },
      { attr: 'middlename', label: 'Middle name' },
      { attr: 'lastname', label: 'Last name' },
      { attr: 'birthdate', label: 'Date of birth', format: 'date', type: 'date' },
      { attr: 'ev_ssn', label: 'Social Security number', format: 'ssn', sensitive: true },
      { attr: 'ev_employer', label: 'Employer' },
    ],
  },
  {
    title: 'Contact',
    fields: [
      { attr: 'emailaddress1', label: 'Email', format: 'email', type: 'email' },
      { attr: 'mobilephone', label: 'Mobile phone', format: 'phone', type: 'tel' },
      { attr: 'telephone1', label: 'Home phone', format: 'phone', type: 'tel' },
    ],
  },
  {
    title: 'Mailing address',
    fields: [
      { attr: 'address1_line1', label: 'Street', span: 2 },
      { attr: 'address1_line2', label: 'Apt, suite' },
      { attr: 'address1_city', label: 'City' },
      { attr: 'address1_stateorprovince', label: 'State' },
      { attr: 'address1_postalcode', label: 'ZIP', format: 'zip' },
    ],
  },
];

/**
 * Contact & accounts: see what Dynamics 365 has for this client and fix it at the
 * source. Unlike edits on the review screen, changes here are written back to CRM.
 */
export function ClientScreen() {
  const client = useApp((s) => s.client);
  const refreshClient = useApp((s) => s.refreshClient);
  const scope = useScope();
  const view = usePacketView();
  const services = useServices();
  const [draft, setDraft] = useState<Partial<Contact>>({});
  const [acctDraft, setAcctDraft] = useState<Record<string, Partial<Account>>>({});
  const [reveal, setReveal] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft({});
    setAcctDraft({});
  }, [client?.contact.contactid]);

  // Which contact attributes the packet's forms read, so gaps that matter stand out.
  const neededAttrs = useMemo(() => {
    const set = new Set<string>();
    view?.fills.forEach((f) =>
      f.fields.forEach((x) => {
        if (x.mapping.source.startsWith('contact.')) set.add(x.mapping.source.slice(8));
        if (x.mapping.source === 'computed.streetAddress') set.add('address1_line1');
        if (x.mapping.source === 'computed.phone') set.add('mobilephone');
      }),
    );
    return set;
  }, [view]);

  if (!client || !scope) return <NoClient />;
  const c = client.contact;

  const contactChanges = Object.entries(draft).filter(([k, v]) => (c[k] ?? '') !== (v ?? ''));
  const acctChanges = Object.entries(acctDraft).flatMap(([id, ch]) => {
    const a = client.accounts.find((x) => x.accountid === id)!;
    return Object.entries(ch)
      .filter(([k, v]) => (a[k] ?? '') !== (v ?? ''))
      .map(([k, v]) => ({ id, name: a.name, k, from: a[k], to: v }));
  });
  const dirty = contactChanges.length + acctChanges.length > 0;
  const invalid = SECTIONS.flatMap((s) => s.fields).some((d) => d.format && draft[d.attr] !== undefined && validateFormat(String(draft[d.attr] ?? ''), d.format));

  async function save() {
    setBusy(true);
    try {
      if (contactChanges.length) await services.crm.updateContact(c.contactid, Object.fromEntries(contactChanges));
      // Only fields that really differ from CRM, so an edit put back is never written.
      const byAccount = new Map<string, Partial<Account>>();
      for (const x of acctChanges) byAccount.set(x.id, { ...byAccount.get(x.id), [x.k]: x.to });
      for (const [id, ch] of byAccount) await services.crm.updateAccount(id, ch);
      await refreshClient();
      setDraft({});
      setAcctDraft({});
      setConfirming(false);
      toast.ok('Saved to Dynamics 365. Open forms picked up the change.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Dynamics 365 didn’t accept the change');
    } finally {
      setBusy(false);
    }
  }

  const labelFor = (k: string) => SECTIONS.flatMap((s) => s.fields).find((f) => f.attr === k)?.label ?? k;

  return (
    <>
      <Toolbar title="Contact & accounts" subtitle={`${c.fullname} · Dynamics 365`}>
        {dirty && (
          <Button variant="gray" onClick={() => (setDraft({}), setAcctDraft({}))}>
            Discard
          </Button>
        )}
        <Button variant="filled" icon="upload" disabled={!dirty || invalid} onClick={() => setConfirming(true)}>
          Save to Dynamics 365
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div className="row-3">
            <Avatar name={c.fullname} size={64} alt />
            <div className="grow">
              <h1 className="t-large">{c.fullname}</h1>
              <p className="t-callout c2">
                Client ID <span className="mono">{c.ev_clientid}</span>
                {c.ev_region ? ` · ${c.ev_region}` : ''} · {client.accounts.length} accounts
              </p>
              {c.unrecognisedChoices && (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {Object.entries(c.unrecognisedChoices).map(([col, u]) => (
                    <span key={col} title={`Dynamics 365 has “${u.value}”, which Folium doesn’t have a mapping for. Forms and signer rules that use ${u.label.toLowerCase()} won’t see it until an admin adds it.`}>
                      <Badge tone="warn" icon="warning">
                        {u.label} not recognised
                      </Badge>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="banner info">
            <Icon name="info" size={18} />
            <span className="t-callout">
              Changes here update the client’s record in Dynamics 365 and every form that uses it. To change a value on one form only, edit it on the review screen.
            </span>
          </div>

          {SECTIONS.map((sec) => (
            <section key={sec.title} className="card card-pad stack-4" aria-labelledby={`sec-${sec.title}`}>
              <h2 id={`sec-${sec.title}`} className="t-title3">{sec.title}</h2>
              <div className="grid-3">
                {sec.fields.map((d) => {
                  const current = String(draft[d.attr] ?? c[d.attr] ?? '');
                  const changed = draft[d.attr] !== undefined && current !== String(c[d.attr] ?? '');
                  const err = d.format ? validateFormat(current, d.format) : undefined;
                  const missing = !current && neededAttrs.has(d.attr);
                  return (
                    <div key={d.attr} className={d.span ? 'span-2' : undefined}>
                      <Field
                        htmlFor={`c-${d.attr}`}
                        label={
                          <span className="row" style={{ gap: 6 }}>
                            {d.label}
                            {changed && <Badge tone="info">Changed</Badge>}
                            {missing && <Badge tone="warn">Needed by forms</Badge>}
                          </span>
                        }
                        error={current ? err : undefined}
                      >
                        <div className="row" style={{ gap: 6 }}>
                          <TextInput
                            id={`c-${d.attr}`}
                            need={missing}
                            type={d.sensitive && !reveal ? 'password' : d.type ?? 'text'}
                            value={current}
                            onChange={(e) => setDraft({ ...draft, [d.attr]: e.target.value })}
                            autoComplete="off"
                          />
                          {d.sensitive && <IconButton icon={reveal ? 'eyeSlash' : 'eye'} label={reveal ? 'Hide' : 'Show'} onClick={() => setReveal(!reveal)} />}
                        </div>
                      </Field>
                    </div>
                  );
                })}
                {sec.title === 'Personal' && (
                  <Field label="Marital status" htmlFor="c-marital">
                    <Select id="c-marital" value={String(draft.familystatuscode ?? c.familystatuscode ?? '')} onChange={(e) => setDraft({ ...draft, familystatuscode: e.target.value as Contact['familystatuscode'] })}>
                      <option value="">—</option>
                      <option value="single">Single</option>
                      <option value="married">Married</option>
                      <option value="divorced">Divorced</option>
                      <option value="widowed">Widowed</option>
                    </Select>
                  </Field>
                )}
                {sec.title === 'Personal' && (
                  <Field label="Gender" htmlFor="c-gender">
                    <Select id="c-gender" value={String(draft.gendercode ?? c.gendercode ?? '')} onChange={(e) => setDraft({ ...draft, gendercode: e.target.value as Contact['gendercode'] })}>
                      <option value="">—</option>
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                    </Select>
                  </Field>
                )}
              </div>
            </section>
          ))}

          <section className="stack" aria-labelledby="accts-h">
            <h2 id="accts-h" className="section-title">Accounts</h2>
            <div className="list">
              {client.accounts.map((a) => {
                const d = acctDraft[a.accountid] ?? {};
                const set = (k: keyof Account, v: string) => setAcctDraft({ ...acctDraft, [a.accountid]: { ...d, [k]: v } });
                return (
                  <div key={a.accountid} className="list-row" style={{ flexWrap: 'wrap', padding: '12px 16px' }}>
                    <div className="grow" style={{ minWidth: 200 }}>
                      <div className="t-headline">{a.name}</div>
                      <div className="t-footnote c3">
                        {a.ev_custodian}
                        {a.ev_balance ? ` · ${formatValue(String(a.ev_balance), 'currency')}` : ''}
                      </div>
                    </div>
                    <TextInput aria-label={`${a.name} account number`} value={String(d.ev_accountno ?? a.ev_accountno)} onChange={(e) => set('ev_accountno', e.target.value)} style={{ width: 170 }} className="mono" />
                    <Select aria-label={`${a.name} type`} value={String(d.ev_accounttype ?? a.ev_accounttype)} onChange={(e) => set('ev_accounttype', e.target.value)} style={{ width: 170 }}>
                      {['Traditional IRA', 'Roth IRA', 'Brokerage', 'Annuity', 'Life policy', 'Checking'].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </Select>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="stack" aria-labelledby="people-h">
            <h2 id="people-h" className="section-title">Related people</h2>
            {client.connections.length === 0 ? (
              <p className="t-callout c3">No connections. Add a spouse, joint owner or trusted contact in Dynamics 365 and Folium uses them for signers and beneficiaries.</p>
            ) : (
              <div className="list">
                {client.connections.map((x, i) => (
                  <div key={i} className="list-row">
                    <Avatar name={x.contact.fullname} size={30} />
                    <div className="grow">
                      <div className="t-headline">{x.contact.fullname}</div>
                      <div className="t-footnote c3">
                        {[x.contact.emailaddress1, x.contact.mobilephone && formatValue(x.contact.mobilephone, 'phone')].filter(Boolean).join(' · ') || 'No email or phone on file'}
                      </div>
                    </div>
                    <Badge>{x.role}</Badge>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card card-pad stack-3">
            <h2 className="t-headline">What forms will see</h2>
            <dl className="prov">
              {['contact.fullname', 'computed.cityStateZip', 'computed.phone', 'connection[Spouse].fullname', 'connection[Joint owner].fullname', 'rep.fullname'].map((p) => (
                <div key={p} style={{ display: 'contents' }}>
                  <dt className="mono">{p}</dt>
                  <dd>{resolvePath(p, scope) ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>

      {confirming && (
        <Sheet
          title="Update Dynamics 365?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="gray" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="filled" busy={busy} onClick={save}>
                Update record
              </Button>
            </>
          }
        >
          <div className="stack-3">
            <p className="t-callout c2">These changes are written to {c.firstname}’s record and show up everywhere that record is used.</p>
            <div className="list">
              {contactChanges.map(([k, v]) => (
                <div key={k} className="list-row">
                  <span className="grow">{labelFor(k)}</span>
                  <span className="t-footnote c3" style={{ textDecoration: 'line-through' }}>{k === 'ev_ssn' ? maskValue(String(c[k] ?? ''), 'ssn') : String(c[k] ?? '—')}</span>
                  <Icon name="arrowRight" size={14} className="c3" />
                  <strong className="t-callout">{k === 'ev_ssn' ? maskValue(String(v ?? ''), 'ssn') : String(v || '—')}</strong>
                </div>
              ))}
              {acctChanges.map((x) => (
                <div key={x.id + x.k} className="list-row">
                  <span className="grow">{x.name}</span>
                  <span className="t-footnote c3" style={{ textDecoration: 'line-through' }}>{String(x.from ?? '—')}</span>
                  <Icon name="arrowRight" size={14} className="c3" />
                  <strong className="t-callout">{String(x.to ?? '—')}</strong>
                </div>
              ))}
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
