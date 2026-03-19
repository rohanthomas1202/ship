/**
 * FleetGraph fetch nodes — pull data from Ship's database.
 * These run inside the same Express process, so they query the DB directly
 * rather than making HTTP calls to ourselves.
 */

import type { Pool } from 'pg';
import type { FleetGraphState } from '@ship/shared';

export async function fetchActivity(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;

  // Get activity counts for the last 24 hours for all active projects
  const result = await pool.query(
    `SELECT da.related_id AS project_id,
            COUNT(DISTINCT d.id) AS activity_count
     FROM documents d
     JOIN document_associations da ON da.document_id = d.id
     WHERE da.relationship_type = 'project'
       AND d.workspace_id = $1
       AND d.updated_at > NOW() - INTERVAL '5 minutes'
       AND d.deleted_at IS NULL
       AND d.archived_at IS NULL
     GROUP BY da.related_id`,
    [workspaceId]
  );

  const activity: Record<string, Array<{ date: string; count: number }>> = {};
  for (const row of result.rows) {
    activity[row.project_id] = [{ date: new Date().toISOString(), count: Number(row.activity_count) }];
  }

  return { ...state, data: { ...state.data, activity } };
}

export async function fetchIssues(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;

  // For proactive: fetch all non-done issues in active sprints
  // For on-demand: fetch issues related to the trigger entity
  let issues;

  if (state.mode === 'on_demand' && state.trigger.entity) {
    const entity = state.trigger.entity;
    if (entity.type === 'dashboard' || !entity.id || entity.id === 'dashboard') {
      // Dashboard scope — get all issues workspace-wide
      const result = await pool.query(
        `SELECT d.*
         FROM documents d
         WHERE d.document_type = 'issue' AND d.workspace_id = $1
           AND d.deleted_at IS NULL
         ORDER BY d.updated_at DESC LIMIT 50`,
        [workspaceId]
      );
      issues = result.rows;
    } else if (entity.type === 'issue') {
      const result = await pool.query(
        `SELECT d.*, da_list.associations
         FROM documents d
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('type', da.relationship_type, 'id', da.related_id)) AS associations
           FROM document_associations da WHERE da.document_id = d.id
         ) da_list ON true
         WHERE d.id = $1 AND d.workspace_id = $2`,
        [entity.id, workspaceId]
      );
      issues = result.rows;
    } else if (entity.type === 'sprint') {
      const result = await pool.query(
        `SELECT d.*, da_list.associations
         FROM documents d
         JOIN document_associations da ON da.document_id = d.id AND da.relationship_type = 'sprint' AND da.related_id = $1
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('type', da2.relationship_type, 'id', da2.related_id)) AS associations
           FROM document_associations da2 WHERE da2.document_id = d.id
         ) da_list ON true
         WHERE d.document_type = 'issue' AND d.workspace_id = $2 AND d.deleted_at IS NULL`,
        [entity.id, workspaceId]
      );
      issues = result.rows;
    } else {
      // Project scope — get all issues associated with this project
      const result = await pool.query(
        `SELECT d.*, da_list.associations
         FROM documents d
         JOIN document_associations da ON da.document_id = d.id AND da.relationship_type = 'project' AND da.related_id = $1
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('type', da2.relationship_type, 'id', da2.related_id)) AS associations
           FROM document_associations da2 WHERE da2.document_id = d.id
         ) da_list ON true
         WHERE d.document_type = 'issue' AND d.workspace_id = $2 AND d.deleted_at IS NULL`,
        [entity.id, workspaceId]
      );
      issues = result.rows;
    }
  } else {
    // Proactive: get all open issues in active projects with recent activity
    const activeProjectIds = Object.keys(state.data.activity);
    if (activeProjectIds.length === 0) {
      return { ...state, data: { ...state.data, issues: [] } };
    }

    const result = await pool.query(
      `SELECT d.*, da_list.associations
       FROM documents d
       JOIN document_associations da ON da.document_id = d.id AND da.relationship_type = 'project' AND da.related_id = ANY($1::uuid[])
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('type', da2.relationship_type, 'id', da2.related_id)) AS associations
         FROM document_associations da2 WHERE da2.document_id = d.id
       ) da_list ON true
       WHERE d.document_type = 'issue'
         AND d.workspace_id = $2
         AND d.deleted_at IS NULL
         AND d.archived_at IS NULL
         AND (d.properties->>'state') NOT IN ('done', 'cancelled')`,
      [activeProjectIds, workspaceId]
    );
    issues = result.rows;
  }

  return { ...state, data: { ...state.data, issues: issues || [] } };
}

export async function fetchSprintDetail(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;

  let sprints;

  if (state.mode === 'on_demand' && state.trigger.entity?.type === 'sprint') {
    const result = await pool.query(
      `SELECT * FROM documents WHERE id = $1 AND workspace_id = $2`,
      [state.trigger.entity.id, workspaceId]
    );
    sprints = result.rows;
  } else {
    // Get active sprints
    const result = await pool.query(
      `SELECT * FROM documents
       WHERE document_type = 'sprint'
         AND workspace_id = $1
         AND deleted_at IS NULL
         AND archived_at IS NULL`,
      [workspaceId]
    );
    sprints = result.rows;
  }

  return { ...state, data: { ...state.data, sprints: sprints || [] } };
}

export async function fetchProjectDetail(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;

  let projects;

  if (state.mode === 'on_demand' && state.trigger.entity?.type === 'project') {
    const result = await pool.query(
      `SELECT * FROM documents WHERE id = $1 AND workspace_id = $2`,
      [state.trigger.entity.id, workspaceId]
    );
    projects = result.rows;
  } else {
    const result = await pool.query(
      `SELECT * FROM documents
       WHERE document_type = 'project'
         AND workspace_id = $1
         AND deleted_at IS NULL
         AND archived_at IS NULL`,
      [workspaceId]
    );
    projects = result.rows;
  }

  return { ...state, data: { ...state.data, projects: projects || [] } };
}

export async function fetchTeam(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;

  const result = await pool.query(
    `SELECT d.*, u.name AS user_name, u.email AS user_email
     FROM documents d
     LEFT JOIN users u ON u.id = (d.properties->>'user_id')::uuid
     WHERE d.document_type = 'person'
       AND d.workspace_id = $1
       AND d.deleted_at IS NULL
       AND d.archived_at IS NULL`,
    [workspaceId]
  );

  return { ...state, data: { ...state.data, team: result.rows } };
}

export async function fetchHistory(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  // Get recent document history for issues in scope
  const issueIds = state.data.issues.map((i: any) => i.id);
  if (issueIds.length === 0) {
    return { ...state, data: { ...state.data, document_history: [] } };
  }

  try {
    const result = await pool.query(
      `SELECT * FROM document_history
       WHERE document_id = ANY($1::uuid[])
       ORDER BY created_at DESC
       LIMIT 500`,
      [issueIds]
    );
    return { ...state, data: { ...state.data, document_history: result.rows } };
  } catch {
    // Table may not exist in some environments — degrade gracefully
    return { ...state, data: { ...state.data, document_history: [] } };
  }
}

export async function fetchAccountability(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  // For on-demand, we fetch accountability items for the current user
  // For proactive, we skip this (too broad)
  if (state.mode === 'proactive') {
    return state;
  }

  // Simplified: fetch overdue accountability items workspace-wide
  // The actual implementation would use the accountability service
  return state;
}
