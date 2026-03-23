/**
 * FleetGraph health score computation.
 *
 * Computes a 0-100 composite health score per project from detected findings.
 * Each finding type maps to a sub-score category. The overall score is a
 * weighted average of 6 sub-scores.
 *
 * Sub-score weights:
 *   velocity       20%  — sprint completion rate
 *   blockers       25%  — blocker chains, ghost blockers in blocking position
 *   workload       15%  — team load imbalance
 *   issue_freshness 15% — ghost blockers (stale issues)
 *   approval_flow  10%  — approval bottlenecks
 *   accountability 15%  — accountability cascades
 */

import type { Pool } from 'pg';
import type { Finding, ProjectHealthScore, HealthSubScore, SignalType } from '@ship/shared';

/** Which sub-score category each signal type contributes to. */
const SIGNAL_TO_SUBSCORE: Record<SignalType, keyof ProjectHealthScore['sub_scores']> = {
  ghost_blocker: 'issue_freshness',
  scope_creep: 'velocity',
  velocity_decay: 'velocity',
  team_overload: 'workload',
  accountability_cascade: 'accountability',
  confidence_drift: 'velocity',
  approval_bottleneck: 'approval_flow',
  blocker_chain: 'blockers',
  sprint_collapse: 'velocity',
};

/** Penalty per finding by severity. Applied to the sub-score (starts at 100). */
const SEVERITY_PENALTY: Record<string, number> = {
  critical: 40,
  high: 25,
  medium: 15,
  low: 5,
};

/** Weights for the overall score (must sum to 1.0). */
const WEIGHTS: Record<keyof ProjectHealthScore['sub_scores'], number> = {
  velocity: 0.20,
  blockers: 0.25,
  workload: 0.15,
  issue_freshness: 0.15,
  approval_flow: 0.10,
  accountability: 0.15,
};

/**
 * Compute a project health score from findings.
 *
 * @param projectId - The project being scored
 * @param findings - All findings (may include findings for other projects — filtered internally)
 * @returns ProjectHealthScore with overall and 6 sub-scores
 */
export function computeHealthScore(
  projectId: string,
  findings: Finding[]
): ProjectHealthScore {
  // Filter to findings affecting this project
  const projectFindings = findings.filter(f =>
    f.affected_entities.some(e => e.id === projectId) ||
    f.data?.project_id === projectId ||
    // Check enriched project associations from document_associations lookup
    (Array.isArray(f.data?._project_ids) && (f.data._project_ids as string[]).includes(projectId))
  );

  // Initialize sub-scores at 100 (healthy)
  const subScoreValues: Record<keyof ProjectHealthScore['sub_scores'], { score: number; findingIds: string[]; descriptions: string[] }> = {
    velocity: { score: 100, findingIds: [], descriptions: [] },
    blockers: { score: 100, findingIds: [], descriptions: [] },
    workload: { score: 100, findingIds: [], descriptions: [] },
    issue_freshness: { score: 100, findingIds: [], descriptions: [] },
    approval_flow: { score: 100, findingIds: [], descriptions: [] },
    accountability: { score: 100, findingIds: [], descriptions: [] },
  };

  // Apply penalties from findings
  for (const finding of projectFindings) {
    const category = SIGNAL_TO_SUBSCORE[finding.signal_type];
    if (!category) continue;

    const penalty = SEVERITY_PENALTY[finding.severity] || 10;
    const entry = subScoreValues[category];
    entry.score = Math.max(0, entry.score - penalty);
    entry.findingIds.push(finding.id);
    entry.descriptions.push(finding.title);
  }

  // Also apply penalties for findings that affect entities within this project
  // but don't directly reference the project ID (e.g., issue-level findings)
  for (const finding of findings) {
    if (projectFindings.includes(finding)) continue; // Already counted

    const category = SIGNAL_TO_SUBSCORE[finding.signal_type];
    if (!category) continue;

    // Check if this finding's affected entities are associated with project
    // We can't check associations here (no DB), but we can check if the
    // finding mentions a sprint or issue that might be in this project.
    // For now, we rely on the projectFindings filter above.
  }

  // Build sub-score objects
  const subScores: ProjectHealthScore['sub_scores'] = {
    velocity: buildSubScore('Velocity', subScoreValues.velocity),
    blockers: buildSubScore('Blockers', subScoreValues.blockers),
    workload: buildSubScore('Workload', subScoreValues.workload),
    issue_freshness: buildSubScore('Issue Freshness', subScoreValues.issue_freshness),
    approval_flow: buildSubScore('Approval Flow', subScoreValues.approval_flow),
    accountability: buildSubScore('Accountability', subScoreValues.accountability),
  };

  // Compute weighted overall
  let overall = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    overall += subScores[key as keyof typeof subScores].score * weight;
  }

  return {
    overall: Math.round(overall),
    sub_scores: subScores,
    computed_at: new Date().toISOString(),
  };
}

function buildSubScore(
  name: string,
  data: { score: number; findingIds: string[]; descriptions: string[] }
): HealthSubScore {
  let description: string;
  if (data.score >= 90) {
    description = 'Healthy — no issues detected';
  } else if (data.score >= 70) {
    description = `Minor concerns: ${data.descriptions.slice(0, 2).join(', ')}`;
  } else if (data.score >= 40) {
    description = `At risk: ${data.descriptions.slice(0, 2).join(', ')}`;
  } else {
    description = `Critical: ${data.descriptions.slice(0, 2).join(', ')}`;
  }

  return {
    name,
    score: Math.max(0, Math.min(100, Math.round(data.score))),
    description,
    finding_ids: data.findingIds,
  };
}

/**
 * Compute health scores for all active projects from findings,
 * and persist them to the fleetgraph_state table.
 */
export async function computeAndPersistHealthScores(
  pool: Pool,
  workspaceId: string,
  findings: Finding[],
  projectIds: string[]
): Promise<Record<string, ProjectHealthScore>> {
  // Resolve issue→project associations so findings targeting issues get
  // attributed to the correct project's health score
  const issueIds = new Set<string>();
  for (const f of findings) {
    for (const e of f.affected_entities) {
      if (e.type === 'issue' || e.type === 'unknown') issueIds.add(e.id);
    }
  }

  const issueToProjects = new Map<string, string[]>();
  if (issueIds.size > 0) {
    try {
      const result = await pool.query(
        `SELECT document_id, related_id FROM document_associations
         WHERE document_id = ANY($1::uuid[]) AND relationship_type = 'project'`,
        [Array.from(issueIds)]
      );
      for (const row of result.rows) {
        const list = issueToProjects.get(row.document_id) || [];
        list.push(row.related_id);
        issueToProjects.set(row.document_id, list);
      }
    } catch {
      // Proceed without associations — scores will be less accurate
    }
  }

  // Tag findings with project_id so computeHealthScore can filter by project
  const enrichedFindings = findings.map(f => {
    const projectIdsForFinding = new Set<string>();
    for (const e of f.affected_entities) {
      const projects = issueToProjects.get(e.id);
      if (projects) projects.forEach(p => projectIdsForFinding.add(p));
    }
    return { ...f, data: { ...f.data, _project_ids: Array.from(projectIdsForFinding) } };
  });

  const scores: Record<string, ProjectHealthScore> = {};

  for (const projectId of projectIds) {
    const score = computeHealthScore(projectId, enrichedFindings);
    scores[projectId] = score;

    try {
      await pool.query(
        `INSERT INTO fleetgraph_state (workspace_id, entity_id, last_checked_at, health_score)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (workspace_id, entity_id)
         DO UPDATE SET health_score = $3, last_checked_at = NOW()`,
        [workspaceId, projectId, JSON.stringify(score)]
      );
    } catch (err) {
      console.error(`[FleetGraph] Failed to persist health score for ${projectId}:`, err);
    }
  }

  return scores;
}
