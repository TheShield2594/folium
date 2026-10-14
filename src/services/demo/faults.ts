import type { Services } from '../types';
import { createUsageQueue, type UsageQueue } from '../usage';
import { demoUsageWriter } from './index';

// Simulated failures for trying the recovery paths by hand, in demo mode only:
//
//   ?demo=1&fail=offline   every call fails as if the network dropped
//   ?demo=1&fail=slow      every call hangs, so time limits kick in
//   ?demo=1&fail=auth      every call fails with the SDK's token error
//   ?demo=1&fail=server    every call fails with a 500
//   ?demo=1&fail=send      the first envelope is created, but the reply is lost
//   ?demo=1&fail=release   the first envelope goes out, but the reply is lost
//
// The first four start `failAfter` seconds after launch (default 10) so Folium can
// boot first; `failAfter=0` fails from the start.

export type FaultMode = 'offline' | 'slow' | 'auth' | 'server' | 'send' | 'release';
const MODES: FaultMode[] = ['offline', 'slow', 'auth', 'server', 'send', 'release'];

export interface FaultPlan {
  mode: FaultMode;
  afterMs: number;
}

function params(): URLSearchParams {
  const p = new URLSearchParams(location.search);
  const hashQuery = location.hash.split('?')[1];
  if (hashQuery) new URLSearchParams(hashQuery).forEach((v, k) => p.set(k, v));
  return p;
}

export function faultFromUrl(): FaultPlan | undefined {
  const p = params();
  const mode = p.get('fail') as FaultMode | null;
  if (!mode || !MODES.includes(mode)) return undefined;
  const after = Number(p.get('failAfter') ?? 10);
  return { mode, afterMs: Number.isFinite(after) ? after * 1000 : 10_000 };
}

export function failureFor(mode: FaultMode): Error {
  switch (mode) {
    case 'auth':
      return Object.assign(new Error('Failed to acquire access token'), { code: 'TOKEN_ACQUISITION_FAILED' });
    case 'server':
      return Object.assign(new Error('Internal Server Error'), { status: 500 });
    default:
      return new TypeError('Failed to fetch');
  }
}

export function injectFaults(services: Services, plan: FaultPlan, now: () => number = Date.now): Services {
  const start = now();
  const active = () => now() - start >= plan.afterMs;
  const out = { ...services } as unknown as Record<string, unknown>;

  if (plan.mode === 'send' || plan.mode === 'release') {
    let spent = false;
    const signing = { ...services.signing };
    const step = plan.mode === 'send' ? 'create' : 'release';
    const real = services.signing[step].bind(services.signing) as (...a: unknown[]) => Promise<unknown>;
    (signing as Record<string, unknown>)[step] = async (...args: unknown[]) => {
      const result = await real(...args);
      if (spent) return result;
      spent = true;
      // DocuSign did the work; the reply never arrived.
      throw new TypeError('Failed to fetch');
    };
    out.signing = signing;
    return out as unknown as Services;
  }

  for (const area of ['directory', 'crm', 'templates', 'drafts', 'requests', 'packets', 'signing', 'feedback'] as const) {
    const target = services[area] as unknown as Record<string, unknown>;
    const wrapped: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(target)) {
      wrapped[name] =
        typeof fn !== 'function'
          ? fn
          : async (...args: unknown[]) => {
              if (active()) {
                if (plan.mode === 'slow') await new Promise(() => undefined);
                throw failureFor(plan.mode);
              }
              return (fn as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            };
    }
    out[area] = wrapped;
  }
  // Usage writes fail (or hang) too, to show they never hold up the advisor.
  (services.usage as Partial<UsageQueue>).dispose?.();
  out.usage = createUsageQueue(async (events) => {
    if (active()) {
      if (plan.mode === 'slow') await new Promise(() => undefined);
      throw failureFor(plan.mode);
    }
    return demoUsageWriter(events);
  });
  return out as unknown as Services;
}
