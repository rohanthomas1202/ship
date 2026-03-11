import { test, expect, Page } from './fixtures/isolated-env';

/**
 * Document Deletion Workflow
 *
 * Covers the critical destructive flow of deleting wiki documents:
 * - Delete via inline "Delete document" button in tree view
 * - Verify the document is removed from both main tree and sidebar
 * - Verify navigating to a deleted document URL shows error/redirect
 *
 * IMPORTANT: The docs page has TWO trees — sidebar and main content.
 * Selectors must be scoped to avoid strict mode violations.
 *
 * Tests share a DB per worker and run sequentially, so each test
 * consumes seed documents. Order is carefully chosen so that:
 *   1. "delete + URL redirect" uses "Architecture Guide" (3 docs → 2)
 *   2. "multiple deletes" uses "Project Overview" + "Welcome to Ship" (2 docs → 1)
 *   3. "sidebar removal" uses "Welcome to Ship" (1 doc → 0)
 *
 * Seed data provides: "Welcome to Ship", "Project Overview", "Architecture Guide"
 */

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 10000 });
}

test.describe('Document Deletion Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('can delete a seed document and navigating to its URL shows error', async ({ page }) => {
    await page.goto('/docs');
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible({ timeout: 10000 });

    // Scope to main content tree to avoid matching sidebar tree too
    const mainTree = page.locator('main');
    const archGuide = mainTree.getByRole('treeitem').filter({ hasText: 'Architecture Guide' });
    await expect(archGuide).toBeVisible({ timeout: 10000 });

    // Capture the document URL before deletion
    const docLink = archGuide.getByRole('link');
    const href = await docLink.getAttribute('href');
    expect(href).toBeTruthy();

    // Set up response listener BEFORE clicking delete
    const deletePromise = page.waitForResponse(
      resp => resp.url().includes('/api/documents/') && resp.request().method() === 'DELETE'
    );

    // Click the inline "Delete document" button within this tree item
    await archGuide.getByRole('button', { name: 'Delete document' }).click();
    await deletePromise;

    // Document should be removed from the main tree
    await expect(archGuide).toBeHidden({ timeout: 5000 });

    // Toast notification should appear
    await expect(page.getByText(/deleted/i)).toBeVisible({ timeout: 5000 });

    // Navigate to the deleted document's URL
    await page.goto(href!);

    // Should either redirect away or show an error state
    await expect(async () => {
      const currentUrl = page.url();
      const pageText = await page.textContent('body');
      const redirected = !currentUrl.includes(href!);
      const showsError = /not found|doesn't exist|error|deleted/i.test(pageText || '');
      expect(redirected || showsError, 'Deleted document should redirect or show error').toBeTruthy();
    }).toPass({ timeout: 10000 });
  });

  test('deleting a document updates tree correctly — other docs remain', async ({ page }) => {
    await page.goto('/docs');
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible({ timeout: 10000 });

    const mainTree = page.locator('main');
    const projectOverview = mainTree.getByRole('treeitem').filter({ hasText: 'Project Overview' });
    const welcomeDoc = mainTree.getByRole('treeitem').filter({ hasText: 'Welcome to Ship' });
    await expect(projectOverview).toBeVisible({ timeout: 10000 });
    await expect(welcomeDoc).toBeVisible({ timeout: 10000 });

    // Delete "Project Overview"
    const deletePromise = page.waitForResponse(
      resp => resp.url().includes('/api/documents/') && resp.request().method() === 'DELETE'
    );
    await projectOverview.getByRole('button', { name: 'Delete document' }).click();
    await deletePromise;

    // Deleted doc should be gone, other doc should remain
    await expect(projectOverview).toBeHidden({ timeout: 5000 });
    await expect(welcomeDoc).toBeVisible();
  });

  test('deleted document disappears from sidebar too', async ({ page }) => {
    await page.goto('/docs');
    await page.waitForLoadState('networkidle');

    // Verify doc exists in both sidebar and main tree
    const sidebarDoc = page.locator('aside').getByText('Welcome to Ship');
    await expect(sidebarDoc).toBeVisible({ timeout: 10000 });

    const mainTree = page.locator('main');
    const mainTreeItem = mainTree.getByRole('treeitem').filter({ hasText: 'Welcome to Ship' });
    await expect(mainTreeItem).toBeVisible({ timeout: 5000 });

    // Delete via main content area
    const deletePromise = page.waitForResponse(
      resp => resp.url().includes('/api/documents/') && resp.request().method() === 'DELETE'
    );
    await mainTreeItem.getByRole('button', { name: 'Delete document' }).click();
    await deletePromise;

    // Should be removed from BOTH main tree and sidebar
    await expect(mainTreeItem).toBeHidden({ timeout: 5000 });
    await expect(sidebarDoc).toBeHidden({ timeout: 5000 });
  });
});
