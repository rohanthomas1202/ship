/**
 * FleetGraph reasoning nodes — where Claude does actual analysis.
 */

import { v4 as uuid } from 'uuid';
import type {
  FleetGraphState,
  HealthSignal,
  Finding,
  CompoundFinding,
  RootCause,
  Severity,
} from '@ship/shared';
import { callBedrock } from './bedrock.js';
import { addHealthSignals, addFindings, addCompoundFindings, addRootCauses, addError, setResponseDraft } from './graph-state.js';
import { detectGhostBlockers, detectApprovalBottlenecks, detectBlockerChains, detectSprintCollapse, hashFinding } from './deterministic-signals.js';
import { buildRolePromptSuffix } from './role-detection.js';
import type { DetectedRole } from '@ship/shared';

// ============================================================
// reason_health_check — detect anomalies
// ============================================================

const HEALTH_CHECK_SYSTEM = `You are FleetGraph, a project intelligence agent analyzing Ship project management data.

Analyze the provided project data and detect health signals. Look for:
1. GHOST BLOCKERS: Issues in "in_progress" with no document_history updates in 3+ days
2. SPRINT SCOPE CREEP: Compare planned_issue_ids snapshot to current issues in sprint
3. BLOCKER CHAINS: Parent issues blocking 3+ child issues (via parent associations)
4. SPRINT COLLAPSE RISK: Low completion rate with few days remaining
5. TEAM OVERLOAD: Any person assigned to issues in 3+ projects or with story points > 2x median
6. APPROVAL BOTTLENECKS: plan_approval or review_approval pending > 2 days
7. CONFIDENCE DRIFT: Sprint confidence dropped > 20 points or never updated

For each signal found, emit a structured finding with:
- type: one of ghost_blocker, scope_creep, velocity_decay, team_overload, accountability_cascade, confidence_drift, approval_bottleneck, blocker_chain, sprint_collapse
- severity: low, medium, high, or critical
- confidence: 0-1 (how sure you are)
- description: concrete, data-backed explanation
- affected entities with their IDs

If the project is healthy, return an empty findings array.

IMPORTANT: Base analysis ONLY on the data provided. Do not hallucinate issues not present in the data.
Respond with valid JSON only.`;

const HEALTH_CHECK_TOOL = {
  name: 'emit_findings',
  description: 'Emit detected health signals and findings',
  input_schema: {
    type: 'object' as const,
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            signal_type: { type: 'string', enum: ['ghost_blocker', 'scope_creep', 'velocity_decay', 'team_overload', 'accountability_cascade', 'confidence_drift', 'approval_bottleneck', 'blocker_chain', 'sprint_collapse'] },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            title: { type: 'string' },
            description: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            affected_entity_ids: { type: 'array', items: { type: 'string' } },
            data: { type: 'object' },
          },
          required: ['signal_type', 'severity', 'title', 'description', 'confidence'],
        },
      },
      health_summary: { type: 'string' },
    },
    required: ['findings', 'health_summary'],
  },
};

export async function reasonHealthCheck(state: FleetGraphState): Promise<FleetGraphState> {
  // 1. Run deterministic detection first (no LLM needed)
  const workspaceStartDate = state.data.workspace_start_date
    ? new Date(state.data.workspace_start_date + 'T00:00:00Z')
    : new Date();

  const deterministicFindings: Finding[] = [
    ...detectGhostBlockers(state.data.issues, state.data.document_history),
    ...detectApprovalBottlenecks(state.data.sprints, state.data.document_history),
    ...detectBlockerChains(state.data.issues),
    ...detectSprintCollapse(state.data.sprints, state.data.issues, workspaceStartDate),
  ];

  // Track deterministic finding hashes to avoid LLM duplicates
  const deterministicHashes = new Set(
    deterministicFindings.map(f =>
      hashFinding(f.signal_type, f.affected_entities.map(e => e.id))
    )
  );

  // 2. Build user ID → name map for resolving assignees
  const nameMap = new Map<string, string>();
  for (const t of state.data.team) {
    const userId = (t as any).properties?.user_id;
    const name = (t as any).user_name || (t as any).title || 'Unknown';
    if (userId) nameMap.set(userId, name);
    nameMap.set((t as any).id, name);
  }
  const resolve = (id: string | undefined) => (id && nameMap.get(id)) || 'unassigned';

  // Build context from fetched data for LLM reasoning
  const issuesSummary = state.data.issues.map((i: any) => ({
    id: i.id,
    title: i.title,
    state: i.properties?.state,
    priority: i.properties?.priority,
    assignee: resolve(i.properties?.assignee_id),
    estimate: i.properties?.estimate,
    updated_at: i.updated_at,
    associations: i.associations,
  }));

  const sprintsSummary = state.data.sprints.map((s: any) => ({
    id: s.id,
    title: s.title,
    status: s.properties?.status,
    confidence: s.properties?.confidence,
    plan_approval: s.properties?.plan_approval,
    review_approval: s.properties?.review_approval,
    planned_issue_ids: s.properties?.planned_issue_ids,
    start_date: s.properties?.start_date,
    end_date: s.properties?.end_date,
  }));

  const teamSummary = state.data.team.map((t: any) => ({
    name: (t as any).user_name || (t as any).title,
    email: (t as any).user_email,
    capacity_hours: t.properties?.capacity_hours,
  }));

  // Build parent-child relationships for blocker chain detection
  const parentChildMap: Record<string, string[]> = {};
  for (const issue of state.data.issues) {
    const assocs = (issue as any).associations || [];
    for (const assoc of assocs) {
      if (assoc.type === 'parent') {
        if (!parentChildMap[assoc.id]) { parentChildMap[assoc.id] = []; }
        parentChildMap[assoc.id]!.push((issue as any).id);
      }
    }
  }

  const now = new Date();
  const recentHistory = state.data.document_history.slice(0, 100).map((h: any) => ({
    document_id: h.document_id,
    field: h.field,
    created_at: h.created_at,
  }));

  const userPrompt = `Analyze this project data for health signals.

CURRENT TIME: ${now.toISOString()}

ISSUES (${issuesSummary.length} total):
${JSON.stringify(issuesSummary, null, 2)}

SPRINTS:
${JSON.stringify(sprintsSummary, null, 2)}

TEAM:
${JSON.stringify(teamSummary, null, 2)}

PARENT-CHILD RELATIONSHIPS (parent_id → child_ids):
${JSON.stringify(parentChildMap, null, 2)}

RECENT DOCUMENT HISTORY (last 100 changes):
${JSON.stringify(recentHistory, null, 2)}

Detect any health signals. If the project is healthy, return empty findings.`;

  const response = await callBedrock({
    system: HEALTH_CHECK_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [HEALTH_CHECK_TOOL],
    max_tokens: 4096,
  });

  if (!response) {
    return addError(state, { node: 'reason_health_check', error: 'Bedrock unavailable', recovered: false });
  }

  // Extract findings from tool_use response
  let findings: Finding[] = [];

  if (response.tool_use?.name === 'emit_findings') {
    const input = response.tool_use.input as { findings?: any[]; health_summary?: string };
    if (input.findings) {
      findings = input.findings.map((f: any) => ({
        id: uuid(),
        signal_type: f.signal_type,
        severity: f.severity as Severity,
        title: f.title,
        description: f.description,
        affected_entities: (f.affected_entity_ids || []).map((id: string) => ({ type: 'unknown', id })),
        data: f.data || {},
        confidence: f.confidence || 0.7,
        source: 'reasoning' as const,
      }));
    }
  } else if (response.text) {
    // Fallback: try to parse JSON from text response
    try {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.findings) {
          findings = parsed.findings.map((f: any) => ({
            id: uuid(),
            signal_type: f.signal_type,
            severity: f.severity as Severity,
            title: f.title,
            description: f.description,
            affected_entities: [],
            data: f.data || {},
            confidence: f.confidence || 0.5,
            source: 'reasoning' as const,
          }));
        }
      }
    } catch {
      // Fall through to heuristic
    }
  }

  // 3. Merge: deterministic findings take precedence, remove LLM duplicates
  const dedupedLlmFindings = findings.filter(f => {
    const h = hashFinding(f.signal_type, f.affected_entities.map(e => e.id));
    return !deterministicHashes.has(h);
  });

  const allFindings = [...deterministicFindings, ...dedupedLlmFindings];
  return addFindings(state, allFindings);
}

// ============================================================
// reason_severity_triage — rank and filter
// ============================================================

export function reasonSeverityTriage(state: FleetGraphState): FleetGraphState {
  // Filter out suppressed findings
  const activeFindings = state.findings.filter(
    f => !state.suppressed_hashes.includes(
      hashFinding(f.signal_type, f.affected_entities.map(e => e.id))
    )
  );

  // Sort by severity (critical > high > medium > low) then confidence
  const severityOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  activeFindings.sort((a, b) => {
    const sevDiff = (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0);
    if (sevDiff !== 0) return sevDiff;
    return b.confidence - a.confidence;
  });

  return { ...state, findings: activeFindings };
}

// ============================================================
// reason_compound_insight — merge related findings
// ============================================================

export function reasonCompoundInsight(state: FleetGraphState): FleetGraphState {
  if (state.findings.length < 2) return state;

  // Group findings by shared entity IDs
  const entityToFindings = new Map<string, Finding[]>();
  for (const f of state.findings) {
    for (const e of f.affected_entities) {
      const existing = entityToFindings.get(e.id) || [];
      existing.push(f);
      entityToFindings.set(e.id, existing);
    }
  }

  const compounds: CompoundFinding[] = [];
  const usedFindingIds = new Set<string>();

  for (const [entityId, relatedFindings] of entityToFindings) {
    if (relatedFindings.length < 2) continue;
    if (relatedFindings.every(f => usedFindingIds.has(f.id))) continue;

    const maxSeverity = relatedFindings.reduce((max, f) => {
      const order: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
      return (order[f.severity] || 0) > (order[max] || 0) ? f.severity : max;
    }, 'low' as string);

    compounds.push({
      id: uuid(),
      root_entity_id: entityId,
      root_entity_type: relatedFindings[0]!.affected_entities.find(e => e.id === entityId)?.type || 'unknown',
      findings: relatedFindings,
      combined_severity: maxSeverity as Severity,
      coordinated_recommendation: `${relatedFindings.length} related issues share a root cause. Addressing the root entity may resolve all of them.`,
    });

    relatedFindings.forEach(f => usedFindingIds.add(f.id));
  }

  return addCompoundFindings(state, compounds);
}

// ============================================================
// reason_root_cause — explain WHY
// ============================================================

const ROOT_CAUSE_SYSTEM = `You are FleetGraph, explaining the root cause of a project health finding.

Given a finding and the project data, explain:
1. WHAT happened — the specific condition detected
2. WHY it happened — trace back through document_history to find when it started and what changed
3. CONTRIBUTING FACTORS — other conditions that made this worse

Be specific and data-backed. Reference issue numbers, person names, and dates.
Keep the explanation concise (3-5 sentences).

Respond with valid JSON:
{
  "explanation": "...",
  "contributing_factors": [{"factor": "...", "evidence": "..."}],
  "temporal_context": "This started in Week N when..."
}`;

export async function reasonRootCause(state: FleetGraphState): Promise<FleetGraphState> {
  const findingsToExplain = state.findings.filter(
    f => f.severity === 'high' || f.severity === 'critical' || f.severity === 'medium'
  );

  if (findingsToExplain.length === 0) return state;

  const rootCauses: RootCause[] = [];

  // Process up to 3 findings to control token costs
  for (const finding of findingsToExplain.slice(0, 3)) {
    // Build name map for root cause context
    const rcNameMap = new Map<string, string>();
    for (const t of state.data.team) {
      const userId = (t as any).properties?.user_id;
      const name = (t as any).user_name || (t as any).title || 'Unknown';
      if (userId) rcNameMap.set(userId, name);
      rcNameMap.set((t as any).id, name);
    }

    // Enrich finding with resolved names before sending to Claude
    const enrichedFinding = {
      ...finding,
      affected_entities: finding.affected_entities.map(e => ({
        ...e,
        name: rcNameMap.get(e.id) || undefined,
      })),
    };

    const userPrompt = `Explain the root cause of this finding:

FINDING:
${JSON.stringify(enrichedFinding, null, 2)}

RELEVANT DOCUMENT HISTORY:
${JSON.stringify(state.data.document_history.slice(0, 50), null, 2)}

TEAM:
${JSON.stringify(state.data.team.map((t: any) => ({ name: (t as any).user_name || (t as any).title, email: (t as any).user_email })), null, 2)}`;

    const response = await callBedrock({
      system: ROOT_CAUSE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 1024,
    });

    if (response?.text) {
      try {
        const jsonMatch = response.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          rootCauses.push({
            finding_id: finding.id,
            explanation: parsed.explanation || 'Unable to determine root cause.',
            contributing_factors: parsed.contributing_factors || [],
            temporal_context: parsed.temporal_context,
          });
        }
      } catch {
        rootCauses.push({
          finding_id: finding.id,
          explanation: response.text.slice(0, 500),
          contributing_factors: [],
        });
      }
    }
  }

  return addRootCauses(state, rootCauses);
}

// ============================================================
// reason_query_response — on-demand chat
// ============================================================

const QUERY_RESPONSE_SYSTEM_BASE = `You are FleetGraph, a project intelligence agent embedded in the Ship project management tool.

The user is viewing a specific entity (issue, sprint, or project) and asking a question about it.
You have access to the entity's data, related issues, sprints, team members, document history, and accountability items.

Answer the user's question based on the data provided. Be:
- SPECIFIC: reference issue numbers, person names, dates
- CONCISE: answer directly, then elaborate if needed
- ACTIONABLE: suggest concrete next steps when relevant
- HONEST: if data is insufficient, say so

If the data reveals health issues (stale issues, blocker chains, etc.), proactively mention them.`;

export async function reasonQueryResponse(
  state: FleetGraphState,
  detectedRole?: DetectedRole
): Promise<FleetGraphState> {
  const question = state.trigger.chat_message || '';
  const entity = state.trigger.entity;

  // Build user ID → name map for resolving assignees/owners
  const userNameMap = new Map<string, string>();
  for (const t of state.data.team) {
    const userId = (t as any).properties?.user_id;
    const name = (t as any).user_name || (t as any).title || 'Unknown';
    if (userId) userNameMap.set(userId, name);
    userNameMap.set((t as any).id, name);
  }
  const resolveName = (id: string | undefined) => (id && userNameMap.get(id)) || undefined;

  const contextData = {
    entity_type: entity?.type,
    entity_id: entity?.id,
    issues: state.data.issues.slice(0, 30).map((i: any) => ({
      id: i.id,
      title: i.title,
      state: i.properties?.state,
      priority: i.properties?.priority,
      assignee: resolveName(i.properties?.assignee_id) || 'unassigned',
      estimate: i.properties?.estimate,
      updated_at: i.updated_at,
    })),
    sprints: state.data.sprints.map((s: any) => ({
      id: s.id,
      title: s.title,
      status: s.properties?.status,
      confidence: s.properties?.confidence,
    })),
    projects: state.data.projects.map((p: any) => ({
      id: p.id,
      title: p.title,
      owner: resolveName(p.properties?.owner_id) || 'unassigned',
      target_date: p.properties?.target_date,
    })),
    team: state.data.team.map((t: any) => ({
      name: (t as any).user_name || (t as any).title,
      email: (t as any).user_email,
    })),
    accountability_items: state.data.accountability_items.length > 0
      ? state.data.accountability_items
      : undefined,
    findings: state.findings,
    root_causes: state.root_causes,
    user_role: detectedRole ? {
      role: detectedRole.role,
      source: detectedRole.source,
    } : undefined,
  };

  // Build role-aware system prompt
  const roleSuffix = detectedRole ? buildRolePromptSuffix(detectedRole) : '';
  const systemPrompt = QUERY_RESPONSE_SYSTEM_BASE + roleSuffix;

  const chatHistory = state.trigger.chat_history || [];
  const messages = [
    ...chatHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    {
      role: 'user' as const,
      content: `Context data:\n${JSON.stringify(contextData, null, 2)}\n\nUser question: ${question}`,
    },
  ];

  const response = await callBedrock({
    system: systemPrompt,
    messages,
    max_tokens: 2048,
  });

  if (!response?.text) {
    // Fallback: generate a context-aware summary without LLM
    console.warn('[FleetGraph] Bedrock unavailable, using data-driven fallback');
    return setResponseDraft(state, buildDataDrivenFallback(state, question));
  }

  return setResponseDraft(state, response.text);
}

// ============================================================
// generateSprintPlan — rank backlog + carryover for sprint planning
// ============================================================

/**
 * Generate a sprint planning recommendation from backlog issues,
 * carryover from previous sprint, and team capacity.
 *
 * Ranking factors (weighted):
 *   1. Carryover flag (1.5x boost — incomplete from last sprint)
 *   2. Priority weight (urgent=4, high=3, medium=2, low=1)
 *   3. Dependency unblocking (issues that are parents of other backlog items)
 *   4. Due date proximity (closer = higher rank)
 *
 * Capacity fitting:
 *   Sum story points until team capacity_hours (or default 40h) is reached.
 *   If no estimates, use issue count limit of 8.
 */
export function generateSprintPlan(
  backlog: any[],
  carryover: any[],
  team: any[],
  sprintTitle: string
): string {
  // Combine and deduplicate (carryover might also appear in backlog)
  const seen = new Set<string>();
  const allIssues: Array<{ issue: any; isCarryover: boolean }> = [];

  for (const issue of carryover) {
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      allIssues.push({ issue, isCarryover: true });
    }
  }
  for (const issue of backlog) {
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      allIssues.push({ issue, isCarryover: false });
    }
  }

  if (allIssues.length === 0) {
    return `**Sprint Plan: ${sprintTitle}**\n\nNo backlog issues found for this project. Create issues first, then ask me to help plan.`;
  }

  // Build parent-child map for dependency scoring
  const childrenOf = new Map<string, number>(); // parentId → child count
  for (const { issue } of allIssues) {
    const assocs = issue.associations || [];
    for (const a of assocs) {
      if (a.type === 'parent') {
        childrenOf.set(a.id, (childrenOf.get(a.id) || 0) + 1);
      }
    }
  }

  // Score each issue
  const priorityWeight: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
  const now = new Date();

  const scored = allIssues.map(({ issue, isCarryover }) => {
    let score = 0;

    // Priority
    score += (priorityWeight[issue.properties?.priority] || 1) * 10;

    // Carryover boost
    if (isCarryover) score += 15;

    // Dependency unblocking: if this issue is a parent of others, boost it
    const unblockCount = childrenOf.get(issue.id) || 0;
    score += unblockCount * 8;

    // Due date proximity
    const dueDate = issue.properties?.due_date;
    if (dueDate) {
      const daysUntilDue = Math.ceil(
        (new Date(dueDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysUntilDue <= 7) score += 12;
      else if (daysUntilDue <= 14) score += 6;
    }

    return { issue, isCarryover, score, unblockCount };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Determine capacity
  const totalCapacityHours = team.reduce((sum: number, t: any) => {
    return sum + (t.properties?.capacity_hours || 0);
  }, 0) || 40; // Default 40h if no capacity set

  // Fit to capacity
  let cumulativePoints = 0;
  let cumulativeCount = 0;
  const recommended: typeof scored = [];
  const overflow: typeof scored = [];
  const pointsPerHour = 0.5; // Rough: 1 story point ≈ 2 hours
  const maxPoints = totalCapacityHours * pointsPerHour;
  const maxCount = 8; // Fallback if no estimates

  const hasEstimates = scored.some(s => s.issue.properties?.estimate > 0);

  for (const item of scored) {
    const points = item.issue.properties?.estimate || 0;

    if (hasEstimates) {
      if (cumulativePoints + points <= maxPoints) {
        recommended.push(item);
        cumulativePoints += points;
      } else {
        overflow.push(item);
      }
    } else {
      if (cumulativeCount < maxCount) {
        recommended.push(item);
        cumulativeCount++;
      } else {
        overflow.push(item);
      }
    }
  }

  // Build output
  let draft = `**Recommended Sprint Plan: ${sprintTitle}**\n`;
  draft += `*Capacity: ${totalCapacityHours}h`;
  if (hasEstimates) {
    draft += ` | Budget: ${maxPoints} story points`;
  }
  draft += `*\n\n`;

  if (recommended.length > 0) {
    let totalPts = 0;
    for (let i = 0; i < recommended.length; i++) {
      const { issue, isCarryover, unblockCount } = recommended[i]!;
      const pts = issue.properties?.estimate || 0;
      totalPts += pts;
      const ticket = issue.ticket_number ? `#${issue.ticket_number}` : '';
      const priority = issue.properties?.priority || '';
      const tags: string[] = [];
      if (isCarryover) tags.push('carryover');
      if (unblockCount > 0) tags.push(`unblocks ${unblockCount}`);
      if (issue.properties?.due_date) {
        const daysUntil = Math.ceil(
          (new Date(issue.properties.due_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (daysUntil <= 7) tags.push(`due in ${daysUntil}d`);
      }
      const tagStr = tags.length > 0 ? ` — ${tags.join(', ')}` : '';

      draft += `${i + 1}. **${issue.title}**`;
      if (ticket) draft += ` (${ticket})`;
      draft += ` [${priority}`;
      if (pts > 0) draft += `, ${pts} pts`;
      draft += `]${tagStr}\n`;
    }

    draft += `\n**Total: ${recommended.length} issues`;
    if (hasEstimates) draft += `, ${totalPts} story points`;
    draft += `**\n`;
  }

  if (overflow.length > 0) {
    draft += `\n*${overflow.length} additional issue${overflow.length > 1 ? 's' : ''} in backlog (exceeds capacity):*\n`;
    for (const { issue } of overflow.slice(0, 5)) {
      const priority = issue.properties?.priority || '';
      const pts = issue.properties?.estimate;
      draft += `- ${issue.title} [${priority}${pts ? `, ${pts} pts` : ''}]\n`;
    }
    if (overflow.length > 5) {
      draft += `- ... and ${overflow.length - 5} more\n`;
    }
  }

  return draft;
}

// ============================================================
// generateStandupDraft — build standup from observable activity
// ============================================================

/**
 * Generate a standup draft from document_history and issue states.
 * Works without LLM — pure data analysis.
 *
 * Sections:
 *   Yesterday: state transitions in last 24h
 *   Today: highest priority remaining issues
 *   Risks: blocker signals, sprint velocity warnings
 */
export function generateStandupDraft(state: FleetGraphState): string {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const userId = state.trigger.user_id;

  // --- Yesterday: find state transitions in last 24h ---
  const recentTransitions = state.data.document_history.filter((h: any) => {
    if (h.field !== 'state') return false;
    const date = new Date(h.created_at);
    return date >= oneDayAgo && date <= now;
  });

  // Map transitions to issues
  const issueMap = new Map<string, any>();
  for (const issue of state.data.issues) {
    issueMap.set(issue.id, issue);
  }

  const completed: string[] = [];
  const movedToReview: string[] = [];
  const started: string[] = [];
  const newBlockers: string[] = [];

  for (const t of recentTransitions) {
    const issue = issueMap.get(t.document_id);
    if (!issue) continue;

    // Filter to current user's issues if userId available
    if (userId && issue.properties?.assignee_id && issue.properties.assignee_id !== userId) continue;

    const label = issue.title || 'Untitled';
    const ticket = issue.ticket_number ? `#${issue.ticket_number}` : '';
    const ref = ticket ? `${label} (${ticket})` : label;

    if (t.new_value === 'done') {
      completed.push(ref);
    } else if (t.new_value === 'in_review') {
      movedToReview.push(ref);
    } else if (t.new_value === 'in_progress' && (t.old_value === 'todo' || t.old_value === 'backlog')) {
      started.push(ref);
    }
  }

  // Check for blockers (issues in_progress with parent in non-done state)
  for (const issue of state.data.issues) {
    if (userId && issue.properties?.assignee_id && issue.properties.assignee_id !== userId) continue;
    if (issue.properties?.state !== 'in_progress') continue;

    const assocs = issue.associations || [];
    for (const a of assocs) {
      if (a.type !== 'parent') continue;
      const parent = issueMap.get(a.id);
      if (parent && parent.properties?.state !== 'done' && parent.properties?.state !== 'cancelled') {
        const label = issue.title || 'Untitled';
        const parentLabel = parent.title || 'Untitled';
        newBlockers.push(`${label} (blocked by ${parentLabel})`);
      }
    }
  }

  // --- Today: highest priority remaining issues ---
  const userIssues = state.data.issues.filter((i: any) => {
    if (userId && i.properties?.assignee_id && i.properties.assignee_id !== userId) return false;
    return i.properties?.state === 'todo' || i.properties?.state === 'in_progress';
  });

  const priorityOrder: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };
  const todayFocus = userIssues
    .sort((a: any, b: any) => {
      const pa = priorityOrder[a.properties?.priority] || 5;
      const pb = priorityOrder[b.properties?.priority] || 5;
      return pa - pb;
    })
    .slice(0, 3)
    .map((i: any) => {
      const label = i.title || 'Untitled';
      const ticket = i.ticket_number ? `#${i.ticket_number}` : '';
      const priority = i.properties?.priority || '';
      return ticket ? `${label} (${ticket}, ${priority})` : `${label} (${priority})`;
    });

  // --- Risks: sprint findings ---
  const risks: string[] = [];
  for (const f of state.findings) {
    if (f.signal_type === 'sprint_collapse' || f.signal_type === 'blocker_chain') {
      risks.push(f.title);
    }
  }

  // --- Assemble ---
  let draft = '**Yesterday:**\n';
  if (completed.length > 0) {
    for (const c of completed) draft += `• Completed ${c}\n`;
  }
  if (movedToReview.length > 0) {
    for (const r of movedToReview) draft += `• Moved ${r} to in_review\n`;
  }
  if (started.length > 0) {
    for (const s of started) draft += `• Started ${s}\n`;
  }
  if (completed.length === 0 && movedToReview.length === 0 && started.length === 0) {
    draft += '• No state transitions recorded in the last 24 hours\n';
  }

  draft += '\n**Today:**\n';
  if (todayFocus.length > 0) {
    for (const t of todayFocus) draft += `• Focus on ${t}\n`;
  } else {
    draft += '• No pending issues found\n';
  }

  if (newBlockers.length > 0 || risks.length > 0) {
    draft += '\n**Risks/Blockers:**\n';
    for (const b of newBlockers) draft += `• ${b}\n`;
    for (const r of risks) draft += `• ${r}\n`;
  }

  return draft;
}

// ============================================================
// buildDataDrivenFallback — context-aware response when Bedrock is unavailable
// ============================================================

function buildDataDrivenFallback(state: FleetGraphState, question: string): string {
  const issues = state.data.issues;
  const sprints = state.data.sprints;
  const team = state.data.team;
  const findings = state.findings;
  const q = question.toLowerCase();

  // Build reusable data summaries
  const byState: Record<string, any[]> = {};
  const byAssignee: Record<string, any[]> = {};
  for (const issue of issues) {
    const st = (issue as any).properties?.state || 'unknown';
    (byState[st] ||= []).push(issue);
    const assignee = (issue as any).properties?.assignee_id;
    if (assignee) (byAssignee[assignee] ||= []).push(issue);
  }

  const staleIssues = issues.filter((i: any) => {
    if (!i.updated_at) return false;
    const daysSince = (Date.now() - new Date(i.updated_at).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince > 3 && (i as any).properties?.state !== 'done';
  });

  const blockedIssues = issues.filter(
    (i: any) => i.properties?.state === 'blocked' || i.properties?.state === 'on_hold'
  );

  // Map user IDs to names — assignee_id in issues is the user ID, not the person doc ID
  const teamNameMap = new Map<string, string>();
  for (const t of team) {
    const userId = (t as any).properties?.user_id;
    const name = (t as any).user_name || (t as any).title || 'Unknown';
    if (userId) teamNameMap.set(userId, name);
    // Also map document ID as fallback
    teamNameMap.set((t as any).id, name);
  }

  // Route by question intent
  if (q.includes('overload') || q.includes('most assigned') || q.includes('who has') || q.includes('workload')) {
    const sorted = Object.entries(byAssignee)
      .map(([id, items]) => ({ name: teamNameMap.get(id) || id.slice(0, 8), count: items.length, items }))
      .sort((a, b) => b.count - a.count);

    if (sorted.length === 0) return 'No issues are currently assigned to team members.';

    let out = '**Task distribution across the team:**\n\n';
    for (const { name, count, items } of sorted.slice(0, 8)) {
      const inProgress = items.filter((i: any) => i.properties?.state === 'in_progress').length;
      out += `- **${name}**: ${count} issue${count !== 1 ? 's' : ''}`;
      if (inProgress > 0) out += ` (${inProgress} in progress)`;
      out += '\n';
    }
    if (sorted.length > 0) {
      const top = sorted[0]!;
      out += `\n${top.name} has the highest load with ${top.count} issues.`;
    }
    return out;
  }

  if (q.includes('blocker') || q.includes('blocked') || q.includes('stuck')) {
    if (blockedIssues.length === 0 && staleIssues.length === 0) {
      return 'No blocked or stale issues found. Everything appears to be moving.';
    }
    let out = '';
    if (blockedIssues.length > 0) {
      out += `**${blockedIssues.length} blocked issue${blockedIssues.length !== 1 ? 's' : ''}:**\n`;
      for (const i of blockedIssues.slice(0, 5)) {
        out += `- **${(i as any).title}** — assigned to ${teamNameMap.get((i as any).properties?.assignee_id) || 'unassigned'}\n`;
      }
    }
    if (staleIssues.length > 0) {
      out += `\n**${staleIssues.length} stale issue${staleIssues.length !== 1 ? 's' : ''} (no activity >3 days):**\n`;
      for (const i of staleIssues.slice(0, 5)) {
        const days = Math.floor((Date.now() - new Date(i.updated_at).getTime()) / (1000 * 60 * 60 * 24));
        out += `- **${(i as any).title}** — ${days} days stale\n`;
      }
    }
    return out;
  }

  if (q.includes('risk') || q.includes('concern') || q.includes('worry')) {
    let out = '';
    if (findings.length > 0) {
      out += `**${findings.length} risk${findings.length !== 1 ? 's' : ''} detected:**\n\n`;
      for (const f of findings) {
        out += `- [${f.severity}] **${f.title || f.signal_type}**: ${f.description || ''}\n`;
      }
    } else {
      const risks: string[] = [];
      if (staleIssues.length > 3) risks.push(`${staleIssues.length} issues have gone stale (no updates in 3+ days)`);
      if (blockedIssues.length > 0) risks.push(`${blockedIssues.length} issue${blockedIssues.length !== 1 ? 's are' : ' is'} blocked`);
      const highPriOpen = issues.filter((i: any) =>
        (i.properties?.priority === 'high' || i.properties?.priority === 'urgent') && i.properties?.state !== 'done'
      );
      if (highPriOpen.length > 0) risks.push(`${highPriOpen.length} high/urgent priority issues still open`);

      if (risks.length > 0) {
        out += '**Potential risks:**\n\n';
        for (const r of risks) out += `- ${r}\n`;
      } else {
        out += 'No significant risks detected. The project appears healthy.';
      }
    }
    return out;
  }

  if (q.includes('sprint') && (q.includes('track') || q.includes('progress') || q.includes('status') || q.includes('how'))) {
    const done = byState['done']?.length || 0;
    const inProgress = byState['in_progress']?.length || 0;
    const todo = byState['todo']?.length || byState['open']?.length || 0;
    const total = issues.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    let out = `**Sprint progress: ${pct}% complete**\n\n`;
    out += `- Done: ${done}\n`;
    out += `- In progress: ${inProgress}\n`;
    out += `- To do: ${todo}\n`;
    out += `- Total: ${total}\n`;
    if (blockedIssues.length > 0) out += `- Blocked: ${blockedIssues.length}\n`;
    if (staleIssues.length > 0) out += `\n${staleIssues.length} issue${staleIssues.length !== 1 ? 's have' : ' has'} gone stale.`;
    return out;
  }

  // Default: context-aware overview
  const done = byState['done']?.length || 0;
  const inProgress = byState['in_progress']?.length || 0;
  const total = issues.length;

  let out = `**Overview** (${total} issues across ${sprints.length} sprint${sprints.length !== 1 ? 's' : ''}):\n\n`;
  out += `- ${done} done, ${inProgress} in progress, ${total - done - inProgress} remaining\n`;
  if (blockedIssues.length > 0) out += `- ${blockedIssues.length} blocked\n`;
  if (staleIssues.length > 0) out += `- ${staleIssues.length} stale (no activity >3 days)\n`;
  if (findings.length > 0) {
    out += `\n**Findings:**\n`;
    for (const f of findings.slice(0, 3)) {
      out += `- [${f.severity}] ${f.title || f.signal_type}: ${f.description || ''}\n`;
    }
  }
  out += '\n*Note: AI analysis is temporarily unavailable. Showing data summary.*';
  return out;
}
