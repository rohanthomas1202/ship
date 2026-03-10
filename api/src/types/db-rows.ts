/**
 * Database row interfaces for PostgreSQL query results.
 *
 * These replace `any` parameters on row-extraction functions throughout the API routes,
 * providing compile-time safety without changing any runtime behaviour.
 *
 * The `properties` field is typed as `Record<string, unknown>` because it maps
 * to a PostgreSQL JSONB column whose shape varies by document_type.  Extraction
 * functions narrow this to the appropriate shared property interface.
 */

// ---------------------------------------------------------------------------
// Base document row – columns shared by every `SELECT d.* FROM documents d` query
// ---------------------------------------------------------------------------
export interface DocumentRow {
  id: string;
  workspace_id: string;
  document_type: string;
  title: string;
  content: Record<string, unknown> | null;
  yjs_state: Buffer | null;
  parent_id: string | null;
  position: number;
  properties: Record<string, unknown>;
  ticket_number: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  visibility: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  reopened_at: string | null;
  converted_to_id: string | null;
  converted_from_id: string | null;
  converted_at: string | null;
  converted_by: string | null;
  deleted_at: string | null;
  // canAccessDocument helper adds this via subquery
  can_access?: boolean;
}

// ---------------------------------------------------------------------------
// Joined row variants – extra columns produced by specific route queries
// ---------------------------------------------------------------------------

/** Row returned by issue list queries (joins users for assignee/creator names) */
export interface IssueRow extends DocumentRow {
  assignee_name?: string;
  assignee_archived?: boolean;
  created_by_name?: string;
}

/** Row returned by project list queries (joins owner + counts) */
export interface ProjectRow extends DocumentRow {
  program_id?: string | null;
  owner_id?: string;
  owner_name?: string;
  owner_email?: string;
  sprint_count?: string; // comes as string from COUNT(), parseInt'd in extraction
  issue_count?: string;
  inferred_status?: string;
}

/** Row returned by program list queries (joins owner + counts) */
export interface ProgramRow extends DocumentRow {
  issue_count?: string;
  sprint_count?: string;
  owner_id?: string;
  owner_name?: string;
  owner_email?: string;
}

/** Row returned by sprint/week list queries */
export interface SprintRow extends DocumentRow {
  owner_id?: string;
  owner_name?: string;
  owner_email?: string;
  program_id?: string;
  program_name?: string;
  program_prefix?: string;
  program_accountable_id?: string | null;
  owner_reports_to?: string | null;
  workspace_sprint_start_date?: string;
  issue_count?: string;
  completed_count?: string;
  started_count?: string;
  has_plan?: boolean | string;
  has_retro?: boolean | string;
  retro_outcome?: string | null;
  retro_id?: string | null;
  // Joined from project queries in projects.ts
  project_id?: string | null;
  project_name?: string | null;
  // Alias used in generatePrefilledRetroContent
  sprint_number?: number;
}

/** Row returned by feedback list queries */
export interface FeedbackRow extends DocumentRow {
  program_id?: string;
  program_name?: string;
  program_prefix?: string;
  program_color?: string;
  created_by_name?: string;
}

/** Row returned by standup list queries (joins author user) */
export interface StandupRow {
  id: string;
  parent_id: string | null;
  title: string;
  content: Record<string, unknown> | null;
  author_id: string;
  author_name: string;
  author_email: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// SQL parameter type – replaces `any[]` on dynamic query builders
// ---------------------------------------------------------------------------

/** Union of types that pg accepts as query parameters */
export type SqlParam = string | number | boolean | null | string[] | number[] | Date | Buffer | undefined;
