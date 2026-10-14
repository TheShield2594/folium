import { useEffect, useState } from 'react';
import { DEFAULT_ATTACHMENT_LIMITS } from '../../domain/checks';
import { consentUrl, DEFAULT_REDIRECT_URL, docuSignProblems, DOCUSIGN_ENVIRONMENTS, withDocuSignDefaults, type DocuSignEnvironment, type DocuSignSetup } from '../../domain/docusign';
import { RETENTION_OPTIONS, retentionDays } from '../../domain/requests';
import { dormantDays } from '../../domain/users';
import type { FirmPolicy, PdfDownloadPolicy, RepDataVisibility, SharingPolicy } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Badge, Button, Field, Select, SwitchRow, TextInput, toast } from '../../ui/controls';

const SHARING: Record<SharingPolicy, { label: string; effect: string }> = {
  off: { label: 'Off', effect: 'Nobody can share a draft. Drafts already shared stay with those people until they’re sent, deleted or expire.' },
  groups: { label: 'Within groups', effect: 'Advisors and assistants can share a draft with people in a group they’re in.' },
  anyone: { label: 'Anyone with Folium', effect: 'A draft can be shared with anyone who uses Folium, in any group.' },
};

const REP_DATA: Record<RepDataVisibility, { label: string; effect: string }> = {
  assistants: { label: 'Assistants only', effect: 'Assistants work as the advisors in their groups. Advisors always fill forms with their own rep code and details.' },
  groupMembers: { label: 'Advisors and assistants within groups', effect: 'Advisors can also work as another advisor in their groups: forms fill with that advisor’s rep data, and the work is in their book.' },
};

const DOWNLOAD: Record<PdfDownloadPolicy, { label: string; effect: string }> = {
  all: { label: 'Allowed', effect: 'Advisors can download fillable and flattened PDFs, print, sign in person, and download signed envelopes.' },
  signedOnly: { label: 'Signed envelopes only', effect: 'Forms leave Folium only through DocuSign. The completed, signed envelope can still be downloaded for OnBase.' },
  none: { label: 'Off', effect: 'No PDF downloads or printing at all: DocuSign is the only way out, and signed envelopes are filed from DocuSign.' },
};

/** A typed limit as a whole number from 1 to `max`; empty or below 1 goes back to the default. */
const clampLimit = (raw: string, max: number) => {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : undefined;
};

/** Firm-wide rules, saved in their own settings row ("Policy"), shared by every firm profile. */
export function AdminSettings() {
  const policy = useApp((s) => s.policy);
  const docuSign = useApp((s) => s.docuSign);
  const reloadDirectory = useApp((s) => s.reloadDirectory);
  const services = useServices();
  const [p, setP] = useState<FirmPolicy>(policy);
  const [d, setD] = useState<DocuSignSetup>(docuSign);
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(policy), [policy]);
  useEffect(() => setD(docuSign), [docuSign]);
  const policyDirty = JSON.stringify(p) !== JSON.stringify(policy);
  const docuSignDirty = JSON.stringify(withDocuSignDefaults(d)) !== JSON.stringify(withDocuSignDefaults(docuSign));
  const problems = docuSignProblems(d);
  const dirty = policyDirty || docuSignDirty;
  const set = (patch: Partial<FirmPolicy>) => setP({ ...p, ...patch });
  const keep = retentionDays(p);

  async function save() {
    if (Object.keys(problems).length) {
      toast.error('Fix the DocuSign settings marked below first.');
      return;
    }
    setBusy(true);
    try {
      if (policyDirty) await services.directory.savePolicy(p);
      if (docuSignDirty) await services.directory.saveDocuSign(withDocuSignDefaults(d));
      await reloadDirectory();
      toast.ok('Settings saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the settings');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Toolbar title="Settings">
        <Button variant="filled" disabled={!dirty} busy={busy} onClick={save}>
          Save
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">Firm settings</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              Rules for everyone at the firm. They apply the next time each person opens Folium. Changes are recorded by Dataverse auditing.
            </p>
          </div>

          <section className="card card-pad stack-4" aria-labelledby="pol-h">
            <h2 id="pol-h" className="t-title3">Sharing and access</h2>
            <Field label="Sharing drafts between people" htmlFor="p-share" help={SHARING[p.sharing].effect}>
              <Select id="p-share" value={p.sharing} onChange={(e) => set({ sharing: e.target.value as SharingPolicy })}>
                {(Object.keys(SHARING) as SharingPolicy[]).map((k) => (
                  <option key={k} value={k}>
                    {SHARING[k].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Working as another advisor (rep data)" htmlFor="p-rep" help={REP_DATA[p.repDataVisibility].effect}>
              <Select id="p-rep" value={p.repDataVisibility} onChange={(e) => set({ repDataVisibility: e.target.value as RepDataVisibility })}>
                {(Object.keys(REP_DATA) as RepDataVisibility[]).map((k) => (
                  <option key={k} value={k}>
                    {REP_DATA[k].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="PDF downloads" htmlFor="p-dl" help={DOWNLOAD[p.pdfDownload].effect}>
              <Select id="p-dl" value={p.pdfDownload} onChange={(e) => set({ pdfDownload: e.target.value as PdfDownloadPolicy })}>
                {(Object.keys(DOWNLOAD) as PdfDownloadPolicy[]).map((k) => (
                  <option key={k} value={k}>
                    {DOWNLOAD[k].label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="list">
              <SwitchRow
                label="People can edit their own rep details"
                detail="Title, phones, office and email on forms, in Settings. Change it for one person in Users & groups. Rep, OSJ and RIA numbers are always set by an administrator."
                checked={p.repDataSelfEdit ?? true}
                onChange={(v) => set({ repDataSelfEdit: v })}
              />
            </div>
            <Field label="Show people as dormant after" htmlFor="p-dormant" help="In Users & groups, for anyone who hasn’t opened Folium in that long.">
              <Select id="p-dormant" value={String(dormantDays(p))} onChange={(e) => set({ dormantAfterDays: Number(e.target.value) })}>
                {[30, 60, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </Select>
            </Field>
          </section>

          <section className="card card-pad stack-3" aria-labelledby="ret-h">
            <h2 id="ret-h" className="t-title3">Draft retention</h2>
            <p className="t-footnote c3">
              Drafts hold client SSNs and account numbers. Folium deletes an unsent draft, and its PDFs in SharePoint, this long after it was last saved. Opening and saving a draft starts the clock again. Packets printed to sign in person and sent requests aren’t affected.
            </p>
            <Field label="Keep unsent drafts for" htmlFor="p-ret" help={keep === 0 ? 'Save draft and Share are hidden. Send and “sign in person” still work.' : 'Shortening it applies from each draft’s next save.'}>
              <Select id="p-ret" value={String(keep)} onChange={(e) => set({ draftRetentionDays: Number(e.target.value) })}>
                {RETENTION_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? 'Don’t keep drafts' : `${d} days${d === 90 ? ' (default)' : ''}`}
                  </option>
                ))}
              </Select>
            </Field>
          </section>

          <section className="card card-pad stack-4" aria-labelledby="env-h">
            <h2 id="env-h" className="t-title3">Envelopes</h2>
            <div className="grid-2">
              <Field label="Most supporting documents" htmlFor="p-maxn">
                <TextInput id="p-maxn" type="number" min={1} max={50} value={p.maxAttachments ?? ''} placeholder={String(DEFAULT_ATTACHMENT_LIMITS.maxFiles)} onChange={(e) => set({ maxAttachments: clampLimit(e.target.value, 50) })} />
              </Field>
              <Field label="Most MB of supporting documents" htmlFor="p-maxmb" help="Check DocuSign’s and the connector’s request limits before raising it.">
                <TextInput id="p-maxmb" type="number" min={1} max={100} value={p.maxAttachmentsMB ?? ''} placeholder={String(DEFAULT_ATTACHMENT_LIMITS.maxMB)} onChange={(e) => set({ maxAttachmentsMB: clampLimit(e.target.value, 100) })} />
              </Field>
            </div>
          </section>
          <div className="list">
            <SwitchRow
              label="Lock the email note"
              detail="Users and Assistants send the note from the firm profile as written. Admins can still edit it, and the disclosure is still added."
              checked={!!p.lockMessage}
              onChange={(v) => set({ lockMessage: v || undefined })}
            />
          </div>

          <DocuSignCard value={d} onChange={setD} problems={problems} />

          <p className="t-footnote c3">Folium never collects device location: nothing in the forms workflow needs it.</p>
        </div>
      </div>
    </>
  );
}

/** Blank input → undefined, so an emptied field saves as "not set". */
const typed = (v: string) => v.trim() || undefined;

/**
 * The firm's DocuSign account. The integration key's secret isn't here: it's in the custom
 * connector. Each person signs in to DocuSign with their own login the first time they
 * open Folium, and sends as themselves.
 */
function DocuSignCard({ value: d, onChange, problems }: { value: DocuSignSetup; onChange: (d: DocuSignSetup) => void; problems: ReturnType<typeof docuSignProblems> }) {
  const services = useServices();
  const [check, setCheck] = useState<{ busy?: boolean; ok?: string; error?: string }>({});
  const set = (patch: Partial<DocuSignSetup>) => {
    onChange({ ...d, ...patch });
    setCheck({});
  };
  const setIdv = (k: keyof DocuSignSetup['idv'], v: string) => set({ idv: { ...d.idv, [k]: typed(v) } });
  const env = DOCUSIGN_ENVIRONMENTS[d.environment];
  const consent = consentUrl(d);

  async function test() {
    setCheck({ busy: true });
    try {
      const a = await services.signing.checkConnection(d);
      setCheck({ ok: `Connected to ${a.accountName}. Your DocuSign sign-in can send from this account.` });
    } catch (e) {
      setCheck({ error: e instanceof Error ? e.message : 'DocuSign didn’t answer.' });
    }
  }

  return (
    <section className="card card-pad stack-4" aria-labelledby="ds-h">
      <div className="row">
        <h2 id="ds-h" className="t-title3 grow">DocuSign</h2>
        {d.accountId && !problems.accountId ? <Badge tone="accent">Set up</Badge> : <Badge tone="warn">Not set up</Badge>}
      </div>
      <p className="t-footnote c3">
        Envelopes go out from each person’s own DocuSign login. The first time someone opens Folium, Power Apps asks them to sign in to DocuSign; their login must be a user in this account. The integration key’s secret stays in the custom connector and never comes here.
      </p>
      <div className="grid-2">
        <Field label="Environment" htmlFor="ds-env" help={`Sign-in at ${env.authHost}. The connector’s host must be ${env.apiHost}.`}>
          <Select id="ds-env" value={d.environment} onChange={(e) => set({ environment: e.target.value as DocuSignEnvironment })}>
            {(Object.keys(DOCUSIGN_ENVIRONMENTS) as DocuSignEnvironment[]).map((k) => (
              <option key={k} value={k}>
                {DOCUSIGN_ENVIRONMENTS[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="API Account ID" htmlFor="ds-acct" error={problems.accountId} help={problems.accountId ? undefined : 'DocuSign Admin › Apps and Keys › My Account Information.'}>
          <TextInput id="ds-acct" value={d.accountId ?? ''} placeholder="1a2b3c4d-…" spellCheck={false} autoComplete="off" onChange={(e) => set({ accountId: typed(e.target.value) })} />
        </Field>
        <Field label="Integration key" htmlFor="ds-key" optional error={problems.integrationKey} help={problems.integrationKey ? undefined : 'The Folium app’s key from Apps and Keys. Lets Folium offer the consent link when DocuSign asks for it.'}>
          <TextInput id="ds-key" value={d.integrationKey ?? ''} placeholder="1a2b3c4d-…" spellCheck={false} autoComplete="off" onChange={(e) => set({ integrationKey: typed(e.target.value) })} />
        </Field>
        <Field label="Connector redirect URL" htmlFor="ds-redir" optional error={problems.redirectUrl} help={problems.redirectUrl ? undefined : 'From the custom connector’s Security tab. Add it to the DocuSign app’s redirect URIs too.'}>
          <TextInput id="ds-redir" type="url" value={d.redirectUrl ?? ''} placeholder={DEFAULT_REDIRECT_URL} spellCheck={false} onChange={(e) => set({ redirectUrl: typed(e.target.value) })} />
        </Field>
      </div>

      <div className="stack-3">
        <h3 className="t-headline">Identity verification</h3>
        <p className="t-footnote c3">Workflow IDs from DocuSign Admin › Identity Verification. A method left blank can’t be chosen on the Send screen: Folium won’t send with weaker verification than the advisor picked. Email needs no workflow.</p>
        <div className="grid-2">
          <Field label="SMS code" htmlFor="ds-sms" optional error={problems.sms}>
            <TextInput id="ds-sms" value={d.idv.sms ?? ''} placeholder="Workflow ID" spellCheck={false} onChange={(e) => setIdv('sms', e.target.value)} />
          </Field>
          <Field label="Phone call" htmlFor="ds-phone" optional error={problems.phone}>
            <TextInput id="ds-phone" value={d.idv.phone ?? ''} placeholder="Workflow ID" spellCheck={false} onChange={(e) => setIdv('phone', e.target.value)} />
          </Field>
          <Field label="ID questions (KBA)" htmlFor="ds-kba" optional error={problems.kba}>
            <TextInput id="ds-kba" value={d.idv.kba ?? ''} placeholder="Workflow ID" spellCheck={false} onChange={(e) => setIdv('kba', e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Button onClick={test} busy={check.busy} disabled={!d.accountId || !!problems.accountId}>
          Test connection
        </Button>
        {consent && (
          <Button variant="plain" onClick={() => window.open(consent, '_blank', 'noopener')}>
            Open the consent page
          </Button>
        )}
      </div>
      {check.ok && (
        <p className="t-footnote c-accent" role="status">
          {check.ok}
        </p>
      )}
      {check.error && (
        <p className="t-footnote c-danger" role="alert">
          {check.error}
        </p>
      )}
    </section>
  );
}
