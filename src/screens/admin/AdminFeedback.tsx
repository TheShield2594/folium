import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { categoryLabel, FEEDBACK_STATUSES, filterFeedback, isOpen, resolveFeedback, statusLabel, type FeedbackKind, type FeedbackStatus, type FormFeedback } from '../../domain/feedback';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Badge, Button, Empty, Field, SearchField, Segmented, Select, Sheet, Spinner, TextArea, toast, TableScroll } from '../../ui/controls';
import { fmtDay } from '../requests/RequestCard';

const STATUS_TONE: Record<FeedbackStatus, 'accent' | 'warn' | 'info' | 'danger' | undefined> = { new: 'warn', inProgress: 'info', fixed: 'accent', wontFix: undefined, duplicate: undefined };

/** Administration › Form feedback: requests for new forms and problem reports, in one list. */
export function AdminFeedback() {
  const me = useApp((s) => s.me);
  // Admins only: the sidebar hides the link, and this stops a typed-in URL.
  if (me?.role !== 'Admin') return <Navigate to="/" replace />;
  return <FeedbackInbox />;
}

function FeedbackInbox() {
  const services = useServices();
  const templates = useApp((s) => s.templates);
  const users = useApp((s) => s.users);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<FormFeedback[]>();
  const [kind, setKind] = useState<FeedbackKind | 'all'>('all');
  const [status, setStatus] = useState<FeedbackStatus | 'open' | ''>('open');
  const [issuer, setIssuer] = useState('');
  const [form, setForm] = useState(params.get('form') ?? '');
  const [open, setOpen] = useState<FormFeedback>();

  async function load() {
    try {
      setList(await services.feedback.list());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load form feedback');
      setList((l) => l ?? []);
    }
  }
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const issuers = useMemo(() => [...new Set((list ?? []).map((f) => f.issuer).filter((x): x is string => !!x))].sort(), [list]);
  const shown = list ? filterFeedback(list, { kind: kind === 'all' ? undefined : kind, status: status || undefined, issuer: issuer || undefined, form }) : [];
  const openCount = (list ?? []).filter(isOpen).length;
  const who = (f: FormFeedback) => users.find((u) => u.systemuserid === f.requestedById)?.fullname ?? f.requestedBy ?? '—';

  return (
    <>
      <Toolbar title="Form feedback" subtitle={list ? `${openCount} open` : undefined}>
        <Button variant="gray" icon="refresh" onClick={load}>
          Refresh
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page stack-5">
          <div>
            <h1 className="t-large">Form feedback</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              Forms advisors asked for, and problems they found on forms in the library. Open a problem to go straight to the field in the template editor.
            </p>
          </div>
          <section className="card" aria-label="Form feedback">
            <div className="row wrap" style={{ padding: 16, gap: 10 }}>
              <div className="grow" style={{ minWidth: 200 }}>
                <SearchField
                  value={form}
                  onChange={(v) => {
                    setForm(v);
                    setParams(v ? { form: v } : {}, { replace: true });
                  }}
                  placeholder="Form number or name"
                  label="Search by form"
                />
              </div>
              <Segmented
                label="Kind"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'problem', label: 'Problems' },
                  { value: 'request', label: 'Requests' },
                ]}
              />
              <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as FeedbackStatus | 'open' | '')} style={{ width: 'auto' }}>
                <option value="open">Open</option>
                <option value="">Every status</option>
                {FEEDBACK_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
              {issuers.length > 1 && (
                <Select aria-label="Company" value={issuer} onChange={(e) => setIssuer(e.target.value)} style={{ width: 'auto' }}>
                  <option value="">Every company</option>
                  {issuers.map((i) => (
                    <option key={i}>{i}</option>
                  ))}
                </Select>
              )}
            </div>
            {!list ? (
              <div style={{ padding: 24, display: 'grid', placeItems: 'center' }}>
                <Spinner label="Loading form feedback" />
              </div>
            ) : shown.length === 0 ? (
              <Empty icon="inbox" title={list.length ? 'Nothing matches' : 'No feedback yet'}>
                {list.length ? 'Try another status or company.' : 'Requests from “Ask Marketing” and problem reports from Review land here.'}
              </Empty>
            ) : (
              <TableScroll label="Form feedback">
                <table className="table" style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      <th>Form</th>
                      <th>What</th>
                      <th>From</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((f) => (
                      <tr
                        key={f.id}
                        tabIndex={0}
                        aria-label={`Open ${f.kind === 'problem' ? 'problem report' : 'form request'}: ${f.name}`}
                        onClick={() => setOpen(f)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setOpen(f);
                          }
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>
                          <div style={{ fontWeight: 600 }}>{f.name}</div>
                          <div className="t-footnote c3">
                            {f.formNumber ? (
                              <>
                                <span className="mono">{f.formNumber}</span> · Rev {f.revision}
                                {f.issuer ? ` · ${f.issuer}` : ''}
                              </>
                            ) : (
                              (f.issuer ?? 'Not in the library')
                            )}
                          </div>
                        </td>
                        <td style={{ maxWidth: 340 }}>
                          <Badge tone={f.kind === 'problem' ? 'danger' : 'info'}>{f.kind === 'problem' ? categoryLabel(f.category) || 'Problem' : 'Form request'}</Badge>
                          {f.fieldKeys?.length ? <div className="t-footnote c2 mono ellipsis" style={{ marginTop: 4 }}>{f.fieldKeys.join(', ')}</div> : null}
                          {f.note && <div className="t-footnote c3 ellipsis" style={{ marginTop: 2 }}>{f.note}</div>}
                        </td>
                        <td className="t-footnote">
                          {who(f)}
                          <div className="c3">{fmtDay(f.createdOn)}</div>
                        </td>
                        <td>
                          <Badge tone={STATUS_TONE[f.status]}>{statusLabel(f.status)}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </section>
        </div>
      </div>
      {open && (
        <FeedbackSheet
          item={open}
          from={who(open)}
          revisions={open.formNumber ? templates.filter((t) => t.formNumber === open.formNumber).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)) : []}
          onEdit={open.templateId && templates.some((t) => t.id === open.templateId) ? () => navigate(`/admin/templates/${open.templateId}${open.fieldKeys?.[0] ? `?field=${encodeURIComponent(open.fieldKeys[0])}` : ''}`) : undefined}
          onClose={() => setOpen(undefined)}
          onSave={async (next) => {
            const saved = await services.feedback.update(next);
            setList((l) => l?.map((x) => (x.id === saved.id ? saved : x)));
            setOpen(undefined);
            toast.ok(`Marked ${statusLabel(saved.status).toLowerCase()}`);
          }}
        />
      )}
    </>
  );
}

function FeedbackSheet({
  item,
  from,
  revisions,
  onEdit,
  onSave,
  onClose,
}: {
  item: FormFeedback;
  from: string;
  revisions: { id: string; revision: string; status: string }[];
  onEdit?: () => void;
  onSave: (f: FormFeedback) => Promise<void>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<FeedbackStatus>(item.status);
  const [resolution, setResolution] = useState(item.resolution ?? '');
  const [fixedIn, setFixedIn] = useState(item.fixedInTemplateId ?? '');
  const [busy, setBusy] = useState(false);
  const needsRevision = status === 'fixed' && item.kind === 'problem' && revisions.length > 0 && !fixedIn;

  return (
    <Sheet
      title={item.kind === 'problem' ? 'Problem report' : 'Form request'}
      onClose={onClose}
      footer={
        <>
          {onEdit && (
            <Button variant="tinted" icon="pencil" onClick={onEdit}>
              Open in template editor
            </Button>
          )}
          <span className="spacer" />
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            busy={busy}
            disabled={needsRevision}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(resolveFeedback(item, status, { resolution, fixedInTemplateId: fixedIn || undefined }));
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not save');
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <div className="card card-pad stack" style={{ gap: 4 }}>
          <span className="t-headline">{item.name}</span>
          <span className="t-footnote c3">
            {item.formNumber ? (
              <>
                <span className="mono">{item.formNumber}</span> · Rev {item.revision} ·{' '}
              </>
            ) : null}
            {item.issuer ?? ''} {item.issuer ? '·' : ''} {from}, {fmtDay(item.createdOn)}
          </span>
          {item.category && <span className="t-callout">{categoryLabel(item.category)}</span>}
          {item.fieldKeys?.length ? (
            <span className="t-footnote">
              Fields: <span className="mono">{item.fieldKeys.join(', ')}</span>
            </span>
          ) : null}
          {item.note && <p className="t-callout c2" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{item.note}</p>}
          {item.detail?.otherForms?.length ? <span className="t-footnote c3">With {item.detail.otherForms.join(', ')} in the packet</span> : null}
          {item.detail?.accountType ? <span className="t-footnote c3">Account: {item.detail.accountType}</span> : null}
        </div>
        <Field label="Status" htmlFor="fb-status">
          <Select id="fb-status" value={status} onChange={(e) => setStatus(e.target.value as FeedbackStatus)}>
            {FEEDBACK_STATUSES.filter((s) => item.kind === 'problem' || s.value !== 'fixed').map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        {status === 'fixed' && item.kind === 'problem' && (
          <Field label="Fixed in" htmlFor="fb-rev" error={needsRevision ? 'Pick the revision that fixes it.' : undefined} help={revisions.length ? 'A mapping fix on the same revision counts: pick the reported one.' : 'This form is no longer in the library.'}>
            <Select id="fb-rev" value={fixedIn} onChange={(e) => setFixedIn(e.target.value)} disabled={!revisions.length}>
              <option value="">{revisions.length ? 'Choose a revision…' : 'No other revisions'}</option>
              {revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  Rev {r.revision} · {r.id === item.templateId ? 'the reported revision (mapping fixed)' : r.status}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Reply to the advisor" htmlFor="fb-res" optional help="They see this in Folium when it’s fixed or won’t be fixed.">
          <TextArea id="fb-res" rows={3} value={resolution} maxLength={2000} onChange={(e) => setResolution(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}
