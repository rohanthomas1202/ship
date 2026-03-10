-- Migration 038: Add expression indexes for frequently-queried JSONB properties
--
-- These JSONB paths are used in WHERE clauses and JOIN conditions across many routes
-- but currently rely on the generic GIN index on properties, which is less efficient
-- for equality/range lookups than dedicated B-tree expression indexes.
--
-- Queries benefiting:
--   - GET /api/weeks (sprint_number filter): idx_documents_sprint_number
--   - GET /api/issues (assignee filter): idx_documents_assignee_id
--   - GET /api/dashboard/my-week (week_number filter): idx_documents_week_number
--   - GET /api/issues (state filter): idx_documents_issue_state
--   - GET /api/weeks, /api/programs/:id/sprints (owner_id join): idx_documents_owner_id

-- Sprint number: used in WHERE (properties->>'sprint_number')::int = $N
-- Covers: GET /api/weeks, GET /api/programs/:id/sprints, GET /api/dashboard/my-work
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_sprint_number
  ON documents (((properties->>'sprint_number')::int))
  WHERE document_type = 'sprint';

-- Assignee ID: used in WHERE (properties->>'assignee_id')::uuid = $N
-- Covers: GET /api/issues?assignee_id=, GET /api/dashboard/my-work
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_assignee_id
  ON documents ((properties->>'assignee_id'))
  WHERE document_type = 'issue';

-- Week number: used in WHERE (properties->>'week_number')::int = $N
-- Covers: GET /api/dashboard/my-week, GET /api/weekly-plans, GET /api/weekly-retros
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_week_number
  ON documents (((properties->>'week_number')::int))
  WHERE document_type IN ('weekly_plan', 'weekly_retro');

-- Issue state: used in WHERE properties->>'state' = 'done' and similar
-- Covers: GET /api/issues?state=, sprint issue counts, dashboard
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_issue_state
  ON documents ((properties->>'state'))
  WHERE document_type = 'issue';

-- Owner ID: used in JOIN conditions and WHERE for sprint/project owner lookups
-- Covers: GET /api/weeks, GET /api/dashboard/my-work (sprints query)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_owner_id
  ON documents ((properties->>'owner_id'))
  WHERE document_type IN ('sprint', 'project');
