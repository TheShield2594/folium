import { createContext, useContext } from 'react';
import { createDemoServices } from './demo';
import { faultFromUrl, injectFaults } from './demo/faults';
import { guardServices } from './guard';
import { dataSourcesInfo } from './power/dataSourcesInfo';
import type { Services } from './types';

/**
 * Folium runs against Power Platform when the app has data sources registered
 * (`pac code add-data-source`) and isn't forced into demo mode with `?demo=1`.
 * Otherwise it uses in-browser demo services so the UI is fully usable anywhere.
 */
export async function createServices(): Promise<Services> {
  const forceDemo = new URLSearchParams(location.search).has('demo') || import.meta.env.VITE_FOLIUM_DEMO === '1';
  if (!forceDemo && Object.keys(dataSourcesInfo).length > 0) {
    const { createPowerServices } = await import('./power');
    return guardServices(createPowerServices());
  }
  // `?fail=offline|slow|auth|server|send|release` simulates failures (see demo/faults.ts).
  const fault = faultFromUrl();
  const demo = createDemoServices();
  return guardServices(fault ? injectFaults(demo, fault) : demo);
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext missing');
  return s;
}
