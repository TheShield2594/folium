import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { expiryInfo, isFinished } from '../../domain/requests';
import type { SignatureRequest } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Empty, Segmented, Spinner, toast } from '../../ui/controls';
import { RequestCard } from './RequestCard';

type Scope = 'client' | 'all';
type Filter = 'open' | 'waiting' | 'expiring' | 'onbase' | 'done' | 'all';

/** Open requests within DocuSign's 7-day warning, or already past their expiry date. */
const expiring = (r: SignatureRequest) => { const e = expiryInfo(r); return !!e && (e.soon || e.pastDue); };

export function RequestsScreen() {
  const client = useApp((s) => s.client);
  const clientRequests = useApp((s) => s.requests);
  const me = useApp((s) => s.me);
  const actingForId = useApp((s) => s.actingForId);
  const services = useServices();
  // Opened from Today's "All requests", it starts on every client.
  const [params] = useSearchParams();
  /** The request just sent, highlighted in Mist as it arrives. */
  const fresh = (useLocation().state as { fresh?: string } | null)?.fresh;
  const [scope, setScope] = useState<Scope>(client && params.get('scope') !== 'all' ? 'client' : 'all');
  const [filter, setFilter] = useState<Filter>('open');
  const [all, setAll] = useState<SignatureRequest[]>();
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (scope !== 'all') return;
    let live = true;
    services.requests.listMine().then(async (list) => {
      const mine = list.filter((r) => r.ownerId === actingForId || r.preparedById === me?.systemuserid || me?.role === 'Admin');
      const ids = [...new Set(mine.map((r) => r.contactId))];
      const n: Record<string, string> = {};
      await Promise.all(ids.map(async (id) => (n[id] = (await services.crm.getClient(id).catch(() => undefined))?.contact.fullname ?? 'Client')));
      if (live) {
        setNames(n);
        setAll(mine);
      }
    }).catch((e) => {
      if (!live) return;
      setAll([]);
      toast.error(e instanceof Error ? e.message : 'Could not load requests');
    });
    return () => {
      live = false;
    };
  }, [scope, services, clientRequests, actingForId, me]);

  const source = scope === 'client' ? clientRequests.filter((r) => r.status !== 'Drafted') : all?.filter((r) => r.status !== 'Drafted');
  const list = useMemo(() => {
    const l = source ?? [];
    switch (filter) {
      case 'waiting':
        return l.filter((r) => r.status === 'Sent' || r.status === 'Viewed');
      case 'expiring':
        return l.filter(expiring);
      case 'onbase':
        return l.filter((r) => r.status === 'Signed' && !r.uploadedToOnBase);
      case 'done':
        return l.filter(isFinished);
      case 'open':
        return l.filter((r) => !isFinished(r));
      default:
        return l;
    }
  }, [source, filter]);

  const counts = useMemo(() => {
    const l = source ?? [];
    return {
      waiting: l.filter((r) => r.status === 'Sent' || r.status === 'Viewed').length,
      onbase: l.filter((r) => r.status === 'Signed' && !r.uploadedToOnBase).length,
      expiring: l.filter(expiring).length,
    };
  }, [source]);

  return (
    <>
      <Toolbar title="Signature requests" subtitle={scope === 'client' && client ? client.contact.fullname : 'Everyone you work for'}>
        {client && (
          <Segmented
            label="Show"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'client', label: client.contact.firstname },
              { value: 'all', label: 'All clients' },
            ]}
          />
        )}
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">Signature requests</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              Status comes from DocuSign. Signed envelopes wait here until you’ve filed them in OnBase.
            </p>
          </div>

          <div className="stat-tiles">
            <div className="stat">
              <b>{counts.waiting}</b>
              <span>Waiting on clients</span>
            </div>
            <div className="stat">
              <b className={counts.onbase ? 'c-warn' : undefined}>{counts.onbase}</b>
              <span>Signed, need OnBase</span>
            </div>
            <div className="stat">
              <b>{(source ?? []).length}</b>
              <span>Sent in total</span>
            </div>
          </div>

          <div className="row wrap" role="group" aria-label="Filter requests" style={{ gap: 6 }}>
            {(
              [
                ['open', 'Open'],
                ['waiting', 'Waiting on client'],
                ['expiring', counts.expiring ? `Expiring soon (${counts.expiring})` : 'Expiring soon'],
                ['onbase', 'Needs OnBase'],
                ['done', 'Finished'],
                ['all', 'All'],
              ] as [Filter, string][]
            ).map(([v, l]) => (
              <button key={v} className="chip" aria-pressed={filter === v} onClick={() => setFilter(v)}>
                {l}
              </button>
            ))}
          </div>

          {scope === 'all' && !all ? (
            <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
              <Spinner />
            </div>
          ) : list.length === 0 ? (
            <Empty icon="signature" title={filter === 'onbase' ? 'Nothing waiting to file' : filter === 'expiring' ? 'Nothing expiring this week' : 'No requests here'}>
              {filter === 'open' ? 'Requests you send show up here until they’re signed and filed.' : 'Try another filter.'}
            </Empty>
          ) : (
            list.map((r) => <RequestCard key={r.id} req={r} fresh={r.id === fresh} showClient={scope === 'all'} clientName={scope === 'all' ? names[r.contactId] : client?.contact.fullname} />)
          )}

          <div className="banner info">
            <span className="badge badge-info">Phase 2</span>
            <span className="t-footnote">The “In OnBase” step will complete on its own once signed envelopes are archived automatically through the OnBase API Server.</span>
          </div>
        </div>
      </div>
    </>
  );
}
