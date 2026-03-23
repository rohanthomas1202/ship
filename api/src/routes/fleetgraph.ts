/**
 * FleetGraph API Routes
 *
 * POST /api/fleetgraph/chat    — On-demand chat (user asks a question about an entity)
 * GET  /api/fleetgraph/insights — Get active insights for a workspace
 * GET  /api/fleetgraph/health-scores — Get project health scores
 * POST /api/fleetgraph/insights/:id/approve — Approve and execute a proposed mutation (HITL)
 * POST /api/fleetgraph/insights/:id/dismiss — Dismiss an insight
 * POST /api/fleetgraph/insights/:id/snooze  — Snooze an insight
 * POST /api/fleetgraph/run      — Trigger a proactive scan (API token only, for scheduled jobs)
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { runOnDemand, runProactive } from '../services/fleetgraph/graph-executor.js';
import { executeMutation } from '../services/fleetgraph/execute-mutation.js';
import { logAuditEvent } from '../services/audit.js';
import type { FleetGraphTrigger, FleetGraphChatRequest, ProposedAction } from '@ship/shared';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * POST /api/fleetgraph/chat
 *
 * Body: { entity_type, entity_id, message, chat_history? }
 *
 * Returns: { message, findings?, proposed_actions?, health_score? }
 */
router.post('/chat', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { entity_type, entity_id, message, chat_history } = req.body as FleetGraphChatRequest;

    if (!entity_type || !entity_id || !message) {
      res.status(400).json({ error: 'entity_type, entity_id, and message are required' });
      return;
    }

    const trigger: FleetGraphTrigger = {
      type: 'user_chat',
      entity: { type: entity_type, id: entity_id },
      user_id: req.userId,
      workspace_id: req.workspaceId!,
      chat_message: message,
      chat_history: chat_history || [],
    };

    const { state, trace } = await runOnDemand(pool, trigger);

    // Fetch health score if viewing a project
    let healthScore;
    if (entity_type === 'project' && entity_id) {
      const hsResult = await pool.query(
        `SELECT health_score FROM fleetgraph_state WHERE workspace_id = $1 AND entity_id = $2`,
        [req.workspaceId, entity_id]
      );
      if (hsResult.rows[0]?.health_score) {
        healthScore = hsResult.rows[0].health_score;
      }
    }

    res.json({
      message: state.response_draft,
      findings: state.findings.length > 0 ? state.findings : undefined,
      proposed_actions: state.findings
        .filter(f => f.proposed_action)
        .map(f => f.proposed_action) || undefined,
      recovery_options: state.recovery_options.length > 0 ? state.recovery_options : undefined,
      health_score: healthScore,
      trace: {
        nodes_executed: trace.nodes_executed,
        duration_ms: trace.duration_ms,
      },
    });
  } catch (err) {
    console.error('[FleetGraph] Chat endpoint error:', err);
    res.status(500).json({ error: 'FleetGraph analysis failed' });
  }
});

/**
 * GET /api/fleetgraph/insights
 *
 * Query: entity_id?, severity?, status?, limit?
 *
 * Returns: { insights }
 */
router.get('/insights', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { entity_id, severity, status, limit } = req.query;
    const workspaceId = req.workspaceId!;

    let query = `SELECT * FROM fleetgraph_insights WHERE workspace_id = $1`;
    const params: any[] = [workspaceId];
    let paramIdx = 2;

    if (entity_id && isValidUuid(entity_id as string)) {
      query += ` AND entity_id = $${paramIdx++}`;
      params.push(entity_id);
    }

    if (severity) {
      query += ` AND severity = $${paramIdx++}`;
      params.push(severity);
    }

    if (status) {
      query += ` AND status = $${paramIdx++}`;
      params.push(status);
    } else {
      // Default: exclude dismissed
      query += ` AND status != 'dismissed'`;
    }

    // Exclude snoozed insights that are still within snooze period
    query += ` AND (snoozed_until IS NULL OR snoozed_until < NOW())`;

    query += ` ORDER BY
      CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END,
      created_at DESC`;

    query += ` LIMIT $${paramIdx++}`;
    params.push(Number(limit) || 20);

    const result = await pool.query(query, params);

    res.json({ insights: result.rows });
  } catch (err) {
    console.error('[FleetGraph] Insights endpoint error:', err);
    res.status(500).json({ error: 'Failed to fetch insights' });
  }
});

/**
 * GET /api/fleetgraph/health-scores
 *
 * Query: workspace_id? (defaults to session workspace)
 *
 * Returns: { scores: { [projectId]: ProjectHealthScore } }
 */
router.get('/health-scores', authMiddleware, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.workspaceId!;

    // Get all projects, LEFT JOIN to health scores so unscored projects show as 100
    const result = await pool.query(
      `SELECT p.id AS entity_id, p.title AS project_title, fs.health_score
       FROM documents p
       LEFT JOIN fleetgraph_state fs ON fs.entity_id = p.id AND fs.workspace_id = p.workspace_id
       WHERE p.document_type = 'project'
         AND p.workspace_id = $1
         AND p.deleted_at IS NULL
       ORDER BY COALESCE((fs.health_score->>'overall')::int, 100), p.title`,
      [workspaceId]
    );

    const defaultSubScores = {
      velocity: { name: 'Velocity', score: 100, description: 'Not yet scanned', finding_ids: [] },
      blockers: { name: 'Blockers', score: 100, description: 'Not yet scanned', finding_ids: [] },
      workload: { name: 'Workload', score: 100, description: 'Not yet scanned', finding_ids: [] },
      issue_freshness: { name: 'Issue Freshness', score: 100, description: 'Not yet scanned', finding_ids: [] },
      approval_flow: { name: 'Approval Flow', score: 100, description: 'Not yet scanned', finding_ids: [] },
      accountability: { name: 'Accountability', score: 100, description: 'Not yet scanned', finding_ids: [] },
    };

    const scores: Record<string, any> = {};
    for (const row of result.rows) {
      scores[row.entity_id] = row.health_score
        ? { ...row.health_score, project_title: row.project_title }
        : { overall: 100, sub_scores: defaultSubScores, project_title: row.project_title };
    }

    res.json({ scores });
  } catch (err) {
    console.error('[FleetGraph] Health scores endpoint error:', err);
    res.status(500).json({ error: 'Failed to fetch health scores' });
  }
});

/**
 * POST /api/fleetgraph/insights/:id/approve
 *
 * Approve and execute a proposed mutation from a FleetGraph insight.
 * Optionally accepts edited content to override the drafted action.
 *
 * Body: { edited_content?: string }
 */
router.post('/insights/:id/approve', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { edited_content } = req.body;
    const workspaceId = req.workspaceId!;
    const userId = req.userId!;

    // Fetch the insight and its proposed_action
    const insightResult = await pool.query(
      `SELECT * FROM fleetgraph_insights WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );

    if (insightResult.rows.length === 0) {
      res.status(404).json({ error: 'Insight not found' });
      return;
    }

    const insight = insightResult.rows[0];
    const proposedAction = insight.proposed_action as ProposedAction | null;

    if (!proposedAction) {
      res.status(400).json({ error: 'This insight has no proposed action to approve' });
      return;
    }

    if (insight.status === 'approved') {
      res.status(400).json({ error: 'This insight has already been approved' });
      return;
    }

    // Apply edited content if provided
    const action: ProposedAction = edited_content
      ? { ...proposedAction, payload: { ...proposedAction.payload, content: edited_content } }
      : proposedAction;

    // Execute the mutation
    const result = await executeMutation(pool, action, userId, workspaceId);

    if (result.success) {
      // Update insight status to approved
      await pool.query(
        `UPDATE fleetgraph_insights SET status = 'approved', updated_at = NOW() WHERE id = $1`,
        [id]
      );

      // Audit log
      await logAuditEvent({
        workspaceId,
        actorUserId: userId,
        action: `fleetgraph.${action.type}`,
        resourceType: action.entity_type,
        resourceId: action.entity_id,
        details: {
          insight_id: id,
          insight_title: insight.title,
          action_type: action.type,
          automated_by: 'fleetgraph',
        },
        req,
      });

      res.json({ ok: true, result });
    } else {
      res.status(500).json({ error: result.error, result });
    }
  } catch (err) {
    console.error('[FleetGraph] Approve error:', err);
    res.status(500).json({ error: 'Failed to approve and execute mutation' });
  }
});

/**
 * POST /api/fleetgraph/insights/:id/dismiss
 */
router.post('/insights/:id/dismiss', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE fleetgraph_insights SET status = 'dismissed', updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
      [id, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[FleetGraph] Dismiss error:', err);
    res.status(500).json({ error: 'Failed to dismiss insight' });
  }
});

/**
 * POST /api/fleetgraph/insights/:id/snooze
 *
 * Body: { hours: number } (default 24)
 */
router.post('/insights/:id/snooze', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const hours = req.body.hours || 24;
    await pool.query(
      `UPDATE fleetgraph_insights SET status = 'snoozed', snoozed_until = NOW() + $3 * INTERVAL '1 hour', updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [id, req.workspaceId, hours]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[FleetGraph] Snooze error:', err);
    res.status(500).json({ error: 'Failed to snooze insight' });
  }
});

/**
 * POST /api/fleetgraph/run
 *
 * Trigger a proactive scan. Intended for scheduled jobs via API token.
 * Query params:
 *   - project_id: scope scan to a single project (optional)
 *   - sync: if "true", await result and return trace data (optional)
 */
router.post('/run', authMiddleware, async (req: Request, res: Response) => {
  const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined;
  if (projectId && !isValidUuid(projectId)) {
    res.status(400).json({ error: 'Invalid project_id — must be a UUID' });
    return;
  }

  const trigger: FleetGraphTrigger = {
    type: 'schedule',
    workspace_id: req.workspaceId!,
    ...(projectId ? { project_id: projectId } : {}),
  };

  const sync = req.query.sync === 'true';

  if (sync) {
    // Synchronous mode — await result and return trace data
    try {
      const { trace } = await runProactive(pool, trigger);
      console.log(`[FleetGraph] Proactive scan complete: ${trace.findings_count} findings in ${trace.duration_ms}ms`);
      res.json(trace);
    } catch (err) {
      console.error('[FleetGraph] Proactive scan failed:', err);
      res.status(500).json({ error: 'Proactive scan failed' });
    }
  } else {
    // Fire-and-forget mode (default — existing behavior)
    res.json({ status: 'started' });
    runProactive(pool, trigger)
      .then(({ trace }) => {
        console.log(`[FleetGraph] Proactive scan complete: ${trace.findings_count} findings in ${trace.duration_ms}ms`);
      })
      .catch(err => {
        console.error('[FleetGraph] Proactive scan failed:', err);
      });
  }
});

export default router;
