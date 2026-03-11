# ShipShape Audit - Video Interview Script

**Repository:** US-Department-of-the-Treasury/ship
**Presenter:** Rohan Thomas
**Estimated Runtime:** 8-12 minutes

---

## INTRO (30-45 seconds)

> Hi, I'm Rohan Thomas. Today I'm presenting my Phase 1 audit of Ship, the Department of the Treasury's collaborative document management platform. Ship is a monorepo with three packages -- an Express API backend, a React and Vite frontend, and a shared TypeScript types package. It uses a unified document model where everything -- wikis, issues, projects, sprints -- lives in a single documents table, with real-time collaboration powered by TipTap, Yjs CRDTs, and WebSocket sync.
>
> This audit covers 7 categories. It's diagnosis only -- no code changes. Every number I'm about to share was verified against a fresh clone of the repository.

---

## CATEGORY 1: TYPE SAFETY (60-90 seconds)

> Starting with type safety. The good news: strict mode is enabled globally across all packages, with extra flags like `noUncheckedIndexedAccess` and `noImplicitReturns`. The shared package has zero type safety violations -- excellent discipline.
>
> Now the findings. I found 267 total `any` type usages -- 109 explicit `: any` annotations and 158 `as any` casts. The overwhelming majority -- 234 out of 267 -- are in the API package. And almost all of those live in test files. The top offender is `transformIssueLinks.test.ts` with 37 violations, followed by `accountability.test.ts` with 32. These tests use `as any` to mock database responses, which masks type drift between mocks and real implementations.
>
> The highest-severity finding here is 274 non-null assertions -- the exclamation mark operator -- scattered across the API and web packages. Patterns like `req.userId!` and `req.workspaceId!` bypass the strict null checks that are otherwise enforced. There's also no runtime schema validation at API boundaries, so request data is trusted based on type assertions alone.
>
> Only 1 `@ts-expect-error` exists in the entire codebase, which is impressively clean.

---

## CATEGORY 2: BUNDLE SIZE (60-75 seconds)

> For bundle size, I ran a production Vite build. The main JavaScript chunk comes in at 2.03 megabytes raw, or about 588 KB gzipped. That exceeds Vite's own 500 KB warning threshold.
>
> The root cause is straightforward: there's no route-level code splitting. All 20-plus page components are statically imported in `main.tsx`, lines 19 through 39. And there's no `manualChunks` configuration in rollup options, so TipTap's 16 packages, Yjs, React Query, dnd-kit, and emoji-picker-react are all bundled into that single chunk.
>
> The codebase does have some smart splitting already in place. Tab-level lazy loading is implemented in `document-tabs.tsx` with 13 lazy-loaded tab components, and SVG icons are individually lazy-loaded across 244 separate chunks. There's also one unused dependency -- `@tanstack/query-sync-storage-persister` -- that's never imported because the codebase uses a custom IndexedDB persister instead.
>
> The largest on-disk dependency is `@uswds/uswds` at 31.3 megabytes, followed by `react-dom` at 4.4 MB and `@tiptap/core` at 4.1 MB.

---

## CATEGORY 3: API RESPONSE TIME (60-90 seconds)

> For API response time, I did a static complexity analysis of the 5 most critical endpoints. Live benchmarks with tools like autocannon or k6 are planned for Phase 2 once the database is seeded.
>
> The dashboard endpoint, `GET /dashboard/my-work`, makes 5 sequential database queries that block on each other -- including a visibility check, then separate queries for documents, issues, and projects, each with their own joins.
>
> The sprint detail endpoint, `GET /weeks/:id`, has the highest query complexity. It runs 8 nested subqueries per row -- 3 COUNT queries, 2 COUNT-greater-than-zero checks, and 3 SELECT subqueries. At scale, this gets expensive fast.
>
> The projects list endpoint, `GET /projects/`, has a ~33-line `inferred_status` subquery that calculates project status from child issues. This subquery is duplicated 3 times in `projects.ts` -- at lines 350, 430, and 794 -- and it runs per row in the result set.
>
> I also observed that the auth middleware uses 2 separate queries per request -- a session lookup plus a membership check -- and the visibility middleware runs a fresh `isWorkspaceAdmin()` query each call with no caching.
>
> My estimated latencies pending live benchmarks: the dashboard at around 150 ms P50, sprint detail around 200 ms P50, and projects list around 200 ms P50 -- but the P99s could hit 500 to 700 ms under load.

---

## CATEGORY 4: DATABASE QUERY EFFICIENCY (60-75 seconds)

> For database query efficiency, I searched all route files for `pool.query` and `client.query` invocations and mapped them against the existing index catalog.
>
> The heaviest file is `weeks.ts` with 84 query invocations, followed by `documents.ts` and `issues.ts` at 60 each, then `projects.ts` at 40.
>
> The codebase has 57-plus indexes, which is solid coverage. All write operations use transactions with proper commit and rollback. All user input uses parameterized queries -- so SQL injection is not a concern. And there's a batch association loading pattern, `getBelongsToAssociationsBatch`, that prevents N+1 query problems. I confirmed no N+1 patterns in any of the 5 user flows I traced.
>
> The key gaps: there are no expression indexes on the most frequently queried JSONB fields -- `assignee_id`, `state`, and `sprint_number`. There's one expression index for `user_id` on person documents and a GIN index on the full `properties` column, but targeted expression indexes on those three fields would significantly improve query performance.
>
> The `ILIKE '%query%'` search pattern triggers a sequential scan -- it's mitigated by LIMIT clauses but there's no trigram or full-text index. And there's zero usage of `EXPLAIN ANALYZE` anywhere in the codebase -- no query performance monitoring at all.

---

## CATEGORY 5: TEST COVERAGE (60-75 seconds)

> Test coverage. The codebase has roughly 1,370 total test cases across 115 files. That breaks down to 488 API unit and integration tests across 28 files, approximately 882 E2E Playwright tests across 71 spec files, and 16 web frontend unit test files.
>
> The E2E suite is strong -- 71 specs covering auth, CRUD operations, accessibility, and security, with only 1 skipped test across all of them. That's excellent test hygiene.
>
> On the weakness side, the web frontend has only 16 test files covering specific components like Icon, Dashboard, SessionTimeout, and some editor features. Many pages and hooks are untested.
>
> The most critical gap is that there's no E2E test for real-time multi-user collaboration -- the WebSocket sync between concurrent editors. Given that this is a core feature of Ship, that's a high-severity gap.
>
> Other untested flows include offline IndexedDB persistence, the OIDC/SSO authentication flow, and CSRF protection enforcement. API code coverage is configured with the v8 provider in vitest config, but it's not part of the default `pnpm test` script.

---

## CATEGORY 6: RUNTIME ERROR HANDLING (45-60 seconds)

> For runtime error handling, there's a solid server-side foundation -- 224 try/catch blocks across the API routes, 588 HTTP error status responses, and a centralized API client on the frontend with comprehensive retry logic: 3 retries, no retry on 4xx, session expiration detection, and CSRF refresh with automatic retry.
>
> WebSocket handling is also well-implemented -- auto-reconnect with a 3-second delay, ping keepalive every 30 seconds, offline detection, and IndexedDB cache fallback.
>
> The main weakness is error boundary coverage. There's only 1 ErrorBoundary component, and it's used in just two places -- `App.tsx` wrapping the main layout and `Editor.tsx`. Individual pages, document tabs, and other feature sections have no granular error boundaries. A crash in any page component takes down the entire app view.
>
> There's also no `window.onerror` or `unhandledrejection` global listener as a safety net, some empty catch blocks in transaction rollback paths that silently swallow errors, and no error tracking or monitoring service integration.

---

## CATEGORY 7: ACCESSIBILITY (45-60 seconds)

> Finally, accessibility. The static analysis shows a strong foundation. I found 232 ARIA attributes total -- 114 `aria-label` instances and 118 `role` attributes covering combobox, menu, tab, tablist, alert, and more. There are `aria-live="polite"` regions on dynamic content like the AccountabilityBanner and Toast components.
>
> Semantic HTML usage is good: 4 `<nav>` elements, 4 `<main>` elements with proper IDs for skip links, 7 headers, and 8 sections. However, there are zero `<article>` or `<footer>` elements -- document content uses divs instead of the semantically appropriate article tag.
>
> There's a dedicated `useFocusOnNavigate` hook for WCAG 2.4.3 compliance, a skip-to-content link that's screen-reader-only but visible on focus, 22 keyboard navigation handlers, and 13 screen-reader-only text instances.
>
> The testing infrastructure is solid -- `@axe-core/playwright` is integrated with 57 targeted remediation tests across 4 spec files covering basic audits, ARIA attributes, and color contrast.
>
> Lighthouse scores and live screen reader testing require a running app and are planned for Phase 2.

---

## CLOSING / PRIORITY SUMMARY (30-45 seconds)

> To summarize the priority matrix: 5 of the 7 categories have high-priority findings.
>
> The biggest impact items are: the 2 MB monolithic bundle with no route-level splitting, the dashboard's 5 sequential queries and sprint detail's 8 nested subqueries, the missing JSONB expression indexes and triplicated inferred_status subquery, the 274 non-null assertions undermining strict mode, and the lack of real-time collaboration E2E tests for a collaboration-first application.
>
> Runtime error handling and accessibility are medium priority -- both have solid foundations but need targeted improvements.
>
> All of these are diagnosed and documented. Phase 2 will focus on implementation -- prioritized by impact and effort -- and live benchmarking once the database is seeded with realistic data. Thank you.

---

## TIPS FOR DELIVERY

- **Open the HTML report** during the video and click through sections as you discuss them. The collapsible sections and bar charts make it visual.
- **Pace yourself** -- each category is roughly 1 minute. If running long, trim the numbers and focus on the "so what" of each finding.
- **Emphasize strengths too** -- the codebase has real positives (strict mode, no N+1s, parameterized queries, strong E2E suite). Audits that only list negatives lose credibility.
- **For Q&A prep**, know: why the latency estimates are estimates (no running DB yet), what Phase 2 priorities would be (bundle splitting and query optimization first), and why non-null assertions matter (they defeat the purpose of strict null checks).
