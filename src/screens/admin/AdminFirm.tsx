import { useEffect, useState } from 'react';
import type { FirmProfile } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Button, Field, TextArea, TextInput, toast } from '../../ui/controls';

const FIELDS: { key: keyof FirmProfile; label: string; span?: boolean; mono?: boolean }[] = [
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
        </div>
      </div>
    </>
  );
}
