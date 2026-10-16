import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { FormFeedback } from '../../domain/feedback';
import {
  companyCoverage,
  formRanking,
  formRankingRows,
  pilotNumbers,
  READINESS_ISSUE,
  readinessChecks,
  readinessSummary,
  SECTION_TITLES,
  type ReadinessItem,
  type ReadinessSection,
  type ReadinessStatus,
} from '../../domain/readiness';
import type { UsageEvent } from '../../domain/usage';
import { toCsv } from '../../domain/users';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Badge, Button, downloadBytes, Empty, Segmented, Spinner, toast, TableScroll } from '../../ui/controls';
import { Icon, type IconName } from '../../ui/Icon';

const ISSUES = 'https://github.com/TheShield2594/folium/issues/';

const STATUS: Record<ReadinessStatus, { label: string; tone?: 'accent' | 'warn' | 'info' | 'danger'; icon: IconName }> = {
  done: { label: 'Done', tone: 'accent', icon: 'checkCircle' },
  review: { label: 'Look at this', tone: 'warn', icon: 'warning' },
  todo: { label: 'To do', tone: 'danger', icon: 'xCircle' },
  manual: { label: 'Check by hand', tone: undefined, icon: 'circle' },
};

const SECTIONS: ReadinessSection[] = ['forms', 'platform', 'environment', 'pilot', 'signoff'];

type Window = '30' | '90' | '365';

/** Administration › Readiness: what has to be true before Folium replaces Laser App (#35). */
export function AdminReadiness() {
  const me = useApp((s) => s.me);
  if (me?.role !== 'Admin') return <Navigate to="/" replace />;
  return <Readiness />;
}

/** The readiness checklist, pilot numbers and forms ranked by use. */
function Readiness() {
  const services = useServices();
  const users = useApp((s) => s.users);
  const groups = useApp((s) => s.groups);
  const firms = useApp((s) => s.firms);
  const policy = useApp((s) => s.policy);
  const docuSign = useApp((s) => s.docuSign);
  const templates = useApp((s) => s.templates);
  const [days, setDays] = useState<Window>('90');
  const [usage, setUsage] = useState<{ events: UsageEvent[]; truncated: boolean } | null>();
  const [feedback, setFeedback] = useState<FormFeedback[] | null>();

  // Only the latest load writes state: a slow 12-month read mustn't land after a 30-day one.
  const latest = useRef(0);
  async function load(window: Window) {
    const mine = ++latest.current;
    setUsage(undefined);
    const since = new Date(Date.now() - Number(window) * 86_400_000).toISOString();
    const [u, f] = await Promise.allSettled([services.usage.list(since), services.feedback.list()]);
    if (mine !== latest.current) return;
    // Either can fail (no Read on the table yet): the list still shows, marked "Check by hand".
    setUsage(u.status === 'fulfilled' ? u.value : null);
    setFeedback(f.status === 'fulfilled' ? f.value : null);
    if (u.status === 'rejected') toast.error('Couldn’t read usage events. Check the Folium Reporting role on ev_usageevent.');
  }
  useEffect(() => {
    void load(days);
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  const events = usage?.events;
  const items = useMemo(
    () => readinessChecks({ users, groups, firms, policy, docuSign, templates, usage: events, feedback: feedback ?? undefined }),
    [users, groups, firms, policy, docuSign, templates, events, feedback],
  );
  const summary = readinessSummary(items);
  const ranking = useMemo(() => (events ? formRanking(events, templates) : []), [events, templates]);
  const coverage = useMemo(() => companyCoverage(templates, events), [templates, events]);
  const pilot = useMemo(() => (events ? pilotNumbers(events, feedback ?? undefined) : undefined), [events, feedback]);
  const totalUses = coverage.reduce((n, c) => n + (c.uses ?? 0), 0);

  function exportRanking() {
    downloadBytes(new TextEncoder().encode(toCsv(formRankingRows(ranking))), `folium-forms-by-use-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
  }

  return (
    <>
      <Toolbar title="Readiness" subtitle={`${summary.done} of ${items.length} done`}>
        <Button variant="gray" icon="refresh" onClick={() => load(days)}>
          Refresh
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page stack-5">
          <div>
            <h1 className="t-large">Replacing Laser App</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              What has to be true before Folium replaces Laser App. Folium checks what it can from its own data; the rest is checked by hand and ticked on{' '}
              <a href={`${ISSUES}${READINESS_ISSUE}`} target="_blank" rel="noopener noreferrer">
                the readiness issue
              </a>
              .
            </p>
            <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
              {(['done', 'review', 'todo', 'manual'] as ReadinessStatus[]).map((s) => (
                <Badge key={s} tone={STATUS[s].tone} icon={STATUS[s].icon}>
                  {summary[s]} {STATUS[s].label.toLowerCase()}
                </Badge>
              ))}
            </div>
          </div>

          <div className="row wrap" style={{ gap: 10 }}>
            <span className="t-callout c2">Usage from the last</span>
            <Segmented
              label="Usage window"
              value={days}
              onChange={setDays}
              options={[
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' },
                { value: '365', label: '12 months' },
              ]}
            />
            {usage === undefined && <Spinner label="Loading usage" />}
            {usage?.truncated && <span className="t-footnote c3">Showing the first {usage.events.length.toLocaleString('en-US')} events; the Power BI report has the rest.</span>}
          </div>

          {pilot && <PilotCard pilot={pilot} />}

          {SECTIONS.map((section) => (
            <section key={section} className="card" aria-labelledby={`rd-${section}`}>
              <h2 id={`rd-${section}`} className="t-title3" style={{ padding: '16px 16px 4px' }}>
                {SECTIONS.indexOf(section) + 1}. {SECTION_TITLES[section]}
              </h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {items
                  .filter((i) => i.section === section)
                  .map((i) => (
                    <ItemRow key={i.id} item={i} />
                  ))}
              </ul>
              {section === 'forms' && <CompanyTable coverage={coverage} totalUses={events ? totalUses : undefined} />}
            </section>
          ))}

          <section className="card" aria-labelledby="rd-rank">
            <div className="row wrap" style={{ padding: 16, gap: 10 }}>
              <div className="grow">
                <h2 id="rd-rank" className="t-title3">
                  Forms by use
                </h2>
                <p className="t-footnote c3">Forms added to packets in the window, every revision together. Start mapping and checking from the top.</p>
              </div>
              <Button variant="gray" icon="download" onClick={exportRanking} disabled={!ranking.length}>
                Export CSV
              </Button>
            </div>
            {usage === undefined ? (
              <div style={{ padding: 24, display: 'grid', placeItems: 'center' }}>
                <Spinner label="Loading usage" />
              </div>
            ) : !ranking.length ? (
              <Empty icon="chart" title={usage === null ? 'Usage couldn’t be read' : 'No forms used yet'}>
                {usage === null ? 'Give Admins Read on ev_usageevent (the Folium Reporting role).' : 'Forms show here as advisors add them to packets.'}
              </Empty>
            ) : (
              <TableScroll label="Forms ranked by use">
                <table className="table" style={{ minWidth: 620 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 48 }}>#</th>
                      <th>Form</th>
                      <th>Company</th>
                      <th style={{ textAlign: 'right' }}>Uses</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.slice(0, 25).map((r, i) => (
                      <tr key={r.formNumber}>
                        <td className="c3">{i + 1}</td>
                        <td>
                          {r.templateId ? <Link to={`/admin/templates/${r.templateId}`}>{r.formNumber}</Link> : r.formNumber}
                          {r.name && <div className="t-footnote c3">{r.name}</div>}
                        </td>
                        <td>{r.issuer ?? '—'}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.count.toLocaleString('en-US')}</td>
                        <td>{r.status ? <Badge tone={r.status === 'Live' ? 'accent' : r.status === 'Retired' ? 'danger' : 'warn'}>{r.status}</Badge> : <Badge tone="danger">Not in Folium</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {ranking.length > 25 && <p className="t-footnote c3" style={{ padding: '8px 16px 16px' }}>{ranking.length - 25} more in the CSV.</p>}
              </TableScroll>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function ItemRow({ item }: { item: ReadinessItem }) {
  const s = STATUS[item.status];
  return (
    <li className="row" style={{ gap: 12, padding: '12px 16px', borderTop: '0.5px solid var(--separator)', alignItems: 'flex-start' }}>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="t-headline" style={{ display: 'block' }}>
          {item.title}
        </span>
        <span className="t-callout c2" style={{ display: 'block', marginTop: 2 }}>
          {item.detail}
        </span>
        <span className="row wrap t-footnote" style={{ gap: 10, marginTop: 6 }}>
          {item.to && (
            <Link to={item.to}>
              Open <Icon name="arrowRight" size={12} />
            </Link>
          )}
          {item.issues?.map((n) => (
            <a key={n} href={`${ISSUES}${n}`} target="_blank" rel="noopener noreferrer" className="c3">
              Issue {n}
            </a>
          ))}
        </span>
      </span>
      <Badge tone={s.tone} icon={s.icon}>
        {s.label}
      </Badge>
    </li>
  );
}

/** Laser App's top companies: their Live forms, those still being mapped, and use. */
function CompanyTable({ coverage, totalUses }: { coverage: ReturnType<typeof companyCoverage>; totalUses?: number }) {
  return (
    <TableScroll label="Top companies’ forms" style={{ borderTop: '0.5px solid var(--separator)' }}>
      <table className="table" style={{ minWidth: 620 }}>
        <caption className="t-footnote c3" style={{ textAlign: 'left', padding: '12px 16px 0', captionSide: 'top' }}>
          Laser App’s top companies (98.6% of 55,374 form uses in 12 months) against Folium’s library{totalUses !== undefined ? ' and use in the window' : ''}.
        </caption>
        <thead>
          <tr>
            <th>Company</th>
            <th style={{ textAlign: 'right' }}>Laser App share</th>
            <th style={{ textAlign: 'right' }}>Live forms</th>
            <th style={{ textAlign: 'right' }}>Being mapped</th>
            {totalUses !== undefined && <th style={{ textAlign: 'right' }}>Folium share</th>}
          </tr>
        </thead>
        <tbody>
          {coverage.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.share}%</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.live ? c.live : <Badge tone="danger">0</Badge>}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.inProgress || '—'}</td>
              {totalUses !== undefined && (
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{totalUses ? `${(((c.uses ?? 0) / totalUses) * 100).toFixed(1)}%` : '—'}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function PilotCard({ pilot }: { pilot: ReturnType<typeof pilotNumbers> }) {
  const pct = (v?: number) => (v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
  const hours = (h?: number) => (h === undefined ? '—' : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);
  const stats: { label: string; value: string; help: string }[] = [
    { label: 'Form uses', value: pilot.formUses.toLocaleString('en-US'), help: 'Forms added to packets' },
    { label: 'Sent', value: pilot.sends.toLocaleString('en-US'), help: `Plus ${pilot.inPerson} signed in person` },
    { label: 'Blocked sends', value: pct(pilot.blockedRate), help: `${pilot.blockedPresses} presses blocked by checks` },
    { label: 'Median time to sign', value: hours(pilot.medianHoursToSign), help: 'Sent to signed' },
    { label: 'Active people', value: String(pilot.activeUsers30), help: 'In the last 30 days' },
    ...(pilot.openProblems !== undefined ? [{ label: 'Open problems', value: String(pilot.openProblems), help: 'Problem reports not closed' }] : []),
  ];
  return (
    <section className="card card-pad stack-3" aria-labelledby="rd-pilot">
      <h2 id="rd-pilot" className="t-title3">
        Pilot numbers
      </h2>
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 16, margin: 0 }}>
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="t-footnote c3">{s.label}</dt>
            <dd className="t-title2" style={{ margin: '2px 0 0', fontVariantNumeric: 'tabular-nums' }}>
              {s.value}
            </dd>
            <dd className="t-footnote c3" style={{ margin: 0 }}>
              {s.help}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
