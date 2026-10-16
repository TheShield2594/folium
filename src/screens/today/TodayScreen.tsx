import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { runChecks } from '../../domain/checks';
import { firmGroup } from '../../domain/firms';
import { prefillPacket } from '../../domain/prefill';
import { clientPrompts, draftPrompt, greeting, relativeTime, requestPrompt, revisionPrompts, sortPrompts, type Prompt } from '../../domain/prompts';
import { isFinished, pipeline, STAGES } from '../../domain/requests';
import { START_CHIPS } from '../../domain/startPacket';
import type { ClientRecord, SignatureRequest } from '../../domain/types';
import { useServices } from '../../services';
import { ContactPicker } from '../../shell/ContactPicker';
import { Toolbar } from '../../shell/Shell';
import { latestLive, packetState, useActingFor, useApp } from '../../state/store';
import { Spinner, toast } from '../../ui/controls';
import { useOpenDraft } from '../common/useOpenDraft';
import { buildPacket } from './buildPacket';

/** How many clients Today reads for prompts. Enough for a book's recent work, without a long wait. */
const CLIENT_LIMIT = 30;

interface TodayData {
  requests: SignatureRequest[];
  clients: Record<string, ClientRecord>;
}

/**
 * The cross-client home: what needs the advisor today, what's out for signature, and
 * (when it's switched on) a way to start a packet by describing what the client needs.
 */
export function TodayScreen() {
  const services = useServices();
  const navigate = useNavigate();
  const me = useApp((s) => s.me);
  const users = useApp((s) => s.users);
  const groups = useApp((s) => s.groups);
  const firm = useApp((s) => s.firm);
  const firms = useApp((s) => s.firms);
  const templates = useApp((s) => s.templates);
  const packets = useApp((s) => s.packets);
  const client = useApp((s) => s.client);
  const clientRequests = useApp((s) => s.requests);
  const showAssist = useApp((s) => s.showAssist);
  const prompt = useApp((s) => s.startPrompt);
  const setPrompt = useApp((s) => s.setStartPrompt);
  const actingFor = useActingFor();
  const opener = useOpenDraft();
  const [data, setData] = useState<TodayData>();
  const [picking, setPicking] = useState(false);
  const [building, setBuilding] = useState(false);
  const now = useMemo(() => new Date(), []);

  // Everyone's requests the advisor may see, then the clients they're about plus the advisor's recent contacts.
  useEffect(() => {
    let live = true;
    (async () => {
      const [all, recent] = await Promise.all([services.requests.listMine(), services.crm.recentContacts().catch(() => [])]);
      const mine = all.filter((r) => r.ownerId === actingFor?.systemuserid || r.preparedById === me?.systemuserid || (r.sharedWith ?? []).includes(me?.systemuserid ?? ''));
      const owned = recent.filter((c) => !c.ownerid || c.ownerid === actingFor?.systemuserid).map((c) => c.contactid);
      const ids = [...new Set([...mine.map((r) => r.contactId), ...owned])].slice(0, CLIENT_LIMIT);
      const clients: Record<string, ClientRecord> = {};
      await Promise.all(ids.map(async (id) => {
        const c = await services.crm.getClient(id).catch(() => undefined);
        if (c) clients[id] = c;
      }));
      if (live) setData({ requests: mine, clients });
    })().catch((e) => {
      if (!live) return;
      setData({ requests: [], clients: {} });
      toast.error(e instanceof Error ? e.message : 'Could not load today’s work');
    });
    return () => {
      live = false;
    };
  }, [services, me, actingFor, clientRequests]);

  const name = (id: string) => data?.clients[id]?.contact.fullname ?? 'Client';

  const needs = useMemo(() => {
    if (!data || !actingFor) return [];
    const list: Prompt[] = [];
    for (const r of data.requests) {
      const c = data.clients[r.contactId];
      if (r.status === 'Drafted') {
        if (!c) continue;
        const p = draftPrompt(r, c.contact.fullname, draftBlocking(r, c));
        if (p) list.push(p);
      } else {
        const p = requestPrompt(r, name(r.contactId), now);
        if (p) list.push(p);
      }
    }
    for (const c of Object.values(data.clients)) if (!c.contact.ownerid || c.contact.ownerid === actingFor.systemuserid) list.push(...clientPrompts(c, now));
    list.push(...revisionPrompts(packets.filter((p) => p.owner === me?.fullname || p.owner === me?.systemuserid), templates, now));
    return sortPrompts(list);

    /** Blocking checks on a saved draft, as Review would count them. */
    function draftBlocking(r: SignatureRequest, c: ClientRecord): number {
      const owner = users.find((u) => u.systemuserid === r.ownerId) ?? actingFor!;
      const scope = { client: c, advisor: owner, firm, firms, firmGroup: firmGroup(owner, groups) };
      const items = r.documents
        .map((d) => ({ template: templates.find((t) => t.id === d.templateId)!, account: c.accounts.find((a) => a.accountid === d.accountId), itemId: d.itemId, copy: d.copy }))
        .filter((i) => i.template);
      if (items.length < r.documents.length) return 1;
      const fills = prefillPacket(items, scope, r.values);
      return runChecks(fills, { scope, values: r.values, latestFor: (n) => latestLive(templates, n), state: packetState({ state: r.state }, c), licensedStates: owner.licensedStates }).filter((x) => x.level === 'block').length;
    }
  }, [data, actingFor, users, groups, firm, firms, templates, packets, me, now]);

  const inflight = useMemo(
    () =>
      (data?.requests ?? [])
        .filter((r) => r.status !== 'Drafted' && !isFinished(r))
        .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)))
        .slice(0, 3),
    [data],
  );

  async function start(text = prompt) {
    if (!client) return setPicking(true);
    if (!text.trim()) return toast.error('Describe what the client needs, or pick a suggestion.');
    setBuilding(true);
    try {
      const added = await buildPacket(text);
      if (added?.length) {
        setPrompt('');
        navigate('/review');
      }
    } finally {
      setBuilding(false);
    }
  }

  async function act(p: Prompt) {
    const app = useApp.getState();
    try {
      if (p.kind === 'revision') return navigate('/packets');
      if (p.kind === 'draft') {
        const req = data?.requests.find((r) => r.id === p.requestId);
        if (req) opener.open(req);
        return;
      }
      if (!p.contactId) return;
      if (p.contactId !== app.contactId && !(await app.openContact(p.contactId))) return;
      if (p.kind === 'request') return navigate('/requests');
      if (p.intent) {
        if (!showAssist) return navigate('/');
        const added = await buildPacket(p.intent);
        if (added?.length) navigate('/review');
      }
    } catch {
      toast.error('That client isn’t available to you.');
    }
  }

  const first = (me?.fullname ?? '').split(' ')[0];

  return (
    <>
      <Toolbar title="Today" />
      <div className="scroll">
        <div className="today">
          <header className="stack" style={{ gap: 4 }}>
            <span className="t-callout c2">{now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
            <h1 className="today-title">
              {greeting(now)}
              {first ? `, ${first}` : ''}
            </h1>
          </header>

          {showAssist && (
            <section className="start-packet" aria-labelledby="start-h">
              <div className="start-body">
                <div className="row wrap" style={{ gap: 10 }}>
                  <h2 id="start-h">Start a packet</h2>
                  <button type="button" className="client-pill" onClick={() => setPicking(true)} aria-label={client ? `For ${client.contact.fullname}. Change client` : 'Choose a client'}>
                    <i className="dot xs" />
                    {client ? `${client.contact.fullname} · from Dynamics 365` : 'Choose a client'}
                  </button>
                </div>
                <textarea
                  className="start-input"
                  rows={2}
                  value={prompt}
                  aria-label="What does the client need?"
                  placeholder={`Describe what the client needs, e.g. ${client?.contact.firstname ?? 'Priya'} is rolling a Fidelity 401(k) into a Praxis IRA`}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start();
                  }}
                />
                <div className="row wrap" style={{ gap: 8 }}>
                  {START_CHIPS.map((c) => (
                    <button key={c} type="button" className="chip" onClick={() => setPrompt(c)}>
                      {c}
                    </button>
                  ))}
                  <button type="button" className="btn btn-filled build-btn" disabled={building} onClick={() => start()}>
                    {building && <span className="spinner" style={{ width: 14, height: 14, borderTopColor: 'currentColor' }} />}
                    Build packet
                  </button>
                </div>
              </div>
              <div className="start-art" aria-hidden="true" />
            </section>
          )}

          <div className="today-cols">
            <section className="stack-3" aria-labelledby="needs-h">
              <div className="today-head">
                <h2 id="needs-h">Needs you</h2>
                {data && <span className="t-callout c2">{needs.length} {needs.length === 1 ? 'item' : 'items'}</span>}
              </div>
              <div className="card today-list">
                {!data ? (
                  <div className="row" style={{ justifyContent: 'center', padding: 32 }}>
                    <Spinner />
                  </div>
                ) : needs.length === 0 ? (
                  <p className="today-empty">Nothing waiting on you. Nice.</p>
                ) : (
                  needs.map((p) => (
                    <button key={p.id} type="button" className="need-row" onClick={() => act(p)}>
                      <i className={`dot ${p.tone}`} />
                      <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <strong>{p.title}</strong>
                        <span className="t-callout c2">{p.detail}</span>
                      </span>
                      <span className="need-action">{p.action}</span>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="stack-3" aria-labelledby="out-h">
              <div className="today-head">
                <h2 id="out-h">Out for signature</h2>
                <button type="button" className="link-btn" onClick={() => navigate('/requests?scope=all')}>
                  All requests
                </button>
              </div>
              <div className="card today-list">
                {!data ? (
                  <div className="row" style={{ justifyContent: 'center', padding: 32 }}>
                    <Spinner />
                  </div>
                ) : inflight.length === 0 ? (
                  <p className="today-empty">No requests out right now.</p>
                ) : (
                  inflight.map((r) => {
                    const stages = pipeline(r);
                    const at = stages.lastIndexOf('now');
                    return (
                      <div key={r.id} className="out-row">
                        <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                          <strong className="ellipsis">{name(r.contactId)}</strong>
                          <span className="t-callout c2" style={{ whiteSpace: 'nowrap' }}>
                            {STAGES[at >= 0 ? at : 4]} · {relativeTime(lastActivity(r), now)}
                          </span>
                        </div>
                        <Pipeline r={r} />
                        <span className="t-callout c2 ellipsis">
                          {r.title} · {r.documents.length} {r.documents.length === 1 ? 'form' : 'forms'}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
      {picking && <ContactPicker onClose={() => setPicking(false)} />}
      {opener.sheet}
    </>
  );
}

/** Five 4px bars: grass for stages passed, royal for the current one, dashed pumpkin while OnBase waits on the advisor. */
export function Pipeline({ r }: { r: Parameters<typeof pipeline>[0] }) {
  const stages = pipeline(r);
  return (
    <ol className="pipeline" aria-label={`Progress: ${STAGES.filter((_, i) => stages[i] !== 'todo' && stages[i] !== 'wait').at(-1)}`}>
      {stages.map((s, i) => (
        <li key={STAGES[i]} className={s} title={STAGES[i]} />
      ))}
    </ol>
  );
}

const lastActivity = (r: SignatureRequest) => r.audit.at(-1)?.at ?? r.signedOn ?? r.viewedOn ?? r.sentOn ?? r.createdOn;
