import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageEvent } from '../domain/usage';
import { createUsageQueue } from './usage';

const ev = (n: number): UsageEvent => ({ type: 'form.added', occurredOn: '2026-10-13T00:00:00.000Z', userId: 'u', batchId: 'b', dedupeKey: `b|form.added|t|${n}` });
const many = (from: number, count: number) => Array.from({ length: count }, (_, i) => ev(from + i));

describe('usage queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits, then writes everything queued in one batch', async () => {
    const write = vi.fn(async (_events: UsageEvent[]) => undefined);
    const q = createUsageQueue(write, { flushOnPageHide: false });
    q.track([ev(1)]);
    q.track([ev(2), ev(3)]);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toHaveLength(3);
    expect(q.pending()).toBe(0);
  });

  it('writes at once when 25 are waiting, in batches of 25', async () => {
    const write = vi.fn(async (_events: UsageEvent[]) => undefined);
    const q = createUsageQueue(write, { flushOnPageHide: false });
    q.track(many(0, 24));
    await vi.advanceTimersByTimeAsync(0);
    expect(write).not.toHaveBeenCalled();
    q.track(many(24, 36));
    await vi.advanceTimersByTimeAsync(0);
    expect(write.mock.calls.map((c) => c[0].length)).toEqual([25, 25, 10]);
  });

  it('writes what’s waiting when the page is hidden', async () => {
    const write = vi.fn(async (_events: UsageEvent[]) => undefined);
    const q = createUsageQueue(write);
    q.track([ev(1)]);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    q.dispose();
  });

  it('never throws to the caller, tries a failed batch once more, then drops it', async () => {
    const write = vi.fn(async (_events: UsageEvent[]): Promise<void> => {
      throw new TypeError('Failed to fetch');
    });
    const q = createUsageQueue(write, { flushOnPageHide: false });
    expect(() => q.track([ev(1), ev(2)])).not.toThrow();
    await expect(q.flush()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    expect(q.pending()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(q.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('keeps new events coming while a retry waits', async () => {
    let fail = true;
    const written: UsageEvent[] = [];
    const q = createUsageQueue(async (events) => {
      if (fail) throw new Error('500');
      written.push(...events);
    }, { flushOnPageHide: false });
    q.track([ev(1)]);
    await q.flush();
    fail = false;
    q.track([ev(2)]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(written.map((e) => e.dedupeKey)).toEqual([ev(1).dedupeKey, ev(2).dedupeKey]);
  });

  it('holds at most the cap, dropping the oldest', async () => {
    const write = vi.fn(async (_events: UsageEvent[]): Promise<void> => {
      throw new Error('offline');
    });
    const q = createUsageQueue(write, { cap: 500, batchSize: 1000, flushOnPageHide: false });
    q.track(many(0, 450));
    q.track(many(450, 100));
    expect(q.pending()).toBe(500);
    const seen: string[] = [];
    write.mockImplementation(async (events: UsageEvent[]) => void seen.push(...events.map((e) => e.dedupeKey)));
    await q.flush();
    expect(seen).toHaveLength(500);
    expect(seen[0]).toBe(ev(50).dedupeKey);
  });

  it('doesn’t make the caller wait on a write that hangs', async () => {
    const q = createUsageQueue(() => new Promise<void>(() => undefined), { batchSize: 1, flushOnPageHide: false });
    const start = Date.now();
    for (let i = 0; i < 100; i++) q.track([ev(i)]);
    expect(Date.now() - start).toBeLessThan(50);
    // One write is stuck; the rest wait their turn in the queue.
    await vi.advanceTimersByTimeAsync(0);
    expect(q.pending()).toBe(99);
  });
});
