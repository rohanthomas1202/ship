import { describe, it, expect } from 'vitest';
import {
  detectGhostBlockers,
  detectApprovalBottlenecks,
  detectBlockerChains,
  detectSprintCollapse,
  getSprintDates,
  subtractBusinessDays,
  hashFinding,
} from '../deterministic-signals.js';

// ============================================================
// subtractBusinessDays
// ============================================================

describe('subtractBusinessDays', () => {
  it('subtracts business days skipping weekends', () => {
    // Friday March 20, 2026 - subtract 3 business days = Tuesday March 17
    const friday = new Date('2026-03-20T12:00:00Z');
    const result = subtractBusinessDays(friday, 3);
    expect(result.getDay()).toBe(2); // Tuesday
    expect(result.getDate()).toBe(17);
  });

  it('handles subtracting across a weekend', () => {
    // Monday March 23, 2026 - subtract 1 business day = Friday March 20
    const monday = new Date('2026-03-23T12:00:00Z');
    const result = subtractBusinessDays(monday, 1);
    expect(result.getDay()).toBe(5); // Friday
    expect(result.getDate()).toBe(20);
  });

  it('handles subtracting 5 business days (full work week)', () => {
    // Friday March 20, 2026 - subtract 5 = Friday March 13
    const friday = new Date('2026-03-20T12:00:00Z');
    const result = subtractBusinessDays(friday, 5);
    expect(result.getDay()).toBe(5); // Friday
    expect(result.getDate()).toBe(13);
  });
});

// ============================================================
// detectGhostBlockers
// ============================================================

describe('detectGhostBlockers', () => {
  const now = new Date('2026-03-20T12:00:00Z'); // Friday

  it('detects issue in_progress > 3 business days with no history', () => {
    const issues = [{
      id: 'issue-1',
      title: 'Implement auth',
      properties: { state: 'in_progress', assignee_id: 'person-1', estimate: 5 },
      updated_at: '2026-03-12T10:00:00Z', // Thursday March 12 — 6 biz days ago
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].signal_type).toBe('ghost_blocker');
    expect(result[0].severity).toBe('high'); // 8 calendar days
    expect(result[0].confidence).toBe(1.0);
    expect(result[0].source).toBe('deterministic');
    expect(result[0].affected_entities).toHaveLength(2); // issue + person
    expect(result[0].data.assignee_id).toBe('person-1');
  });

  it('does NOT flag issue updated within 3 business days', () => {
    const issues = [{
      id: 'issue-2',
      title: 'Recent issue',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-18T10:00:00Z', // Wednesday — 2 biz days ago
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(0);
  });

  it('does NOT flag issues in done state', () => {
    const issues = [{
      id: 'issue-3',
      title: 'Done issue',
      properties: { state: 'done' },
      updated_at: '2026-03-01T10:00:00Z', // Very old
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(0);
  });

  it('does NOT flag issues in cancelled state', () => {
    const issues = [{
      id: 'issue-4',
      title: 'Cancelled issue',
      properties: { state: 'cancelled' },
      updated_at: '2026-03-01T10:00:00Z',
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(0);
  });

  it('does NOT flag issues in todo state', () => {
    const issues = [{
      id: 'issue-5',
      title: 'Todo issue',
      properties: { state: 'todo' },
      updated_at: '2026-03-01T10:00:00Z',
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(0);
  });

  it('uses document_history for more accurate last activity', () => {
    const issues = [{
      id: 'issue-6',
      title: 'Active via history',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-05T10:00:00Z', // Very old updated_at
    }];
    const history = [{
      document_id: 'issue-6',
      field: 'properties.priority',
      created_at: '2026-03-19T10:00:00Z', // Yesterday — recent activity!
    }];
    const result = detectGhostBlockers(issues, history, now);
    expect(result).toHaveLength(0); // History shows recent activity
  });

  it('uses most recent history entry when multiple exist', () => {
    const issues = [{
      id: 'issue-7',
      title: 'Multiple history',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-01T10:00:00Z',
    }];
    const history = [
      { document_id: 'issue-7', field: 'title', created_at: '2026-03-05T10:00:00Z' },
      { document_id: 'issue-7', field: 'state', created_at: '2026-03-19T10:00:00Z' }, // Most recent
      { document_id: 'issue-7', field: 'priority', created_at: '2026-03-10T10:00:00Z' },
    ];
    const result = detectGhostBlockers(issues, history, now);
    expect(result).toHaveLength(0); // Most recent history is yesterday
  });

  it('assigns high severity for 7+ calendar days stale', () => {
    const issues = [{
      id: 'issue-8',
      title: 'Very stale',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-05T10:00:00Z', // 15 calendar days ago
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('high');
  });

  it('assigns medium severity for 5-6 calendar days stale', () => {
    const issues = [{
      id: 'issue-9',
      title: 'Moderately stale',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-15T10:00:00Z', // 5 calendar days ago (Sunday)
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('medium');
  });

  it('assigns low severity for 3-4 calendar days stale', () => {
    // Need an issue that's > 3 biz days ago but only 3-4 calendar days
    // Wednesday March 18 minus 3 biz days = Friday March 13 (5 biz days if from Friday)
    // Actually, from Friday March 20, 3 biz days ago = Tuesday March 17
    // So updated on March 16 (Monday) = 4 calendar days, should be low
    const issues = [{
      id: 'issue-10',
      title: 'Slightly stale',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-16T10:00:00Z', // Monday — 4 calendar days ago, but only ~3 biz days
    }];
    const result = detectGhostBlockers(issues, [], now);
    // 3 biz days ago from Friday = Tuesday March 17
    // March 16 (Monday) < March 17 (Tuesday), so it IS stale
    // 4 calendar days = low severity
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('low');
  });

  it('handles issue with no assignee_id', () => {
    const issues = [{
      id: 'issue-11',
      title: 'Unassigned stale',
      properties: { state: 'in_progress' }, // No assignee
      updated_at: '2026-03-05T10:00:00Z',
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].affected_entities).toHaveLength(1); // Only issue, no person
  });

  it('handles multiple stale issues', () => {
    const issues = [
      { id: 'a', title: 'A', properties: { state: 'in_progress' }, updated_at: '2026-03-05T10:00:00Z' },
      { id: 'b', title: 'B', properties: { state: 'in_progress' }, updated_at: '2026-03-06T10:00:00Z' },
      { id: 'c', title: 'C', properties: { state: 'done' }, updated_at: '2026-03-01T10:00:00Z' },
    ];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(2); // Only in_progress ones
  });
});

// ============================================================
// detectApprovalBottlenecks
// ============================================================

describe('detectApprovalBottlenecks', () => {
  const now = new Date('2026-03-20T12:00:00Z'); // Friday

  it('detects plan approval changes_requested > 2 business days', () => {
    const sprints = [{
      id: 'sprint-1',
      title: 'Sprint 32',
      properties: {
        status: 'active',
        plan_approval: {
          state: 'changes_requested',
          approved_at: '2026-03-16T10:00:00Z', // Monday — 4 biz days ago
        },
        owner_id: 'person-1',
      },
      started_at: '2026-03-16T00:00:00Z',
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].signal_type).toBe('approval_bottleneck');
    expect(result[0].data.approval_type).toBe('plan');
    expect(result[0].data.approval_state).toBe('changes_requested');
    expect(result[0].confidence).toBe(1.0);
  });

  it('detects active sprint with null plan_approval > 2 business days', () => {
    const sprints = [{
      id: 'sprint-2',
      title: 'Sprint 33',
      properties: {
        status: 'active',
        owner_id: 'person-1',
        // plan_approval intentionally absent
      },
      started_at: '2026-03-12T00:00:00Z', // 8 days ago
      created_at: '2026-03-12T00:00:00Z',
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].data.approval_type).toBe('plan');
    expect(result[0].data.approval_state).toBeNull();
  });

  it('does NOT flag completed sprints', () => {
    const sprints = [{
      id: 'sprint-3',
      title: 'Sprint 31',
      properties: {
        status: 'completed',
        plan_approval: {
          state: 'changes_requested',
          approved_at: '2026-03-01T10:00:00Z',
        },
      },
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(0);
  });

  it('does NOT flag sprint with approved plan', () => {
    const sprints = [{
      id: 'sprint-4',
      title: 'Sprint 34',
      properties: {
        status: 'active',
        plan_approval: {
          state: 'approved',
          approved_at: '2026-03-15T10:00:00Z',
        },
      },
      started_at: '2026-03-15T00:00:00Z',
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(0);
  });

  it('detects review approval changes_requested > 2 business days', () => {
    const sprints = [{
      id: 'sprint-5',
      title: 'Sprint 35',
      properties: {
        status: 'active',
        plan_approval: { state: 'approved' },
        review_approval: {
          state: 'changes_requested',
          approved_at: '2026-03-12T10:00:00Z', // 8 days ago
        },
        owner_id: 'person-1',
      },
      updated_at: '2026-03-12T10:00:00Z',
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].data.approval_type).toBe('review');
  });

  it('assigns high severity for 5+ day bottleneck', () => {
    const sprints = [{
      id: 'sprint-6',
      title: 'Sprint 36',
      properties: {
        status: 'active',
        plan_approval: {
          state: 'changes_requested',
          approved_at: '2026-03-10T10:00:00Z', // 10 days ago
        },
      },
      started_at: '2026-03-10T00:00:00Z',
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('high');
  });

  it('assigns medium severity for 2-4 day bottleneck', () => {
    const sprints = [{
      id: 'sprint-7',
      title: 'Sprint 37',
      properties: {
        status: 'active',
        plan_approval: {
          state: 'changes_requested',
          approved_at: '2026-03-17T10:00:00Z', // 3 days ago (Tuesday)
        },
      },
      started_at: '2026-03-17T00:00:00Z',
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('medium');
  });

  it('does NOT flag planning sprint with no plan_approval', () => {
    const sprints = [{
      id: 'sprint-8',
      title: 'Sprint 38',
      properties: {
        status: 'planning',
        // No plan_approval — sprint not active yet
      },
      started_at: null,
      created_at: '2026-03-01T00:00:00Z',
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(0); // Only flags 'active' sprints
  });
});

// ============================================================
// detectBlockerChains
// ============================================================

describe('detectBlockerChains', () => {
  const now = new Date('2026-03-20T12:00:00Z');

  it('detects parent blocking 3+ children', () => {
    const issues = [
      {
        id: 'parent-1',
        title: 'Root blocker',
        properties: { state: 'in_progress', assignee_id: 'p1', estimate: 8 },
        updated_at: '2026-03-15T10:00:00Z',
        associations: [],
      },
      {
        id: 'child-1',
        title: 'Child 1',
        properties: { state: 'todo', assignee_id: 'p2', estimate: 3 },
        associations: [{ type: 'parent', id: 'parent-1' }],
      },
      {
        id: 'child-2',
        title: 'Child 2',
        properties: { state: 'todo', assignee_id: 'p3', estimate: 2 },
        associations: [{ type: 'parent', id: 'parent-1' }],
      },
      {
        id: 'child-3',
        title: 'Child 3',
        properties: { state: 'todo', assignee_id: 'p4', estimate: 5 },
        associations: [{ type: 'parent', id: 'parent-1' }],
      },
    ];
    const result = detectBlockerChains(issues, now);
    expect(result).toHaveLength(1);
    expect(result[0].signal_type).toBe('blocker_chain');
    expect(result[0].severity).toBe('high'); // 3 blocked
    expect(result[0].data.blocked_count).toBe(3);
    expect(result[0].data.blocked_story_points).toBe(10); // 3+2+5
    expect(result[0].data.blocked_assignee_count).toBe(3);
    expect(result[0].confidence).toBe(1.0);
  });

  it('detects transitive blocking (grandchildren)', () => {
    const issues = [
      {
        id: 'root',
        title: 'Root',
        properties: { state: 'todo', estimate: 5 },
        associations: [],
      },
      {
        id: 'mid-1',
        title: 'Mid 1',
        properties: { state: 'todo', estimate: 3 },
        associations: [{ type: 'parent', id: 'root' }],
      },
      {
        id: 'leaf-1',
        title: 'Leaf 1',
        properties: { state: 'todo', estimate: 2 },
        associations: [{ type: 'parent', id: 'mid-1' }],
      },
      {
        id: 'leaf-2',
        title: 'Leaf 2',
        properties: { state: 'todo', estimate: 2 },
        associations: [{ type: 'parent', id: 'mid-1' }],
      },
      {
        id: 'leaf-3',
        title: 'Leaf 3',
        properties: { state: 'todo', estimate: 1 },
        associations: [{ type: 'parent', id: 'root' }],
      },
    ];
    const result = detectBlockerChains(issues, now);
    expect(result).toHaveLength(1);
    // root blocks: mid-1, leaf-1, leaf-2, leaf-3 = 4 transitive descendants
    expect(result[0].data.blocked_count).toBe(4);
  });

  it('does NOT flag parent in done state', () => {
    const issues = [
      {
        id: 'done-parent',
        title: 'Done parent',
        properties: { state: 'done' },
        associations: [],
      },
      {
        id: 'c1',
        title: 'C1',
        properties: { state: 'todo' },
        associations: [{ type: 'parent', id: 'done-parent' }],
      },
      {
        id: 'c2',
        title: 'C2',
        properties: { state: 'todo' },
        associations: [{ type: 'parent', id: 'done-parent' }],
      },
      {
        id: 'c3',
        title: 'C3',
        properties: { state: 'todo' },
        associations: [{ type: 'parent', id: 'done-parent' }],
      },
    ];
    const result = detectBlockerChains(issues, now);
    expect(result).toHaveLength(0);
  });

  it('does NOT flag parent with fewer than 3 descendants', () => {
    const issues = [
      {
        id: 'small-parent',
        title: 'Small parent',
        properties: { state: 'in_progress' },
        associations: [],
      },
      {
        id: 'sc1',
        title: 'SC1',
        properties: { state: 'todo' },
        associations: [{ type: 'parent', id: 'small-parent' }],
      },
      {
        id: 'sc2',
        title: 'SC2',
        properties: { state: 'todo' },
        associations: [{ type: 'parent', id: 'small-parent' }],
      },
    ];
    const result = detectBlockerChains(issues, now);
    expect(result).toHaveLength(0);
  });

  it('assigns critical severity for 5+ blocked issues', () => {
    const children = Array.from({ length: 5 }, (_, i) => ({
      id: `big-child-${i}`,
      title: `Big Child ${i}`,
      properties: { state: 'todo', estimate: 2 },
      associations: [{ type: 'parent', id: 'big-parent' }],
    }));
    const issues = [
      {
        id: 'big-parent',
        title: 'Big parent',
        properties: { state: 'in_progress' },
        associations: [],
      },
      ...children,
    ];
    const result = detectBlockerChains(issues, now);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });
});

// ============================================================
// hashFinding
// ============================================================

describe('hashFinding', () => {
  it('produces consistent hash for same inputs', () => {
    const h1 = hashFinding('ghost_blocker', ['issue-1', 'person-1']);
    const h2 = hashFinding('ghost_blocker', ['issue-1', 'person-1']);
    expect(h1).toBe(h2);
  });

  it('produces same hash regardless of entity order', () => {
    const h1 = hashFinding('ghost_blocker', ['person-1', 'issue-1']);
    const h2 = hashFinding('ghost_blocker', ['issue-1', 'person-1']);
    expect(h1).toBe(h2); // Sorted internally
  });

  it('produces different hash for different signal types', () => {
    const h1 = hashFinding('ghost_blocker', ['issue-1']);
    const h2 = hashFinding('approval_bottleneck', ['issue-1']);
    expect(h1).not.toBe(h2);
  });
});

// ============================================================
// getSprintDates
// ============================================================

describe('getSprintDates', () => {
  const wsStart = new Date('2026-01-05T00:00:00Z'); // Monday

  it('computes Sprint 1 dates correctly', () => {
    const { start, end } = getSprintDates(wsStart, 1);
    expect(start.toISOString().slice(0, 10)).toBe('2026-01-05');
    expect(end.toISOString().slice(0, 10)).toBe('2026-01-11');
  });

  it('computes Sprint 2 dates correctly', () => {
    const { start, end } = getSprintDates(wsStart, 2);
    expect(start.toISOString().slice(0, 10)).toBe('2026-01-12');
    expect(end.toISOString().slice(0, 10)).toBe('2026-01-18');
  });

  it('computes Sprint 10 dates correctly', () => {
    const { start, end } = getSprintDates(wsStart, 10);
    expect(start.toISOString().slice(0, 10)).toBe('2026-03-09');
    expect(end.toISOString().slice(0, 10)).toBe('2026-03-15');
  });
});

// ============================================================
// detectSprintCollapse
// ============================================================

describe('detectSprintCollapse', () => {
  // Workspace started 2026-01-05 (Monday). Sprint 11 = Mar 16–22.
  const wsStart = new Date('2026-01-05T00:00:00Z');

  function makeSprintIssues(sprintId: string, states: Array<{ state: string; estimate?: number }>) {
    return states.map((s, i) => ({
      id: `issue-${sprintId}-${i}`,
      title: `Issue ${i}`,
      properties: { state: s.state, estimate: s.estimate || 3 },
      associations: [{ type: 'sprint', id: sprintId }],
    }));
  }

  it('detects sprint at risk — low completion with few days remaining', () => {
    // Sprint 11: Mar 16–22. Now = Mar 20 (day 5/7, past 40%)
    const now = new Date('2026-03-20T12:00:00Z');
    const sprints = [{
      id: 'sprint-collapse-1',
      title: 'Sprint 11',
      properties: { sprint_number: 11, status: 'active' },
    }];
    // 8 issues, only 2 done = 25% completion with 2 days left
    const issues = makeSprintIssues('sprint-collapse-1', [
      { state: 'done' }, { state: 'done' },
      { state: 'in_progress' }, { state: 'in_progress' },
      { state: 'todo' }, { state: 'todo' },
      { state: 'todo' }, { state: 'todo' },
    ]);

    const result = detectSprintCollapse(sprints, issues, wsStart, now);
    expect(result).toHaveLength(1);
    expect(result[0].signal_type).toBe('sprint_collapse');
    expect(result[0].data.done_issues).toBe(2);
    expect(result[0].data.total_issues).toBe(8);
    expect(result[0].data.remaining_issues).toBe(6);
    expect(result[0].data.projected_overrun_days).toBeGreaterThan(0);
    expect(result[0].confidence).toBe(1.0);
  });

  it('does NOT flag sprint with good completion rate', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const sprints = [{
      id: 'sprint-ok',
      title: 'Sprint 11',
      properties: { sprint_number: 11, status: 'active' },
    }];
    // 8 issues, 6 done = 75% — on track
    const issues = makeSprintIssues('sprint-ok', [
      { state: 'done' }, { state: 'done' }, { state: 'done' },
      { state: 'done' }, { state: 'done' }, { state: 'done' },
      { state: 'in_progress' }, { state: 'todo' },
    ]);

    const result = detectSprintCollapse(sprints, issues, wsStart, now);
    expect(result).toHaveLength(0);
  });

  it('does NOT flag completed sprints', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const sprints = [{
      id: 'sprint-done',
      title: 'Sprint 10',
      properties: { sprint_number: 10, status: 'completed' },
    }];
    const issues = makeSprintIssues('sprint-done', [
      { state: 'todo' }, { state: 'todo' }, { state: 'todo' },
    ]);

    const result = detectSprintCollapse(sprints, issues, wsStart, now);
    expect(result).toHaveLength(0);
  });

  it('does NOT flag sprints too early (< 40% elapsed)', () => {
    // Sprint 11: Mar 16–22. Now = Mar 17 (day 2/7 = 28% — too early)
    const now = new Date('2026-03-17T12:00:00Z');
    const sprints = [{
      id: 'sprint-early',
      title: 'Sprint 11',
      properties: { sprint_number: 11, status: 'active' },
    }];
    const issues = makeSprintIssues('sprint-early', [
      { state: 'todo' }, { state: 'todo' }, { state: 'todo' },
      { state: 'todo' }, { state: 'todo' },
    ]);

    const result = detectSprintCollapse(sprints, issues, wsStart, now);
    expect(result).toHaveLength(0);
  });

  it('excludes cancelled issues from total', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const sprints = [{
      id: 'sprint-cancelled',
      title: 'Sprint 11',
      properties: { sprint_number: 11, status: 'active' },
    }];
    // 5 issues: 3 done, 2 cancelled. Effective: 3/3 = 100%
    const issues = makeSprintIssues('sprint-cancelled', [
      { state: 'done' }, { state: 'done' }, { state: 'done' },
      { state: 'cancelled' }, { state: 'cancelled' },
    ]);

    const result = detectSprintCollapse(sprints, issues, wsStart, now);
    expect(result).toHaveLength(0); // All non-cancelled are done
  });

  it('assigns critical severity when 1 day left and < 60% complete', () => {
    // Sprint 11: Mar 16–22. Now = Mar 21 (day 6/7 = 1 day left)
    const now = new Date('2026-03-21T12:00:00Z');
    const sprints = [{
      id: 'sprint-critical',
      title: 'Sprint 11',
      properties: { sprint_number: 11, status: 'active' },
    }];
    const issues = makeSprintIssues('sprint-critical', [
      { state: 'done' }, { state: 'done' },
      { state: 'todo' }, { state: 'todo' },
      { state: 'todo' }, { state: 'todo' },
    ]);

    const result = detectSprintCollapse(sprints, issues, wsStart, now);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('includes story point data', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const sprints = [{
      id: 'sprint-pts',
      title: 'Sprint 11',
      properties: { sprint_number: 11, status: 'active' },
    }];
    const issues = makeSprintIssues('sprint-pts', [
      { state: 'done', estimate: 5 },
      { state: 'todo', estimate: 8 },
      { state: 'todo', estimate: 3 },
      { state: 'todo', estimate: 5 },
    ]);

    const result = detectSprintCollapse(sprints, issues, wsStart, now);
    expect(result).toHaveLength(1);
    expect(result[0].data.total_story_points).toBe(21);
    expect(result[0].data.done_story_points).toBe(5);
    expect(result[0].data.remaining_story_points).toBe(16);
  });

  it('counts blockers in sprint', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const sprints = [{
      id: 'sprint-block',
      title: 'Sprint 11',
      properties: { sprint_number: 11, status: 'active' },
    }];
    // Issue with parent in todo = blocked
    const issues = [
      {
        id: 'parent-block',
        title: 'Parent',
        properties: { state: 'todo', estimate: 5 },
        associations: [{ type: 'sprint', id: 'sprint-block' }],
      },
      {
        id: 'child-blocked',
        title: 'Blocked child',
        properties: { state: 'todo', estimate: 3 },
        associations: [
          { type: 'sprint', id: 'sprint-block' },
          { type: 'parent', id: 'parent-block' },
        ],
      },
      {
        id: 'other-todo',
        title: 'Other',
        properties: { state: 'todo', estimate: 2 },
        associations: [{ type: 'sprint', id: 'sprint-block' }],
      },
    ];

    const result = detectSprintCollapse(sprints, issues, wsStart, now);
    expect(result).toHaveLength(1);
    expect(result[0].data.blocker_count).toBe(1); // child-blocked has non-done parent
  });
});
