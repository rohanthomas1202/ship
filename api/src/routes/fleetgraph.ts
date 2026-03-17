/**
 * FleetGraph API Routes
 *
 * POST /api/fleetgraph/chat    — On-demand chat (user asks a question about an entity)
 * GET  /api/fleetgraph/insights — Get active insights for a workspace
 * POST /api/fleetgraph/insights/:id/dismiss — Dismiss an insight
 * POST /api/fleetgraph/insights/:id/snooze  — Snooze an insight
 * POST /api/fleetgraph/run      — Trigger a proactive scan (API token only, for scheduled jobs)
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { runOnDemand, runProactive } from '../services/fleetgraph/graph-executor.js';
import type { FleetGraphTrigger, FleetGraphChatRequest } from '@ship/shared';

const router = Router();

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

    res.json({
      message: state.response_draft,
      findings: state.findings.length > 0 ? state.findings : undefined,
      proposed_actions: state.findings
        .filter(f => f.proposed_action)
        .map(f => f.proposed_action) || undefined,
      recovery_options: state.recovery_options.length > 0 ? state.recovery_options : undefined,
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

    if (entity_id) {
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
 */
router.post('/run', authMiddleware, async (req: Request, res: Response) => {
  try {
    const trigger: FleetGraphTrigger = {
      type: 'schedule',
      workspace_id: req.workspaceId!,
    };

    const { state, trace } = await runProactive(pool, trigger);

    res.json({
      findings_count: trace.findings_count,
      nodes_executed: trace.nodes_executed,
      duration_ms: trace.duration_ms,
      errors: trace.errors,
    });
  } catch (err) {
    console.error('[FleetGraph] Proactive run error:', err);
    res.status(500).json({ error: 'Proactive scan failed' });
  }
});

export default router;
