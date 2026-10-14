import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseEnvelope } from '../state/actions';
import { createDemoServices, resetDemo } from './demo';
import { failureFor, injectFaults } from './demo/faults';
import { classifyError, connectionProblem, FoliumError, repeatsBanner, resetConnection, withRetry, withTimeout } from './errors';
import { guardServices } from './guard';
import type { SendRequest, Services } from './types';

const noWait = { wait: async () => undefined, waitOnline: async () => undefined };

describe('classifyError', () => {
  it('reads SDK token failures as auth', () => {
    expect(classifyError({ message: 'Failed to acquire access token' })).toBe('auth');
    expect(classifyError({ code: 'TOKEN_ACQUISITION_FAILED', message: 'x' })).toBe('auth');
    expect(classifyError(failureFor('auth'))).toBe('auth');
    expect(classifyError({ status: 401 })).toBe('auth');
    expect(classifyError({ error: { message: 'Request failed with status 403' } })).toBe('auth');
  });

  it('reads network failures and being offline as offline', () => {
    expect(classifyError(new TypeError('Failed to fetch'))).toBe('offline');
    expect(classifyError(new Error('NetworkError when attempting to fetch resource.'))).toBe('offline');
    // Offline wins: without a network, token refresh fails too.
    expect(classifyError({ message: 'Failed to acquire access token' }, false)).toBe('offline');
  });

  it('reads timeouts, conflicts and server errors', () => {
    expect(classifyError(new FoliumError('timeout', 'x', 'x took too long'))).toBe('timeout');
    expect(classifyError({ status: 504 })).toBe('timeout');
    expect(classifyError(new Error('The operation timed out'))).toBe('timeout');
    expect(classifyError({ status: 412 })).toBe('conflict');
    expect(classifyError(failureFor('server'))).toBe('server');
    expect(classifyError(new Error('503 Service Unavailable'))).toBe('server');
    expect(classifyError(new Error('Envelope is missing a signer'))).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
  });
});

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects with a timeout error when the call hangs', async () => {
    const p = withTimeout(() => new Promise(() => undefined), 30_000, 'crm.getClient');
    const check = expect(p).rejects.toMatchObject({ kind: 'timeout', op: 'crm.getClient' });
    await vi.advanceTimersByTimeAsync(30_000);
    await check;
  });

  it('passes results and errors through in time', async () => {
    await expect(withTimeout(async () => 7, 1000, 'x')).resolves.toBe(7);
    await expect(withTimeout(async () => Promise.reject(new Error('nope')), 1000, 'x')).rejects.toThrow('nope');
  });
});

describe('withRetry', () => {
  it('tries reads again on offline, timeout and server failures, up to 3 times', async () => {
    for (const err of [new TypeError('Failed to fetch'), new FoliumError('timeout', 'x', 'slow'), failureFor('server')]) {
      let n = 0;
      const out = await withRetry(
        async () => {
          if (++n < 3) throw err;
          return 'ok';
        },
        { op: 'read', ...noWait },
      );
      expect(out).toBe('ok');
      expect(n).toBe(3);
    }
  });

  it('gives up after 3 attempts with a classified error', async () => {
    let n = 0;
    await expect(withRetry(async () => Promise.reject(new TypeError('Failed to fetch')).finally(() => n++), { op: 'read', ...noWait })).rejects.toMatchObject({ kind: 'offline' });
    expect(n).toBe(3);
  });

  it('doesn’t retry auth or unknown failures', async () => {
    for (const err of [failureFor('auth'), new Error('Envelope is missing a signer')]) {
      let n = 0;
      await expect(withRetry(async () => Promise.reject(err).finally(() => n++), { op: 'read', ...noWait })).rejects.toBeInstanceOf(FoliumError);
      expect(n).toBe(1);
    }
  });

  it('waits for the network before trying again when offline', async () => {
    const waitOnline = vi.fn(async () => undefined);
    let n = 0;
    await withRetry(
      async () => {
        if (++n === 1) throw new TypeError('Failed to fetch');
        return 1;
      },
      { op: 'read', wait: async () => undefined, waitOnline },
    );
    expect(waitOnline).toHaveBeenCalledOnce();
  });
});

describe('guarded services', () => {
  beforeEach(() => {
    resetDemo();
    resetConnection();
  });

  /** Demo services whose calls fail with `err` until `okAfter` calls, counting calls per op. */
  function flaky(err: unknown, okAfter = Infinity) {
    const base = createDemoServices();
    const calls: Record<string, number> = {};
    const out = { ...base } as unknown as Record<string, Record<string, unknown>>;
    for (const area of ['crm', 'requests', 'signing'] as const) {
      const target = base[area] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      out[area] = Object.fromEntries(
        Object.entries(target).map(([name, fn]) => [
          name,
          typeof fn === 'function'
            ? async (...args: unknown[]) => {
                const op = `${area}.${name}`;
                calls[op] = (calls[op] ?? 0) + 1;
                if (calls[op] <= okAfter) throw err;
                return fn.apply(target, args);
              }
            : fn,
        ]),
      );
    }
    return { services: guardServices(out as unknown as Services, { retry: { baseMs: 1, onlineWaitMs: 1 } }), calls };
  }

  it('retries reads', async () => {
    const { services, calls } = flaky(new TypeError('Failed to fetch'), 2);
    await expect(services.crm.getClient('c-jordan')).resolves.toMatchObject({ contact: { contactid: 'c-jordan' } });
    expect(calls['crm.getClient']).toBe(3);
  });

  it('never retries writes, including creating an envelope', async () => {
    const { services, calls } = flaky(new TypeError('Failed to fetch'));
    const req = { id: 'x', contactId: 'c-jordan' } as never;
    await expect(services.requests.save(req)).rejects.toMatchObject({ kind: 'offline' });
    await expect(services.signing.create({} as SendRequest)).rejects.toMatchObject({ kind: 'offline' });
    await expect(services.signing.release('e')).rejects.toBeInstanceOf(FoliumError);
    expect(calls['requests.save']).toBe(1);
    expect(calls['signing.create']).toBe(1);
    expect(calls['signing.release']).toBe(1);
  });

  it('raises the connection banner for offline and auth, and clears offline on success', async () => {
    const off = flaky(new TypeError('Failed to fetch'), 3);
    await expect(off.services.crm.getClient('c-jordan')).rejects.toBeTruthy();
    expect(connectionProblem()).toBe('offline');
    expect(repeatsBanner('No connection. Check your network and try again.')).toBe(true);
    await off.services.crm.getClient('c-jordan');
    expect(connectionProblem()).toBeUndefined();

    const auth = flaky(failureFor('auth'));
    await expect(auth.services.crm.getClient('c-jordan')).rejects.toMatchObject({ kind: 'auth' });
    expect(connectionProblem()).toBe('auth');
  });

  it('stops a hung call at its time limit, retries included', async () => {
    const services = guardServices(injectFaults(createDemoServices(), { mode: 'slow', afterMs: 0 }), { timeouts: { normal: 40, long: 80 }, retry: { baseMs: 1 } });
    const t0 = Date.now();
    await expect(services.crm.getClient('c-jordan')).rejects.toMatchObject({ kind: 'timeout' });
    await expect(services.requests.save({} as never)).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('two-step send', () => {
  beforeEach(() => resetDemo());
  const req: SendRequest = { documents: [], signers: [{ role: 'Owner', name: 'Jordan', email: 'j@example.com', order: 1, auth: 'email' }], subject: 's', message: 'm' };

  it('creates the envelope as a draft and sends it on release', async () => {
    const { signing } = createDemoServices();
    const { envelopeId } = await signing.create(req);
    expect((await signing.getStatus(envelopeId)).status).toBe('Drafted');
    expect(await releaseEnvelope(signing, envelopeId, false)).toBe('released');
    expect((await signing.getStatus(envelopeId)).status).toBe('Sent');
  });

  it('resumes after a lost reply without sending twice', async () => {
    const base = createDemoServices();
    const release = vi.spyOn(base.signing, 'release');
    const { signing } = injectFaults(base, { mode: 'release', afterMs: 0 });
    const { envelopeId } = await signing.create(req);
    // DocuSign sent it, but the reply never came back.
    await expect(signing.release(envelopeId)).rejects.toThrow('Failed to fetch');
    expect(release).toHaveBeenCalledTimes(1);
    // Resuming asks first, sees it went out, and doesn't release again.
    expect(await releaseEnvelope(signing, envelopeId, true)).toBe('already sent');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('resumes a release that never happened', async () => {
    const { signing } = createDemoServices();
    const { envelopeId } = await signing.create(req);
    expect(await releaseEnvelope(signing, envelopeId, true)).toBe('released');
    expect((await signing.getStatus(envelopeId)).status).toBe('Sent');
  });
});
