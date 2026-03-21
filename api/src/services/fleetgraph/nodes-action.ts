/**
 * FleetGraph action & output nodes — format insights, draft artifacts, persist results.
 */

import { v4 as uuid } from 'uuid';
import type { Pool } from 'pg';
import type {
  FleetGraphState,
  FleetGraphInsight,
  DraftedArtifact,
  Finding,
  RecoveryOption,
  RootCause,
  Severity,
} from '@ship/shared';
import { callBedrock } from './bedrock.js';
import { addError, setResponseDraft } from './graph-state.js';
import { hashFinding } from './deterministic-signals.js';

// ============================================================
// generate_insight — format findings into displayable insight cards
// ============================================================

export function generateInsight(state: FleetGraphState): FleetGraphState {
  // Transform findings + root causes + recovery options into insight objects
  // These get persisted to `fleetgraph_insights` by `surfaceInsight`
  return state; // State already has findings, root_causes, recovery_options
}

// ============================================================
// draft_artifact — generate ready-to-use content behind HITL gate
// ============================================================

const DRAFT_ARTIFACT_SYSTEM = `You are FleetGraph, drafting a specific artifact for a project manager or engineer to review and approve.

Given a finding, root cause, and recovery option, draft the appropriate artifact:
- For COMMENTS: Write a concise, empathetic message to the relevant person. Include the specific issue, why it matters, and a concrete ask.
- For PM UPDATES: Write a brief status update summarizing the situation, root cause, and recommended action.
- For STANDUP DRAFTS: Summarize yesterday's activity, today's plan, and blockers.

Keep tone professional but friendly. Be specific — reference issue numbers, person names, and dates.
Output valid JSON: { "content": "...", "type": "comment|pm_update|standup" }`;

export async function draftArtifact(state: FleetGraphState): Promise<FleetGraphState> {
  if (state.findings.length === 0) return state;

  // Only draft artifacts for high/critical findings that have recovery options
  const highFindings = state.findings.filter(
    f => f.severity === 'high' || f.severity === 'critical'
  );

  if (highFindings.length === 0) return state;

  const finding = highFindings[0]!;
  const rootCause = state.root_causes.find(rc => rc.finding_id === finding.id);
  const recoveryOpts = state.recovery_options.filter(ro => ro.finding_id === finding.id);

  const userPrompt = `Draft an intervention artifact for this finding:

FINDING:
${JSON.stringify(finding, null, 2)}

ROOT CAUSE:
${JSON.stringify(rootCause || 'Not available', null, 2)}

RECOVERY OPTIONS:
${JSON.stringify(recoveryOpts, null, 2)}

TEAM:
${JSON.stringify(state.data.team.map((t: any) => ({ id: t.id, name: t.user_name || t.title })), null, 2)}

Draft a comment that a PM could post on the relevant issue to address this finding.`;

  const response = await callBedrock({
    system: DRAFT_ARTIFACT_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 1024,
  });

  if (!response?.text) return state;

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const artifact: DraftedArtifact = {
        type: parsed.type || 'comment',
        target_entity_id: finding.affected_entities[0]?.id || '',
        content: parsed.content || response.text,
      };
      // Store on the finding's proposed_action for the HITL gate
      const updatedFindings = state.findings.map(f =>
        f.id === finding.id
          ? {
              ...f,
              proposed_action: {
                type: 'comment' as const,
                entity_id: artifact.target_entity_id,
                entity_type: finding.affected_entities[0]?.type || 'issue',
                payload: { content: artifact.content },
                description: `Post drafted comment on ${finding.affected_entities[0]?.type || 'issue'}`,
              },
            }
          : f
      );
      return { ...state, findings: updatedFindings };
    }
  } catch {
    // Fall through
  }

  return state;
}

// ============================================================
// compose_chat_response — assemble on-demand chat response
// ============================================================

export function composeChatResponse(state: FleetGraphState): FleetGraphState {
  // The response_draft is already set by reasonQueryResponse
  // This node enriches it with inline data references and follow-up suggestions
  if (!state.response_draft) {
    return setResponseDraft(state, 'I wasn\'t able to find relevant data to answer your question.');
  }

  // Append findings summary if available
  if (state.findings.length > 0) {
    const findingsSummary = state.findings
      .slice(0, 3)
      .map(f => `- **${f.title}** (${f.severity}): ${f.description}`)
      .join('\n');

    const enriched = `${state.response_draft}\n\n---\n**Active Findings:**\n${findingsSummary}`;
    return setResponseDraft(state, enriched);
  }

  return state;
}

// ============================================================
// surface_insight — persist insights to fleetgraph_insights table
// ============================================================

export async function surfaceInsight(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;

  for (const finding of state.findings) {
    const rootCause = state.root_causes.find(rc => rc.finding_id === finding.id);
    const recoveryOpts = state.recovery_options.filter(ro => ro.finding_id === finding.id);
    const entityId = finding.affected_entities[0]?.id || null;

    try {
      // Deduplication: skip if same category + entity has a pending insight within 24h
      if (entityId) {
        const existing = await pool.query(
          `SELECT id FROM fleetgraph_insights
           WHERE workspace_id = $1
             AND entity_id = $2
             AND category = $3
             AND status IN ('pending', 'viewed')
             AND created_at > NOW() - INTERVAL '24 hours'
           LIMIT 1`,
          [workspaceId, entityId, finding.signal_type]
        );
        if (existing.rows.length > 0) {
          continue; // Skip duplicate
        }
      }

      await pool.query(
        `INSERT INTO fleetgraph_insights
          (id, workspace_id, entity_id, entity_type, severity, category, title, content, root_cause, recovery_options, proposed_action, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          finding.id,
          workspaceId,
          entityId,
          finding.affected_entities[0]?.type || null,
          finding.severity,
          finding.signal_type,
          finding.title,
          JSON.stringify({ description: finding.description, data: finding.data, confidence: finding.confidence }),
          rootCause ? JSON.stringify(rootCause) : null,
          recoveryOpts.length > 0 ? JSON.stringify(recoveryOpts) : null,
          finding.proposed_action ? JSON.stringify(finding.proposed_action) : null,
        ]
      );
    } catch (err) {
      console.error('[FleetGraph] Failed to persist insight:', err);
    }
  }

  // After persisting insights, handle target_user assignment and escalation
  await assignTargetUsers(pool, state);
  await escalatePersistentFindings(pool, state);

  return state;
}

// ============================================================
// assignTargetUsers — route insights to the right person via RACI
// ============================================================

async function assignTargetUsers(
  pool: Pool,
  state: FleetGraphState
): Promise<void> {
  const workspaceId = state.trigger.workspace_id;

  for (const finding of state.findings) {
    const entityId = finding.affected_entities[0]?.id;
    const entityType = finding.affected_entities[0]?.type;
    if (!entityId) continue;

    let targetUserId: string | null = null;

    try {
      if (entityType === 'sprint') {
        // Route to sprint owner
        const result = await pool.query(
          `SELECT properties->>'owner_id' AS owner_id FROM documents WHERE id = $1 AND deleted_at IS NULL`,
          [entityId]
        );
        targetUserId = result.rows[0]?.owner_id || null;
      } else if (entityType === 'issue') {
        // Route to issue assignee, or fall back to project owner
        const result = await pool.query(
          `SELECT properties->>'assignee_id' AS assignee_id FROM documents WHERE id = $1 AND deleted_at IS NULL`,
          [entityId]
        );
        targetUserId = result.rows[0]?.assignee_id || null;

        if (!targetUserId) {
          // Fall back: get the project owner via associations
          const projResult = await pool.query(
            `SELECT p.properties->>'owner_id' AS owner_id
             FROM document_associations da
             JOIN documents p ON p.id = da.related_id AND p.document_type = 'project'
             WHERE da.document_id = $1 AND da.relationship_type = 'project'
             LIMIT 1`,
            [entityId]
          );
          targetUserId = projResult.rows[0]?.owner_id || null;
        }
      }

      if (targetUserId) {
        await pool.query(
          `UPDATE fleetgraph_insights
           SET target_user_id = $1, updated_at = NOW()
           WHERE workspace_id = $2 AND entity_id = $3 AND category = $4
             AND status = 'pending' AND target_user_id IS NULL`,
          [targetUserId, workspaceId, entityId, finding.signal_type]
        );
      }
    } catch (err) {
      // Non-critical — insight still exists, just without target routing
    }
  }
}

// ============================================================
// escalatePersistentFindings — escalate if finding persists 2+ cycles
// ============================================================

/**
 * Track finding persistence in fleetgraph_state.last_findings.
 * Format: { [hash]: { count: number, first_seen: string } }
 *
 * If a finding hash persists 2+ cycles AND the insight is still 'pending'
 * (not viewed/dismissed), escalate by re-routing target_user_id to the
 * project accountable_id.
 */
async function escalatePersistentFindings(
  pool: Pool,
  state: FleetGraphState
): Promise<void> {
  const workspaceId = state.trigger.workspace_id;

  // Build current finding hashes
  const currentHashes = new Map<string, Finding>();
  for (const f of state.findings) {
    const h = hashFinding(f.signal_type, f.affected_entities.map(e => e.id));
    currentHashes.set(h, f);
  }

  // Group findings by project
  const projectFindings = new Map<string, Map<string, Finding>>();
  for (const f of state.findings) {
    for (const e of f.affected_entities) {
      // Get project ID from issue associations or directly
      if (e.type === 'project') {
        const existing = projectFindings.get(e.id) || new Map();
        const h = hashFinding(f.signal_type, f.affected_entities.map(ae => ae.id));
        existing.set(h, f);
        projectFindings.set(e.id, existing);
      }
    }
  }

  // For each project, load previous cycle's findings from fleetgraph_state
  for (const [projectId, findings] of projectFindings) {
    try {
      const stateResult = await pool.query(
        `SELECT last_findings FROM fleetgraph_state WHERE workspace_id = $1 AND entity_id = $2`,
        [workspaceId, projectId]
      );

      const prevFindings: Record<string, { count: number; first_seen: string }> =
        stateResult.rows[0]?.last_findings || {};

      // Update cycle counts
      const updatedFindings: Record<string, { count: number; first_seen: string }> = {};
      for (const [hash, finding] of findings) {
        const prev = prevFindings[hash];
        updatedFindings[hash] = {
          count: prev ? prev.count + 1 : 1,
          first_seen: prev?.first_seen || new Date().toISOString(),
        };

        // Escalate if 2+ cycles and insight still pending
        if (updatedFindings[hash]!.count >= 2) {
          // Find the project accountable_id (via program association)
          const accountableResult = await pool.query(
            `SELECT prog.properties->>'accountable_id' AS accountable_id
             FROM document_associations da
             JOIN documents prog ON prog.id = da.related_id AND prog.document_type = 'program'
             WHERE da.document_id = $1 AND da.relationship_type = 'program'
             LIMIT 1`,
            [projectId]
          );
          const accountableId = accountableResult.rows[0]?.accountable_id;

          if (accountableId) {
            const entityId = finding.affected_entities[0]?.id;
            if (entityId) {
              await pool.query(
                `UPDATE fleetgraph_insights
                 SET target_user_id = $1, updated_at = NOW()
                 WHERE workspace_id = $2 AND entity_id = $3 AND category = $4
                   AND status = 'pending'`,
                [accountableId, workspaceId, entityId, finding.signal_type]
              );
            }
          }
        }
      }

      // Persist updated cycle counts
      await pool.query(
        `UPDATE fleetgraph_state
         SET last_findings = $1
         WHERE workspace_id = $2 AND entity_id = $3`,
        [JSON.stringify(updatedFindings), workspaceId, projectId]
      );
    } catch (err) {
      // Non-critical
    }
  }
}

// ============================================================
// persist_narrative — append project summary to narrative memory
// ============================================================

export async function persistNarrative(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;
  const now = new Date().toISOString();

  // Build a one-line summary for each active project
  const projectIds = new Set<string>();
  for (const issue of state.data.issues) {
    const assocs = (issue as any).associations || [];
    for (const a of assocs) {
      if (a.type === 'project') projectIds.add(a.id);
    }
  }

  for (const projectId of projectIds) {
    const projectFindings = state.findings.filter(f =>
      f.affected_entities.some(e => e.id === projectId)
    );

    const summary = projectFindings.length > 0
      ? `${now.slice(0, 10)}: ${projectFindings.length} finding(s) — ${projectFindings.map(f => f.signal_type).join(', ')}`
      : `${now.slice(0, 10)}: Clean — no findings detected`;

    try {
      await pool.query(
        `INSERT INTO fleetgraph_state (workspace_id, entity_id, last_checked_at, narrative)
         VALUES ($1, $2, NOW(), $3::jsonb)
         ON CONFLICT (workspace_id, entity_id)
         DO UPDATE SET
           last_checked_at = NOW(),
           narrative = COALESCE(fleetgraph_state.narrative, '[]'::jsonb) || $3::jsonb`,
        [workspaceId, projectId, JSON.stringify([summary])]
      );
    } catch (err) {
      console.error('[FleetGraph] Failed to persist narrative:', err);
    }
  }

  return state;
}

// ============================================================
// log_clean_run — update last_checked timestamps
// ============================================================

export async function logCleanRun(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;

  // Update last_checked for the workspace
  try {
    await pool.query(
      `INSERT INTO fleetgraph_state (workspace_id, entity_id, last_checked_at, last_activity_count)
       VALUES ($1, $1, NOW(), $2)
       ON CONFLICT (workspace_id, entity_id)
       DO UPDATE SET last_checked_at = NOW(), last_activity_count = $2`,
      [workspaceId, Object.keys(state.data.activity).length]
    );
  } catch (err) {
    console.error('[FleetGraph] Failed to log clean run:', err);
  }

  return state;
}
