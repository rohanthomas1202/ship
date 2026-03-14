# Discovery Write-Up

Three technical discoveries made while auditing and improving the Ship codebase.

---

## Discovery 1: Yjs CRDT Server-Authoritative Real-Time Collaboration

**File:** `api/src/collaboration/index.ts` (lines 195–344)

### What It Does
Ship uses Yjs CRDTs to implement real-time collaborative editing where PostgreSQL is the single source of truth. When a client connects via WebSocket, the server loads binary Yjs state (`yjs_state` column) from the database into an in-memory `Y.Doc`. Client edits arrive as Yjs sync protocol messages, get applied to the server's authoritative copy, broadcast immediately to other connected clients, and persisted to PostgreSQL on a 2-second debounce.

The key insight is the **separation of real-time sync from persistence**: clients receive updates instantly (sub-millisecond broadcast), while database writes are batched. If the server crashes, clients reconnect and the last-persisted state is authoritative. The system also stores a JSON `content` backup alongside the binary `yjs_state` so REST API consumers can read documents without a Yjs client.

### How to Apply in Future Projects
Use this pattern when building multi-user editing with a persistent backend:
1. **Server-authoritative model** — clients sync to server, server persists. More secure than peer-to-peer since the server controls what gets saved.
2. **Debounce persistence** — don't write to the database on every keystroke. A 2-second debounce reduces write load by 100x during active editing.
3. **Dual storage** — keep both binary CRDT state (for fast sync) and JSON content (for API reads/search).
4. **Graceful migration** — handle documents created via REST API (JSON only) by converting to Yjs state on first WebSocket connection.

---

## Discovery 2: Unified Document Model (Single-Table Inheritance with JSONB)

**File:** `api/src/db/schema.sql` (lines 98–162)

### What It Does
Instead of separate tables for issues, projects, sprints, wikis, persons, and plans, Ship stores **everything** in a single `documents` table with a `document_type` enum discriminator. Type-specific metadata (issue state, assignee, sprint number, priority) lives in a JSONB `properties` column. All document types share the same columns for content, collaboration state, visibility, timestamps, and hierarchy.

This follows Notion's paradigm: the difference between an issue and a project is their properties, not their structure. A document can be converted between types (issue → project) without data migration. The unified model enables a single `Editor` component, a single permission system, and a single `document_associations` table for all cross-references.

### How to Apply in Future Projects
Use single-table inheritance when entity types share 80%+ of their behavior:
1. **Discriminator column** — `document_type` enum makes queries type-safe while keeping one table.
2. **JSONB for type-specific properties** — avoids schema migrations when adding new property fields. Each type can evolve its property shape independently.
3. **Unified editor** — one component handles all types, reducing frontend code by 5-10x vs separate editors.
4. **Tradeoff: lost per-column constraints** — you can't enforce "issues must have a state" at the schema level. Use application-layer validation or CHECK constraints in migrations.

---

## Discovery 3: JSONB Expression Indexes vs Generic GIN Indexes

**File:** `api/src/db/migrations/038_jsonb_expression_indexes.sql` (lines 14–42)

### What It Does
PostgreSQL's generic GIN index on JSONB (`CREATE INDEX ... USING gin (properties)`) indexes all keys and values, making it versatile but slow for targeted equality/range lookups. Ship's migration creates **5 targeted B-tree expression indexes** on frequently-queried JSONB paths, with partial index filters to keep them small:

```sql
CREATE INDEX CONCURRENTLY idx_documents_sprint_number
  ON documents (((properties->>'sprint_number')::int))
  WHERE document_type = 'sprint';
```

Each index extracts a specific JSONB key, casts it to the appropriate type (int, uuid, text), and limits the index to relevant document types via `WHERE`. This turns what was a sequential scan + generic GIN probe into a fast B-tree index lookup.

The before/after was dramatic: the weeks endpoint's correlated subqueries did **35 loops of sequential scans** (each scanning 257 rows) because PostgreSQL couldn't use the GIN index for `(properties->>'sprint_number')::int = $N` comparisons. With the expression index, this becomes an index scan.

### How to Apply in Future Projects
When using JSONB for flexible properties but querying specific paths frequently:
1. **Start with GIN** for development flexibility — it handles all queries adequately at small scale.
2. **Identify hot paths** — use `EXPLAIN ANALYZE` or `pg_stat_user_indexes` to find which JSONB lookups cause sequential scans.
3. **Add expression indexes** on hot paths with the exact expression used in queries (including type casts). The expression must match the query exactly.
4. **Use partial indexes** (`WHERE document_type = '...'`) to keep index size small — an issue-state index doesn't need to include sprint rows.
5. **Use `CONCURRENTLY`** to avoid locking the table during index creation in production.
