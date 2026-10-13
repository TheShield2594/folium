import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { roleLabel } from '../../domain/signers';
import type { SignatureRequest } from '../../domain/types';
import { useServices } from '../../services';
import { audit } from '../../state/actions';
import { useApp } from '../../state/store';
import { Badge, Button, Field, IconButton, Menu, Select, Sheet, TextArea, TextInput, downloadBytes, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

export const fmtWhen = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
export const fmtDay = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

export function statusInfo(r: SignatureRequest): { label: string; tone: 'accent' | 'warn' | 'info' | 'danger' | undefined } {
  switch (r.status) {
    case 'Drafted':
      return { label: r.inPerson ? 'Printed to sign in person' : 'Draft', tone: undefined };
    case 'Sent':
      return { label: 'Sent, not opened', tone: 'warn' };
    case 'Viewed':
      return { label: 'Opened, not signed', tone: 'info' };
    case 'Signed':
      return r.uploadedToOnBase ? { label: 'Complete · in OnBase', tone: 'accent' } : { label: 'Signed · needs OnBase upload', tone: 'warn' };
    case 'Declined':
      return { label: 'Declined', tone: 'danger' };
    case 'Voided':
      return { label: 'Voided', tone: 'danger' };
  }
}

export function RequestCard({ req, showClient, clientName }: { req: SignatureRequest; showClient?: boolean; clientName?: string }) {
  const services = useServices();
  const me = useApp((s) => s.me);
  const users = useApp((s) => s.users);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const loadRequest = useApp((s) => s.loadRequest);
  const openContact = useApp((s) => s.openContact);
  const contactId = useApp((s) => s.contactId);
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string>();
  const [sheet, setSheet] = useState<'void' | 'correct'>();
  const r = req;

  const info = statusInfo(r);
  const signed = r.signers.filter((s) => s.status === 'signed').length;
  const order = ['Drafted', 'Sent', 'Viewed', 'Signed'] as const;
  const reached = r.status === 'Declined' || r.status === 'Voided' ? 1 : order.indexOf(r.status as (typeof order)[number]);
  const ownerName = users.find((u) => u.systemuserid === r.ownerId)?.fullname;

  async function save(next: SignatureRequest, msg?: string) {
    await services.requests.save(next);
    await refreshRequests();
    if (msg) toast.ok(msg);
  }

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(undefined);
    }
  }

  const download = () =>
    withBusy('dl', async () => {
      const { pdf, certificate } = await services.signing.downloadCompleted(r.envelopeId!);
      const base = `${clientName ?? 'Client'} - ${r.title} (signed)`;
      downloadBytes(pdf, `${base}.pdf`);
      downloadBytes(certificate, `${base} - certificate.pdf`);
      if (!r.audit.some((a) => a.action === 'Downloaded signed PDF')) await save({ ...r, audit: [...r.audit, audit(me, 'Downloaded signed PDF')] });
    });

  const markOnBase = (checked: boolean) =>
    withBusy('onbase', () =>
      save(
        {
          ...r,
          uploadedToOnBase: checked,
          uploadedBy: checked ? me?.fullname : undefined,
          uploadedOn: checked ? new Date().toISOString() : undefined,
          audit: [...r.audit, audit(me, checked ? 'Marked as uploaded to OnBase' : 'Unmarked OnBase upload')],
        },
        checked ? 'Marked as filed in OnBase' : undefined,
      ),
    );

  const refresh = () =>
    withBusy('status', async () => {
      const st = await services.signing.getStatus(r.envelopeId!);
      if (st.status === r.status) return toast.ok('No change yet');
      const events = [...r.audit];
      if (st.viewedOn && !r.viewedOn) events.push({ at: st.viewedOn, actor: r.signers[0]?.name ?? 'Signer', action: 'Viewed' });
      if (st.status === 'Signed') events.push({ at: st.signedOn ?? new Date().toISOString(), actor: 'DocuSign', action: 'Completed', detail: 'All signers signed' });
      await save(
        {
          ...r,
          status: st.status,
          viewedOn: st.viewedOn ?? r.viewedOn,
          signedOn: st.signedOn ?? r.signedOn,
          signers: r.signers.map((s) => {
            const rec = st.recipients.find((x) => x.role === s.role);
            return rec ? { ...s, status: rec.status === 'completed' ? 'signed' : rec.status === 'delivered' ? 'viewed' : rec.status === 'declined' ? 'declined' : 'sent', signedOn: rec.at ?? s.signedOn } : s;
          }),
          audit: events,
        },
        `Now: ${st.status.toLowerCase()}`,
      );
    });

  const resend = () =>
    withBusy('resend', async () => {
      await services.signing.resend(r.envelopeId!);
      await save({ ...r, lastReminderOn: new Date().toISOString(), audit: [...r.audit, audit(me, 'Resent')] }, 'Resent to signers who haven’t signed');
    });

  async function openDraft(asNew?: boolean) {
    if (r.contactId !== contactId) await openContact(r.contactId);
    loadRequest(asNew ? { ...r, id: '', values: r.values } : r);
    if (asNew) useApp.getState().setPacket({ requestId: undefined, sharedWith: [] });
    navigate('/review');
  }

  const steps = [
    { label: 'Drafted', at: r.createdOn, done: true },
    { label: 'Sent', at: r.sentOn, done: reached >= 1 && r.status !== 'Drafted' },
    { label: 'Viewed', at: r.viewedOn, done: reached >= 2 },
    { label: r.signers.length > 1 && r.status !== 'Signed' ? `Signed (${signed} of ${r.signers.length})` : 'Signed', at: r.signedOn, done: reached >= 3 },
    { label: 'In OnBase', at: r.uploadedOn, done: r.uploadedToOnBase, wait: r.status === 'Signed' && !r.uploadedToOnBase },
  ];

  return (
    <article className="card req" aria-labelledby={`req-${r.id}`}>
      <div className="req-head">
        <div style={{ minWidth: 0 }}>
          <h2 id={`req-${r.id}`} className="t-title3">
            {showClient && clientName ? `${clientName} · ` : ''}
            {r.title}
          </h2>
          <div className="t-footnote c3" style={{ marginTop: 4 }}>
            {r.documents.length} {r.documents.length === 1 ? 'form' : 'forms'}
            {r.sentOn ? ` · sent ${fmtDay(r.sentOn)} by ${r.sentBy}` : ` · started ${fmtDay(r.createdOn)} by ${r.preparedBy ?? r.sentBy}`}
            {ownerName && r.preparedById && r.preparedById !== r.ownerId ? ` for ${ownerName}` : ''}
            {r.lastReminderOn ? ` · reminded ${fmtDay(r.lastReminderOn)}` : ''}
            {r.envelopeId && (
              <>
                {' · '}
                <span className="mono" title={r.envelopeId}>
                  {r.envelopeId.slice(0, 8)}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="row">
          <Badge tone={info.tone}>{info.label}</Badge>
          <Menu
            trigger={(p) => <IconButton icon="ellipsis" label="More actions" {...p} />}
            items={[
              { label: 'Use these forms again', icon: 'copy', onSelect: () => openDraft(true) },
              ...(r.envelopeId && (r.status === 'Sent' || r.status === 'Viewed') ? [{ label: 'Check status now', icon: 'refresh' as const, onSelect: refresh }] : []),
              ...(r.draftFolderUrl ? [{ label: 'Open SharePoint folder', icon: 'folder' as const, onSelect: () => window.open(r.draftFolderUrl, '_blank', 'noopener') }] : []),
              ...(r.status === 'Drafted'
                ? [
                    { separator: true, label: '' },
                    {
                      label: 'Delete draft',
                      icon: 'trash' as const,
                      danger: true,
                      onSelect: () => withBusy('del', async () => (await services.requests.remove(r.id), await refreshRequests(), toast.ok('Draft deleted'))),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>

      {r.status !== 'Drafted' && (
        <ol className="steps" aria-label="Progress">
          {steps.map((s) => (
            <li key={s.label} className={s.done ? 'done' : s.wait ? 'wait' : undefined}>
              <i />
              <strong className={s.wait ? 'c-warn' : s.done ? undefined : 'c3'}>{s.label}</strong>
              <span>{s.done ? fmtWhen(s.at) : s.wait ? 'Waiting on you' : '—'}</span>
            </li>
          ))}
        </ol>
      )}

      {r.status === 'Signed' && (
        <div className="req-action">
          <span className="grow t-callout" style={{ minWidth: 240 }}>
            {r.uploadedToOnBase ? (
              <>
                Filed in OnBase by {r.uploadedBy} on {fmtDay(r.uploadedOn)}.
              </>
            ) : (
              <>Download the completed envelope (forms + certificate) and upload it to OnBase.</>
            )}
          </span>
          <Button variant={r.uploadedToOnBase ? 'gray' : 'filled'} icon="download" busy={busy === 'dl'} onClick={download}>
            Download signed PDF
          </Button>
          <label className="row t-callout" style={{ minHeight: 44, cursor: 'pointer', fontWeight: 600 }}>
            <input type="checkbox" className="check" checked={r.uploadedToOnBase} disabled={busy === 'onbase'} onChange={(e) => markOnBase(e.target.checked)} />
            Uploaded to OnBase
          </label>
        </div>
      )}

      {(r.status === 'Sent' || r.status === 'Viewed') && (
        <div className="row wrap">
          <Button variant="bordered" icon="refresh" busy={busy === 'status'} onClick={refresh}>
            Check status
          </Button>
          <Button variant="bordered" icon="send" busy={busy === 'resend'} onClick={resend}>
            Resend
          </Button>
          <Button variant="bordered" icon="pencil" onClick={() => setSheet('correct')}>
            Correct signer
          </Button>
          <Button variant="danger" icon="xCircle" onClick={() => setSheet('void')}>
            Void
          </Button>
        </div>
      )}

      {r.status === 'Drafted' && (
        <div className="row wrap">
          <Button variant="filled" icon="pencil" onClick={() => openDraft()}>
            Continue draft
          </Button>
          {r.sharedWith?.length ? (
            <span className="t-footnote c3">
              Shared with {users.filter((u) => r.sharedWith!.includes(u.systemuserid)).map((u) => u.fullname).join(', ')}
            </span>
          ) : null}
        </div>
      )}

      {(r.status === 'Voided' || r.status === 'Declined') && (
        <div className="row wrap">
          <span className="t-callout c2 grow">{r.voidedReason ? `Reason: ${r.voidedReason}` : 'This envelope can’t be signed.'}</span>
          <Button variant="tinted" icon="copy" onClick={() => openDraft(true)}>
            Start again from these forms
          </Button>
        </div>
      )}

      <details>
        <summary className="row t-callout c-accent" style={{ minHeight: 36, cursor: 'pointer', fontWeight: 600, listStyle: 'none' }}>
          <Icon name="chevronRight" size={14} strokeWidth={2.2} className="disclosure" />
          Forms, signers and audit trail
        </summary>
        <div className="grid-2" style={{ marginTop: 10 }}>
          <div className="stack-3">
            <div>
              <h3 className="t-caption c3" style={{ marginBottom: 6 }}>FORMS</h3>
              <ul className="stack t-callout" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {r.documents.map((d) => (
                  <li key={d.templateId}>
                    {d.name} <span className="t-footnote c3 mono">{d.formNumber} · Rev {d.revision}</span>
                  </li>
                ))}
              </ul>
            </div>
            {r.signers.length > 0 && (
              <div>
                <h3 className="t-caption c3" style={{ marginBottom: 6 }}>SIGNERS</h3>
                <ul className="stack t-callout" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {r.signers.map((s) => (
                    <li key={s.role} className="row">
                      <Icon name={s.status === 'signed' ? 'checkCircle' : 'circle'} size={16} className={s.status === 'signed' ? 'c-accent' : 'c3'} />
                      <span className="grow">
                        {s.name} <span className="t-footnote c3">· {roleLabel(s.role)} · {s.auth === 'sms' ? 'SMS code' : s.auth === 'kba' ? 'ID questions' : 'email'}</span>
                      </span>
                      <span className="t-footnote c3">{s.signedOn ? fmtWhen(s.signedOn) : s.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div>
            <h3 className="t-caption c3" style={{ marginBottom: 6 }}>AUDIT TRAIL</h3>
            <ol className="audit">
              {r.audit
                .slice()
                .reverse()
                .map((a, i) => (
                  <li key={i}>
                    <i />
                    <span>
                      <strong>{a.action}</strong> · {a.actor}
                      {a.detail && <span className="c3"> — {a.detail}</span>}
                    </span>
                    <span className="c3">{fmtWhen(a.at)}</span>
                  </li>
                ))}
            </ol>
          </div>
        </div>
      </details>

      {sheet === 'void' && (
        <VoidSheet
          onClose={() => setSheet(undefined)}
          onVoid={(reason) =>
            withBusy('void', async () => {
              await services.signing.void(r.envelopeId!, reason);
              await save({ ...r, status: 'Voided', voidedReason: reason, audit: [...r.audit, audit(me, 'Voided', reason)] }, 'Envelope voided');
              setSheet(undefined);
            })
          }
        />
      )}
      {sheet === 'correct' && (
        <CorrectSheet
          req={r}
          onClose={() => setSheet(undefined)}
          onSave={(role, change) =>
            withBusy('correct', async () => {
              await services.signing.correctRecipient(r.envelopeId!, role, change);
              await save(
                {
                  ...r,
                  signers: r.signers.map((s) => (s.role === role ? { ...s, ...change } : s)),
                  audit: [...r.audit, audit(me, 'Corrected signer', `${roleLabel(role)}: ${Object.values(change).filter(Boolean).join(', ')}`)],
                },
                'Signer corrected and envelope resent',
              );
              setSheet(undefined);
            })
          }
        />
      )}
    </article>
  );
}

function VoidSheet({ onClose, onVoid }: { onClose: () => void; onVoid: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Sheet
      title="Void this envelope?"
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" disabled={!reason.trim()} onClick={() => onVoid(reason.trim())}>
            Void envelope
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <p className="t-callout c2">Signers can no longer open it, and DocuSign tells them why. You can start again from the same forms.</p>
        <Field label="Reason" htmlFor="void-reason" help="Signers see this.">
          <TextArea id="void-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sent to an old email address" />
        </Field>
      </div>
    </Sheet>
  );
}

function CorrectSheet({ req, onClose, onSave }: { req: SignatureRequest; onClose: () => void; onSave: (role: string, change: { email?: string; phone?: string; name?: string }) => void }) {
  const pending = req.signers.filter((s) => s.status !== 'signed');
  const [role, setRole] = useState(pending[0]?.role ?? '');
  const s = req.signers.find((x) => x.role === role);
  const [email, setEmail] = useState(s?.email ?? '');
  const [phone, setPhone] = useState(s?.phone ?? '');
  return (
    <Sheet
      title="Correct a signer"
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => onSave(role, { email, phone: phone || undefined })}>
            Save and resend
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <Field label="Signer" htmlFor="c-role">
          <Select
            id="c-role"
            value={role}
            onChange={(e) => {
              const n = req.signers.find((x) => x.role === e.target.value);
              setRole(e.target.value);
              setEmail(n?.email ?? '');
              setPhone(n?.phone ?? '');
            }}
          >
            {pending.map((p) => (
              <option key={p.role} value={p.role}>
                {p.name} · {roleLabel(p.role)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Email" htmlFor="c-email">
          <TextInput id="c-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Mobile" htmlFor="c-phone" optional>
          <TextInput id="c-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <p className="t-footnote c3">This changes the envelope only. Update the contact in Dynamics 365 too if the old details are wrong there.</p>
      </div>
    </Sheet>
  );
}
