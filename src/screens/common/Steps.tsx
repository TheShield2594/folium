import { useNavigate } from 'react-router-dom';

const STEPS = [
  { label: 'Forms', to: '/' },
  { label: 'Review', to: '/review' },
  { label: 'Send', to: '/send' },
];

/** Pick → Review → Send, shown in the toolbar on wide windows. */
export function Steps({ current }: { current: number }) {
  const navigate = useNavigate();
  return (
    <ol className="flow-steps" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li key={s.label} aria-current={i === current ? 'step' : undefined} className={i < current ? 'done' : undefined}>
          <button type="button" onClick={() => navigate(s.to)} disabled={i === current}>
            <span className="n">{i + 1}</span>
            {s.label}
          </button>
        </li>
      ))}
    </ol>
  );
}
