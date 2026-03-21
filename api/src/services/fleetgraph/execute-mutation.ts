/**
 * FleetGraph mutation execution — apply approved write operations.
 *
 * All mutations flow through the HITL gate:
 *   1. FleetGraph proposes an action (ProposedAction on a Finding)
 *   2. User reviews via insight card (Approve / Edit / Dismiss)
 *   3. On Approve, this module executes the write against Ship's DB
 *   4. document_history and audit_logs are updated
 *
 * Supported mutation types:
 *   - comment: Post a comment on a document
 *   - reassign: Change issue assignee_id
 *   - state_change: Change issue state
 */

import type { Pool } from 'pg';
import type { ProposedAction, MutationResult } from '@ship/shared';
import { v4 as uuid } from 'uuid';
import { logDocumentChange } from '../../utils/document-crud.js';

/**
 * Execute an approved mutation against Ship data.
 *
 * @param pool - Database connection
 * @param action - The approved ProposedAction
 * @param approvedBy - User ID who approved (for audit trail)
 * @param workspaceId - Current workspace
 */
export async function executeMutation(
  pool: Pool,
  action: ProposedAction,
  approvedBy: string,
  workspaceId: string
): Promise<MutationResult> {
  try {
    switch (action.type) {
      case 'comment':
        return await executeComment(pool, action, approvedBy, workspaceId);
      case 'reassign':
        return await executeReassign(pool, action, approvedBy, workspaceId);
      case 'state_change':
        return await executeStateChange(pool, action, approvedBy, workspaceId);
      default:
        return {
          success: false,
          action_type: action.type,
          entity_id: action.entity_id,
          error: `Unsupported mutation type: ${action.type}`,
        };
    }
  } catch (err) {
    console.error('[FleetGraph] Mutation execution failed:', err);
    return {
      success: false,
      action_type: action.type,
      entity_id: action.entity_id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Post a comment on a document.
 */
async function executeComment(
  pool: Pool,
  action: ProposedAction,
  approvedBy: string,
  workspaceId: string
): Promise<MutationResult> {
  const content = action.payload.content;
  if (!content) {
    return { success: false, action_type: 'comment', entity_id: action.entity_id, error: 'No content provided' };
  }

  // Verify the target document exists
  const docCheck = await pool.query(
    `SELECT id FROM documents WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [action.entity_id, workspaceId]
  );
  if (docCheck.rows.length === 0) {
    return { success: false, action_type: 'comment', entity_id: action.entity_id, error: 'Target document not found' };
  }

  const commentId = uuid();
  await pool.query(
    `INSERT INTO comments (document_id, comment_id, author_id, workspace_id, content)
     VALUES ($1, $2, $3, $4, $5)`,
    [action.entity_id, commentId, approvedBy, workspaceId, JSON.stringify({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: content }],
      }],
    })]
  );

  return { success: true, action_type: 'comment', entity_id: action.entity_id };
}

/**
 * Reassign an issue to a different person.
 */
async function executeReassign(
  pool: Pool,
  action: ProposedAction,
  approvedBy: string,
  workspaceId: string
): Promise<MutationResult> {
  const newAssigneeId = action.payload.assignee_id;
  if (!newAssigneeId) {
    return { success: false, action_type: 'reassign', entity_id: action.entity_id, error: 'No assignee_id provided' };
  }

  // Get current assignee for history
  const current = await pool.query(
    `SELECT properties->>'assignee_id' AS assignee_id FROM documents
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [action.entity_id, workspaceId]
  );
  if (current.rows.length === 0) {
    return { success: false, action_type: 'reassign', entity_id: action.entity_id, error: 'Issue not found' };
  }

  const oldAssigneeId = current.rows[0].assignee_id;

  await pool.query(
    `UPDATE documents
     SET properties = jsonb_set(properties, '{assignee_id}', $1::jsonb),
         updated_at = NOW()
     WHERE id = $2 AND workspace_id = $3`,
    [JSON.stringify(newAssigneeId), action.entity_id, workspaceId]
  );

  // Log to document_history
  await logDocumentChange(
    action.entity_id,
    'assignee_id',
    oldAssigneeId,
    newAssigneeId,
    approvedBy,
    'fleetgraph'
  );

  return { success: true, action_type: 'reassign', entity_id: action.entity_id };
}

/**
 * Change an issue's state.
 */
async function executeStateChange(
  pool: Pool,
  action: ProposedAction,
  approvedBy: string,
  workspaceId: string
): Promise<MutationResult> {
  const newState = action.payload.state;
  if (!newState) {
    return { success: false, action_type: 'state_change', entity_id: action.entity_id, error: 'No state provided' };
  }

  const validStates = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];
  if (!validStates.includes(newState)) {
    return { success: false, action_type: 'state_change', entity_id: action.entity_id, error: `Invalid state: ${newState}` };
  }

  // Get current state for history
  const current = await pool.query(
    `SELECT properties->>'state' AS state FROM documents
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [action.entity_id, workspaceId]
  );
  if (current.rows.length === 0) {
    return { success: false, action_type: 'state_change', entity_id: action.entity_id, error: 'Issue not found' };
  }

  const oldState = current.rows[0].state;

  // Build timestamp updates based on state transition
  let timestampUpdate = '';
  if (newState === 'in_progress') {
    timestampUpdate = ', started_at = COALESCE(started_at, NOW())';
  } else if (newState === 'done') {
    timestampUpdate = ', completed_at = COALESCE(completed_at, NOW())';
  } else if (newState === 'cancelled') {
    timestampUpdate = ', cancelled_at = NOW()';
  }

  await pool.query(
    `UPDATE documents
     SET properties = jsonb_set(properties, '{state}', $1::jsonb),
         updated_at = NOW()${timestampUpdate}
     WHERE id = $2 AND workspace_id = $3`,
    [JSON.stringify(newState), action.entity_id, workspaceId]
  );

  // Log to document_history
  await logDocumentChange(
    action.entity_id,
    'state',
    oldState,
    newState,
    approvedBy,
    'fleetgraph'
  );

  return { success: true, action_type: 'state_change', entity_id: action.entity_id };
}
