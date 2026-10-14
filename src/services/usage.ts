import type { UsageEvent } from '../domain/usage';
import type { UsageLog } from './types';

// The usage queue. Tracking must never slow or stop the work it records: `track` only
// adds to an in-memory queue and returns, and the queue is written in the background.
// A failed write is tried once more and then dropped; nothing is shown to the advisor.

export interface UsageQueueOptions {
  /** Write at most this often while events are waiting. Default 10 seconds. */
  intervalMs?: number;
  /** Write straight away once this many are waiting. Default 25. */
  batchSize?: number;
  /** Most events held; the oldest go first past it. Default 500. */
  cap?: number;
  /** Listen for `pagehide` and write what's waiting. Default true where there's a window. */
  flushOnPageHide?: boolean;
}

interface Pending {
  event: UsageEvent;
  tries: number;
}

export interface UsageQueue extends UsageLog {
  /** Events waiting to be written (for tests and diagnostics). */
  pending(): number;
  /** Stop the timer and the page listener. */
  dispose(): void;
}

/** A queue that hands batches to `write` (a Dataverse or demo writer). */
export function createUsageQueue(write: (events: UsageEvent[]) => Promise<void>, opts: UsageQueueOptions = {}): UsageQueue {
  const intervalMs = opts.intervalMs ?? 10_000;
  const batchSize = opts.batchSize ?? 25;
  const cap = opts.cap ?? 500;
  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;

  const trim = () => {
    if (queue.length > cap) queue = queue.slice(queue.length - cap);
  };

  const schedule = () => {
    if (timer || !queue.length) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, intervalMs);
  };

  async function writeOnce(): Promise<void> {
    while (queue.length) {
      const batch = queue.slice(0, batchSize);
      queue = queue.slice(batch.length);
      try {
        await write(batch.map((p) => p.event));
      } catch {
        // One more try, at the next write; then it's dropped.
        const again = batch.filter((p) => p.tries < 1).map((p) => ({ ...p, tries: p.tries + 1 }));
        queue = [...again, ...queue];
        trim();
        break;
      }
    }
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    // One write at a time; a flush during a write waits for it, then writes what's left.
    const next: Promise<void> = (writing ?? Promise.resolve())
      .then(writeOnce)
      .catch(() => undefined)
      .finally(() => {
        if (writing === next) writing = undefined;
        schedule();
      });
    writing = next;
    return next;
  }

  function track(events: UsageEvent[]) {
    try {
      if (!events.length) return;
      queue.push(...events.map((event) => ({ event, tries: 0 })));
      trim();
      if (queue.length >= batchSize) void flush();
      else schedule();
    } catch {
      /* tracking never gets in the way */
    }
  }

  const onHide = () => void flush();
  const listen = (opts.flushOnPageHide ?? true) && typeof window !== 'undefined';
  if (listen) window.addEventListener('pagehide', onHide);

  return {
    track,
    flush,
    pending: () => queue.length,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (listen) window.removeEventListener('pagehide', onHide);
    },
  };
}
