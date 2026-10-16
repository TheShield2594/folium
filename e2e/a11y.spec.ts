import { expect, test } from '@playwright/test';
import { ADMIN, ADVISOR, expectNoViolations, go, openAs, openReview } from './helpers';

// Automated WCAG 2.1 AA checks (axe-core) on every main screen, in light and dark.
// They catch what a machine can: names, roles, contrast, labels, ARIA misuse. The
// manual audit in docs/ACCESSIBILITY.md covers the rest.

const ADVISOR_SCREENS = ['/', '/packets', '/recent', '/requests', '/drafts', '/client', '/settings'];
const ADMIN_SCREENS = ['/admin/templates', '/admin/people', '/admin/feedback', '/admin/announcements', '/admin/firm', '/admin/settings', '/admin/readiness'];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} appearance`, () => {
    test('advisor screens', async ({ page }) => {
      await openAs(page, ADVISOR, scheme);
      for (const path of ADVISOR_SCREENS) {
        await test.step(path, async () => {
          await go(page, path);
          await expectNoViolations(page);
        });
      }
    });

    test('administration', async ({ page }) => {
      await openAs(page, ADMIN, scheme);
      for (const path of ADMIN_SCREENS) {
        await test.step(path, async () => {
          await go(page, path);
          await expectNoViolations(page);
        });
      }
    });

    test('review with the PDF and its field overlays, then send', async ({ page }) => {
      await openAs(page, ADVISOR, scheme);
      await openReview(page);
      await expectNoViolations(page);
      await page.getByRole('tab').nth(1).click();
      await expect(page.locator('.pdf-overlay .hl').first()).toBeVisible();
      await expectNoViolations(page);
      await go(page, '/send');
      await expectNoViolations(page);
    });

    test('template editor', async ({ page }) => {
      await openAs(page, ADMIN, scheme);
      await go(page, '/admin/templates');
      await page.locator('a.row-link').first().click();
      await expect(page).toHaveURL(/admin\/templates\/.+/);
      await expect(page.locator('.pdf-overlay').first()).toBeVisible();
      await expectNoViolations(page);
    });
  });
}

test('dialogs and menus', async ({ page }) => {
  await openAs(page, ADVISOR);
  await go(page, '/');
  await page.getByRole('button', { name: /^Preview / }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoViolations(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Ask Marketing to add it' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoViolations(page);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Search everything/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoViolations(page);
  await page.keyboard.press('Escape');

  await openReview(page);
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expectNoViolations(page);
});
