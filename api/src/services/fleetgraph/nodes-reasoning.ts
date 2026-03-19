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
  // Build context from fetched data
  const issuesSummary = state.data.issues.map((i: any) => ({
    id: i.id,
    title: i.title,
    state: i.properties?.state,
    priority: i.properties?.priority,
    assignee_id: i.properties?.assignee_id,
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
    id: t.id,
    name: t.user_name || t.title,
    user_id: t.properties?.user_id,
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

  // Heuristic fallback: detect ghost blockers mechanically
  if (findings.length === 0) {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    for (const issue of state.data.issues) {
      const i = issue as any;
      if (i.properties?.state === 'in_progress' && new Date(i.updated_at) < threeDaysAgo) {
        findings.push({
          id: uuid(),
          signal_type: 'ghost_blocker',
          severity: 'medium',
          title: `Stale issue: ${i.title}`,
          description: `Issue has been in_progress since ${i.updated_at} with no recent activity.`,
          affected_entities: [{ type: 'issue', id: i.id, title: i.title }],
          data: { days_stale: Math.floor((now.getTime() - new Date(i.updated_at).getTime()) / (24 * 60 * 60 * 1000)) },
          confidence: 0.3,
          source: 'heuristic',
        });
      }
    }
  }

  return addFindings(state, findings);
}

// ============================================================
// reason_severity_triage — rank and filter
// ============================================================

export function reasonSeverityTriage(state: FleetGraphState): FleetGraphState {
  // Filter out suppressed findings
  const activeFindings = state.findings.filter(
    f => !state.suppressed_hashes.includes(hashFinding(f))
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

function hashFinding(f: Finding): string {
  return `${f.signal_type}:${f.affected_entities.map(e => e.id).sort().join(',')}`;
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
    const userPrompt = `Explain the root cause of this finding:

FINDING:
${JSON.stringify(finding, null, 2)}

RELEVANT DOCUMENT HISTORY:
${JSON.stringify(state.data.document_history.slice(0, 50), null, 2)}

TEAM:
${JSON.stringify(state.data.team.map((t: any) => ({ id: t.id, name: t.user_name || t.title })), null, 2)}`;

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

const QUERY_RESPONSE_SYSTEM = `You are FleetGraph, a project intelligence agent embedded in the Ship project management tool.

The user is viewing a specific entity (issue, sprint, or project) and asking a question about it.
You have access to the entity's data, related issues, sprints, team members, and document history.

Answer the user's question based on the data provided. Be:
- SPECIFIC: reference issue numbers, person names, dates
- CONCISE: answer directly, then elaborate if needed
- ACTIONABLE: suggest concrete next steps when relevant
- HONEST: if data is insufficient, say so

Adapt your response based on the user's likely role:
- If they seem to be a PM (asking about project health, team): give operational guidance
- If they seem to be an engineer (asking about specific issues): give task-level detail
- If they seem to be a director (asking about portfolio): give strategic summary

If the data reveals health issues (stale issues, blocker chains, etc.), proactively mention them.`;

export async function reasonQueryResponse(state: FleetGraphState): Promise<FleetGraphState> {
  const question = state.trigger.chat_message || '';
  const entity = state.trigger.entity;

  const contextData = {
    entity_type: entity?.type,
    entity_id: entity?.id,
    issues: state.data.issues.slice(0, 30).map((i: any) => ({
      id: i.id,
      title: i.title,
      state: i.properties?.state,
      priority: i.properties?.priority,
      assignee_id: i.properties?.assignee_id,
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
      owner_id: p.properties?.owner_id,
      target_date: p.properties?.target_date,
    })),
    team: state.data.team.map((t: any) => ({
      id: t.id,
      name: t.user_name || t.title,
    })),
    findings: state.findings,
    root_causes: state.root_causes,
  };

  const chatHistory = state.trigger.chat_history || [];
  const messages = [
    ...chatHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    {
      role: 'user' as const,
      content: `Context data:\n${JSON.stringify(contextData, null, 2)}\n\nUser question: ${question}`,
    },
  ];

  const response = await callBedrock({
    system: QUERY_RESPONSE_SYSTEM,
    messages,
    max_tokens: 2048,
  });

  if (!response?.text) {
    // Fallback: generate a data-driven summary without LLM
    const issueCount = state.data.issues.length;
    const sprintCount = state.data.sprints.length;
    const findings = state.findings;
    let fallback = `Here's what I found in the data:\n\n`;
    fallback += `- **${issueCount} issues** in scope, **${sprintCount} sprints** tracked\n`;
    if (findings.length > 0) {
      fallback += `- **${findings.length} finding(s)** detected:\n`;
      for (const f of findings) {
        fallback += `  - [${f.severity}] ${f.signal_type}: ${f.description || 'See details'}\n`;
      }
    } else {
      fallback += `- No health issues detected — project looks on track\n`;
    }
    const staleIssues = state.data.issues.filter((i: any) => {
      if (!i.updated_at) return false;
      const daysSince = (Date.now() - new Date(i.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince > 3 && i.properties?.state !== 'done';
    });
    if (staleIssues.length > 0) {
      fallback += `- **${staleIssues.length} stale issues** (no activity >3 days): ${staleIssues.slice(0, 3).map((i: any) => i.title).join(', ')}${staleIssues.length > 3 ? '...' : ''}\n`;
    }
    return setResponseDraft(state, fallback);
  }

  return setResponseDraft(state, response.text);
}
