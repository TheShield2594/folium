import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FormCategory, FormSource, FormTemplate, TemplateStatus } from '../../domain/types';
import { useServices } from '../../services';
import type { IncomingFile } from '../../services/types';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Badge, Button, Empty, Field, SearchField, Segmented, Select, Sheet, TextInput, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { fmtDay } from '../requests/RequestCard';
import { searchTemplates } from '../library/search';

export const STATUS_TONE: Record<TemplateStatus, 'accent' | 'warn' | 'info' | undefined> = { Live: 'accent', 'Needs mapping': 'warn', Draft: 'info', Retired: undefined };

/** Marketing's SharePoint library, as Folium sees it. */
export function AdminTemplates() {
  const templates = useApp((s) => s.templates);
  const refreshTemplates = useApp((s) => s.refreshTemplates);
  const services = useServices();
  const navigate = useNavigate();
  const [incoming, setIncoming] = useState<IncomingFile[]>();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | TemplateStatus>('all');
  const [registering, setRegistering] = useState<IncomingFile>();
  const [syncing, setSyncing] = useState(false);

  async function sync() {
    setSyncing(true);
    try {
      const [inc] = await Promise.all([services.templates.listIncoming(), refreshTemplates()]);
      setIncoming(inc);
    } finally {
      setSyncing(false);
    }
  }
  useEffect(() => {
    sync();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c: Record<TemplateStatus, number> = { Live: 0, 'Needs mapping': 0, Draft: 0, Retired: 0 };
    templates.forEach((t) => c[t.status]++);
    return c;
  }, [templates]);

  const list = searchTemplates(templates, q)
    .filter((t) => status === 'all' || t.status === status)
    .sort((a, b) => a.formNumber.localeCompare(b.formNumber) || b.effectiveDate.localeCompare(a.effectiveDate));

  return (
    <>
      <Toolbar title="Template library" subtitle="SharePoint › Marketing › Forms">
        <Button variant="gray" icon="refresh" busy={syncing} onClick={sync}>
          Sync
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page stack-5">
          <div>
            <h1 className="t-large">Template library</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              Marketing uploads PDFs to SharePoint. Map each new revision here, test it with a real contact, and publish it on its effective date.
            </p>
          </div>

          <div className="stat-tiles">
            {(['Live', 'Needs mapping', 'Draft', 'Retired'] as TemplateStatus[]).map((s) => (
              <button key={s} className="stat" style={{ textAlign: 'left', border: 0, cursor: 'pointer', outline: status === s ? '2px solid var(--accent)' : undefined }} onClick={() => setStatus(status === s ? 'all' : s)}>
                <b className={s === 'Needs mapping' && counts[s] ? 'c-warn' : undefined}>{counts[s]}</b>
                <span>{s}</span>
              </button>
            ))}
          </div>

          {incoming && incoming.length > 0 && (
            <section className="card" aria-labelledby="inc-h">
              <div className="card-head">
                <h2 id="inc-h">New from Marketing</h2>
                <Badge tone="warn">{incoming.length}</Badge>
              </div>
              <div style={{ padding: '0 8px 8px' }}>
                {incoming.map((f) => (
                  <div key={f.itemId} className="list-row">
                    <Icon name="doc_badge" size={22} className="c-warn" />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="t-headline ellipsis">{f.name}</div>
                      <div className="t-footnote c3">
                        Uploaded {fmtDay(f.uploadedOn)} by {f.uploadedBy} · {Math.round(f.sizeBytes / 1024)} KB
                        {f.guessedFormNumber && templates.some((t) => t.formNumber === f.guessedFormNumber) ? ` · looks like a new revision of ${f.guessedFormNumber}` : ' · new form'}
                      </div>
                    </div>
                    <Button variant="tinted" size="sm" onClick={() => setRegistering(f)}>
                      Set up
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card" aria-label="Templates">
            <div className="row wrap" style={{ padding: 16, gap: 10 }}>
              <div className="grow" style={{ minWidth: 220 }}>
                <SearchField value={q} onChange={setQ} placeholder="Search templates" label="Search templates" />
              </div>
              <Segmented
                label="Status"
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'Live', label: 'Live' },
                  { value: 'Needs mapping', label: 'Needs mapping' },
                  { value: 'Draft', label: 'Draft' },
                  { value: 'Retired', label: 'Retired' },
                ]}
              />
            </div>
            <div style={{ overflowX: 'auto' }}>
              {list.length === 0 ? (
                <Empty icon="folder" title="No templates match" />
              ) : (
                <table className="table" style={{ minWidth: 820 }}>
                  <thead>
                    <tr>
                      <th>Form</th>
                      <th>Revision</th>
                      <th>Status</th>
                      <th>Effective</th>
                      <th>PDF</th>
                      <th>Fields</th>
                      <th>Changed</th>
                      <th aria-label="Open" />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((t) => (
                      <tr key={t.id} onClick={() => navigate(`/admin/templates/${t.id}`)} style={{ cursor: 'pointer' }}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{t.name}</div>
                          <div className="t-footnote c3">
                            <span className="mono">{t.formNumber}</span> · {t.issuer ?? t.source}
                          </div>
                        </td>
                        <td className="tabular">{t.revision}</td>
                        <td>
                          <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                        </td>
                        <td className="tabular">{new Date(t.effectiveDate + 'T00:00').toLocaleDateString()}</td>
                        <td>{t.pdfKind === 'fillable' ? 'Fillable' : t.pdfKind === 'xfa' ? <Badge tone="warn">XFA</Badge> : <Badge tone="warn">Scanned</Badge>}</td>
                        <td className="tabular">{t.mapping.fields.length}</td>
                        <td className="t-footnote c3">
                          {fmtDay(t.modifiedOn)} · {t.modifiedBy}
                        </td>
                        <td>
                          <Icon name="chevronRight" size={16} className="c3" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>
      {registering && (
        <RegisterSheet
          file={registering}
          existing={templates}
          onClose={() => setRegistering(undefined)}
          onDone={async (t) => {
            setRegistering(undefined);
            await sync();
            toast.ok(`${t.formNumber} added. Map its fields next.`);
            navigate(`/admin/templates/${t.id}`);
          }}
        />
      )}
    </>
  );
}

function RegisterSheet({ file, existing, onClose, onDone }: { file: IncomingFile; existing: FormTemplate[]; onClose: () => void; onDone: (t: FormTemplate) => void }) {
  const services = useServices();
  const prev = existing.find((t) => t.formNumber === file.guessedFormNumber && t.status === 'Live');
  const [formNumber, setFormNumber] = useState(file.guessedFormNumber ?? '');
  const [name, setName] = useState(prev?.name ?? file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '));
  const [revision, setRevision] = useState(/Rev[-_ ]?(\d{2})[-_](\d{4})/i.exec(file.name)?.slice(1).join('/') ?? '');
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState<FormSource>(prev?.source ?? 'Everence');
  const [category, setCategory] = useState<FormCategory>(prev?.category ?? 'Account maintenance');
  const [busy, setBusy] = useState(false);

  return (
    <Sheet
      title="Set up template"
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            busy={busy}
            disabled={!formNumber || !name || !revision}
            onClick={async () => {
              setBusy(true);
              try {
                onDone(await services.templates.register(file, { formNumber, name, revision, effectiveDate: effective, source, category, issuer: prev?.issuer }));
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not set up the template');
                setBusy(false);
              }
            }}
          >
            Continue to mapping
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <p className="t-callout c2">
          <span className="mono">{file.name}</span>
          {prev ? ` replaces Rev ${prev.revision}. Folium will carry over unchanged field mappings.` : ''}
        </p>
        <div className="grid-2">
          <Field label="Form number" htmlFor="r-num">
            <TextInput id="r-num" className="mono" value={formNumber} onChange={(e) => setFormNumber(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Revision" htmlFor="r-rev" help="As printed on the form, e.g. 01/2027">
            <TextInput id="r-rev" value={revision} onChange={(e) => setRevision(e.target.value)} />
          </Field>
          <div className="span-2">
            <Field label="Name" htmlFor="r-name">
              <TextInput id="r-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Field label="Source" htmlFor="r-src">
            <Select id="r-src" value={source} onChange={(e) => setSource(e.target.value as FormSource)}>
              <option>Everence</option>
              <option>Praxis</option>
              <option>Carrier</option>
            </Select>
          </Field>
          <Field label="Category" htmlFor="r-cat">
            <Select id="r-cat" value={category} onChange={(e) => setCategory(e.target.value as FormCategory)}>
              {['Account maintenance', 'Beneficiary', 'Distributions', 'Transfers', 'New accounts', 'Insurance service', 'Banking'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Effective date" htmlFor="r-eff">
            <TextInput id="r-eff" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
          </Field>
        </div>
      </div>
    </Sheet>
  );
}
