import { reportFailure, reportSuccess, TIMEOUT, toFoliumError, withRetry, withTimeout } from './errors';
import type { Services } from './types';

type Area = Exclude<keyof Services, 'mode' | 'attachments'>;
const AREAS: Area[] = ['directory', 'crm', 'templates', 'drafts', 'requests', 'packets', 'signing'];

/** Reads: safe to try again. Everything else is a write and runs once. */
const READS = new Set([
  'directory.currentUser',
  'directory.listUsers',
  'directory.listGroups',
  'directory.getFirm',
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
  const out = { ...services } as Services;
  for (const area of AREAS) {
    const target = services[area] as unknown as Record<string, unknown>;
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(target)) {
      if (typeof value !== 'function') {
        wrapped[name] = value;
        continue;
      }
      const op = `${area}.${name}`;
      const call = (...args: unknown[]) => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      wrapped[name] = async (...args: unknown[]) => {
        const once = () => call(...args);
        try {
          const run = READS.has(op) ? () => withRetry(once, { op, ...opts.retry }) : once;
          const result = await withTimeout(run, LONG.has(op) ? limits.long : limits.normal, op);
          reportSuccess();
          return result;
        } catch (e) {
          const err = toFoliumError(e, op);
          reportFailure(err.kind);
          throw err;
        }
      };
    }
    (out as unknown as Record<string, unknown>)[area] = wrapped;
  }
  return out;
}
