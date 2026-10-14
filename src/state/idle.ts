// Timing for the optional idle auto-save (firm setting `idleAutoSave`). Pure, so the
// countdown can be tested without waiting 25 minutes.

export const DEFAULT_IDLE_MINUTES = 25;
/** How long the warning counts down before the draft is saved. */
export const WARNING_MS = 2 * 60_000;

export type IdleState = { phase: 'active' } | { phase: 'warning'; remainingMs: number } | { phase: 'due' };

/** Where an idle packet is: still in use, counting down, or due to be saved. */
export function idleState(lastActivity: number, now: number, idleMs: number, warnMs: number = WARNING_MS): IdleState {
  const idle = now - lastActivity;
  if (idle < idleMs) return { phase: 'active' };
  if (idle < idleMs + warnMs) return { phase: 'warning', remainingMs: idleMs + warnMs - idle };
  return { phase: 'due' };
}

/** "1:05" */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
