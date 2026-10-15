import { normalizeProviderId } from '../domain/signing';
import type { SigningProvider, SigningRegistry } from './types';

/** A registry over these connections. Ids must be unique; the first is the fallback. */
export function createSigningRegistry(providers: SigningProvider[]): SigningRegistry {
  if (!providers.length) throw new Error('Folium needs at least one e-signature connection.');
  const byId = new Map(providers.map((p) => [p.id, p]));
  if (byId.size !== providers.length) throw new Error('Two e-signature connections share an id.');
  const warned = new Set<string>();
  return {
    list: () => [...providers],
    has: (id) => byId.has(id),
    get(id) {
      const want = normalizeProviderId(id);
      const found = byId.get(want);
      if (found) return found;
      if (!warned.has(want)) {
        warned.add(want);
        console.warn(`Folium: no e-signature connection “${want}”; using ${providers[0].id}.`);
      }
      return providers[0];
    },
  };
}

/** The same registry with every connection replaced by `fn(connection)` (guards, simulated faults). */
export function mapSigningRegistry(registry: SigningRegistry, fn: (p: SigningProvider) => SigningProvider): SigningRegistry {
  return createSigningRegistry(registry.list().map(fn));
}

/** A connection's methods wrapped one by one; its id, label, kind and capabilities are kept. */
export function wrapProvider(p: SigningProvider, wrap: (name: string, fn: (...a: unknown[]) => Promise<unknown>) => (...a: unknown[]) => Promise<unknown>): SigningProvider {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(p)) {
    out[name] = typeof value === 'function' ? wrap(name, (...args) => (value as (...a: unknown[]) => Promise<unknown>).apply(p, args)) : value;
  }
  return out as unknown as SigningProvider;
}
