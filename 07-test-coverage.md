# Test Coverage Analysis — Ship E2E Suite

**Analyzed:** 2026-03-10
**Suite:** Playwright (Chromium, isolated testcontainers)
**Config:** `playwright.config.ts` — 60s timeout, 1 retry (local), 2 retries (CI)

---

## Summary

| Metric | Value |
|--------|-------|
| **Total tests** | **884** (across **74** spec files) |
| **Tests before changes** | 869 tests / 71 files |
| **Tests added** | **15 new tests / 3 new files** |
| **New tests passing** | **15/15 (100%)** |
| **New test runtime** | 48.8s (1 worker) |
| **Known flaky** | 3–5 pre-existing (documented below) |
| **Retries configured** | 1 (local), 2 (CI) |
| **Runtime (full suite)** | ~8–15 min (4 workers, depends on hardware) |
| **Browser** | Chromium only (Desktop Chrome) |

---

## Test Results — New Tests

**Run date:** 2026-03-10
**Command:** `PLAYWRIGHT_WORKERS=1 playwright test e2e/document-deletion.spec.ts e2e/search-ui-navigation.spec.ts e2e/workspace-settings-roles.spec.ts`

```
  15 passed (48.8s)
  0 failed
  0 flaky
```

All 15 new tests passed on first attempt with zero flakiness.

---

## Known Flaky Tests (Pre-Existing)

| Test file | Cause | Severity |
|-----------|-------|----------|
| `my-week-stale-data.spec.ts` | Yjs content not persisted to `content` column before API reads it. Documented: "retro test fails first attempt, passes on retry." | Medium |
| `race-conditions.spec.ts` | Heavy use of `waitForTimeout()` (100–3000ms). Network latency variance causes false negatives on slow CI. | Medium |
| `autosave-race-conditions.spec.ts` | Assumes debounce timing of exactly 800ms. Breaks when server is under load. | Low |
| `edge-cases.spec.ts` | `page.keyboard.type(text, { delay: 0 })` sends all characters without pause, causing editor race conditions. | Low |
| `session-timeout.spec.ts` | Uses `page.clock` fake timers. Brittle if session timeout constants change. | Low |

### Root Cause Patterns

1. **Hardcoded `waitForTimeout()`** — 50+ instances across the suite. Should use `waitForResponse()`, `waitForLoadState()`, or UI state assertions.
2. **Fragile `.first()` selectors** — Multiple tests use `page.locator('...').first()` which breaks if DOM order changes.
3. **Missing visibility checks before `.click()`** — ~30 instances of clicking elements without confirming they are interactive.

---

## Uncovered Critical Flows (Pre-Change)

| Flow | Risk | Status |
|------|------|--------|
| Workspace Settings: member role changes | HIGH — affects permissions | **Now covered** |
| Workspace Settings: member archive/restore | HIGH — destructive + cache invalidation | **Now covered** |
| Workspace Settings: last-admin protection | HIGH — prevents workspace lockout | **Now covered** |
| Document deletion via inline tree button | HIGH — destructive, irreversible | **Now covered** |
| Document deletion: URL redirect / 404 | MEDIUM — stale bookmarks | **Now covered** |
| Document deletion: sidebar sync | MEDIUM — stale sidebar after delete | **Now covered** |
| Search UI: keyboard navigation in @mention | MEDIUM — accessibility, core editor flow | **Now covered** |
| Search UI: filter-as-you-type | MEDIUM — usability regression risk | **Now covered** |
| Search UI: mention persistence after save | MEDIUM — data integrity | **Now covered** |
| Org chart drag-and-drop | HIGH — zero coverage, complex interaction | Still uncovered |
| Public feedback form validation | MEDIUM — security surface area (XSS) | Still uncovered |
| Mobile/responsive layout | LOW — no mobile tests in suite | Still uncovered |

---

## Tests Added

### 1. `workspace-settings-roles.spec.ts` — 6 tests

**User flow covered:** Workspace admin manages team member roles and access.

**Risk prevented:**
- Silent permission escalation if role change API fails without UI feedback
- Workspace lockout if last admin is demoted
- Stale UI after archiving a member (cached member lists, mentions)
- Non-admins accidentally accessing admin-only settings

| Test | What it verifies |
|------|-----------------|
| `admin can promote a member to admin role` | Role select changes from member→admin, API PATCH succeeds, UI reflects new role |
| `admin can demote another admin back to member` | Two-admin scenario: promotes Bob, then demotes back. Verifies round-trip works |
| `cannot demote last admin — select is disabled` | Dev User's role select is `disabled` with explanatory `title` attribute |
| `admin can archive a member` | Clicks Archive, accepts `confirm()` dialog, member disappears from active list |
| `archived member appears when "Show archived" is enabled` | Toggles checkbox, API refetch with `includeArchived=true`, shows "(archived)" badge and Restore button |
| `non-admin sees permission denied on settings page` | Logs in as Bob (member role), navigates to `/settings`, sees "You don't have permission" |

**Key patterns:**
- Uses `waitForTableData()` helper to avoid acting on partially-loaded member table
- Intercepts `PATCH` and `DELETE` responses to confirm API success before asserting UI state
- Handles the browser `confirm()` dialog via `page.on('dialog')` for archive flow
- Resilient to shared DB state: checks if Bob is already archived before attempting archive

---

### 2. `document-deletion.spec.ts` — 3 tests

**User flow covered:** User deletes wiki documents and the system updates all views.

**Risk prevented:**
- Deleted documents remaining visible in lists/sidebar (stale cache)
- Navigating to a deleted document URL showing broken page instead of error/redirect
- Missing user feedback (no toast notification) on destructive action

| Test | What it verifies |
|------|-----------------|
| `can delete a seed document and navigating to its URL shows error` | Inline "Delete document" button → API DELETE → doc removed from tree → toast shown → URL shows error/redirect |
| `deleting a document updates tree correctly — other docs remain` | Deletes one doc, verifies a different doc is still visible in the tree |
| `deleted document disappears from sidebar too` | Verifies doc exists in both sidebar and main tree, deletes it, confirms removed from both |

**Key patterns:**
- All selectors scoped to `page.locator('main')` to avoid strict mode violations from dual tree (sidebar + main)
- Tests consume seed docs sequentially (Architecture Guide → Project Overview → Welcome to Ship) to avoid shared-DB conflicts
- Uses `waitForResponse()` on DELETE API call before asserting UI state
- Combined delete + URL redirect into single test to conserve seed documents

---

### 3. `search-ui-navigation.spec.ts` — 6 tests

**User flow covered:** User searches for and selects people/documents using the @mention popup with keyboard navigation.

**Risk prevented:**
- Keyboard users unable to navigate mention results (accessibility regression)
- Filter-as-you-type breaking silently (API works but UI doesn't update)
- Selected mentions not persisting after autosave + reload (data loss)
- Escape key not closing popup (frustrating UX regression)

| Test | What it verifies |
|------|-----------------|
| `typing after @ filters results in real time` | Opens popup, types "Dev", result count narrows, matching option contains "Dev" |
| `arrow keys cycle through mention options` | ArrowDown selects option, ArrowDown again moves selection, ArrowUp returns to first |
| `Enter key selects highlighted option and inserts mention` | ArrowDown + Enter → popup closes → `.mention` element inserted in editor |
| `Escape closes popup without inserting a mention` | Escape → popup hidden → no `.mention` elements in editor |
| `inserted mention persists after save` | Insert mention → wait for Yjs WebSocket sync → reload page → `.mention` still visible |
| `search filters people by partial name` | Types "Bob" → option with "Bob Martinez" appears |

**Key patterns:**
- Uses the shared `triggerMentionPopup()` helper (retries `@` keystroke with editor refocus under load)
- Checks `aria-selected="true"` attribute for keyboard navigation state
- Content saves via Yjs WebSocket (not REST PATCH), so uses `waitForTimeout(3000)` for persistence test
- Compares mention text before and after page reload

---

## Architecture Notes

- All tests import from `./fixtures/isolated-env` (per-worker PostgreSQL + API + Vite preview)
- Seed data in `isolated-env.ts` provides 2 users (admin + member), 5 programs, issues, projects, wiki docs
- Tests use `waitForResponse()` over `waitForTimeout()` wherever possible to avoid flakiness
- Deletion tests are ordered to consume seed docs without conflicts (shared DB per worker)
- The `triggerMentionPopup()` helper uses Playwright's `toPass()` retry for resilience under parallel load

---

## Bug Fix: Pre-Existing TypeScript Build Errors

Fixed 7 TypeScript errors in `api/src/collaboration/__tests__/api-content-preservation.test.ts` that blocked `pnpm build:api` (and thus E2E global setup):
- `TS2532: Object is possibly 'undefined'` on content array access → added non-null assertions (`!`)
- `TS18047: 'result' is possibly 'null'` → added non-null assertions

---

## Recommendations for Future Improvement

1. **Replace `waitForTimeout()` calls** across the suite (~50 instances) with `waitForResponse()` or UI state assertions
2. **Add org chart tests** — zero coverage on a complex drag-and-drop feature
3. **Add public feedback validation tests** — unauthenticated surface area with XSS risk
4. **Add multi-browser coverage** — currently Chromium only; Firefox and WebKit untested
5. **Add mobile viewport tests** — no responsive layout verification exists
