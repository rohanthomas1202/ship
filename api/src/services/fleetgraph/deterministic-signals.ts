/**
 * FleetGraph deterministic signal detection — pure data analysis without LLM.
 *
 * These run BEFORE the Bedrock reasoning call to catch obvious health signals
 * mechanically. They produce findings with confidence: 1.0 since the detection
 * is deterministic (data either matches the condition or it doesn't).
 */

import { v4 as uuid } from 'uuid';
import type { Finding, Severity } from '@ship/shared';

// ============================================================
// Ghost Blocker Detection
// ============================================================

/**
 * Detect ghost blockers — issues stuck in 'in_progress' with no activity.
 *
 * A ghost blocker is an issue where:
 * - state = 'in_progress'
 * - No document_history entry in last 3 business days
 * - OR updated_at > 3 business days ago (fallback if no history)
 */
export function detectGhostBlockers(
  issues: any[],
  documentHistory: any[],
  now: Date = new Date()
): Finding[] {
  const findings: Finding[] = [];
  const threeBizDaysAgo = subtractBusinessDays(now, 3);

  // Build a map of most recent history entry per issue
  const lastActivityMap = new Map<string, Date>();
  for (const entry of documentHistory) {
    const issueId = entry.document_id;
    const entryDate = new Date(entry.created_at);
    const existing = lastActivityMap.get(issueId);
    if (!existing || entryDate > existing) {
      lastActivityMap.set(issueId, entryDate);
    }
  }

  for (const issue of issues) {
    if (issue.properties?.state !== 'in_progress') continue;

    const lastActivity = lastActivityMap.get(issue.id)
      || new Date(issue.updated_at);

    if (lastActivity >= threeBizDaysAgo) continue;

    const daysStale = Math.floor(
      (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)
    );

    const severity: Severity = daysStale >= 7 ? 'high' : daysStale >= 5 ? 'medium' : 'low';

    findings.push({
      id: uuid(),
      signal_type: 'ghost_blocker',
      severity,
      title: `Stale issue: ${issue.title || 'Untitled'}`,
      description: `Issue has been in_progress for ${daysStale} days with no activity since ${lastActivity.toISOString().slice(0, 10)}.`,
      affected_entities: [
        { type: 'issue', id: issue.id, title: issue.title },
        ...(issue.properties?.assignee_id
          ? [{ type: 'person', id: issue.properties.assignee_id }]
          : []),
      ],
      data: {
        days_stale: daysStale,
        last_activity: lastActivity.toISOString(),
        assignee_id: issue.properties?.assignee_id || null,
        priority: issue.properties?.priority || null,
        estimate: issue.properties?.estimate || null,
      },
      confidence: 1.0,
      source: 'deterministic',
    });
  }

  return findings;
}

// ============================================================
// Approval Bottleneck Detection
// ============================================================

/**
 * Detect approval bottlenecks — plan/review approvals stuck for >2 business days.
 *
 * An approval bottleneck is:
 * - plan_approval.state is 'changes_requested' for >2 business days
 * - Sprint is 'active' with no plan_approval (never submitted) for >2 business days
 * - review_approval.state is 'changes_requested' for >2 business days
 */
export function detectApprovalBottlenecks(
  sprints: any[],
  documentHistory: any[],
  now: Date = new Date()
): Finding[] {
  const findings: Finding[] = [];
  const twoBizDaysAgo = subtractBusinessDays(now, 2);

  for (const sprint of sprints) {
    const props = sprint.properties || {};
    if (props.status === 'completed') continue;

    // Check plan approval
    const planApproval = props.plan_approval;
    if (
      planApproval?.state === 'changes_requested' ||
      (props.status === 'active' && (!planApproval || !planApproval.state))
    ) {
      const stateDate = planApproval?.approved_at
        ? new Date(planApproval.approved_at)
        : new Date(sprint.started_at || sprint.created_at);

      if (stateDate < twoBizDaysAgo) {
        const daysWaiting = Math.floor(
          (now.getTime() - stateDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        findings.push({
          id: uuid(),
          signal_type: 'approval_bottleneck',
          severity: daysWaiting >= 5 ? 'high' : 'medium',
          title: `Plan approval pending: ${sprint.title || 'Sprint'}`,
          description: `Sprint plan ${planApproval?.state === 'changes_requested' ? 'has changes requested' : 'has not been submitted'} for ${daysWaiting} days.`,
          affected_entities: [
            { type: 'sprint', id: sprint.id, title: sprint.title },
          ],
          data: {
            approval_type: 'plan',
            approval_state: planApproval?.state || null,
            days_waiting: daysWaiting,
            owner_id: props.owner_id || null,
          },
          confidence: 1.0,
          source: 'deterministic',
        });
      }
    }

    // Check review approval
    const reviewApproval = props.review_approval;
    if (reviewApproval?.state === 'changes_requested') {
      const stateDate = reviewApproval.approved_at
        ? new Date(reviewApproval.approved_at)
        : new Date(sprint.updated_at || sprint.created_at);

      if (stateDate < twoBizDaysAgo) {
        const daysWaiting = Math.floor(
          (now.getTime() - stateDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        findings.push({
          id: uuid(),
          signal_type: 'approval_bottleneck',
          severity: daysWaiting >= 5 ? 'high' : 'medium',
          title: `Review approval pending: ${sprint.title || 'Sprint'}`,
          description: `Sprint review has changes requested for ${daysWaiting} days.`,
          affected_entities: [
            { type: 'sprint', id: sprint.id, title: sprint.title },
          ],
          data: {
            approval_type: 'review',
            approval_state: reviewApproval.state,
            days_waiting: daysWaiting,
            owner_id: props.owner_id || null,
          },
          confidence: 1.0,
          source: 'deterministic',
        });
      }
    }
  }

  return findings;
}

// ============================================================
// Blocker Chain Detection (deterministic graph traversal)
// ============================================================

/**
 * Detect blocker chains — parent issues blocking 3+ downstream issues.
 *
 * Traverses document_associations with relationship_type = 'parent' to find
 * parent issues in todo/in_progress that transitively block 3+ children.
 */
export function detectBlockerChains(
  issues: any[],
  now: Date = new Date()
): Finding[] {
  const findings: Finding[] = [];

  // Build parent-child map from associations
  // associations format: [{ type: 'parent', id: parentId }, { type: 'sprint', id: sprintId }, ...]
  const childrenOf = new Map<string, string[]>(); // parentId → childIds[]
  const issueMap = new Map<string, any>(); // id → issue

  for (const issue of issues) {
    issueMap.set(issue.id, issue);
    const assocs = issue.associations || [];
    for (const assoc of assocs) {
      if (assoc.type === 'parent') {
        const children = childrenOf.get(assoc.id) || [];
        children.push(issue.id);
        childrenOf.set(assoc.id, children);
      }
    }
  }

  // Find root blockers: issues that are parents AND in todo/in_progress
  const blockingStates = new Set(['todo', 'in_progress', 'triage', 'backlog']);

  for (const [parentId, directChildren] of childrenOf) {
    const parent = issueMap.get(parentId);
    if (!parent) continue;
    if (!blockingStates.has(parent.properties?.state)) continue;

    // Count transitive descendants
    const allDescendants = new Set<string>();
    const queue = [...directChildren];
    while (queue.length > 0) {
      const childId = queue.shift()!;
      if (allDescendants.has(childId)) continue;
      allDescendants.add(childId);
      const grandchildren = childrenOf.get(childId) || [];
      queue.push(...grandchildren);
    }

    if (allDescendants.size < 3) continue;

    // Compute total blocked story points
    let blockedPoints = 0;
    const blockedAssignees = new Set<string>();
    for (const descId of allDescendants) {
      const desc = issueMap.get(descId);
      if (desc?.properties?.estimate) blockedPoints += desc.properties.estimate;
      if (desc?.properties?.assignee_id) blockedAssignees.add(desc.properties.assignee_id);
    }

    const daysStale = parent.updated_at
      ? Math.floor((now.getTime() - new Date(parent.updated_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    findings.push({
      id: uuid(),
      signal_type: 'blocker_chain',
      severity: allDescendants.size >= 5 ? 'critical' : allDescendants.size >= 3 ? 'high' : 'medium',
      title: `Blocker chain: ${parent.title || 'Untitled'} blocking ${allDescendants.size} issues`,
      description: `Issue "${parent.title}" (${parent.properties?.state}) is transitively blocking ${allDescendants.size} downstream issues. ${blockedAssignees.size} engineer(s) waiting, ${blockedPoints} story points blocked.`,
      affected_entities: [
        { type: 'issue', id: parent.id, title: parent.title },
        ...[...allDescendants].slice(0, 5).map(id => {
          const desc = issueMap.get(id);
          return { type: 'issue', id, title: desc?.title };
        }),
      ],
      data: {
        root_blocker_id: parent.id,
        root_blocker_state: parent.properties?.state,
        root_blocker_assignee: parent.properties?.assignee_id || null,
        blocked_count: allDescendants.size,
        blocked_story_points: blockedPoints,
        blocked_assignee_count: blockedAssignees.size,
        days_stale: daysStale,
        chain_ids: [parent.id, ...[...allDescendants]],
      },
      confidence: 1.0,
      source: 'deterministic',
    });
  }

  return findings;
}

// ============================================================
// Utility
// ============================================================

/**
 * Subtract business days (skip weekends) from a date.
 */
export function subtractBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return result;
}

/**
 * Generate a hash for a finding to support deduplication and suppression.
 */
export function hashFinding(signalType: string, entityIds: string[]): string {
  return `${signalType}:${[...entityIds].sort().join(',')}`;
}
