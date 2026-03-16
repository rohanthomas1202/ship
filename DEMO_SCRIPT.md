# Demo Script (3-5 minutes)

## Opening (30 seconds)

"I'm Rohan Thomas. I audited the US Department of the Treasury's Ship platform — a full-stack project management app built with React, Express, and PostgreSQL. It features real-time collaborative editing using Yjs CRDTs. I'll walk through my findings and the improvements I shipped across 7 categories."

## Act 1: The Audit — What I Found (60 seconds)

### Type Safety
"The codebase had 211 type safety violations — mostly `as any` casts in test files. The top 5 files alone had 136 violations. Test mocks were completely bypassing TypeScript's type system, meaning type drift between mocks and real implementations would go undetected."

### Database Performance
"Using EXPLAIN ANALYZE, I discovered the weeks endpoint was executing 70 sequential scans per request. Each of the 35 sprints triggered 2 correlated subqueries, each doing a full table scan. The auth middleware was also making 3 separate database round-trips on every single request."

### Bundle Size
"The entire frontend was shipping as a single 2,074 KB JavaScript chunk. No code splitting, no lazy loading — every user downloaded every page on first load."

## Act 2: The Fixes — What I Did (90 seconds)

### Type Safety (211 → 60 violations, 71.6% reduction)
"I created typed mock factories — functions like `mockQueryResult<T>()` that return properly typed objects instead of `as any`. The key insight was that Vitest's `vi.mocked()` picks the void-returning overload of pg's query method, so I used a typed `Mock<>` cast instead. Fixed 151 violations across 6 test files."

### Database Efficiency
"Three targeted fixes:
1. Replaced correlated subqueries with LATERAL JOINs — 70 sequential scans down to 1
2. Consolidated auth from 3 queries to 1 with LEFT JOIN, throttled the activity UPDATE to every 60 seconds
3. Added 5 JSONB expression indexes on hot query paths — these use B-tree lookups instead of generic GIN probes, with partial filters by document_type to keep indexes small"

### Bundle Size (2,074 KB → route-split chunks)
"Implemented React.lazy() for all page components with route-level code splitting. Added manual Vite chunks to separate vendor libraries — the editor alone is 537 KB. Initial App chunk dropped to 88 KB."

### Other Categories
"Also added 15 Playwright E2E tests covering document deletion, workspace roles, and search navigation. Fixed 4 runtime errors including uncaught promise rejections. Applied 18 accessibility improvements for WCAG compliance."

## Act 3: Key Discoveries (45 seconds)

"Three things stood out:

1. **Yjs CRDT Architecture** — The server-authoritative model with 2-second debounced persistence is elegant. Clients get instant updates, database writes are batched. Dual storage — binary CRDT state plus JSON backup — lets REST consumers read without a Yjs client.

2. **Unified Document Model** — Everything lives in one `documents` table with a JSONB `properties` column. Issues, projects, sprints, wikis — same table, same editor, same permission system. Follows Notion's paradigm.

3. **Expression Indexes vs GIN** — Generic GIN indexes on JSONB are versatile but slow for targeted lookups. B-tree expression indexes on specific JSONB paths with partial filters gave us index scans instead of sequential scans."

## Closing (15 seconds)

"All 451 tests pass. 71.6% type safety improvement, database scans reduced from 70 to 1, bundle split from monolith to lazy-loaded chunks. The full audit report, improvement documentation, and benchmarks are all in the repository."
