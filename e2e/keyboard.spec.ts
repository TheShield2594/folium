import { expect, test } from '@playwright/test';
import { ADMIN, ADVISOR, expectNoViolations, go, openAs, openReview } from './helpers';

// What the audit fixed, kept fixed: keyboard paths and what screen readers are told.

test('skip link goes past the sidebar to the screen', async ({ page }) => {
  await openAs(page, ADVISOR);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('each screen names the browser tab', async ({ page }) => {
  await openAs(page, ADVISOR);
  await go(page, '/requests');
  await expect(page).toHaveTitle(/.+ – Folium$/);
  const first = await page.title();
  await go(page, '/settings');
  await expect(page).not.toHaveTitle(first);
});

test('PDF overlay: page order, labels, and checks linked to fields', async ({ page }) => {
  await openAs(page, ADVISOR);
  await openReview(page);

  // Pages are named groups.
  await expect(page.getByRole('group', { name: /^Page 1 of \d+$/ })).toBeVisible();

  // Field boxes are in reading order: top to bottom, then left to right.
  const boxes = page.locator('.pdf-overlay').first().locator('button.hl');
  const rects = await boxes.evaluateAll((els) => els.map((e) => ({ top: parseFloat((e as HTMLElement).style.top), left: parseFloat((e as HTMLElement).style.left) })));
  expect(rects.length).toBeGreaterThan(3);
  for (let i = 1; i < rects.length; i++) {
    const [a, b] = [rects[i - 1], rects[i]];
    expect(a.top < b.top || (a.top === b.top && a.left <= b.left), `box ${i} is out of reading order`).toBe(true);
  }

  // A field that needs input says so, and is described by the check about it.
  const need = page.locator('button.hl-need').first();
  await expect(need).toHaveAccessibleName(/needs input|invalid/);
  const described = await page.locator('button.hl[aria-describedby]').count();
  expect(described).toBeGreaterThan(0);
  const ids = (await page.locator('button.hl[aria-describedby]').first().getAttribute('aria-describedby'))!.split(' ');
  for (const id of ids) await expect(page.locator(`#${id}`)).toHaveCount(1);

  // Activating a box puts the keyboard in its input, which is labelled and marked.
  await need.focus();
  await page.keyboard.press('Enter');
  const input = page.locator('.review-side :focus');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAttribute('aria-required', 'true');

  // Signer-only and preview fields are text, not buttons that do nothing.
  await expect(page.locator('.pdf-overlay button.hl-signer')).toHaveCount(0);
});

test('form tabs move with the arrow keys', async ({ page }) => {
  await openAs(page, ADVISOR);
  await openReview(page);
  const tabs = page.getByRole('tab');
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'doc-tab-1');
  await page.keyboard.press('Home');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
});

test('dialogs keep and return focus', async ({ page }) => {
  await openAs(page, ADVISOR);
  await go(page, '/');
  const ask = page.getByRole('button', { name: 'Ask Marketing to add it' });
  await ask.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(ask).toBeFocused();
});

test('templates open from the keyboard', async ({ page }) => {
  await openAs(page, ADMIN);
  await go(page, '/admin/templates');
  await page.locator('a.row-link').first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/admin\/templates\/.+/);
});

// 1.4.10 Reflow: 320 CSS px is 1280 px at 400% zoom. No sideways scrolling of the page;
// a data table may scroll inside its own (keyboard-scrollable) box, which axe checks.
test.describe('reflow at 400% zoom', () => {
  test.use({ viewport: { width: 320, height: 640 } });
  const pageOverflow = (page: import('@playwright/test').Page) =>
    page.evaluate(() => Math.max(...[document.documentElement, document.querySelector<HTMLElement>('main')!].map((el) => el.scrollWidth - el.clientWidth)));
  for (const [who, paths] of [
    [ADVISOR, ['/', '/requests', '/drafts', '/client', '/settings', '/review', '/send']],
    [ADMIN, ['/admin/templates', '/admin/people', '/admin/readiness', '/admin/settings']],
  ] as const) {
    for (const path of paths) {
      test(path, async ({ page }) => {
        await openAs(page, who);
        if (path === '/review' || path === '/send') await openReview(page);
        await go(page, path);
        expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
        // The primary action stays on screen.
        for (const b of await page.locator('.toolbar .btn-filled').all()) {
          const box = (await b.boundingBox())!;
          expect(box.x + box.width).toBeLessThanOrEqual(321);
        }
        await expectNoViolations(page);
      });
    }
  }
});
