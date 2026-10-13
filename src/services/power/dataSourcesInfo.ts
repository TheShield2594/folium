import type { getClient } from '@microsoft/power-apps/data';

// `pac code add-data-source` generates the real data-source description in
// `.power/schemas/appschemas/dataSourcesInfo.ts`. Re-export it from here once the
// data sources are added (see docs/DEPLOY.md):
//
//   export { dataSourcesInfo } from '../../../.power/schemas/appschemas/dataSourcesInfo';
//
// Until then this is empty and Folium runs on demo data.

export const dataSourcesInfo: Parameters<typeof getClient>[0] = {};
