import { useEffect, useState } from 'react';
import { categoryLabel, newlyResolved, statusLabel, type FormFeedback } from '../../domain/feedback';
import { useServices } from '../../services';
import { useApp } from '../../state/store';
import { Badge, toast } from '../../ui/controls';
import { fmtDay } from '../requests/RequestCard';

const SEEN_KEY = 'folium.feedbackSeen';

function readSeen(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function writeSeen(seen: string[]) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-200)));
  } catch {
    /* ignore */
  }
}

/** Once per sign-in: tell the advisor when Marketing fixed (or won't fix) something they reported. */
export function FeedbackNotices() {
  const services = useServices();
  const me = useApp((s) => s.me);
  const userId = me?.systemuserid;
  useEffect(() => {
    if (!userId) return;
    let live = true;
    services.feedback
      .listMine(userId)
      .then((mine) => {
        if (!live) return;
        const seen = readSeen();
        const done = newlyResolved(mine, userId, seen);
        if (!done.length) return;
        const first = done[0];
        toast.ok(
          done.length === 1
            ? `Marketing marked your report on ${first.formNumber ?? first.name} “${statusLabel(first.status).toLowerCase()}”.${first.resolution ? ` ${first.resolution}` : ''}`
            : `Marketing answered ${done.length} of your form reports. See Settings.`,
        );
        writeSeen([...seen, ...done.map((f) => `${f.id}:${f.status}`)]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [userId, services]);
  return null;
}

/** Settings: the form requests and problem reports you sent, and where they stand. */
export function MyFormReports() {
  const services = useServices();
  const me = useApp((s) => s.me);
  const [list, setList] = useState<FormFeedback[]>();
  useEffect(() => {
    if (!me?.systemuserid) return;
    services.feedback
      .listMine(me.systemuserid)
      .then(setList)
      .catch(() => setList([]));
  }, [me?.systemuserid, services]);
  if (!list?.length) return null;
  return (
    <section className="card card-pad stack-3" aria-labelledby="mine-fb-h">
      <h2 id="mine-fb-h" className="t-title3">
        Forms you reported
      </h2>
      <ul className="stack-3" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {list.map((f) => (
          <li key={f.id} className="row" style={{ alignItems: 'flex-start' }}>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="t-headline" style={{ display: 'block' }}>
                {f.formNumber ? `${f.formNumber} · ` : ''}
                {f.name}
              </span>
              <span className="t-footnote c3" style={{ display: 'block' }}>
                {f.kind === 'problem' ? categoryLabel(f.category) || 'Problem' : 'Asked to add it'} · {fmtDay(f.createdOn)}
              </span>
              {f.resolution && <span className="t-footnote c2" style={{ display: 'block', marginTop: 2 }}>{f.resolution}</span>}
            </span>
            <Badge tone={f.status === 'fixed' ? 'accent' : f.status === 'new' ? undefined : 'info'}>{statusLabel(f.status)}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
