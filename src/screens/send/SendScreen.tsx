import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { attachmentLimits, attachmentsMB, checkAttachments, MB, outputGate, summarize } from '../../domain/checks';
import { fillSubject, fillTokens, listForms, SUBJECT_MAX } from '../../domain/format';
import { relatedPeople } from '../../domain/prefill';
import { canDownload, sharingAllowed } from '../../domain/policy';
import { expiresOnFrom, retentionDays } from '../../domain/requests';
import { accessCodeWarnings, assignSigners, envelopeSigners, generateAccessCode, recordedSigners, roleLabel, rolesForPacket, validateSigners } from '../../domain/signers';
import type { SignatureRequest, SignerAssignment, VerificationMethod } from '../../domain/types';
import { useServices } from '../../services';
import { classifyError, isConsentRequired } from '../../services/errors';
import { DOCUSIGN } from '../../services/power/config';
import { Toolbar } from '../../shell/Shell';
import { attachmentBytes, audit, fillPacket, packetAsOnePdf, releaseEnvelope, saveDraft, unreachableAttachments, type SendSetup } from '../../state/actions';
import { useActingFor, useApp, useScope, type SendState } from '../../state/store';
import { Avatar, Button, Empty, Field, IconButton, Menu, Select, Sheet, SwitchRow, TextArea, TextInput, downloadBytes, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { NoClient } from '../common/NoClient';
import { ShareSheet } from '../common/ShareSheet';
import { Steps } from '../common/Steps';
import { usePacketView } from '../common/usePacket';

const AUTH_LABEL: Record<VerificationMethod, string> = { email: 'Email only', sms: 'SMS code', phone: 'Phone call', kba: 'ID questions (KBA)' };

export function SendScreen() {
  const client = useApp((s) => s.client);
  const contactId = useApp((s) => s.contactId);
  const packet = useApp((s) => s.packet);
  const setPacket = useApp((s) => s.setPacket);
  const clearPacket = useApp((s) => s.clearPacket);
  const me = useApp((s) => s.me);
  const firm = useApp((s) => s.firm);
  const policy = useApp((s) => s.policy);
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
  const people = useMemo(() => (scope ? relatedPeople(scope.client) : []), [scope]);
  const [signers, setSigners] = useState<SignerAssignment[]>([]);
  // The sender's own default, else the advisor's they work for, else the firm's. The switch still decides per envelope.
  const defaultAnyOrder = me?.defaultAnyOrder ?? owner?.defaultAnyOrder ?? firm?.sending?.defaultAnyOrder ?? false;
  const [anyOrder, setAnyOrder] = useState(defaultAnyOrder);
  const [ccMe, setCcMe] = useState(true);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [reminder, setReminder] = useState(String(owner?.defaultReminderDays ?? 3));
  const [expires, setExpires] = useState('60');
  const [busy, setBusy] = useState<string>();
  const [sharing, setSharing] = useState(false);
  /** Access codes by role. Only on this screen and in the envelope: never saved with the request. */
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [codeFor, setCodeFor] = useState<string>();
  /**
   * Where a send got to. Kept on the packet (and so in the session journal), not in this
   * screen, so a reload or a trip to another screen can never lead to a second envelope.
   */
  const sendState = packet.send;
  const setSend = (send: SendState | undefined) => setPacket({ send });
  /** Bytes of the packet's forms (the blank PDFs; filling adds little), for the envelope size. */
  const [formBytes, setFormBytes] = useState<number>();
  const templateIds = view?.templates.map((t) => t.id).join('|');
  useEffect(() => {
    if (!view) return;
    let live = true;
    Promise.all(view.templates.map((t) => services.templates.getPdf(t).then((b) => b.byteLength)))
      .then((sizes) => live && setFormBytes(sizes.reduce((a, b) => a + b, 0)))
      .catch(() => live && setFormBytes(undefined));
    return () => {
      live = false;
    };
    // Only when the forms change, not on every keystroke.
  }, [templateIds, services]);
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
    setAnyOrder(defaultAnyOrder);
    const ctx = { client: scope.client.contact, advisor: owner ?? {}, firm, forms: view.templates.map((t) => t.name) };
    const sending = firm?.sending;
    setSubject(sending?.subjectTemplate ? fillSubject(sending.subjectTemplate, ctx) : `Forms to sign: ${listForms(view.templates.map((t) => t.name.toLowerCase()))}`.slice(0, SUBJECT_MAX));
    setMessage(
      sending?.messageTemplate
        ? fillTokens(sending.messageTemplate, ctx)
        : `Hi ${scope.client.contact.firstname},\n\nHere ${view.templates.length === 1 ? 'is the form' : `are the ${view.templates.length} forms`} we talked about. They’re already filled in from what we have on file — please look them over and sign. Call me with any questions.\n\n${owner?.emailSignature ?? `${owner?.fullname ?? ''}\n${owner?.phone ?? ''}`}`,
    );
  }, [scope, view, needs, owner, existing, signers.length, firm, defaultAnyOrder]);

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
  const codeWarnings = accessCodeWarnings(ordered, codes);
  const sum = summarize(view.checks);
  // Wet signing needs the same clean bill as DocuSign: no PDF and no request while checks are open.
  const inPersonGate = outputGate(view.checks, 'flatten');
  const tabCount = view.templates.reduce((n, t) => n + t.mapping.placements.filter((p) => ordered.some((s) => s.role === p.role)).length, 0);
  const limits = attachmentLimits(policy);
  const attachmentChecks = checkAttachments(packet.attachments, limits);
  const attachedMB = attachmentsMB(packet.attachments);
  const envelopeMB = formBytes === undefined ? undefined : formBytes / MB + attachedMB;
  // Users and Assistants can't edit a locked note; Admins can. The disclosure is still added.
  const messageLocked = !!policy.lockMessage && me?.role !== 'Admin';
  const canShare = sharingAllowed(policy);
  const blockers = [
    ...(sum.blocking ? [`${sum.blocking} pre-send ${sum.blocking === 1 ? 'check needs' : 'checks need'} attention`] : []),
    ...attachmentChecks.map((c) => `${c.title}. ${c.detail}`),
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

  /** The request row this packet is saved as, if any, read fresh so a retry never adds a second row. */
  async function currentRow(): Promise<SignatureRequest | undefined> {
    if (savedDraft.current) return savedDraft.current;
    if (existing) return existing;
    return packet.requestId ? services.requests.get(packet.requestId) : undefined;
  }

  /**
   * Step 1: create the envelope as a DocuSign draft (nothing reaches the signers yet) and
   * note its ID on the request row. Step 2 (`finishSend`) releases it.
   */
  async function send() {
    if (!contactId || !me || !owner || !view || sendState) return;
    setBusy('send');
    let docs: Awaited<ReturnType<typeof fillPacket>>;
    const attachments: { name: string; pdf: Uint8Array }[] = [];
    try {
      docs = await fillPacket(services, view.fills, 'flatten');
      for (const a of packet.attachments) attachments.push({ name: a.name, pdf: await attachmentBytes(services, a) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not prepare the PDFs');
      setBusy(undefined);
      return;
    }
    let envelopeId: string;
    try {
      ({ envelopeId } = await services.signing.create({
        documents: docs.map((d) => ({ name: d.fileName, pdf: d.pdf, placements: d.placements })),
        signers: envelopeSigners(ordered, codes),
        ccs: ccList(),
        subject,
        message: firm?.disclosure ? `${message}\n\n${firm.disclosure}` : message,
        reminderDays: reminder === '0' ? undefined : Number(reminder),
        expiresInDays: Number(expires),
        attachments,
      }));
    } catch (e) {
      const kind = classifyError(e);
      // A lost reply may still have created a (draft) envelope. Don't invite a second one.
      if (kind === 'timeout' || kind === 'offline' || kind === 'server') setSend({ phase: 'unknown', at: new Date().toISOString() });
      else if (isConsentRequired(e)) consentToast();
      else toast.error(e instanceof Error ? e.message : 'DocuSign didn’t accept the envelope');
      setBusy(undefined);
      return;
    }
    setSend({ phase: 'created', envelopeId, at: new Date().toISOString() });
    try {
      const row = await saveDraft({ services, packet, fills: view.fills, contactId, me, owner, existing: await currentRow(), sendSetup: sendSetup(), retentionDays: retentionDays(policy) });
      // Mid-send: retention never deletes it (DocuSign holds the envelope), so no draft expiry.
      const marked = await services.requests.save({ ...row, envelopeId, envelopePhase: 'created', expiresOn: undefined, audit: [...row.audit, audit(me, 'Envelope created in DocuSign', 'Not sent yet')] });
      savedDraft.current = marked;
      setPacket({ requestId: marked.id, formsUpdated: undefined, dirty: false });
    } catch {
      // The envelope ID is on the packet and in the session journal; carry on.
    }
    await finishSend(envelopeId, false);
  }

  /** Step 2: release the draft envelope. When resuming, ask DocuSign first so it never goes twice. */
  async function finishSend(envelopeId: string, resuming: boolean) {
    setBusy('send');
    try {
      await releaseEnvelope(services.signing, envelopeId, resuming);
    } catch (e) {
      toast.error(`DocuSign has the envelope but didn’t confirm sending it${e instanceof Error ? ` (${e.message})` : ''}. Use “Finish sending”: it checks first, so it won’t send twice.`);
      setBusy(undefined);
      return;
    }
    setSend({ phase: 'sent', envelopeId, at: new Date().toISOString() });
    await recordSent(envelopeId);
  }

  /** What a draft keeps of this screen, so it reopens set up the same way. */
  function sendSetup(): SendSetup {
    // 0 = never remind; the sent record stores that as no reminder.
    return { signers: ordered, ccs: ccList(), subject, message, anyOrder, reminderDays: Number(reminder), expiresInDays: Number(expires) };
  }

  function consentToast() {
    if (DOCUSIGN.consentUrl) toast.ok('DocuSign needs your permission for Folium before it can send. Grant it, then send again.', { label: 'Open DocuSign', onClick: () => window.open(DOCUSIGN.consentUrl, '_blank', 'noopener') });
    else toast.error('DocuSign needs permission for Folium before it can send. Ask an administrator to grant consent for the Folium DocuSign app.');
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
      const draft = savedDraft.current ?? (await saveDraft({ services, packet, fills: view.fills, contactId, me, owner, existing: await currentRow(), retentionDays: retentionDays(policy) }));
      savedDraft.current = draft;
      setPacket({ requestId: draft.id });
      const sentOn = new Date().toISOString();
      const sent: SignatureRequest = {
        ...draft,
        status: 'Sent',
        envelopeId,
        envelopePhase: undefined,
        sentOn,
        expiresOn: expiresOnFrom(sentOn, Number(expires)),
        sentBy: me.fullname,
        signers: recordedSigners(ordered, codes),
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
      const now = ordered.filter((s) => s.inSession);
      toast.ok(now.length ? `Sent. Use “Sign now” on the request to open DocuSign for ${now.map((s) => s.name.split(' ')[0]).join(' and ')}.` : `Sent to ${ordered.map((s) => s.name.split(' ')[0]).join(' and ')}`);
      navigate('/requests');
    } catch (e) {
      toast.error(`DocuSign sent the envelope, but Folium couldn’t record it${e instanceof Error ? ` (${e.message})` : ''}. Don’t send again — use “Record it again”.`);
    } finally {
      setBusy(undefined);
    }
  }

  async function inPerson() {
    if (!contactId || !me || !owner || !view || !inPersonGate.allowed || sendState || !canDownload('inPerson', policy)) return;
    setBusy('print');
    try {
      const bytes = await packetAsOnePdf(services, view.fills, 'flatten');
      downloadBytes(bytes, `${client!.contact.lastname} - sign in person.pdf`);
      const draft = await saveDraft({ services, packet, fills: view.fills, contactId, me, owner, existing, sendSetup: sendSetup(), retentionDays: retentionDays(policy) });
      // A record of a printed packet, not abandoned work: retention doesn't delete it.
      await services.requests.save({ ...draft, inPerson: true, expiresOn: undefined, audit: [...draft.audit, audit(me, 'Downloaded to sign in person')] });
      setPacket({ requestId: draft.id, formsUpdated: undefined, dirty: false });
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
        {canShare && (
          <Button variant="gray" icon="share" onClick={() => setSharing(true)}>
            Share
          </Button>
        )}
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
                          {roleLabel(s.role)} · {[...new Set(forms.map((f) => f.formNumber))].join(', ')}
                        </span>
                        {people.length > 1 && (
                          <Select
                            aria-label={`Choose the ${roleLabel(s.role)}`}
                            value=""
                            onChange={(e) => {
                              const p = people[Number(e.target.value)];
                              if (p) update(i, { name: p.name, email: p.contact?.emailaddress1 ?? '', phone: p.contact?.mobilephone || (s.auth === 'phone' ? p.contact?.telephone1 : undefined) || undefined, contactId: p.contactId });
                            }}
                            style={{ minHeight: 30, fontSize: 13 }}
                          >
                            <option value="">Choose person…</option>
                            {people.map((p, k) => (
                              <option key={`${p.contactId}-${p.role}`} value={String(k)}>
                                {p.name} · {p.role}
                              </option>
                            ))}
                          </Select>
                        )}
                        {(codes[s.role] || s.inSession) && (
                          <span className="row wrap" style={{ gap: 4 }}>
                            {codes[s.role] && (
                              <button type="button" className="chip" onClick={() => setCodeFor(s.role)} aria-label={`${roleLabel(s.role)} access code is set. Change it`}>
                                <Icon name="lock" size={12} /> Access code
                              </button>
                            )}
                            {s.inSession && (
                              <span className="badge badge-info">
                                <Icon name="signature" size={12} /> Signs now, with you
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="stack" style={{ gap: 6 }}>
                        <TextInput aria-label={`${roleLabel(s.role)} email`} type="email" value={s.email} onChange={(e) => update(i, { email: e.target.value })} placeholder="Email" aria-invalid={bad.some((b) => b.message.includes('email')) || undefined} />
                        <TextInput aria-label={`${roleLabel(s.role)} mobile`} type="tel" value={s.phone ?? ''} onChange={(e) => update(i, { phone: e.target.value })} placeholder={s.auth === 'phone' ? 'Phone (for the call)' : 'Mobile (for SMS)'} />
                      </div>
                      <Field label="Verify with" htmlFor={`auth-${i}`}>
                        <Select id={`auth-${i}`} value={s.auth} onChange={(e) => update(i, { auth: e.target.value as VerificationMethod })}>
                          {(['email', 'sms', 'phone', 'kba'] as const).map((a) => (
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
                          { separator: true, label: '' },
                          { label: codes[s.role] ? 'Change access code…' : 'Access code…', icon: 'lock', onSelect: () => setCodeFor(s.role) },
                          s.inSession
                            ? { label: 'Send by email instead', icon: 'envelope', onSelect: () => update(i, { inSession: undefined }) }
                            : { label: 'Sign now, with me (in session)', icon: 'signature', onSelect: () => update(i, { inSession: true }) },
                        ]}
                      />
                      {bad.length > 0 && (
                        <p className="t-footnote c-danger" style={{ gridColumn: '2 / -1' }} role="alert">
                          {bad.map((b) => b.message).join(' ')}
                        </p>
                      )}
                      {codeWarnings.some((w) => w.role === s.role) && (
                        <p className="t-footnote c-warn" style={{ gridColumn: '2 / -1' }}>
                          {codeWarnings.filter((w) => w.role === s.role).map((w) => w.message).join(' ')}
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
                <Field
                  label="Note"
                  htmlFor="note"
                  help={[messageLocked ? 'Set by your firm.' : '', firm?.disclosure ? `Folium adds the firm disclosure: “${firm.disclosure}”` : ''].filter(Boolean).join(' ') || undefined}
                >
                  <TextArea id="note" rows={7} value={message} readOnly={messageLocked} aria-readonly={messageLocked || undefined} onChange={(e) => setMessage(e.target.value)} />
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
                  <div className="row">
                    <span className="grow">Attachments</span>
                    <strong className={unreachable.length || attachmentChecks.length ? 'c-warn tabular' : 'tabular'}>
                      {packet.attachments.length - unreachable.length} of {limits.maxFiles} · {attachedMB.toFixed(1)} of {limits.maxMB} MB
                    </strong>
                  </div>
                  <div className="row" title="Forms and supporting documents together. DocuSign receives about a third more once they’re encoded.">
                    <span className="grow">Envelope size</span>
                    <strong className="tabular">{envelopeMB === undefined ? '—' : `${envelopeMB < 0.1 ? '< 0.1' : envelopeMB.toFixed(1)} MB`}</strong>
                  </div>
                  <div className="row"><span className="grow">Checks</span><strong className={sum.blocking ? 'c-warn' : 'c-accent'}>{sum.blocking ? `${sum.blocking} to fix` : 'All passed'}</strong></div>
                </div>
                {blockers.length > 0 && (
                  <ul className="t-footnote c-warn stack" style={{ margin: 0, paddingLeft: 18 }}>
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
                {sendState?.phase === 'sent' && sendState.envelopeId ? (
                  <>
                    <div className="banner" role="alert">
                      <Icon name="warning" size={18} />
                      <span className="t-footnote">
                        DocuSign already sent this envelope (<span className="mono">{sendState.envelopeId.slice(0, 8)}</span>). Folium just needs to save the record.
                      </span>
                    </div>
                    <Button variant="filled" size="lg" block icon="refresh" busy={busy === 'send'} onClick={() => recordSent(sendState.envelopeId!)}>
                      Record it again
                    </Button>
                  </>
                ) : sendState?.phase === 'created' && sendState.envelopeId ? (
                  <>
                    <div className="banner" role="alert">
                      <Icon name="warning" size={18} />
                      <span className="t-footnote">
                        DocuSign has this envelope (<span className="mono">{sendState.envelopeId.slice(0, 8)}</span>) but hasn’t confirmed sending it. Finishing checks with DocuSign first, so it won’t go twice.
                      </span>
                    </div>
                    <Button variant="filled" size="lg" block icon="send" busy={busy === 'send'} onClick={() => finishSend(sendState.envelopeId!, true)}>
                      Finish sending
                    </Button>
                  </>
                ) : sendState?.phase === 'unknown' ? (
                  <>
                    <div className="banner" role="alert">
                      <Icon name="warning" size={18} />
                      <span className="t-footnote">
                        We couldn’t confirm the send. Check {client.contact.firstname}’s Signature requests (and DocuSign’s Drafts) before sending again. An unconfirmed envelope stays a draft in DocuSign and never reaches the signers.
                      </span>
                    </div>
                    <Button variant="tinted" block onClick={() => navigate('/requests')}>
                      Check Signature requests
                    </Button>
                    <Button variant="bordered" block onClick={() => setSend(undefined)}>
                      I’ve checked. Let me send again
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
                {canDownload('inPerson', policy) && (
                  <Button variant="bordered" block icon="printer" busy={busy === 'print'} disabled={!inPersonGate.allowed || !!sendState} onClick={inPerson}>
                    Download to sign in person
                  </Button>
                )}
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
      {sharing && canShare && <ShareSheet onClose={() => setSharing(false)} sendSetup={sendSetup()} />}
      {codeFor && (
        <AccessCodeSheet
          name={ordered.find((s) => s.role === codeFor)?.name || roleLabel(codeFor)}
          value={codes[codeFor] ?? ''}
          onSave={(code) => (setCodes((c) => ({ ...c, [codeFor]: code })), setCodeFor(undefined))}
          onClose={() => setCodeFor(undefined)}
        />
      )}
    </>
  );
}

/** Set a signer's DocuSign access code. The code stays on this screen and in the envelope only. */
function AccessCodeSheet({ name, value, onSave, onClose }: { name: string; value: string; onSave: (code: string) => void; onClose: () => void }) {
  const [code, setCode] = useState(value);
  const trimmed = code.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 4;
  return (
    <Sheet
      title={`Access code for ${name}`}
      onClose={onClose}
      footer={
        <>
          {value && (
            <Button variant="gray" onClick={() => onSave('')}>
              Remove code
            </Button>
          )}
          <span className="spacer" />
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" disabled={!trimmed || tooShort} onClick={() => onSave(trimmed)}>
            Use this code
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <p className="t-callout c2">DocuSign asks {name.split(' ')[0]} for this code before showing the forms. It works with any verification method.</p>
        <Field label="Access code" htmlFor="ac-code" error={tooShort ? 'Use at least 4 characters.' : undefined}>
          <div className="row" style={{ gap: 6 }}>
            <TextInput id="ac-code" className="mono" value={code} maxLength={50} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
            <Button variant="tinted" icon="refresh" onClick={() => setCode(generateAccessCode())}>
              Generate
            </Button>
          </div>
        </Field>
        <div className="banner">
          <Icon name="info" size={18} />
          <span className="t-footnote">Give the code to the client by phone or in person, never by email. Folium doesn’t keep it: note it now. If you save a draft instead of sending, set it again before you send.</span>
        </div>
      </div>
    </Sheet>
  );
}
