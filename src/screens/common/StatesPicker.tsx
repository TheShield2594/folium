import { US_STATES } from '../../domain/states';

/**
 * Pick USPS states. An empty pick means `emptyLabel` ("All states" for a form), so the
 * first chip clears the list. Used for a form's approved states and an advisor's licences.
 */
export function StatesPicker({ value, onChange, label, emptyLabel = 'All states' }: { value: string[]; onChange: (v: string[]) => void; label: string; emptyLabel?: string }) {
  const on = new Set(value);
  const toggle = (s: string) => onChange(US_STATES.filter((x) => (x === s ? !on.has(s) : on.has(x))));
  return (
    <div className="row wrap" role="group" aria-label={label} style={{ gap: 4 }}>
      <button type="button" className="chip" aria-pressed={value.length === 0} onClick={() => onChange([])}>
        {emptyLabel}
      </button>
      {US_STATES.map((s) => (
        <button key={s} type="button" className="chip mono" aria-pressed={on.has(s)} onClick={() => toggle(s)} style={{ minWidth: 40, padding: '0 8px', justifyContent: 'center' }}>
          {s}
        </button>
      ))}
    </div>
  );
}
