import { useEffect, useState } from 'react';
import type { FirmProfile, SendingDefaults } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Button, Field, Select, SwitchRow, TextArea, TextInput, toast } from '../../ui/controls';
import { DEFAULT_IDLE_MINUTES } from '../../state/idle';
import { isReportUrl } from '../../domain/reports';

/** The firm's text fields (settings below are switches and choices). */
type TextKey = Exclude<{ [K in keyof FirmProfile]-?: FirmProfile[K] extends string ? K : never }[keyof FirmProfile], 'disclosure'>;

const FIELDS: { key: TextKey; label: string; span?: boolean; mono?: boolean }[] = [
  { key: 'name', label: 'Display name' },
  { key: 'legalName', label: 'Legal name' },
  { key: 'address1', label: 'Street', span: true },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'phone', label: 'Phone' },
  { key: 'website', label: 'Website' },
  { key: 'brokerDealer', label: 'Broker-dealer' },
  { key: 'crd', label: 'CRD number', mono: true },
];

/** Firm data: available to every form as `firm.*` and added to envelope emails. */
export function AdminFirm() {
  const firm = useApp((s) => s.firm);
  const reloadDirectory = useApp((s) => s.reloadDirectory);
  const services = useServices();
  const [f, setF] = useState<FirmProfile | undefined>(firm);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(firm), [firm]);
  if (!f) return null;
  const dirty = JSON.stringify(f) !== JSON.stringify(firm);
  const sending = f.sending ?? {};
  /** Set one Send screen setting; an empty value goes back to the default. */
  const setSending = (patch: Partial<SendingDefaults>) => setF({ ...f, sending: { ...sending, ...patch } });

  return (
    <>
      <Toolbar title="Firm profile">
        <Button
          variant="filled"
          disabled={!dirty}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await services.directory.saveFirm(f);
              await reloadDirectory();
              toast.ok('Firm profile saved');
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Could not save the firm profile');
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">Firm profile</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              Map any form field to these with <span className="mono">firm.*</span> in the template editor. Changes apply to the next form anyone opens.
            </p>
          </div>
          <section className="card card-pad">
            <div className="grid-2">
              {FIELDS.map((d) => (
                <div key={d.key} className={d.span ? 'span-2' : undefined}>
                  <Field label={d.label} htmlFor={`f-${d.key}`} help={`firm.${d.key}`}>
                    <TextInput id={`f-${d.key}`} className={d.mono ? 'mono' : undefined} value={f[d.key]} onChange={(e) => setF({ ...f, [d.key]: e.target.value })} />
                  </Field>
                </div>
              ))}
            </div>
          </section>
          <section className="card card-pad stack-3">
            <Field label="Disclosure added to every envelope email" htmlFor="f-disc" help="Shown under the advisor’s note in DocuSign.">
              <TextArea id="f-disc" rows={3} value={f.disclosure} onChange={(e) => setF({ ...f, disclosure: e.target.value })} />
            </Field>
          </section>
          <div className="list">
            <SwitchRow
              label="Block the editable PDF while checks are open"
              detail="Flattened PDFs, printing and DocuSign are always blocked until review’s checks pass. Off: the editable PDF still downloads, stamped “DRAFT — NOT FOR SIGNATURE”."
              checked={!!f.blockFillableWhenIncomplete}
              onChange={(v) => setF({ ...f, blockFillableWhenIncomplete: v || undefined })}
            />
            <SwitchRow
              label="Save drafts automatically when work is left idle"
              detail="After an advisor leaves unsaved changes untouched, Folium counts down for 2 minutes in the tab title, then saves the packet as a draft. Moving the mouse or typing cancels it."
              checked={!!f.idleAutoSave}
              onChange={(v) => setF({ ...f, idleAutoSave: v || undefined })}
            />
          </div>
          {f.idleAutoSave && (
            <section className="card card-pad">
              <Field label="Start the countdown after" htmlFor="f-idle">
                <Select id="f-idle" value={String(f.idleAutoSaveMinutes ?? DEFAULT_IDLE_MINUTES)} onChange={(e) => setF({ ...f, idleAutoSaveMinutes: Number(e.target.value) })}>
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
            <Field label="Email note" htmlFor="f-msg" help="Blank: Folium’s standard note with the advisor’s sign-off. The disclosure above is always added. Administration › Settings can lock it.">
              <TextArea id="f-msg" rows={6} value={sending.messageTemplate ?? ''} placeholder={'Hi {client.firstname},\n\nHere are the forms we talked about…\n\n{advisor.signature}'} onChange={(e) => setSending({ messageTemplate: e.target.value || undefined })} />
            </Field>
          </section>
          <div className="list">
            <SwitchRow
              label="Signers sign in any order by default"
              detail="Off: DocuSign routes envelopes in the order on the Send screen. Advisors can set their own default in Settings and change it on each envelope."
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
              <TextInput id="f-reports" type="url" value={f.reportsUrl ?? ''} placeholder="https://app.powerbi.com/groups/…/reports/…" onChange={(e) => setF({ ...f, reportsUrl: e.target.value.trim() || undefined })} />
            </Field>
          </section>
        </div>
      </div>
    </>
  );
}
