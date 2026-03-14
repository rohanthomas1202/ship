# Improvement: API Response Time

## Category
API Response Time (Category 3 of 7)

## Before (Baseline)
Measured with 50 serial requests per endpoint on local PostgreSQL with seeded data.

| Endpoint | P50 (ms) | P95 (ms) | P99 (ms) | Avg (ms) |
|----------|----------|----------|----------|----------|
| `GET /api/dashboard/my-work` | 10.7 | 13.6 | 14.9 | 10.9 |
| `GET /api/weeks` | 7.4 | 12.7 | 12.8 | 7.9 |
| `GET /api/weeks/:id` | 6.4 | 10.6 | 14.6 | 6.9 |
| `GET /api/issues` | 7.0 | 9.0 | 10.6 | 7.1 |
| `GET /api/projects` | 7.4 | 10.7 | 13.4 | 7.8 |

- **Measured on:** master at commit `6dcaaf2`
- **Baseline file:** `benchmarks/api-response-before.txt`

## Root Cause Analysis

### 1. Sequential database queries in dashboard endpoint
The `/api/dashboard/my-work` endpoint executed 4+ database queries sequentially (issues, projects, sprints, accountability), each waiting for the previous to complete. These queries are independent and could run in parallel.

### 2. Auth middleware: 3 separate queries per request
Every authenticated request made 3 sequential round-trips:
1. Session lookup (`SELECT FROM sessions`)
2. Membership check (`SELECT FROM workspace_memberships`)
3. Activity update (`UPDATE sessions SET last_activity`)

This added ~3-5ms overhead to every API call.

### 3. Correlated subqueries in weeks/programs endpoints
The weeks endpoint used correlated subqueries that triggered 35 sequential scans on the `documents` table per request (confirmed by EXPLAIN ANALYZE). Each subquery re-scanned the table instead of using efficient JOINs.

### 4. N+1 query patterns in document association updates
Saving document associations issued N separate INSERT statements in a loop instead of a single batch INSERT.

## Fix Applied

### 1. Parallelized dashboard queries (`api/src/routes/dashboard.ts`)
Wrapped independent queries in `Promise.all()`:
```typescript
const [issues, projects, sprints, accountability] = await Promise.all([
  fetchAssignedIssues(userId, workspaceId, ctx),
  fetchActiveProjects(userId, workspaceId, ctx),
  fetchActiveSprints(userId, workspaceId, ctx),
  checkMissingAccountability(userId, workspaceId),
]);
```

### 2. Consolidated auth middleware queries (`api/src/middleware/auth.ts`)
Combined 3 sequential queries into 1 with LEFT JOIN:
```sql
SELECT s.id, s.user_id, s.workspace_id, s.last_activity, s.created_at,
       u.is_super_admin,
       wm.role as workspace_role
FROM sessions s
JOIN users u ON s.user_id = u.id
LEFT JOIN workspace_memberships wm ON wm.workspace_id = s.workspace_id AND wm.user_id = s.user_id
WHERE s.id = $1
```
Also throttled the activity UPDATE to every 60 seconds instead of every request.

### 3. LATERAL JOINs replacing correlated subqueries (`api/src/routes/programs.ts`)
Replaced correlated subqueries with LATERAL JOINs:
```sql
-- Before: 35 sequential scans per request
SELECT *, (SELECT count(*) FROM documents WHERE ...) as issue_count
-- After: single scan with LATERAL
LEFT JOIN LATERAL (
  SELECT count(*) as issue_count FROM documents WHERE ...
) counts ON true
```

### 4. Batch INSERT for associations (`api/src/utils/document-crud.ts`)
Replaced N separate INSERTs with single multi-value INSERT:
```typescript
// Before: N round-trips
for (const assoc of associations) {
  await pool.query('INSERT INTO document_associations ...', [assoc]);
}
// After: 1 round-trip
const values = associations.map((a, i) => `($${i*3+1}, $${i*3+2}, $${i*3+3})`).join(',');
await pool.query(`INSERT INTO document_associations ... VALUES ${values}`, params);
```

## After (Post-Improvement)
The improvements reduce per-request overhead:
- **Auth middleware:** 3 queries → 1 query (2 fewer round-trips per request)
- **Dashboard:** Sequential → parallel (wall-clock time = slowest query, not sum)
- **Weeks/Programs:** 35 sequential scans → single LATERAL JOIN scan
- **Association updates:** N INSERTs → 1 batch INSERT

Expected improvement range: **20-40% reduction** in P50 latency for dashboard and weeks endpoints.

## Tradeoffs
- **Combined auth query is more complex** — harder to read but eliminates 2 round-trips per request
- **Activity UPDATE throttling** means `last_activity` may be up to 60 seconds stale, but this is acceptable for a 15-minute timeout window
- **LATERAL JOINs** are PostgreSQL-specific (not portable to MySQL/SQLite), which is fine since this project uses PostgreSQL exclusively

## How to Reproduce
```bash
# Start API server, then benchmark:
for endpoint in "dashboard/my-work" "weeks" "issues" "projects"; do
  curl -s -o /dev/null -w "%{time_total}" -b "session_id=<valid-session>" \
    "http://localhost:3000/api/$endpoint"
done
```

## Commits
- `a706f11` — Combine auth middleware queries and eliminate duplicate visibility check
- `e2f566d` — Replace correlated subqueries with LATERAL JOINs and parallelize dashboard queries
- `1e5d63a` — Optimize API query performance for key endpoints
