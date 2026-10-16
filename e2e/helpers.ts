import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.0 and 2.1, levels A and AA: the bar in docs/ACCESSIBILITY.md. */
export const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export const ADVISOR = 'usr-advisor-1';
export const ADMIN = 'usr-admin-1';

/** Open the demo as someone (it remembers who in localStorage), with fresh sample data. */
export async function openAs(page: Page, userId: string, scheme: 'light' | 'dark' = 'light') {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.goto('./');
  await expect(page.getByRole('navigation', { name: 'Folium' })).toBeVisible();
  await page.evaluate((id) => {
    const state = JSON.parse(localStorage.getItem('folium.demo.v1') ?? '{}');
    localStorage.setItem('folium.demo.v1', JSON.stringify({ ...state, currentUserId: id }));
  }, userId);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Folium' })).toBeVisible();
}

export async function go(page: Page, path: string) {
  await page.evaluate((p) => (location.hash = `#${p}`), path);
  await expect(page.locator('.toolbar').first()).toBeVisible();
}

/** Run axe against the page (or part of it) and fail with a readable list of what's wrong. */
export async function expectNoViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_AA);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  const report = violations.flatMap((v) => v.nodes.map((n) => `${v.impact} ${v.id}: ${v.help}\n    ${n.target.join(' ')}\n    ${n.failureSummary?.replace(/\n/g, '\n    ')}`));
  expect(report, report.join('\n')).toEqual([]);
}

/** Put two forms in the packet and open Review with the PDF drawn. */
export async function openReview(page: Page) {
  await go(page, '/');
  const add = page.getByRole('button', { name: /^Add .* to packet$/ });
  await add.first().click();
  await add.first().click();
  await go(page, '/review');
  await expect(page.locator('.pdf-overlay .hl').first()).toBeVisible();
}
