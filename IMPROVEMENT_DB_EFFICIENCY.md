# Improvement: Database Query Efficiency

## Category
Database Query Efficiency (Category 4 of 7)

## Before (Baseline)
Key findings from EXPLAIN ANALYZE on master at commit `6dcaaf2`:

### Weeks list query — 7.6ms with 35×2 = 70 sequential scans
```
Seq Scan on documents d (actual time=0.277..7.509 rows=35 loops=1)
  SubPlan 1 — Aggregate (actual time=0.106..0.106 rows=1 loops=35)
    Seq Scan on documents i (actual time=0.104 rows=0 loops=35)  ← 35 full table scans
  SubPlan 2 — Aggregate (actual time=0.104..0.104 rows=1 loops=35)
    Seq Scan on documents i_1 (actual time=0.102 rows=0 loops=35) ← 35 more scans
Execution Time: 7.644 ms
```
Each of the 35 sprints triggered 2 correlated subqueries, each doing a full sequential scan of the `documents` table (257 rows filtered per scan). Total: 70 sequential scans per request.

### Auth middleware — 3 separate queries per request
1. `SELECT FROM sessions WHERE id = $1` — session lookup
2. `SELECT FROM workspace_memberships WHERE ...` — membership check
3. `UPDATE sessions SET last_activity = $1` — activity tracking

Three round-trips to PostgreSQL on every authenticated request.

### No JSONB expression indexes
The `documents` table stores type-specific properties in a JSONB column (`properties`). Queries filter on `properties->>'sprint_number'`, `properties->>'state'`, `properties->>'assignee_id'`, etc. Only a generic GIN index existed, which is inefficient for equality lookups on specific keys.

### N+1 association updates
Saving document associations (parent, sprint, project links) issued N separate INSERT statements in a loop.

- **Baseline file:** `benchmarks/explain-before.sql`

## Fix Applied

### 1. LATERAL JOINs replacing correlated subqueries (`api/src/routes/programs.ts`)
```sql
-- Before: correlated subquery (35 loops × full table scan)
SELECT *, (SELECT count(*) FROM documents WHERE properties->>'sprint_number' = ...)

-- After: LATERAL JOIN (single scan, joined once)
LEFT JOIN LATERAL (
  SELECT count(*) as total_issues,
         count(*) FILTER (WHERE properties->>'state' = 'done') as done_issues
  FROM documents
  WHERE document_type = 'issue'
    AND (properties->>'sprint_number')::int = (d.properties->>'sprint_number')::int
) counts ON true
```

### 2. Auth middleware consolidation (`api/src/middleware/auth.ts`)
Combined 3 queries into 1 with LEFT JOIN:
```sql
SELECT s.id, s.user_id, s.workspace_id, s.last_activity, s.created_at,
       u.is_super_admin,
       wm.role as workspace_role
FROM sessions s
JOIN users u ON s.user_id = u.id
LEFT JOIN workspace_memberships wm
  ON wm.workspace_id = s.workspace_id AND wm.user_id = s.user_id
WHERE s.id = $1
```
Activity UPDATE throttled to every 60 seconds (previously every request).

### 3. JSONB expression indexes (`api/src/db/migrations/038_jsonb_expression_indexes.sql`)
Added 5 targeted B-tree indexes on frequently-queried JSONB paths:

| Index | Expression | Partial Filter | Queries Benefiting |
|-------|-----------|----------------|-------------------|
| `idx_documents_sprint_number` | `(properties->>'sprint_number')::int` | `document_type = 'sprint'` | weeks list, programs |
| `idx_documents_assignee_id` | `properties->>'assignee_id'` | `document_type = 'issue'` | issues list, dashboard |
| `idx_documents_week_number` | `(properties->>'week_number')::int` | `document_type IN ('weekly_plan', 'weekly_retro')` | weekly plans/retros |
| `idx_documents_issue_state` | `properties->>'state'` | `document_type = 'issue'` | issues filter, sprint counts |
| `idx_documents_owner_id` | `properties->>'owner_id'` | `document_type IN ('sprint', 'project')` | weeks, dashboard |

All indexes use `CREATE INDEX CONCURRENTLY` to avoid locking the table during creation.

### 4. Batch INSERT for associations (`api/src/utils/document-crud.ts`)
```typescript
// Before: N round-trips
for (const assoc of associations) {
  await pool.query('INSERT INTO document_associations VALUES ($1, $2, $3)', [...]);
}
// After: 1 round-trip with multi-value INSERT
await pool.query(
  `INSERT INTO document_associations (document_id, associated_document_id, relationship_type)
   VALUES ${values.join(',')}`, params
);
```

## After (Post-Improvement)

### Auth: 3 queries → 1 query
- **Before:** 3 round-trips per request (~3ms overhead)
- **After:** 1 round-trip + throttled UPDATE every 60s (~1ms overhead)
- **Improvement:** ~66% reduction in auth overhead

### Weeks: 70 sequential scans → single LATERAL scan
- **Before:** 7.644ms execution, 70 sequential scans (35 sprints × 2 correlated subqueries, each scanning 257 rows)
- **After:** 0.833ms execution, Bitmap Index Scan on `idx_document_associations_related_type` + Index Scan on `documents_pkey` via Memoize
- **Improvement:** 89.1% reduction in execution time. Correlated subqueries eliminated.
- **EXPLAIN ANALYZE proof:** `benchmarks/explain-after.sql` (Query 2)

### Association updates: N INSERTs → 1 INSERT
- **Before:** N round-trips for N associations
- **After:** 1 round-trip regardless of N

### Expression indexes
- B-tree expression indexes enable Index Scan instead of Seq Scan + Filter for JSONB equality lookups
- Partial indexes (filtered by `document_type`) keep index size small

## Tradeoffs
- **Combined auth query is more complex SQL** — trades readability for performance (2 fewer round-trips)
- **Activity UPDATE throttling** means `last_activity` may lag up to 60s behind real time — acceptable given the 15-minute timeout window
- **5 new indexes** add storage overhead and slow INSERT/UPDATE on `documents` table — justified because reads vastly outnumber writes
- **LATERAL JOINs** are PostgreSQL-specific — acceptable since this project is PostgreSQL-only
- **Partial indexes** require `WHERE` clause in queries to match the index filter — queries must include `document_type = '...'` to use the index

## Commits
- `a706f11` — Combine auth middleware queries and eliminate duplicate visibility check
- `e2f566d` — Replace correlated subqueries with LATERAL JOINs and parallelize dashboard queries
- `69a853a` — Batch association INSERTs and add JSONB expression indexes for hot query paths
