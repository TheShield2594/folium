import type { SignatureRequest } from '../domain/types';
import type { Services } from '../services/types';

// The version of each request row this tab last read into a packet or wrote itself, so
// autosave can tell when someone else (a colleague with a shared draft, or this person
// in another tab) saved the draft since, instead of quietly writing over their work.

/** A row's version: every save through Folium adds or moves an audit entry or changes the status. */
export function rowVersion(r: Pick<SignatureRequest, 'audit' | 'status'>): string {
  return `${r.audit.length}|${r.audit.at(-1)?.at ?? ''}|${r.status}`;
}

const known = new Map<string, string>();

/** Remember a row as this tab has it. Rows without an id (a draft opened as new) are skipped. */
export function noteRow(r: Pick<SignatureRequest, 'id' | 'audit' | 'status'> | undefined): void {
  if (r?.id) known.set(r.id, rowVersion(r));
}

/** The version of a row this tab last read or wrote; undefined if it hasn't seen the row. */
export function knownVersion(id: string): string | undefined {
  return known.get(id);
}

/** For tests. */
export function forgetRows(): void {
  known.clear();
}

/** Services whose request saves note the row they wrote, whichever screen saved it. */
export function withRowVersions(services: Services): Services {
  const requests = services.requests;
  return {
    ...services,
    requests: {
      ...requests,
      async save(req) {
        const saved = await requests.save(req);
        noteRow(saved);
        return saved;
      },
    },
  };
}

let chain: Promise<unknown> = Promise.resolve();

/** Run draft saves one at a time, so an autosave and a Save draft never write a row at once. */
export function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
