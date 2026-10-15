import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { blankFirm, firmProblems, setDefaultFirm, templateIssuers, templatesUsing } from '../../domain/firms';
import { isReportUrl } from '../../domain/reports';
import type { FirmProfile, SendingDefaults } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { DEFAULT_IDLE_MINUTES } from '../../state/idle';
import { currentTemplates, useApp } from '../../state/store';
import { Badge, Button, ConfirmSheet, Field, Select, SwitchRow, TextArea, TextInput, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

/** A profile's text fields, as forms read them (`firm.<key>`). */
type TextKey = Exclude<{ [K in keyof FirmProfile]-?: FirmProfile[K] extends string | undefined ? K : never }[keyof FirmProfile], 'disclosure' | 'id' | 'reportsUrl' | 'signingProviderId'>;

const FIELDS: { key: TextKey; label: string; span?: boolean; mono?: boolean }[] = [
  { key: 'name', label: 'Display name' },
  { key: 'legalName', label: 'Legal name' },
  { key: 'address1', label: 'Street', span: true },
  { key: 'suite', label: 'Suite or PO box' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'phone', label: 'Phone' },
  { key: 'phoneExt', label: 'Extension' },
  { key: 'fax', label: 'Fax' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'brokerDealer', label: 'Broker-dealer' },
  { key: 'crd', label: 'CRD number', mono: true },
  { key: 'firmNumber', label: 'Firm, BD or IMO number', mono: true },
  { key: 'branchNumber', label: 'Branch number', mono: true },
  { key: 'osjName', label: 'OSJ name' },
  { key: 'riaName', label: 'RIA name' },
];

const newId = () => `firm-${Date.now().toString(36)}`;

/**
 * Firm profiles: one per legal entity, each available to its own forms as `firm.*` (a
 * form's issuer picks the profile; see domain/firms). The default profile fills
 * everything else and carries the firm-wide settings.
 */
export function AdminFirm() {
  const firms = useApp((s) => s.firms);
  const allTemplates = useApp((s) => s.templates);
  const reloadDirectory = useApp((s) => s.reloadDirectory);
  const services = useServices();
  const connections = services.signing.list();
  const templates = useMemo(() => currentTemplates(allTemplates), [allTemplates]);
  const issuers = useMemo(() => templateIssuers(templates), [templates]);
  /** Every profile as edited here; Save writes the ones that changed. */
  const [draft, setDraft] = useState<FirmProfile[]>(firms);
  const [selected, setSelected] = useState<string | undefined>(firms.find((f) => f.isDefault)?.id ?? firms[0]?.id);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<FirmProfile>();
  // A reload (after removing a profile, say) keeps edits not yet saved: a profile edited
  // here stays as edited, one added here stays, one removed elsewhere goes. After this
  // screen saves, what was saved comes back as it now is.
  const serverFirms = useRef(firms);
  const justSaved = useRef(false);
  useEffect(() => {
    const before = serverFirms.current;
    serverFirms.current = firms;
    const saved = justSaved.current;
    justSaved.current = false;
    setDraft((current) => {
      if (saved) return firms;
      const edited = (x: FirmProfile) => JSON.stringify(x) !== JSON.stringify(before.find((b) => b.id === x.id));
      const kept = firms.map((server) => current.find((x) => x.id === server.id && before.some((b) => b.id === x.id) && edited(x)) ?? server);
      const added = current.filter((x) => !before.some((b) => b.id === x.id) && !firms.some((f) => f.id === x.id));
      return [...kept, ...added];
    });
  }, [firms]);

  const saved = (id: string) => firms.find((x) => x.id === id);
  const changed = draft.filter((f) => JSON.stringify(f) !== JSON.stringify(saved(f.id)));
  const f = draft.find((x) => x.id === selected) ?? draft[0];
  const problems = f ? firmProblems(f, draft) : {};
  const allProblems = changed.flatMap((x) => Object.values(firmProblems(x, draft)).map((p) => `${x.name || 'New profile'}: ${p}`));

  const setF = (patch: Partial<FirmProfile>) => f && setDraft((list) => list.map((x) => (x.id === f.id ? { ...x, ...patch } : x)));
  const sending = f?.sending ?? {};
  /** Set one Send screen setting; an empty value goes back to the default. */
  const setSending = (patch: Partial<SendingDefaults>) => setF({ sending: { ...sending, ...patch } });

  async function save() {
    if (allProblems.length) {
      toast.error(allProblems[0]);
      return;
    }
    setBusy(true);
    try {
      // The default last: saving it takes the default from any other profile.
      for (const x of [...changed].sort((a, b) => Number(!!a.isDefault) - Number(!!b.isDefault))) await services.directory.saveFirm(x);
      justSaved.current = true;
      await reloadDirectory();
      toast.ok(changed.length === 1 ? `${changed[0].name} saved` : `${changed.length} firm profiles saved`);
    } catch (e) {
      justSaved.current = false;
      toast.error(e instanceof Error ? e.message : 'Could not save the firm profiles');
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const id = newId();
    // The first profile is the default: it fills every form.
    setDraft((list) => [...list, { ...blankFirm(id), ...(list.length ? {} : { isDefault: true }) }]);
    setSelected(id);
  }

  const using = f ? templatesUsing(f, templates, draft) : [];
  const takenBy = (issuer: string) => draft.find((x) => x.id !== f?.id && x.issuers.some((i) => i.toLowerCase() === issuer.toLowerCase()));

  return (
    <>
      <Toolbar title="Firm profiles">
        <Button variant="gray" icon="plus" onClick={add}>
          Add profile
        </Button>
        <Button variant="filled" disabled={!changed.length} busy={busy} onClick={save}>
          Save{changed.length > 1 ? ` ${changed.length}` : ''}
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">Firm profiles</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              One profile per Everence entity. A form’s <span className="mono">firm.*</span> fields fill from the profile that lists its issuer, unless the template names another; forms no profile claims use the group’s default, then the default profile. Changes apply to the next form anyone opens.
            </p>
          </div>

          <div className="list" role="listbox" aria-label="Firm profiles">
            {draft.map((x) => {
              const n = templatesUsing(x, templates, draft).length;
              return (
                <button key={x.id} type="button" role="option" className="list-row" aria-selected={x.id === f?.id} onClick={() => setSelected(x.id)}>
                  <Icon name="building" size={18} className="c3" />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="t-headline ellipsis" style={{ display: 'block' }}>
                      {x.name || 'New profile'}
                    </span>
                    <span className="t-footnote c3 ellipsis" style={{ display: 'block' }}>
                      {x.issuers.length ? x.issuers.join(', ') : x.isDefault ? 'Every form no other profile claims' : 'No issuers yet'}
                    </span>
                  </span>
                  {changed.includes(x) && <Badge tone="warn">Unsaved</Badge>}
                  {x.isDefault && <Badge tone="accent">Default</Badge>}
                  <span className="t-footnote c3 tabular">
                    {n} {n === 1 ? 'form' : 'forms'}
                  </span>
                </button>
              );
            })}
          </div>

          {f && (
            <>
              <section className="card card-pad stack-4" aria-labelledby="firm-h">
                <div className="row wrap">
                  <h2 id="firm-h" className="t-title3 grow">
                    {f.name || 'New profile'}
                  </h2>
                  {!f.isDefault && (
                    <>
                      <Button variant="gray" size="sm" onClick={() => setDraft((list) => setDefaultFirm(list, f.id))}>
                        Make default
                      </Button>
                      <Button
                        variant="plain"
                        size="sm"
                        onClick={() => (saved(f.id) ? setRemoving(f) : (setDraft((list) => list.filter((x) => x.id !== f.id)), setSelected(draft.find((x) => x.isDefault)?.id)))}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
                <div className="grid-2">
                  {FIELDS.map((d) => (
                    <div key={d.key} className={d.span ? 'span-2' : undefined}>
                      <Field label={d.label} htmlFor={`f-${d.key}`} help={`firm.${d.key}`} error={d.key === 'name' ? problems.name : undefined}>
                        <TextInput id={`f-${d.key}`} className={d.mono ? 'mono' : undefined} value={f[d.key] ?? ''} onChange={(e) => setF({ [d.key]: e.target.value })} />
                      </Field>
                    </div>
                  ))}
                </div>
              </section>

              <section className="stack-3" aria-labelledby="iss-h">
                <div>
                  <h2 id="iss-h" className="t-title3">
                    Issuers
                  </h2>
                  <p className="t-footnote c3" style={{ marginTop: 4 }}>
                    Forms from these issuers fill from this profile. An issuer can be on one profile only.{f.isDefault ? ' The default profile also fills every form no profile claims.' : ''}
                  </p>
                </div>
                {problems.issuers && (
                  <p className="t-footnote c-danger" role="alert">
                    {problems.issuers}
                  </p>
                )}
                <fieldset className="list" style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend className="sr-only">Issuers for {f.name || 'this profile'}</legend>
                  {[...new Set([...issuers, ...f.issuers])].map((i) => {
                    const other = takenBy(i);
                    return (
                      <label key={i} className="list-row" style={{ cursor: 'pointer' }}>
                        <input type="checkbox" className="check" checked={f.issuers.includes(i)} onChange={(e) => setF({ issuers: e.target.checked ? [...f.issuers, i] : f.issuers.filter((x) => x !== i) })} />
                        <span className="grow">{i}</span>
                        {other && <span className="t-footnote c3">on {other.name || 'another profile'}</span>}
                        {!issuers.includes(i) && <span className="t-footnote c3">no forms yet</span>}
                      </label>
                    );
                  })}
                </fieldset>
              </section>

              <section className="card card-pad stack-3">
                <Field label="Disclosure added to envelope emails" htmlFor="f-disc" help="Shown under the advisor’s note. An envelope carries the default profile’s disclosure, plus this one when it holds this entity’s forms and the wording differs.">
                  <TextArea id="f-disc" rows={3} value={f.disclosure} onChange={(e) => setF({ disclosure: e.target.value })} />
                </Field>
                {connections.length > 1 && (
                  <Field label="E-signature for this entity’s forms" htmlFor="f-sign" help="Over a group’s choice and the firm’s default (Administration › Settings › E-signature).">
                    <Select id="f-sign" value={f.signingProviderId ?? ''} onChange={(e) => setF({ signingProviderId: e.target.value || undefined })}>
                      <option value="">The group’s or firm’s default</option>
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </section>

              <section className="stack-3" aria-labelledby="uses-h">
                <h2 id="uses-h" className="t-title3">
                  Forms that fill from this profile <span className="c3 tabular">{using.length}</span>
                </h2>
                {using.length ? (
                  <div className="list">
                    {using.slice(0, 50).map((t) => (
                      <Link key={t.id} to={`/admin/templates/${t.id}`} className="list-row">
                        <span className="mono t-footnote c3">{t.formNumber}</span>
                        <span className="grow ellipsis">{t.name}</span>
                        <span className="t-footnote c3">{t.firmId === f.id ? 'Set on the template' : templateIssuerLabel(t)}</span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="t-footnote c3">None yet. Tick an issuer above, or choose this profile in a template’s details.</p>
                )}
              </section>

              {f.isDefault && <FirmWide f={f} setF={setF} sending={sending} setSending={setSending} />}
            </>
          )}
        </div>
      </div>
      {removing && (
        <ConfirmSheet
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove profile"
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await services.directory.removeFirm(removing.id);
            setSelected(firms.find((x) => x.isDefault)?.id);
            await reloadDirectory();
            toast.ok(`${removing.name} removed`);
          }}
        >
          Its forms fill from the default profile (or a group’s default) from the next form anyone opens. Templates that named it go back to their issuer.
        </ConfirmSheet>
      )}
    </>
  );
}

const templateIssuerLabel = (t: { issuer?: string; source: string }) => t.issuer || t.source;

/** Settings that are firm-wide, not per entity: kept on the default profile. */
function FirmWide({ f, setF, sending, setSending }: { f: FirmProfile; setF: (p: Partial<FirmProfile>) => void; sending: SendingDefaults; setSending: (p: Partial<SendingDefaults>) => void }) {
  return (
    <>
      <div>
        <h2 className="t-title2">Firm-wide settings</h2>
        <p className="t-footnote c3" style={{ marginTop: 4 }}>
          These apply whichever profile a form fills from. They stay with the default profile when you make another the default.
        </p>
      </div>
      <div className="list">
        <SwitchRow
          label="Block the editable PDF while checks are open"
          detail="Flattened PDFs, printing and DocuSign are always blocked until review’s checks pass. Off: the editable PDF still downloads, stamped “DRAFT — NOT FOR SIGNATURE”."
          checked={!!f.blockFillableWhenIncomplete}
          onChange={(v) => setF({ blockFillableWhenIncomplete: v || undefined })}
        />
        <SwitchRow
          label="Save drafts automatically when work is left idle"
          detail="After an advisor leaves unsaved changes untouched, Folium counts down for 2 minutes in the tab title, then saves the packet as a draft. Moving the mouse or typing cancels it."
          checked={!!f.idleAutoSave}
          onChange={(v) => setF({ idleAutoSave: v || undefined })}
        />
      </div>
      {f.idleAutoSave && (
        <section className="card card-pad">
          <Field label="Start the countdown after" htmlFor="f-idle">
            <Select id="f-idle" value={String(f.idleAutoSaveMinutes ?? DEFAULT_IDLE_MINUTES)} onChange={(e) => setF({ idleAutoSaveMinutes: Number(e.target.value) })}>
              {[10, 15, 25, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m} minutes idle
                </option>
              ))}
            </Select>
          </Field>
        </section>
      )}

      <section className="card card-pad stack-4" aria-labelledby="send-h">
        <div>
          <h2 id="send-h" className="t-title3">Sending</h2>
          <p className="t-footnote c3" style={{ marginTop: 4 }}>
            Defaults for every envelope. Tokens: <span className="mono">{'{client.firstname}'}</span>, <span className="mono">{'{client.lastname}'}</span>, <span className="mono">{'{forms}'}</span>,{' '}
            <span className="mono">{'{formCount}'}</span>, <span className="mono">{'{advisor.fullname}'}</span>, <span className="mono">{'{advisor.signature}'}</span>, <span className="mono">{'{firm.name}'}</span>. A token with no value is left blank.
          </p>
        </div>
        <Field label="Email subject" htmlFor="f-subj" help="Blank: “Forms to sign: …”. Cut to 100 characters.">
          <TextInput id="f-subj" value={sending.subjectTemplate ?? ''} placeholder="Forms to sign: {forms}" onChange={(e) => setSending({ subjectTemplate: e.target.value || undefined })} />
        </Field>
        <Field label="Email note" htmlFor="f-msg" help="Blank: Folium’s standard note with the advisor’s sign-off. The disclosure is always added. Administration › Settings can lock it.">
          <TextArea id="f-msg" rows={6} value={sending.messageTemplate ?? ''} placeholder={'Hi {client.firstname},\n\nHere are the forms we talked about…\n\n{advisor.signature}'} onChange={(e) => setSending({ messageTemplate: e.target.value || undefined })} />
        </Field>
      </section>
      <div className="list">
        <SwitchRow
          label="Signers sign in any order by default"
          detail="Off: envelopes are routed in the order on the Send screen. Advisors can set their own default in Settings and change it on each envelope."
          checked={!!sending.defaultAnyOrder}
          onChange={(v) => setSending({ defaultAnyOrder: v || undefined })}
        />
      </div>

      <section className="card card-pad stack-4" aria-labelledby="rep-h">
        <div>
          <h2 id="rep-h" className="t-title3">Reports</h2>
          <p className="t-footnote c3" style={{ marginTop: 4 }}>
            Form usage, people, e-signature and quality reports live in Power BI (see docs/REPORTS.md). With a link here, Administrators and people given the reporting role in Users &amp; groups see Reports in the sidebar.
          </p>
        </div>
        <Field
          label="Power BI report link"
          htmlFor="f-reports"
          optional
          help="The report’s URL in the Power BI service. Blank hides the Reports link."
          error={f.reportsUrl && !isReportUrl(f.reportsUrl) ? 'Use the report’s https:// link. Other links aren’t shown.' : undefined}
        >
          <TextInput id="f-reports" type="url" value={f.reportsUrl ?? ''} placeholder="https://app.powerbi.com/groups/…/reports/…" onChange={(e) => setF({ reportsUrl: e.target.value.trim() || undefined })} />
        </Field>
      </section>
    </>
  );
}
