import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { prefillCoverage } from '../../domain/prefill';
import { roleLabel } from '../../domain/signers';
import type { FormSource, FormTemplate } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { currentTemplates, latestLive, useApp, useScope, visibleTemplates } from '../../state/store';
import { Badge, Button, Empty, IconButton, Meter, SearchField, Select } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { NoClient } from '../common/NoClient';
import { PacketInspector } from './PacketInspector';
import { QuickLook } from './QuickLook';
import { RequestFormSheet } from './RequestFormSheet';
import { searchTemplates } from './search';

type Filter = 'all' | 'suggested' | 'favorites' | 'recent' | FormSource;

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All forms' },
  { value: 'suggested', label: 'Suggested' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'recent', label: 'Recently used' },
  { value: 'Everence', label: 'Everence' },
  { value: 'Praxis', label: 'Praxis funds' },
  { value: 'Carrier', label: 'Insurance carriers' },
];

export function LibraryScreen() {
  const client = useApp((s) => s.client);
  const clientLoading = useApp((s) => s.clientLoading);
  const me = useApp((s) => s.me);
  const groups = useApp((s) => s.groups);
  const templates = useApp((s) => s.templates);
  const requests = useApp((s) => s.requests);
  const favorites = useApp((s) => s.favorites);
  const recent = useApp((s) => s.recent);
  const packet = useApp((s) => s.packet);
  const addToPacket = useApp((s) => s.addToPacket);
  const removeFromPacket = useApp((s) => s.removeFromPacket);
  const toggleFavorite = useApp((s) => s.toggleFavorite);
  const scope = useScope();
  const navigate = useNavigate();
  const services = useServices();

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('suggested');
  const [category, setCategory] = useState('');
  const [peek, setPeek] = useState<FormTemplate>();
  const [asking, setAsking] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search, like Finder and Mail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea, select')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const live = useMemo(() => currentTemplates(visibleTemplates(me, groups, templates)), [me, groups, templates]);
  const accountTypes = useMemo(() => new Set(client?.accounts.map((a) => a.ev_accounttype)), [client]);
  const suggested = useMemo(() => live.filter((t) => t.appliesTo?.some((a) => accountTypes.has(a))), [live, accountTypes]);
  const coverage = useMemo(() => {
    const m = new Map<string, number>();
    if (scope) for (const t of live) m.set(t.id, prefillCoverage(t, { ...scope, account: client?.accounts.find((a) => t.appliesTo?.includes(a.ev_accounttype)) }));
    return m;
  }, [live, scope, client]);

  const list = useMemo(() => {
    let base = live;
    if (!q) {
      if (filter === 'suggested') base = suggested;
      if (filter === 'favorites') base = live.filter((t) => favorites.includes(t.id));
      if (filter === 'recent') base = recent.map((r) => live.find((t) => t.id === r.templateId)).filter((t): t is FormTemplate => !!t);
    }
    if (filter === 'Everence' || filter === 'Praxis' || filter === 'Carrier') base = base.filter((t) => t.source === filter);
    if (category) base = base.filter((t) => t.category === category);
    return searchTemplates(base, q);
  }, [live, suggested, favorites, recent, filter, category, q]);

  const upcoming = (t: FormTemplate) => templates.find((x) => x.formNumber === t.formNumber && x.id !== t.id && x.status !== 'Retired' && x.effectiveDate > t.effectiveDate);
  const waiting = requests.filter((r) => r.status === 'Sent' || r.status === 'Viewed');
  const categories = [...new Set(live.map((t) => t.category))].sort();

  if (!client) return <NoClient loading={clientLoading} />;

  return (
    <>
      <Toolbar title="Find forms" subtitle={`${client.contact.fullname} · ${client.contact.ev_clientid}`}>
        <Button variant="filled" icon="checkCircle" disabled={!packet.items.length} onClick={() => navigate('/review')} className="only-compact-btn">
          Review {packet.items.length ? `(${packet.items.length})` : ''}
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page">
          <div className="split">
            <div className="stack-5" style={{ minWidth: 0 }}>
              <div className="page-head" style={{ marginBottom: 0 }}>
                <div>
                  <h1 className="t-large">Forms for {client.contact.firstname}</h1>
                  <p className="sub">Prefilled from Dynamics 365. Always the current version from Marketing’s library.</p>
                </div>
              </div>

              {waiting.length > 0 && (
                <div className="banner" role="status">
                  <Icon name="clock" size={20} />
                  <span className="grow">
                    <strong>{waiting.length === 1 ? '1 request is' : `${waiting.length} requests are`} waiting on {client.contact.firstname}.</strong>{' '}
                    {waiting[0].title} — {waiting[0].status === 'Viewed' ? 'opened, not signed' : 'not opened yet'}.
                  </span>
                  <Link to="/requests" className="btn btn-plain btn-sm">View status</Link>
                </div>
              )}

              <div className="card card-pad stack-4">
                <div className="row wrap" style={{ gap: 10 }}>
                  <div className="grow" style={{ minWidth: 240 }}>
                    <SearchField inputRef={searchRef} value={q} onChange={setQ} placeholder="Search by name, form number, carrier or keyword" shortcut="/" label="Search forms" />
                  </div>
                  <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={{ width: 'auto', minWidth: 170 }}>
                    <option value="">All categories</option>
                    {categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                </div>
                <div className="row wrap" role="group" aria-label="Filter forms" style={{ gap: 6 }}>
                  {FILTERS.map((f) => (
                    <button key={f.value} type="button" className="chip" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                      {f.value === 'favorites' && <Icon name="star" size={13} strokeWidth={2} />}
                      {f.label}
                    </button>
                  ))}
                </div>

                <div>
                  <div className="row" style={{ padding: '4px 4px 8px' }}>
                    <h2 className="t-footnote c3" style={{ fontWeight: 600 }}>
                      {q ? `${list.length} result${list.length === 1 ? '' : 's'} for “${q}”` : filter === 'suggested' ? `Suggested from ${client.contact.firstname}’s accounts` : FILTERS.find((f) => f.value === filter)?.label}
                    </h2>
                  </div>
                  {list.length === 0 ? (
                    <Empty icon={filter === 'favorites' ? 'star' : 'search'} title={filter === 'favorites' && !q ? 'No favorites yet' : 'No forms found'}>
                      {filter === 'favorites' && !q ? 'Star a form to keep it here.' : 'Try another word, a form number, or ask Marketing to add it.'}
                    </Empty>
                  ) : (
                    <ul className="form-list" aria-label="Forms">
                      {list.map((t) => {
                        const inPacket = packet.items.some((i) => i.templateId === t.id);
                        const next = upcoming(t);
                        const cov = coverage.get(t.id) ?? 0;
                        const fav = favorites.includes(t.id);
                        return (
                          <li key={t.id} className={['form-row', inPacket && 'in'].filter(Boolean).join(' ')}>
                            <button
                              type="button"
                              className="add"
                              aria-pressed={inPacket}
                              aria-label={inPacket ? `Remove ${t.name} from packet` : `Add ${t.name} to packet`}
                              onClick={() => (inPacket ? removeFromPacket(t.id) : addToPacket(t.id))}
                            >
                              <Icon name={inPacket ? 'check' : 'plus'} size={16} strokeWidth={2.4} />
                            </button>
                            <button type="button" className="info" onClick={() => setPeek(t)} aria-label={`Preview ${t.name}`}>
                              <span className="name">{t.name}</span>
                              <span className="meta">
                                <span className="mono">{t.formNumber}</span> · {t.issuer ?? t.source} · Rev {t.revision}
                              </span>
                            </button>
                            <span className="cell-ver">
                              {next ? (
                                <Badge tone="warn" icon="sparkle">
                                  New rev {new Date(next.effectiveDate + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                </Badge>
                              ) : (
                                <span className="t-footnote c3">{t.pageCount} {t.pageCount === 1 ? 'page' : 'pages'}</span>
                              )}
                            </span>
                            <span className="cell-fill" title={`${cov}% of fields fill from CRM`}>
                              <Meter value={cov} label={`${cov}% prefilled`} />
                              <span className="t-footnote c3 tabular">{cov}%</span>
                            </span>
                            <span className="cell-signers t-footnote c2 ellipsis">{t.mapping.signers.map((s) => roleLabel(s.role)).join(', ')}</span>
                            <IconButton icon={fav ? 'starFill' : 'star'} label={fav ? 'Remove from favorites' : 'Add to favorites'} pressed={fav} onClick={() => toggleFavorite(t.id)} className={fav ? 'fav on' : 'fav'} />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                <div className="row t-footnote c3" style={{ justifyContent: 'center', paddingTop: 4 }}>
                  Can’t find a form?
                  <button className="btn btn-plain btn-sm" onClick={() => setAsking(true)}>
                    Ask Marketing to add it
                  </button>
                </div>
              </div>
            </div>

            <PacketInspector />
          </div>
        </div>
      </div>
      {peek && (
        <QuickLook
          template={peek}
          inPacket={packet.items.some((i) => i.templateId === peek.id)}
          onAdd={() => addToPacket(peek.id)}
          onClose={() => setPeek(undefined)}
          latest={latestLive(templates, peek.formNumber)}
        />
      )}
      {asking && <RequestFormSheet initial={q} onClose={() => setAsking(false)} services={services} />}
    </>
  );
}
