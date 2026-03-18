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
} from './nodes-fetch.js';
import {
  reasonHealthCheck,
  reasonSeverityTriage,
  reasonCompoundInsight,
  reasonRootCause,
  reasonQueryResponse,
} from './nodes-reasoning.js';
import {
  generateInsight,
  draftArtifact,
  composeChatResponse,
  surfaceInsight,
  persistNarrative,
  logCleanRun,
} from './nodes-action.js';

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

    if (state.findings.length === 0) {
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

    // 9. Persist results
    trackNode('generate_insight');
    state = generateInsight(state);

    trackNode('surface_insight');
    state = await surfaceInsight(pool, state);

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
    // 1. Parallel fetch for entity context
    trackNode('fetch_issues');
    trackNode('fetch_sprint_detail');
    trackNode('fetch_project_detail');
    trackNode('fetch_team');
    const [issueState, sprintState, projectState, teamState] = await Promise.all([
      fetchIssues(pool, state),
      fetchSprintDetail(pool, state),
      fetchProjectDetail(pool, state),
      fetchTeam(pool, state),
    ]);
    state = {
      ...state,
      data: {
        ...state.data,
        issues: issueState.data.issues,
        sprints: sprintState.data.sprints,
        projects: projectState.data.projects,
        team: teamState.data.team,
      },
    };

    // 2. Fetch history
    trackNode('fetch_history');
    state = await fetchHistory(pool, state);

    // 3. Background health check to enrich context
    trackNode('reason_health_check');
    state = await reasonHealthCheck(state);

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

    // 4. Generate the chat response
    trackNode('reason_query_response');
    state = await reasonQueryResponse(state);

    // 5. Compose final response
    trackNode('compose_chat_response');
    state = composeChatResponse(state);

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
