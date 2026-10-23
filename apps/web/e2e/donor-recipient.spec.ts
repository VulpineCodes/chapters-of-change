import { test, expect } from '@playwright/test';

/**
 * Donor→recipient journey at the UI level:
 * a visitor lands, browses listings (the recipient's discovery step),
 * and both role dashboards render. The service-layer workflow itself
 * (request → approve → ship → deliver → complete) is covered end-to-end
 * by the Vitest integration suite in packages/app-services; this spec
 * verifies the pages a user actually walks through.
 */
test.describe('donor→recipient journey', () => {
  test('home page explains the platform and links to listings', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Stories deserve a second reader.' })).toBeVisible();
    await expect(page.getByText('connects people donating used comic books and manga')).toBeVisible();
    await page.getByRole('link', { name: /Browse available comics/ }).click();
    await expect(page).toHaveURL(/\/listings$/);
    await expect(page.getByRole('heading', { name: 'Browse comics & manga' })).toBeVisible();
  });

  test('listings page offers search/filter and an honest empty state', async ({ page }) => {
    await page.goto('/listings');
    await expect(page.getByRole('heading', { name: 'Browse comics & manga' })).toBeVisible();
    await expect(page.getByLabel('Search titles')).toBeVisible();
    await expect(page.getByLabel('Genre')).toBeVisible();
    // The API is fully wired to the workflow service, but its seed data
    // creates organizations/users only — no listings — so the designed
    // empty state is what a user sees — asserted explicitly, not hidden.
    await expect(page.getByRole('heading', { name: 'No listings match your search' })).toBeVisible();

    // Filtering re-queries and keeps the empty state for an unmatched genre.
    await page.getByLabel('Genre').selectOption('Manga');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/genre=Manga/);
    await expect(page.getByRole('heading', { name: 'No listings match your search' })).toBeVisible();
  });

  test('donor dashboard renders for the approval side of the workflow', async ({ page }) => {
    await page.goto('/dashboard/donor');
    await expect(page.getByRole('heading', { name: 'Donor dashboard' })).toBeVisible();
    await expect(page.getByText(/donation requests awaiting your approval/)).toBeVisible();
  });

  test('organization dashboard renders for the requesting side of the workflow', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Organization dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard\/org$/);
    await expect(page.getByRole('heading', { name: 'Organization dashboard' })).toBeVisible();
    await expect(page.getByText(/track approvals and deliveries/)).toBeVisible();
  });

  test('navigation connects all three surfaces', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Browse comics' }).click();
    await expect(page).toHaveURL(/\/listings$/);
    await page.getByRole('link', { name: 'Donor dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard\/donor$/);
    await page.getByRole('link', { name: 'Organization dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard\/org$/);
  });
});
