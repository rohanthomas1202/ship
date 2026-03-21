/**
 * FleetGraph role detection — determine user's role via RACI cascade.
 *
 * Cascade order (most authoritative first):
 *   1. program.accountable_id → Director
 *   2. project.owner_id → PM
 *   3. issue.assignee_id → Engineer
 *   4. workspace_memberships.role → admin=PM, member=Engineer
 *
 * The role determines:
 *   - Detail granularity in chat responses
 *   - Recommended actions (strategic vs. operational vs. task-level)
 *   - Notification sensitivity
 */

import type { Pool } from 'pg';
import type { DetectedRole, DetectedRoleType, RoleSource } from '@ship/shared';

/**
 * Detect a user's role relative to a specific entity context.
 *
 * @param pool - Database connection
 * @param userId - The user's auth user ID
 * @param workspaceId - Current workspace
 * @param entityType - The entity type the user is viewing (project, sprint, issue, dashboard)
 * @param entityId - The entity ID (optional for dashboard)
 */
export async function detectUserRole(
  pool: Pool,
  userId: string,
  workspaceId: string,
  entityType?: string,
  entityId?: string
): Promise<DetectedRole> {
  // Get the user's person document ID (needed for RACI matching)
  const personResult = await pool.query(
    `SELECT id FROM documents
     WHERE workspace_id = $1
       AND document_type = 'person'
       AND properties->>'user_id' = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, userId]
  );
  const personId = personResult.rows[0]?.id;

  // 1. Check if user is accountable_id on any program
  const programResult = await pool.query(
    `SELECT id FROM documents
     WHERE workspace_id = $1
       AND document_type = 'program'
       AND properties->>'accountable_id' = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, userId]
  );
  if (programResult.rows[0]) {
    return {
      role: 'director',
      source: 'program_accountable',
      person_id: personId,
      determining_entity_id: programResult.rows[0].id,
    };
  }

  // 2. Check if user is owner_id on relevant project
  if (entityType === 'project' && entityId) {
    // Direct check on the viewed project
    const projectResult = await pool.query(
      `SELECT id FROM documents
       WHERE id = $1 AND properties->>'owner_id' = $2 AND deleted_at IS NULL`,
      [entityId, userId]
    );
    if (projectResult.rows[0]) {
      return {
        role: 'pm',
        source: 'project_owner',
        person_id: personId,
        determining_entity_id: entityId,
      };
    }
  } else if (entityType === 'sprint' && entityId) {
    // Check if user owns the project this sprint belongs to
    const sprintProjectResult = await pool.query(
      `SELECT p.id FROM documents p
       JOIN document_associations da ON da.related_id = p.id AND da.relationship_type = 'project'
       WHERE da.document_id = $1
         AND p.properties->>'owner_id' = $2
         AND p.deleted_at IS NULL
       LIMIT 1`,
      [entityId, userId]
    );
    if (sprintProjectResult.rows[0]) {
      return {
        role: 'pm',
        source: 'project_owner',
        person_id: personId,
        determining_entity_id: sprintProjectResult.rows[0].id,
      };
    }
  }

  // Also check if user owns ANY project in the workspace
  const anyProjectResult = await pool.query(
    `SELECT id FROM documents
     WHERE workspace_id = $1
       AND document_type = 'project'
       AND properties->>'owner_id' = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, userId]
  );
  if (anyProjectResult.rows[0]) {
    return {
      role: 'pm',
      source: 'project_owner',
      person_id: personId,
      determining_entity_id: anyProjectResult.rows[0].id,
    };
  }

  // 3. Check if user is assignee on issues (default for IC engineers)
  const issueResult = await pool.query(
    `SELECT id FROM documents
     WHERE workspace_id = $1
       AND document_type = 'issue'
       AND properties->>'assignee_id' = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, userId]
  );
  if (issueResult.rows[0]) {
    return {
      role: 'engineer',
      source: 'issue_assignee',
      person_id: personId,
      determining_entity_id: issueResult.rows[0].id,
    };
  }

  // 4. Fallback: workspace role
  const membershipResult = await pool.query(
    `SELECT role FROM workspace_memberships
     WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId]
  );
  const wsRole = membershipResult.rows[0]?.role;
  if (wsRole === 'admin') {
    return {
      role: 'pm',
      source: 'workspace_admin',
      person_id: personId,
    };
  }

  return {
    role: 'engineer',
    source: 'workspace_member',
    person_id: personId,
  };
}

/**
 * Build a role-aware system prompt suffix for chat responses.
 */
export function buildRolePromptSuffix(role: DetectedRole): string {
  switch (role.role) {
    case 'director':
      return `
The user is a DIRECTOR (program accountable). Tailor your response:
- Lead with strategic summary: health score trends, velocity trajectory, cross-project comparison
- Focus on resource allocation efficiency and portfolio-level risks
- Recommend actions at the team/project level, not individual issue level
- Use business language: timeline impact, capacity planning, risk mitigation`;

    case 'pm':
      return `
The user is a PM / PROJECT OWNER. Tailor your response:
- Lead with operational status: sprint completion, blocker chains, who to follow up with today
- Focus on what's actionable this sprint: pending approvals, stale issues, scope changes
- Recommend specific follow-ups with people and issues
- Include timeline impact: "this delays the sprint by ~N days"`;

    case 'engineer':
      return `
The user is an ENGINEER. Tailor your response:
- Lead with their personal scope: their assignments ranked by recommended work order
- Focus on what's blocking their work and what to pick up next
- Be specific about dependencies: "resolve #X before starting #Y"
- Skip management context unless directly relevant to their tasks`;
  }
}
