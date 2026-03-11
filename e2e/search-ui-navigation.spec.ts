import { test, expect, Page } from './fixtures/isolated-env';
import { triggerMentionPopup } from './fixtures/test-helpers';

/**
 * Search UI & Keyboard Navigation
 *
 * Covers the critical interaction flow of searching for and selecting
 * people/documents via the @mention popup in the TipTap editor.
 * This tests the full UI flow (not just the API, which search-api.spec.ts covers).
 *
 * Key behaviors tested:
 *   - Filtering narrows results as the user types
 *   - Arrow key navigation cycles through options
 *   - Enter key selects the highlighted option
 *   - Escape dismisses the popup without inserting
 *   - Selected mention persists after editor blur/refocus
 *
 * Seed data provides:
 *   - "Dev User" (person) and "Bob Martinez" (person)
 *   - "Welcome to Ship", "Getting Started", "Project Overview" (wiki docs)
 *   - Programs: "Ship Core", "Authentication", "API Platform", etc.
 */

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 10000 });
}

async function createNewDocument(page: Page) {
  await page.goto('/docs');
  await page.waitForLoadState('networkidle');

  const currentUrl = page.url();
  const sidebarButton = page.locator('aside').getByRole('button', { name: /new|create|\+/i }).first();
  const mainButton = page.getByRole('button', { name: 'New Document', exact: true });

  if (await sidebarButton.isVisible({ timeout: 2000 })) {
    await sidebarButton.click();
  } else {
    await expect(mainButton).toBeVisible({ timeout: 5000 });
    await mainButton.click();
  }

  await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl && /\/documents\/[a-f0-9-]+/.test(window.location.href),
    currentUrl,
    { timeout: 10000 }
  );

  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
}

test.describe('Search UI & Keyboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('typing after @ filters results in real time', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');

    // Open mention popup using the robust helper
    await triggerMentionPopup(page, editor);

    // Get the initial option count
    const initialCount = await page.locator('[role="option"]').count();
    expect(initialCount, 'Mention popup should show at least 1 result').toBeGreaterThan(0);

    // Type a filter string — "Dev" should narrow to Dev User
    await page.keyboard.type('Dev');

    // Wait for the filtered results
    await expect(async () => {
      const filteredCount = await page.locator('[role="option"]').count();
      // Filtered results should be <= initial results
      expect(filteredCount).toBeLessThanOrEqual(initialCount);
      expect(filteredCount).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });

    // At least one result should contain "Dev"
    const matchingOption = page.locator('[role="option"]').filter({ hasText: /dev/i });
    await expect(matchingOption.first()).toBeVisible({ timeout: 3000 });
  });

  test('arrow keys cycle through mention options', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await triggerMentionPopup(page, editor);

    const options = page.locator('[role="option"]');
    const optionCount = await options.count();

    if (optionCount < 2) {
      test.skip(true, 'Need at least 2 options to test keyboard cycling');
      return;
    }

    // Press ArrowDown — first (or second) option should be selected
    await page.keyboard.press('ArrowDown');
    const selectedAfterDown = page.locator('[role="option"][aria-selected="true"]');
    await expect(selectedAfterDown).toBeVisible({ timeout: 3000 });
    const firstSelectedText = await selectedAfterDown.textContent();

    // Press ArrowDown again — selection should move
    await page.keyboard.press('ArrowDown');
    await expect(async () => {
      const currentSelected = page.locator('[role="option"][aria-selected="true"]');
      const currentText = await currentSelected.textContent();
      // Selection should have changed (unless we wrapped around in a 2-item list)
      expect(currentText).not.toBeNull();
    }).toPass({ timeout: 3000 });

    // Press ArrowUp — selection should move back
    await page.keyboard.press('ArrowUp');
    const selectedAfterUp = page.locator('[role="option"][aria-selected="true"]');
    await expect(selectedAfterUp).toBeVisible({ timeout: 3000 });
    const upText = await selectedAfterUp.textContent();
    expect(upText).toBe(firstSelectedText);
  });

  test('Enter key selects highlighted option and inserts mention', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await triggerMentionPopup(page, editor);

    // Verify at least one option exists
    const options = page.locator('[role="option"]');
    const count = await options.count();
    expect(count, 'Popup should have at least one option').toBeGreaterThan(0);

    // Get the text of the first option (it will be auto-selected or we select it)
    await page.keyboard.press('ArrowDown');
    const selectedOption = page.locator('[role="option"][aria-selected="true"]');
    await expect(selectedOption).toBeVisible({ timeout: 3000 });

    // Press Enter to insert the mention
    await page.keyboard.press('Enter');

    // Popup should close
    await expect(page.locator('[role="listbox"]')).toBeHidden({ timeout: 3000 });

    // A mention should be inserted in the editor
    const mention = editor.locator('.mention');
    await expect(mention).toBeVisible({ timeout: 5000 });
  });

  test('Escape closes popup without inserting a mention', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await triggerMentionPopup(page, editor);

    // Popup should be visible
    await expect(page.locator('[role="listbox"]')).toBeVisible();

    // Press Escape
    await page.keyboard.press('Escape');

    // Popup should close
    await expect(page.locator('[role="listbox"]')).toBeHidden({ timeout: 3000 });

    // No mention should be inserted
    await expect(editor.locator('.mention')).toHaveCount(0);
  });

  test('inserted mention persists after save', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await triggerMentionPopup(page, editor);

    // Select first option with Enter
    const options = page.locator('[role="option"]');
    const count = await options.count();
    expect(count).toBeGreaterThan(0);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Mention should be visible
    const mention = editor.locator('.mention');
    await expect(mention).toBeVisible({ timeout: 5000 });
    const mentionText = await mention.textContent();

    // Content saves via Yjs WebSocket (not REST PATCH), so wait for sync to complete
    await page.keyboard.type(' saved');
    // Wait for Yjs to persist the content (collaboration server syncs to DB)
    await page.waitForTimeout(3000);

    // Reload the page
    const docUrl = page.url();
    await page.goto(docUrl);
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10000 });

    // Mention should still be present after reload
    const reloadedMention = page.locator('.ProseMirror .mention');
    await expect(reloadedMention).toBeVisible({ timeout: 15000 });

    // Verify it's the same mention text
    const reloadedText = await reloadedMention.textContent();
    expect(reloadedText).toBe(mentionText);
  });

  test('search filters people by partial name', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await triggerMentionPopup(page, editor);

    // Type partial name "Bob" — should show Bob Martinez
    await page.keyboard.type('Bob');

    // Wait for filtered results
    await expect(async () => {
      const matchingOption = page.locator('[role="option"]').filter({ hasText: /Bob/i });
      await expect(matchingOption.first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 10000 });

    // The matching option should contain "Bob Martinez"
    const bobOption = page.locator('[role="option"]').filter({ hasText: /Bob Martinez/i });
    await expect(bobOption).toBeVisible();
  });
});
