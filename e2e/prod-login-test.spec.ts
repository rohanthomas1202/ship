import { test, expect } from '@playwright/test';

const PROD_URL = 'https://ship.awsdev.treasury.gov';

test('login to prod with dev@ship.local', async ({ page }) => {
  // Go to login page
  await page.goto(`${PROD_URL}/login`);
  await page.waitForLoadState('networkidle');

  // Take screenshot of login page
  await page.screenshot({ path: 'test-results/prod-login-page.png' });

  // Fill in credentials
  await page.fill('input[type="email"], input[name="email"], input[placeholder*="email" i]', 'dev@ship.local');
  await page.fill('input[type="password"], input[name="password"], input[placeholder*="password" i]', 'admin123');

  // Take screenshot before clicking login
  await page.screenshot({ path: 'test-results/prod-login-filled.png' });

  // Click login button
  await page.click('button[type="submit"]');

  // Wait for response
  await page.waitForTimeout(3000);

  // Take screenshot of result
  await page.screenshot({ path: 'test-results/prod-login-result.png' });

  // Check if we navigated away from login (success) or stayed (failure)
  const url = page.url();
  console.log('Current URL after login:', url);

  // Check for error messages on page
  const pageContent = await page.textContent('body');
  if (pageContent?.includes('Invalid email or password')) {
    console.log('LOGIN FAILED: Invalid credentials');

    // Try to capture the network response
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/auth/login'), { timeout: 5000 }).catch(() => null),
      page.click('button[type="submit"]').catch(() => null),
    ]);

    if (response) {
      const body = await response.json().catch(() => ({}));
      console.log('Login response:', JSON.stringify(body, null, 2));
    }
  } else {
    console.log('LOGIN APPEARS SUCCESSFUL - navigated to:', url);
  }

  // Also try via API directly from playwright context
  const apiResponse = await page.evaluate(async () => {
    // Get CSRF token
    const csrfRes = await fetch('/api/csrf-token', { credentials: 'include' });
    const { token } = await csrfRes.json();

    // Attempt login
    const loginRes = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify({ email: 'dev@ship.local', password: 'admin123' }),
    });

    return {
      status: loginRes.status,
      body: await loginRes.json(),
    };
  });

  console.log('Direct API login result:', JSON.stringify(apiResponse, null, 2));
});
