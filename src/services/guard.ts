import { reportFailure, reportSuccess, TIMEOUT, toFoliumError, withRetry, withTimeout } from './errors';
import { mapSigningRegistry, wrapProvider } from './registry';
import type { Services } from './types';

// `usage` isn't guarded: its queue drops failures on purpose, and a usage write that
// fails mustn't flag the connection as down. `signing` is a registry: each connection
// in it is guarded the same way, as `signing.<method>`.
type Area = Exclude<keyof Services, 'mode' | 'attachments' | 'usage' | 'signing'>;
const AREAS: Area[] = ['directory', 'crm', 'templates', 'drafts', 'requests', 'packets', 'feedback'];

/** Reads: safe to try again. Everything else is a write and runs once. */
const READS = new Set([
  'directory.currentUser',
  'directory.listUsers',
  'directory.listGroups',
  'directory.listFirms',
  'directory.listAnnouncements',
  'crm.getClient',
  'crm.searchContacts',
  'crm.recentContacts',
  'templates.list',
  'templates.getPdf',
  'templates.listIncoming',
  'drafts.folderUrl',
  'drafts.getFile',
  'requests.listForContact',
  'requests.listMine',
  'requests.get',
  'packets.list',
  'feedback.list',
  'feedback.listMine',
  'signing.getStatus',
  'signing.downloadCompleted',
]);

/** Envelope creation and file transfers get the long limit. */
const LONG = new Set(['templates.getPdf', 'drafts.getFile', 'drafts.saveDraft', 'drafts.saveAttachment', 'signing.create', 'signing.downloadCompleted']);

export interface GuardOptions {
  timeouts?: { normal: number; long: number };
  /** Passed to withRetry; tests shorten the waits. */
  retry?: { attempts?: number; baseMs?: number; onlineWaitMs?: number };
}

/**
 * Every service call, with a time limit, retries for reads, classified errors
 * (FoliumError) and the app-wide connection state. The time limit covers retries too,
 * so no button spins for longer than its call's limit.
 */
export function guardServices(services: Services, opts: GuardOptions = {}): Services {
  const limits = opts.timeouts ?? TIMEOUT;
  const guard = (op: string, call: (...args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
    const once = () => call(...args);
    // A call can't be cancelled, but once the time limit passes no further retry starts.
    let timedOut = false;
    try {
      const run = READS.has(op) ? () => withRetry(once, { op, ...opts.retry, cancelled: () => timedOut }) : once;
      const result = await withTimeout(run, LONG.has(op) ? limits.long : limits.normal, op).catch((e) => {
        timedOut = true;
        throw e;
      });
      reportSuccess();
      return result;
    } catch (e) {
      const err = toFoliumError(e, op);
      reportFailure(err.kind);
      throw err;
    }
  };
  const out = { ...services } as Services;
  for (const area of AREAS) {
    const target = services[area] as unknown as Record<string, unknown>;
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(target)) {
      wrapped[name] = typeof value === 'function' ? guard(`${area}.${name}`, (...args) => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)) : value;
    }
    (out as unknown as Record<string, unknown>)[area] = wrapped;
  }
  out.signing = mapSigningRegistry(services.signing, (p) => wrapProvider(p, (name, call) => guard(`signing.${name}`, call)));
  return out;
}
