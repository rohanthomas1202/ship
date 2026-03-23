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
  const projectId = state.trigger.project_id;

  // Get activity counts for the last 24 hours for active projects
  // When project_id is set, scope to that single project
  const params: any[] = [workspaceId];
  let projectFilter = '';
  if (projectId) {
    projectFilter = 'AND da.related_id = $2';
    params.push(projectId);
  }

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
       ${projectFilter}
     GROUP BY da.related_id`,
    params
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
    const projectId = state.trigger.project_id;
    const activeProjectIds = projectId ? [projectId] : Object.keys(state.data.activity);
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

  // Also fetch workspace_start_date for sprint date calculations
  let workspaceStartDate = state.data.workspace_start_date;
  if (!workspaceStartDate) {
    try {
      const wsResult = await pool.query(
        `SELECT sprint_start_date FROM workspaces WHERE id = $1`,
        [workspaceId]
      );
      if (wsResult.rows[0]?.sprint_start_date) {
        const raw = wsResult.rows[0].sprint_start_date;
        workspaceStartDate = raw instanceof Date
          ? raw.toISOString().slice(0, 10)
          : String(raw);
      }
    } catch { /* non-critical */ }
  }

  return { ...state, data: { ...state.data, sprints: sprints || [], workspace_start_date: workspaceStartDate } };
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

export async function fetchBacklog(
  pool: Pool,
  state: FleetGraphState
): Promise<any[]> {
  const workspaceId = state.trigger.workspace_id;
  const sprintId = state.trigger.entity?.id;

  if (!sprintId) return [];

  // Get the project this sprint belongs to
  const projectResult = await pool.query(
    `SELECT da.related_id AS project_id FROM document_associations da
     WHERE da.document_id = $1 AND da.relationship_type = 'project'
     LIMIT 1`,
    [sprintId]
  );
  const projectId = projectResult.rows[0]?.project_id;
  if (!projectId) return [];

  // Get all active sprint IDs for this project (to exclude already-assigned issues)
  const activeSprintsResult = await pool.query(
    `SELECT d.id FROM documents d
     JOIN document_associations da ON da.document_id = d.id
       AND da.relationship_type = 'project' AND da.related_id = $1
     WHERE d.document_type = 'sprint' AND d.workspace_id = $2
       AND d.deleted_at IS NULL
       AND (d.properties->>'status') IN ('active', 'planning')`,
    [projectId, workspaceId]
  );
  const activeSprintIds = activeSprintsResult.rows.map((r: any) => r.id);

  // Fetch issues in this project NOT in any active sprint, in backlog/triage/todo state
  const result = await pool.query(
    `SELECT d.*, da_list.associations
     FROM documents d
     JOIN document_associations da_proj ON da_proj.document_id = d.id
       AND da_proj.relationship_type = 'project' AND da_proj.related_id = $1
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('type', da2.relationship_type, 'id', da2.related_id)) AS associations
       FROM document_associations da2 WHERE da2.document_id = d.id
     ) da_list ON true
     WHERE d.document_type = 'issue'
       AND d.workspace_id = $2
       AND d.deleted_at IS NULL
       AND (d.properties->>'state') IN ('triage', 'backlog', 'todo', 'in_progress')
       AND NOT EXISTS (
         SELECT 1 FROM document_associations da_sprint
         WHERE da_sprint.document_id = d.id
           AND da_sprint.relationship_type = 'sprint'
           AND da_sprint.related_id = ANY($3::uuid[])
       )
     ORDER BY
       CASE d.properties->>'priority'
         WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4
         ELSE 5
       END,
       d.created_at ASC
     LIMIT 30`,
    [projectId, workspaceId, activeSprintIds.length > 0 ? activeSprintIds : [sprintId]]
  );

  return result.rows;
}

export async function fetchCarryover(
  pool: Pool,
  state: FleetGraphState
): Promise<any[]> {
  const workspaceId = state.trigger.workspace_id;
  const sprintId = state.trigger.entity?.id;

  if (!sprintId) return [];

  // Get this sprint's sprint_number to find the previous sprint
  const sprintResult = await pool.query(
    `SELECT properties->>'sprint_number' AS sprint_number,
            da.related_id AS project_id
     FROM documents d
     JOIN document_associations da ON da.document_id = d.id AND da.relationship_type = 'project'
     WHERE d.id = $1`,
    [sprintId]
  );
  const sprintNumber = parseInt(sprintResult.rows[0]?.sprint_number || '0', 10);
  const projectId = sprintResult.rows[0]?.project_id;
  if (sprintNumber <= 1 || !projectId) return [];

  // Find the previous sprint for this project
  const prevSprintResult = await pool.query(
    `SELECT d.id FROM documents d
     JOIN document_associations da ON da.document_id = d.id
       AND da.relationship_type = 'project' AND da.related_id = $1
     WHERE d.document_type = 'sprint' AND d.workspace_id = $2
       AND (d.properties->>'sprint_number')::int = $3
     LIMIT 1`,
    [projectId, workspaceId, sprintNumber - 1]
  );
  const prevSprintId = prevSprintResult.rows[0]?.id;
  if (!prevSprintId) return [];

  // Get incomplete issues from previous sprint
  const result = await pool.query(
    `SELECT d.*, da_list.associations
     FROM documents d
     JOIN document_associations da ON da.document_id = d.id
       AND da.relationship_type = 'sprint' AND da.related_id = $1
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('type', da2.relationship_type, 'id', da2.related_id)) AS associations
       FROM document_associations da2 WHERE da2.document_id = d.id
     ) da_list ON true
     WHERE d.document_type = 'issue'
       AND d.workspace_id = $2
       AND d.deleted_at IS NULL
       AND (d.properties->>'state') NOT IN ('done', 'cancelled')
     ORDER BY
       CASE d.properties->>'priority'
         WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4
         ELSE 5
       END`,
    [prevSprintId, workspaceId]
  );

  return result.rows;
}

export async function fetchAccountability(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  // For proactive, we skip this (too broad — accountability is per-user)
  if (state.mode === 'proactive') {
    return state;
  }

  const workspaceId = state.trigger.workspace_id;
  const userId = state.trigger.user_id;

  if (!userId) {
    return state;
  }

  try {
    // Use the accountability service to get the current user's overdue items.
    // We import dynamically to avoid circular dependency issues.
    const { checkMissingAccountability } = await import('../accountability.js');
    const items = await checkMissingAccountability(userId, workspaceId);

    // Map to the format the graph state expects
    const accountabilityItems = items.map((item: any) => ({
      id: `${item.type}-${item.targetId}`,
      type: item.type,
      target_id: item.targetId,
      target_title: item.targetTitle,
      target_type: item.targetType,
      due_date: item.dueDate,
      message: item.message,
      days_since_last_standup: item.daysSinceLastStandup,
      person_id: item.personId,
      project_id: item.projectId,
      week_number: item.weekNumber,
    }));

    return { ...state, data: { ...state.data, accountability_items: accountabilityItems } };
  } catch (err) {
    console.error('[FleetGraph] Failed to fetch accountability:', err);
    return state; // Degrade gracefully
  }
}
