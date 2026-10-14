// Failure handling for every service call: what kind of failure it was, how long a
// call may take, which calls are safe to try again, and the app-wide connection state
// the recovery banner shows. Pure apart from `navigator.onLine` and timers.

export type ErrorKind = 'auth' | 'offline' | 'timeout' | 'conflict' | 'server' | 'unknown';

/** A service failure Folium has classified. `message` stays readable for toasts. */
export class FoliumError extends Error {
  readonly kind: ErrorKind;
  readonly op: string;
  readonly cause?: unknown;
  constructor(kind: ErrorKind, op: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'FoliumError';
    this.kind = kind;
    this.op = op;
    this.cause = cause;
  }
}

const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

/** Pull message, code and HTTP status out of whatever the SDK, fetch or a connector threw. */
function parts(e: unknown): { message: string; code: string; status?: number; name: string } {
  if (e === null || e === undefined) return { message: '', code: '', name: '' };
  if (typeof e === 'string') return { message: e, code: '', name: '' };
  const o = e as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown; error?: unknown; cause?: unknown; response?: { status?: unknown } };
  const inner = o.error && typeof o.error === 'object' ? parts(o.error) : undefined;
  const statusRaw = o.status ?? o.statusCode ?? o.response?.status ?? inner?.status;
  const status = typeof statusRaw === 'number' ? statusRaw : typeof statusRaw === 'string' && /^\d{3}$/.test(statusRaw) ? Number(statusRaw) : undefined;
  return {
    message: [typeof o.message === 'string' ? o.message : '', inner?.message ?? ''].filter(Boolean).join(' '),
    code: [typeof o.code === 'string' ? o.code : '', inner?.code ?? ''].filter(Boolean).join(' '),
    status,
    name: typeof o.name === 'string' ? o.name : '',
  };
}

/**
 * What went wrong, as far as the error says. The Power Apps SDK rarely carries an HTTP
 * status, so this reads SDK codes and message text as well as any status it finds.
 * Being offline wins over everything: without a network, token refresh fails too.
 */
export function classifyError(e: unknown, online: boolean = isOnline()): ErrorKind {
  if (e instanceof FoliumError) return e.kind;
  if (!online) return 'offline';
  const { message, code, status, name } = parts(e);
  const text = `${code} ${message}`;
  if (status === 401 || status === 403 || /TOKEN_ACQUISITION_FAILED|access token|unauthori[sz]ed|forbidden|session (has )?expired|sign[- ]?in (is )?required|\b40[13]\b/i.test(text)) return 'auth';
  if ((name === 'TypeError' && /fetch|network|load failed/i.test(message)) || /failed to fetch|networkerror|network request failed|ERR_INTERNET_DISCONNECTED|ERR_NETWORK/i.test(text)) return 'offline';
  if (status === 408 || status === 504 || name === 'TimeoutError' || /timed? ?out|timeout|\b50[4]\b/i.test(text)) return 'timeout';
  if (status === 409 || status === 412 || /conflict|precondition failed|\b409\b|\b412\b/i.test(text)) return 'conflict';
  if ((status !== undefined && status >= 500) || status === 429 || /\b5\d\d\b|server error|service unavailable|bad gateway|too many requests|throttl/i.test(text)) return 'server';
  return 'unknown';
}

const MESSAGE = {
  offline: 'No connection. Check your network and try again.',
  timeout: 'That took too long. Check your connection and try again.',
  auth: 'Your sign-in expired. Reload Folium to sign in again.',
} as const;

/**
 * Whether an error toast only repeats what the connection banner already says, so the
 * app shows one banner instead of a stream of identical toasts.
 */
export function repeatsBanner(text: string): boolean {
  return (problem === 'offline' && (text === MESSAGE.offline || text === MESSAGE.timeout)) || (problem === 'auth' && text === MESSAGE.auth);
}

/** Wrap anything thrown into a FoliumError for `op`, keeping an existing classification. */
export function toFoliumError(e: unknown, op: string): FoliumError {
  if (e instanceof FoliumError) return e;
  const kind = classifyError(e);
  const raw = parts(e).message;
  const message = kind === 'offline' ? MESSAGE.offline : kind === 'timeout' ? MESSAGE.timeout : kind === 'auth' ? MESSAGE.auth : raw || `${op} failed`;
  return new FoliumError(kind, op, message, e);
}

/** Default time limits: most calls 30 s; envelope creation and file transfers 90 s. */
export const TIMEOUT = { normal: 30_000, long: 90_000 } as const;

/**
 * Reject with a `timeout` FoliumError when `fn` takes longer than `ms`. The underlying
 * call can't be cancelled, so a late success is ignored: callers must treat a timed-out
 * write as "outcome unknown", never as "didn't happen".
 */
export function withTimeout<T>(fn: () => Promise<T>, ms: number, op: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new FoliumError('timeout', op, `${op} took too long`)), ms);
    fn().then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const RETRYABLE: ReadonlySet<ErrorKind> = new Set(['offline', 'timeout', 'server']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves when the browser reports it's back online, or after `ms`. */
export function waitForOnline(ms: number): Promise<void> {
  if (typeof window === 'undefined' || isOnline()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      window.removeEventListener('online', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    window.addEventListener('online', done);
  });
}

export interface RetryOptions {
  op: string;
  /** Attempts in total, including the first. */
  attempts?: number;
  /** First backoff; doubles each time. */
  baseMs?: number;
  /** How long to wait for the network to come back before the next attempt. */
  onlineWaitMs?: number;
  wait?: (ms: number) => Promise<void>;
  waitOnline?: (ms: number) => Promise<void>;
}

/**
 * Try a read again on offline, timeout and server failures: 3 attempts with backoff,
 * waiting for the `online` event when the network is down. Only for reads: a write is
 * never retried, because its first attempt may have landed.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const wait = opts.wait ?? sleep;
  const waitOnline = opts.waitOnline ?? waitForOnline;
  let last: FoliumError | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = toFoliumError(e, opts.op);
      if (!RETRYABLE.has(last.kind) || i === attempts - 1) throw last;
      if (last.kind === 'offline') await waitOnline(opts.onlineWaitMs ?? TIMEOUT.normal);
      else await wait((opts.baseMs ?? 500) * 2 ** i);
    }
  }
  throw last;
}

// ------------------------------------------------------------------ connection state

/** What the app-level banner shows. Undefined when calls are going through. */
export type ConnectionProblem = 'auth' | 'offline' | undefined;

let problem: ConnectionProblem;
const listeners = new Set<() => void>();

export function connectionProblem(): ConnectionProblem {
  return problem;
}

export function subscribeConnection(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setProblem(next: ConnectionProblem) {
  if (next === problem) return;
  problem = next;
  listeners.forEach((l) => l());
}

/** A call failed. Auth sticks until reload; offline clears on the next success or the `online` event. */
export function reportFailure(kind: ErrorKind) {
  if (kind === 'auth') setProblem('auth');
  else if (kind === 'offline' && problem !== 'auth') setProblem('offline');
}

export function reportSuccess() {
  if (problem === 'offline') setProblem(undefined);
}

if (typeof window !== 'undefined') window.addEventListener('online', reportSuccess);

/** For tests. */
export function resetConnection() {
  problem = undefined;
}
