import { useNavigate } from 'react-router-dom';

const STEPS = [
  { label: 'Forms', to: '/' },
  { label: 'Review', to: '/review' },
  { label: 'Send', to: '/send' },
];

/**
 * Pick → Review → Send, shown in the toolbar on wide windows. Steps in `locked` stay
 * visible but can't be opened: Send waits until every blocking check passes.
 */
export function Steps({ current, locked = [] }: { current: number; locked?: number[] }) {
  const navigate = useNavigate();
  return (
    <ol className="flow-steps" aria-label="Steps">
      {STEPS.map((s, i) => {
        const off = locked.includes(i);
        return (
          <li key={s.label} aria-current={i === current ? 'step' : undefined} className={off ? 'locked' : i < current ? 'done' : undefined}>
            <button type="button" onClick={() => navigate(s.to)} disabled={i === current || off} title={off ? 'Fix the blocking checks first' : undefined}>
              <span className="n">{i + 1}</span>
              {s.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
