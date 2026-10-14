import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { outputGate, summarize } from '../../domain/checks';
import { assignSigners, roleLabel, rolesForPacket, validateSigners } from '../../domain/signers';
import type { SignatureRequest, SignerAssignment, VerificationMethod } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { attachmentBytes, audit, fillPacket, packetAsOnePdf, saveDraft, unreachableAttachments, type SendSetup } from '../../state/actions';
import { useActingFor, useApp, useScope } from '../../state/store';
import { Avatar, Button, Empty, Field, IconButton, Menu, Select, SwitchRow, TextArea, TextInput, downloadBytes, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { NoClient } from '../common/NoClient';
import { ShareSheet } from '../common/ShareSheet';
import { Steps } from '../common/Steps';
import { usePacketView } from '../common/usePacket';

const AUTH_LABEL: Record<VerificationMethod, string> = { email: 'Email only', sms: 'SMS code', kba: 'ID questions (KBA)' };

export function SendScreen() {
  const client = useApp((s) => s.client);
  const contactId = useApp((s) => s.contactId);
  const packet = useApp((s) => s.packet);
  const setPacket = useApp((s) => s.setPacket);
  const clearPacket = useApp((s) => s.clearPacket);
  const me = useApp((s) => s.me);
  const firm = useApp((s) => s.firm);
  const requests = useApp((s) => s.requests);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const markUsed = useApp((s) => s.markUsed);
  const owner = useActingFor();
  const scope = useScope();
  const view = usePacketView();
  const services = useServices();
  const navigate = useNavigate();

  const existing = packet.requestId ? requests.find((r) => r.id === packet.requestId) : undefined;
  const needs = useMemo(() => (view && scope ? rolesForPacket(view.templates, scope) : []), [view, scope]);
  const [signers, setSigners] = useState<SignerAssignment[]>([]);
  const [anyOrder, setAnyOrder] = useState(false);
  const [ccMe, setCcMe] = useState(true);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [reminder, setReminder] = useState(String(owner?.defaultReminderDays ?? 3));
  const [expires, setExpires] = useState('60');
  const [busy, setBusy] = useState<string>();
  const [sharing, setSharing] = useState(false);
  /** Set the moment DocuSign accepts the envelope, so a failed save can never lead to a second send. */
  const [sentEnvelopeId, setSentEnvelopeId] = useState<string>();
  /** The draft row saved for this envelope, so a retry updates it instead of adding another. */
  const savedDraft = useRef<SignatureRequest>(undefined);

  // Seed signers and message once the packet is known, restoring what a draft saved.
  useEffect(() => {
    if (!scope || !view || signers.length) return;
    const assigned = assignSigners(needs, scope, owner?.defaultAuth ?? 'sms');
    if (existing && (existing.signers.length || existing.subject)) {
      // Saved signers (in their saved order) for roles the packet still needs, then any new role.
      const kept = [...existing.signers].sort((a, b) => a.order - b.order).filter((x) => assigned.some((a) => a.role === x.role));
      const added = assigned.filter((a) => !kept.some((x) => x.role === a.role));
      setSigners([...kept, ...added].map((x, k) => ({ ...x, order: k + 1 })));
      setSubject(existing.subject);
      setMessage(existing.message);
      setAnyOrder(existing.anyOrder);
      setCcMe(existing.ccs.length > 0);
      if (existing.reminderDays !== undefined) setReminder(String(existing.reminderDays));
      if (existing.expiresInDays) setExpires(String(existing.expiresInDays));
      return;
    }
    setSigners(assigned);
    const names = view.templates.map((t) => t.name.toLowerCase());
    setSubject(`Forms to sign: ${names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and more`}`.slice(0, 100));
    setMessage(
      `Hi ${scope.client.contact.firstname},\n\nHere ${view.templates.length === 1 ? 'is the form' : `are the ${view.templates.length} forms`} we talked about. They’re already filled in from what we have on file — please look them over and sign. Call me with any questions.\n\n${owner?.emailSignature ?? `${owner?.fullname ?? ''}\n${owner?.phone ?? ''}`}`,
    );
  }, [scope, view, needs, owner, existing, signers.length]);

  if (!client) return <NoClient />;
  if (!view || !packet.items.length) {
    return (
      <>
        <Toolbar title="Send" back={{ label: 'Review', to: '/review' }} />
        <div className="scroll" style={{ display: 'grid', placeItems: 'center' }}>
          <Empty icon="send" title="Nothing to send yet" action={<Button variant="filled" onClick={() => navigate('/')}>Find forms</Button>} />
        </div>
      </>
    );
  }

  const ordered = signers.map((s) => ({ ...s, order: anyOrder ? 1 : s.order }));
  const unreachable = unreachableAttachments(services, packet.attachments);
  const problems = validateSigners(ordered);
  const sum = summarize(view.checks);
  // Wet signing needs the same clean bill as DocuSign: no PDF and no request while checks are open.
  const inPersonGate = outputGate(view.checks, 'flatten');
  const tabCount = view.templates.reduce((n, t) => n + t.mapping.placements.filter((p) => ordered.some((s) => s.role === p.role)).length, 0);
  const blockers = [
    ...(sum.blocking ? [`${sum.blocking} pre-send ${sum.blocking === 1 ? 'check needs' : 'checks need'} attention`] : []),
    ...problems.map((p) => p.message),
    ...(!subject.trim() ? ['Add an email subject'] : []),
    ...unreachable.map((a) => `Re-attach ${a.name}`),
  ];

  function update(i: number, patch: Partial<SignerAssignment>) {
    setSigners((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }
  function move(i: number, d: number) {
    setSigners((list) => {
      const next = [...list];
      const j = i + d;
      if (j < 0 || j >= next.length) return list;
      [next[i], next[j]] = [next[j], next[i]];
      return next.map((s, k) => ({ ...s, order: k + 1 }));
    });
  }

  async function send() {
    if (!contactId || !me || !owner || !view || sentEnvelopeId) return;
    setBusy('send');
    let envelopeId: string;
    try {
      const docs = await fillPacket(services, view.fills, 'flatten');
      const attachments: { name: string; pdf: Uint8Array }[] = [];
      for (const a of packet.attachments) attachments.push({ name: a.name, pdf: await attachmentBytes(services, a) });
      ({ envelopeId } = await services.signing.send({
        documents: docs.map((d) => ({ name: d.fileName, pdf: d.pdf, placements: d.placements })),
        signers: ordered,
        ccs: ccList(),
        subject,
        message: firm?.disclosure ? `${message}\n\n${firm.disclosure}` : message,
        reminderDays: reminder === '0' ? undefined : Number(reminder),
        expiresInDays: Number(expires),
        attachments,
      }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'DocuSign didn’t accept the envelope');
      setBusy(undefined);
      return;
    }
    setSentEnvelopeId(envelopeId);
    await recordSent(envelopeId);
  }

  /** What a draft keeps of this screen, so it reopens set up the same way. */
  function sendSetup(): SendSetup {
    // 0 = never remind; the sent record stores that as no reminder.
    return { signers: ordered, ccs: ccList(), subject, message, anyOrder, reminderDays: Number(reminder), expiresInDays: Number(expires) };
  }

  function ccList() {
    if (!ccMe || !me || !owner) return [];
    return [{ name: owner.fullname, email: owner.email }, ...(me.systemuserid !== owner.systemuserid ? [{ name: me.fullname, email: me.email }] : [])];
  }

  /** Save the Signature Request for an envelope DocuSign already accepted. Safe to retry. */
  async function recordSent(envelopeId: string) {
    if (!contactId || !me || !owner || !view) return;
    setBusy('send');
    try {
      const draft = savedDraft.current ?? (await saveDraft({ services, packet, fills: view.fills, contactId, me, owner, existing }));
      savedDraft.current = draft;
      setPacket({ requestId: draft.id });
      const sent: SignatureRequest = {
        ...draft,
        status: 'Sent',
        envelopeId,
        sentOn: new Date().toISOString(),
        sentBy: me.fullname,
        signers: ordered.map((s) => ({ ...s, status: s.order === Math.min(...ordered.map((x) => x.order)) ? 'sent' : 'pending' })),
        ccs: ccList(),
        subject,
        message,
        anyOrder,
        reminderDays: reminder === '0' ? undefined : Number(reminder),
        expiresInDays: Number(expires),
        audit: [...draft.audit, audit(me, 'Sent with DocuSign', `${ordered.length} signer${ordered.length > 1 ? 's' : ''} · ${tabCount} tabs${me.systemuserid !== owner.systemuserid ? ` · for ${owner.fullname}` : ''}`)],
      };
      await services.requests.save(sent);
      markUsed(view.templates.map((t) => t.id));
      clearPacket();
      await refreshRequests();
      toast.ok(`Sent to ${ordered.map((s) => s.name.split(' ')[0]).join(' and ')}`);
      navigate('/requests');
    } catch (e) {
      toast.error(`DocuSign sent the envelope, but Folium couldn’t record it${e instanceof Error ? ` (${e.message})` : ''}. Don’t send again — use “Record it again”.`);
    } finally {
      setBusy(undefined);
    }
  }

  async function inPerson() {
    if (!contactId || !me || !owner || !view || !inPersonGate.allowed) return;
    setBusy('print');
    try {
      const bytes = await packetAsOnePdf(services, view.fills, 'flatten');
      downloadBytes(bytes, `${client!.contact.lastname} - sign in person.pdf`);
      const draft = await saveDraft({ services, packet, fills: view.fills, contactId, me, owner, existing, sendSetup: sendSetup() });
      await services.requests.save({ ...draft, inPerson: true, audit: [...draft.audit, audit(me, 'Downloaded to sign in person')] });
      setPacket({ requestId: draft.id });
      markUsed(view.templates.map((t) => t.id));
      await refreshRequests();
      toast.ok('Downloaded. Upload the wet-signed copy to OnBase when it’s back.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not prepare the PDF');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <Toolbar title="Signers & send" subtitle={`${client.contact.fullname} · ${view.templates.length} ${view.templates.length === 1 ? 'form' : 'forms'}`} back={{ label: 'Review', to: '/review' }}>
        <Steps current={2} />
        <Button variant="gray" icon="share" onClick={() => setSharing(true)}>
          Share
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page">
          <div className="split">
            <div className="stack-5" style={{ minWidth: 0 }}>
              <div>
                <h1 className="t-large">Who signs</h1>
                <p className="t-callout c2" style={{ marginTop: 4 }}>
                  Roles come from the form templates. Names and contact details come from Dynamics 365 — change them here for this envelope only.
                </p>
              </div>

              <section className="card" aria-label="Signers">
                {ordered.map((s, i) => {
                  const forms = view.templates.filter((t) => needs.find((n) => n.role === s.role)?.templateIds.includes(t.id));
                  const bad = problems.filter((p) => p.role === s.role);
                  return (
                    <div key={s.role} className="signer">
                      <span className="order" aria-label={`Signs ${anyOrder ? 'in any order' : `in position ${s.order}`}`}>{anyOrder ? <Icon name="dot" size={14} /> : s.order}</span>
                      <div className="stack" style={{ gap: 6 }}>
                        <div className="row">
                          <Avatar name={s.name || roleLabel(s.role)} size={26} alt={s.role !== 'Owner'} />
                          <TextInput aria-label={`${roleLabel(s.role)} name`} value={s.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Full name" style={{ fontWeight: 600 }} />
                        </div>
                        <span className="t-footnote c3">
                          {roleLabel(s.role)} · {forms.map((f) => f.formNumber).join(', ')}
                        </span>
                      </div>
                      <div className="stack" style={{ gap: 6 }}>
                        <TextInput aria-label={`${roleLabel(s.role)} email`} type="email" value={s.email} onChange={(e) => update(i, { email: e.target.value })} placeholder="Email" aria-invalid={bad.some((b) => b.message.includes('email')) || undefined} />
                        <TextInput aria-label={`${roleLabel(s.role)} mobile`} type="tel" value={s.phone ?? ''} onChange={(e) => update(i, { phone: e.target.value })} placeholder="Mobile (for SMS)" />
                      </div>
                      <Field label="Verify with" htmlFor={`auth-${i}`}>
                        <Select id={`auth-${i}`} value={s.auth} onChange={(e) => update(i, { auth: e.target.value as VerificationMethod })}>
                          {(['email', 'sms', 'kba'] as const).map((a) => (
                            <option key={a} value={a}>
                              {AUTH_LABEL[a]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Menu
                        trigger={(p) => <IconButton icon="ellipsis" label={`More for ${roleLabel(s.role)}`} {...p} />}
                        items={[
                          { label: 'Sign earlier', icon: 'chevronUp', onSelect: () => move(i, -1), disabled: i === 0 || anyOrder },
                          { label: 'Sign later', icon: 'chevronDown', onSelect: () => move(i, 1), disabled: i === ordered.length - 1 || anyOrder },
                        ]}
                      />
                      {bad.length > 0 && (
                        <p className="t-footnote c-danger" style={{ gridColumn: '2 / -1' }} role="alert">
                          {bad.map((b) => b.message).join(' ')}
                        </p>
                      )}
                    </div>
                  );
                })}
                <div className="signer cc">
                  <span className="order">
                    <Icon name="envelope" size={14} />
                  </span>
                  <div>
                    <div className="t-headline">{owner?.fullname}</div>
                    <div className="t-footnote c3">{me?.systemuserid !== owner?.systemuserid ? `Advisor · and you (${me?.fullname}) as assistant` : 'You'} · copy only</div>
                  </div>
                  <span className="t-callout c2">Gets the completed envelope</span>
                  <span />
                  <span />
                </div>
              </section>

              <div className="list">
                <SwitchRow label="Signers can sign in any order" detail="Otherwise DocuSign routes the envelope in the order above." checked={anyOrder} onChange={setAnyOrder} />
                <SwitchRow label="Send me a copy when it’s complete" checked={ccMe} onChange={setCcMe} />
              </div>

              <section className="card card-pad stack-4" aria-labelledby="msg-h">
                <h2 id="msg-h" className="t-title3">Message to {client.contact.firstname}</h2>
                <Field label="Email subject" htmlFor="subj" help={`${subject.length}/100`}>
                  <TextInput id="subj" value={subject} maxLength={100} onChange={(e) => setSubject(e.target.value)} />
                </Field>
                <Field label="Note" htmlFor="note" help={firm?.disclosure ? `Folium adds the firm disclosure: “${firm.disclosure}”` : undefined}>
                  <TextArea id="note" rows={7} value={message} onChange={(e) => setMessage(e.target.value)} />
                </Field>
                <div className="grid-2">
                  <Field label="Remind if unsigned after" htmlFor="rem">
                    <Select id="rem" value={reminder} onChange={(e) => setReminder(e.target.value)}>
                      <option value="2">2 days</option>
                      <option value="3">3 days</option>
                      <option value="5">5 days</option>
                      <option value="7">7 days</option>
                      <option value="0">Never</option>
                    </Select>
                  </Field>
                  <Field label="Expires after" htmlFor="exp">
                    <Select id="exp" value={expires} onChange={(e) => setExpires(e.target.value)}>
                      <option value="30">30 days</option>
                      <option value="60">60 days</option>
                      <option value="120">120 days</option>
                    </Select>
                  </Field>
                </div>
              </section>
            </div>

            <aside className="stack-4 sticky">
              <section className="card card-pad stack-4" aria-labelledby="ready-h">
                <h2 id="ready-h" className="t-title3">{blockers.length ? 'Almost ready' : 'Ready to send'}</h2>
                <div className="stack t-callout">
                  <div className="row"><span className="grow">Forms</span><strong className="tabular">{view.templates.length}</strong></div>
                  <div className="row"><span className="grow">Signers</span><strong className="tabular">{ordered.length}</strong></div>
                  <div className="row"><span className="grow">Signature tabs</span><strong className="tabular">{tabCount}</strong></div>
                  <div className="row"><span className="grow">Attachments</span><strong className={unreachable.length ? 'c-warn tabular' : 'tabular'}>{packet.attachments.length - unreachable.length}</strong></div>
                  <div className="row"><span className="grow">Checks</span><strong className={sum.blocking ? 'c-warn' : 'c-accent'}>{sum.blocking ? `${sum.blocking} to fix` : 'All passed'}</strong></div>
                </div>
                {blockers.length > 0 && (
                  <ul className="t-footnote c-warn stack" style={{ margin: 0, paddingLeft: 18 }}>
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
                {sentEnvelopeId ? (
                  <>
                    <div className="banner" role="alert">
                      <Icon name="warning" size={18} />
                      <span className="t-footnote">
                        DocuSign already has this envelope (<span className="mono">{sentEnvelopeId.slice(0, 8)}</span>). Folium just needs to save the record.
                      </span>
                    </div>
                    <Button variant="filled" size="lg" block icon="refresh" busy={busy === 'send'} onClick={() => recordSent(sentEnvelopeId)}>
                      Record it again
                    </Button>
                  </>
                ) : (
                  <Button variant="filled" size="lg" block icon="send" busy={busy === 'send'} disabled={blockers.length > 0} onClick={send}>
                    Send with DocuSign
                  </Button>
                )}
                {sum.blocking > 0 && (
                  <Button variant="tinted" block onClick={() => navigate('/review')}>
                    Fix in review
                  </Button>
                )}
                <Button variant="bordered" block icon="printer" busy={busy === 'print'} disabled={!inPersonGate.allowed} onClick={inPerson}>
                  Download to sign in person
                </Button>
              </section>
              <section className="banner info" style={{ alignItems: 'flex-start' }}>
                <Icon name="info" size={18} />
                <span className="t-footnote">
                  <strong>What happens next.</strong> DocuSign emails {ordered.length > 1 ? 'each signer' : client.contact.firstname}. Status shows on {client.contact.firstname}’s Forms tab. When it’s signed, download the completed PDF and upload it to OnBase as you do today, then tick it off in Folium.
                </span>
              </section>
            </aside>
          </div>
        </div>
      </div>
      {sharing && <ShareSheet onClose={() => setSharing(false)} sendSetup={sendSetup()} />}
    </>
  );
}
