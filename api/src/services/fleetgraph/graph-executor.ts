/**
 * FleetGraph Graph Executor — orchestrates node execution with conditional branching.
 *
 * Implements the graph execution logic in TypeScript, following the architecture:
 *   detect → triage → compound → explain → simulate → prioritize → draft → approve
 *
 * Each node is a pure function: (state) => state or (pool, state) => state.
 * The executor handles sequencing, parallelism, and conditional branching.
 *
 * LangSmith tracing: every run is traced via the `traceable` wrapper.
 * Set LANGCHAIN_TRACING_V2=true and LANGCHAIN_API_KEY to enable.
 */

import type { Pool } from 'pg';
import type { FleetGraphState, FleetGraphMode, FleetGraphTrigger } from '@ship/shared';
import { traceable } from 'langsmith/traceable';
import { Client as LangSmithClient } from 'langsmith';
import { createInitialState } from './graph-state.js';

// Verify LangSmith connectivity on startup
const lsClient = new LangSmithClient();
lsClient.readProject({ projectName: 'fleetgraph' })
  .then(() => console.log('[FleetGraph] LangSmith tracing connected (project: fleetgraph)'))
  .catch(() => console.warn('[FleetGraph] LangSmith not available — traces will not be recorded'));
import {
  fetchActivity,
  fetchIssues,
  fetchSprintDetail,
  fetchProjectDetail,
  fetchTeam,
  fetchHistory,
  fetchAccountability,
  fetchBacklog,
  fetchCarryover,
} from './nodes-fetch.js';
import {
  reasonHealthCheck,
  reasonSeverityTriage,
  reasonCompoundInsight,
  reasonRootCause,
  reasonQueryResponse,
  generateStandupDraft,
  generateSprintPlan,
} from './nodes-reasoning.js';
import {
  generateInsight,
  draftArtifact,
  composeChatResponse,
  surfaceInsight,
  persistNarrative,
  logCleanRun,
} from './nodes-action.js';
import { detectUserRole } from './role-detection.js';
import { computeAndPersistHealthScores } from './health-score.js';

export interface ExecutionTrace {
  nodes_executed: string[];
  duration_ms: number;
  findings_count: number;
  errors: Array<{ node: string; error: string }>;
}

/**
 * Run the proactive analysis pipeline.
 *
 * Flow:
 *   fetch_activity → (no activity? → log_clean_run)
 *   → parallel(fetch_issues, fetch_sprint_detail, fetch_team)
 *   → fetch_history
 *   → reason_health_check → (no findings? → persist_narrative → log_clean_run)
 *   → reason_severity_triage
 *   → reason_compound_insight (if 2+ findings)
 *   → reason_root_cause (medium+ findings)
 *   → draft_artifact (high/critical)
 *   → surface_insight
 *   → persist_narrative → log_clean_run
 */
export const runProactive = traceable(
  async function runProactive(
    pool: Pool,
    trigger: FleetGraphTrigger
  ): Promise<{ state: FleetGraphState; trace: ExecutionTrace }> {
  const start = Date.now();
  const nodesExecuted: string[] = [];
  let state = createInitialState('proactive', trigger);

  const trackNode = (name: string) => nodesExecuted.push(name);

  try {
    // 1. Fetch activity to gate further analysis
    trackNode('fetch_activity');
    state = await fetchActivity(pool, state);

    const hasActivity = Object.keys(state.data.activity).length > 0;
    if (!hasActivity) {
      trackNode('log_clean_run');
      state = await logCleanRun(pool, state);
      return { state, trace: buildTrace(nodesExecuted, start, state) };
    }

    // 2. Parallel fetch: issues, sprints, team
    trackNode('fetch_issues');
    trackNode('fetch_sprint_detail');
    trackNode('fetch_team');
    const [issueState, sprintState, teamState] = await Promise.all([
      fetchIssues(pool, state),
      fetchSprintDetail(pool, state),
      fetchTeam(pool, state),
    ]);
    state = {
      ...state,
      data: {
        ...state.data,
        issues: issueState.data.issues,
        sprints: sprintState.data.sprints,
        team: teamState.data.team,
      },
    };

    // 3. Fetch history (depends on issues being loaded)
    trackNode('fetch_history');
    state = await fetchHistory(pool, state);

    // 4. Reasoning: health check
    trackNode('reason_health_check');
    state = await reasonHealthCheck(state);
    state = resolveNamesInFindings(state);

    if (state.findings.length === 0) {
      // Compute health scores even for healthy projects (score = 100)
      const projectIds = extractProjectIds(state);
      if (projectIds.length > 0) {
        trackNode('compute_health_score');
        await computeAndPersistHealthScores(pool, state.trigger.workspace_id, [], projectIds);
      }
      trackNode('persist_narrative');
      state = await persistNarrative(pool, state);
      trackNode('log_clean_run');
      state = await logCleanRun(pool, state);
      return { state, trace: buildTrace(nodesExecuted, start, state) };
    }

    // 5. Severity triage
    trackNode('reason_severity_triage');
    state = reasonSeverityTriage(state);

    // 6. Compound insight (if 2+ findings share entities)
    if (state.findings.length >= 2) {
      trackNode('reason_compound_insight');
      state = reasonCompoundInsight(state);
    }

    // 7. Root cause for medium+ severity
    const hasMediumPlus = state.findings.some(
      f => f.severity === 'medium' || f.severity === 'high' || f.severity === 'critical'
    );
    if (hasMediumPlus) {
      trackNode('reason_root_cause');
      state = await reasonRootCause(state);
    }

    // 8. Draft artifact for high/critical
    const hasHigh = state.findings.some(
      f => f.severity === 'high' || f.severity === 'critical'
    );
    if (hasHigh) {
      trackNode('draft_artifact');
      state = await draftArtifact(state);
    }

    // 9. Replace UUIDs with human-readable names in all text content
    state = humanizeUuids(state);

    trackNode('generate_insight');
    state = generateInsight(state);

    trackNode('surface_insight');
    state = await surfaceInsight(pool, state);

    // 10. Compute and persist health scores for affected projects
    const projectIds = extractProjectIds(state);
    if (projectIds.length > 0) {
      trackNode('compute_health_score');
      await computeAndPersistHealthScores(
        pool, state.trigger.workspace_id, state.findings, projectIds
      );
    }

    trackNode('persist_narrative');
    state = await persistNarrative(pool, state);

    trackNode('log_clean_run');
    state = await logCleanRun(pool, state);

    return { state, trace: buildTrace(nodesExecuted, start, state) };
  } catch (err) {
    console.error('[FleetGraph] Proactive execution failed:', err);
    state.errors.push({
      node: nodesExecuted[nodesExecuted.length - 1] || 'unknown',
      error: err instanceof Error ? err.message : String(err),
      recovered: false,
    });
    return { state, trace: buildTrace(nodesExecuted, start, state) };
  }
}, { name: 'fleetgraph_proactive', project_name: 'fleetgraph', metadata: { mode: 'proactive' } });

/**
 * Run the on-demand chat pipeline.
 *
 * Flow:
 *   parallel(fetch_issues, fetch_sprint_detail, fetch_project_detail, fetch_team, fetch_history)
 *   → reason_health_check (background analysis)
 *   → reason_query_response
 *   → compose_chat_response
 */
export const runOnDemand = traceable(
  async function runOnDemand(
    pool: Pool,
    trigger: FleetGraphTrigger
  ): Promise<{ state: FleetGraphState; trace: ExecutionTrace }> {
  const start = Date.now();
  const nodesExecuted: string[] = [];
  let state = createInitialState('on_demand', trigger);

  const trackNode = (name: string) => nodesExecuted.push(name);

  try {
    // 1. Parallel fetch for entity context (including accountability)
    trackNode('fetch_issues');
    trackNode('fetch_sprint_detail');
    trackNode('fetch_project_detail');
    trackNode('fetch_team');
    trackNode('fetch_accountability');
    const [issueState, sprintState, projectState, teamState, accountabilityState] = await Promise.all([
      fetchIssues(pool, state),
      fetchSprintDetail(pool, state),
      fetchProjectDetail(pool, state),
      fetchTeam(pool, state),
      fetchAccountability(pool, state),
    ]);
    state = {
      ...state,
      data: {
        ...state.data,
        issues: issueState.data.issues,
        sprints: sprintState.data.sprints,
        projects: projectState.data.projects,
        team: teamState.data.team,
        accountability_items: accountabilityState.data.accountability_items,
      },
    };

    // 2. Fetch history
    trackNode('fetch_history');
    state = await fetchHistory(pool, state);

    // 3. Background health check to enrich context
    trackNode('reason_health_check');
    state = await reasonHealthCheck(state);
    state = resolveNamesInFindings(state);

    if (state.findings.length > 0) {
      trackNode('reason_severity_triage');
      state = reasonSeverityTriage(state);

      // Root cause for medium+ findings to enrich the chat response
      const hasMediumPlus = state.findings.some(
        f => f.severity === 'medium' || f.severity === 'high' || f.severity === 'critical'
      );
      if (hasMediumPlus) {
        trackNode('reason_root_cause');
        state = await reasonRootCause(state);
      }
    }

    // 4. Detect user role from RACI cascade
    let detectedRole;
    if (state.trigger.user_id) {
      trackNode('detect_role');
      detectedRole = await detectUserRole(
        pool,
        state.trigger.user_id,
        state.trigger.workspace_id,
        state.trigger.entity?.type,
        state.trigger.entity?.id
      );
    }

    // 5. Generate the chat response — route by intent
    const chatMessage = (state.trigger.chat_message || '').toLowerCase();
    const isStandupRequest = chatMessage.includes('standup') || chatMessage.includes('stand-up')
      || chatMessage.includes('daily update') || chatMessage.includes('draft my');
    const isPlanRequest = chatMessage.includes('plan') || chatMessage.includes('help me plan')
      || chatMessage.includes('sprint planning') || chatMessage.includes('what should be in');

    if (isStandupRequest) {
      trackNode('generate_standup_draft');
      const draft = generateStandupDraft(state);
      state = { ...state, response_draft: draft };
    } else if (isPlanRequest && state.trigger.entity?.type === 'sprint') {
      // Fetch backlog and carryover for planning
      trackNode('fetch_backlog');
      trackNode('fetch_carryover');
      const [backlog, carryover] = await Promise.all([
        fetchBacklog(pool, state),
        fetchCarryover(pool, state),
      ]);
      trackNode('generate_sprint_plan');
      const sprintTitle = state.data.sprints[0]?.title || 'Sprint';
      const draft = generateSprintPlan(backlog, carryover, state.data.team, sprintTitle);
      state = { ...state, response_draft: draft };
    } else {
      trackNode('reason_query_response');
      state = await reasonQueryResponse(state, detectedRole);
    }

    // 6. Compose final response
    trackNode('compose_chat_response');
    state = composeChatResponse(state);

    // 7. Replace UUIDs with human-readable names
    state = humanizeUuids(state);

    return { state, trace: buildTrace(nodesExecuted, start, state) };
  } catch (err) {
    console.error('[FleetGraph] On-demand execution failed:', err);
    state.errors.push({
      node: nodesExecuted[nodesExecuted.length - 1] || 'unknown',
      error: err instanceof Error ? err.message : String(err),
      recovered: false,
    });
    // Still return a response
    if (!state.response_draft) {
      state.response_draft = 'I encountered an error while analyzing the data. Please try again.';
    }
    return { state, trace: buildTrace(nodesExecuted, start, state) };
  }
}, { name: 'fleetgraph_on_demand', project_name: 'fleetgraph', metadata: { mode: 'on_demand' } });

/**
 * Build a UUID → human label map from all entities in state.
 * Then replace every UUID occurrence in text fields across findings, root causes, and response drafts.
 */
function humanizeUuids(state: FleetGraphState): FleetGraphState {
  // Build comprehensive UUID → label map
  const labelMap = new Map<string, string>();

  for (const t of state.data.team) {
    const userId = (t as any).properties?.user_id;
    const name = (t as any).user_name || (t as any).title || '';
    if (name) {
      if (userId) labelMap.set(userId, name);
      labelMap.set((t as any).id, name);
    }
  }
  for (const i of state.data.issues) {
    const title = (i as any).title;
    if (title) labelMap.set((i as any).id, title);
  }
  for (const s of state.data.sprints) {
    const title = (s as any).title;
    if (title) labelMap.set((s as any).id, title);
  }
  for (const p of state.data.projects) {
    const title = (p as any).title;
    if (title) labelMap.set((p as any).id, title);
  }

  if (labelMap.size === 0) return state;

  // UUID regex (standard format)
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  const replaceInText = (text: string | undefined): string | undefined => {
    if (!text) return text;
    return text.replace(uuidRe, (match) => {
      const label = labelMap.get(match.toLowerCase());
      return label || match;
    });
  };

  // Replace in findings
  const findings = state.findings.map(f => {
    const updated = {
      ...f,
      title: replaceInText(f.title) || f.title,
      description: replaceInText(f.description) || f.description,
    };
    if (f.proposed_action) {
      updated.proposed_action = {
        ...f.proposed_action,
        description: replaceInText(f.proposed_action.description) || f.proposed_action.description,
        payload: f.proposed_action.payload ? {
          ...f.proposed_action.payload,
          content: typeof f.proposed_action.payload.content === 'string'
            ? replaceInText(f.proposed_action.payload.content)
            : f.proposed_action.payload.content,
        } : f.proposed_action.payload,
      };
    }
    return updated;
  });

  // Replace in root causes
  const root_causes = state.root_causes.map(rc => ({
    ...rc,
    explanation: replaceInText(rc.explanation) || rc.explanation,
    temporal_context: replaceInText(rc.temporal_context),
    contributing_factors: rc.contributing_factors.map(cf => ({
      ...cf,
      factor: replaceInText(cf.factor) || cf.factor,
      evidence: replaceInText(cf.evidence) || cf.evidence,
    })),
  }));

  // Replace in response draft
  const response_draft = replaceInText(state.response_draft) || state.response_draft;

  return { ...state, findings, root_causes, response_draft };
}

/**
 * Enrich findings by resolving user IDs to names using team data.
 * Replaces person entity IDs with names and adds assignee names to finding data.
 */
function resolveNamesInFindings(state: FleetGraphState): FleetGraphState {
  const nameMap = new Map<string, string>();
  for (const t of state.data.team) {
    const userId = (t as any).properties?.user_id;
    const name = (t as any).user_name || (t as any).title || 'Unknown';
    if (userId) nameMap.set(userId, name);
    nameMap.set((t as any).id, name);
  }

  const enrichedFindings = state.findings.map(f => ({
    ...f,
    affected_entities: f.affected_entities.map(e => ({
      ...e,
      title: e.type === 'person' && !e.title ? (nameMap.get(e.id) || e.id) : e.title,
    })),
    data: {
      ...f.data,
      assignee_name: f.data?.assignee_id ? (nameMap.get(f.data.assignee_id as string) || undefined) : undefined,
    },
  }));

  return { ...state, findings: enrichedFindings };
}

function buildTrace(
  nodesExecuted: string[],
  startTime: number,
  state: FleetGraphState
): ExecutionTrace {
  return {
    nodes_executed: nodesExecuted,
    duration_ms: Date.now() - startTime,
    findings_count: state.findings.length,
    errors: state.errors.map(e => ({ node: e.node, error: e.error })),
  };
}

/**
 * Extract unique project IDs from the graph state.
 * Looks at: activity keys, issue associations, and project data.
 */
function extractProjectIds(state: FleetGraphState): string[] {
  const ids = new Set<string>();

  // From activity (proactive mode — keys are project IDs)
  for (const key of Object.keys(state.data.activity)) {
    ids.add(key);
  }

  // From projects fetched directly
  for (const p of state.data.projects) {
    ids.add(p.id);
  }

  // From issue associations
  for (const issue of state.data.issues) {
    const assocs = (issue as any).associations || [];
    for (const a of assocs) {
      if (a.type === 'project') ids.add(a.id);
    }
  }

  return [...ids];
}
