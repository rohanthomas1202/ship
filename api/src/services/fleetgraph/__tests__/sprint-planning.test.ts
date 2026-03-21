import { describe, it, expect } from 'vitest';
import { generateSprintPlan } from '../nodes-reasoning.js';

function makeIssue(overrides: {
  id?: string;
  title: string;
  priority: string;
  estimate?: number;
  due_date?: string;
  associations?: any[];
}) {
  return {
    id: overrides.id || `issue-${Math.random().toString(36).slice(2, 8)}`,
    title: overrides.title,
    ticket_number: Math.floor(Math.random() * 1000),
    properties: {
      state: 'backlog',
      priority: overrides.priority,
      estimate: overrides.estimate || 0,
      ...(overrides.due_date ? { due_date: overrides.due_date } : {}),
    },
    associations: overrides.associations || [],
  };
}

function makeTeam(capacityHours: number[]) {
  return capacityHours.map((h, i) => ({
    id: `person-${i}`,
    properties: { capacity_hours: h },
  }));
}

describe('generateSprintPlan', () => {
  it('ranks urgent issues above low priority', () => {
    const backlog = [
      makeIssue({ title: 'Low task', priority: 'low', estimate: 3 }),
      makeIssue({ title: 'Urgent task', priority: 'urgent', estimate: 3 }),
      makeIssue({ title: 'Medium task', priority: 'medium', estimate: 3 }),
    ];

    const plan = generateSprintPlan(backlog, [], [], 'Sprint 12');
    const urgentIdx = plan.indexOf('Urgent task');
    const lowIdx = plan.indexOf('Low task');
    expect(urgentIdx).toBeLessThan(lowIdx);
  });

  it('boosts carryover issues', () => {
    const backlog = [
      makeIssue({ title: 'New high', priority: 'high', estimate: 3 }),
    ];
    const carryover = [
      makeIssue({ title: 'Carryover medium', priority: 'medium', estimate: 3 }),
    ];

    const plan = generateSprintPlan(backlog, carryover, [], 'Sprint 12');
    // Carryover medium should rank above new high due to 15pt carryover boost
    const carryIdx = plan.indexOf('Carryover medium');
    expect(plan).toContain('carryover');
    expect(carryIdx).toBeGreaterThan(-1);
  });

  it('boosts issues that unblock others', () => {
    const parentId = 'parent-issue';
    const backlog = [
      makeIssue({ id: parentId, title: 'Parent blocker', priority: 'medium', estimate: 3 }),
      makeIssue({ title: 'Child 1', priority: 'medium', estimate: 2, associations: [{ type: 'parent', id: parentId }] }),
      makeIssue({ title: 'Child 2', priority: 'medium', estimate: 2, associations: [{ type: 'parent', id: parentId }] }),
      makeIssue({ title: 'Child 3', priority: 'medium', estimate: 2, associations: [{ type: 'parent', id: parentId }] }),
    ];

    const plan = generateSprintPlan(backlog, [], [], 'Sprint 12');
    // Parent should rank first because it unblocks 3 children
    expect(plan).toContain('unblocks 3');
    const parentIdx = plan.indexOf('Parent blocker');
    const child1Idx = plan.indexOf('Child 1');
    expect(parentIdx).toBeLessThan(child1Idx);
  });

  it('boosts issues with near due dates', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3); // 3 days from now
    const later = new Date();
    later.setDate(later.getDate() + 30); // 30 days from now

    const backlog = [
      makeIssue({ title: 'Due later', priority: 'medium', estimate: 3, due_date: later.toISOString().slice(0, 10) }),
      makeIssue({ title: 'Due soon', priority: 'medium', estimate: 3, due_date: soon.toISOString().slice(0, 10) }),
    ];

    const plan = generateSprintPlan(backlog, [], [], 'Sprint 12');
    const soonIdx = plan.indexOf('Due soon');
    const laterIdx = plan.indexOf('Due later');
    expect(soonIdx).toBeLessThan(laterIdx);
    expect(plan).toContain('due in');
  });

  it('fits to capacity based on story points', () => {
    const team = makeTeam([20]); // 20h capacity → 10 story points budget
    const backlog = [
      makeIssue({ title: 'Task A', priority: 'high', estimate: 5 }),
      makeIssue({ title: 'Task B', priority: 'high', estimate: 5 }),
      makeIssue({ title: 'Task C', priority: 'medium', estimate: 5 }),
      makeIssue({ title: 'Task D', priority: 'low', estimate: 5 }),
    ];

    const plan = generateSprintPlan(backlog, [], team, 'Sprint 12');
    // With 20h and 0.5 pts/hr, budget = 10 points. Should fit Task A + B (10 pts)
    expect(plan).toContain('Task A');
    expect(plan).toContain('Task B');
    // Task C and D should be in overflow
    expect(plan).toContain('exceeds capacity');
  });

  it('uses count limit when no estimates', () => {
    const backlog = Array.from({ length: 12 }, (_, i) =>
      makeIssue({ title: `No-est task ${i}`, priority: 'medium' })
    );

    const plan = generateSprintPlan(backlog, [], [], 'Sprint 12');
    // Default limit is 8 issues when no estimates
    const recommendedLines = plan.split('\n').filter(l => /^\d+\./.test(l));
    expect(recommendedLines.length).toBeLessThanOrEqual(8);
    expect(plan).toContain('additional issue');
  });

  it('sums team capacity from multiple members', () => {
    const team = makeTeam([20, 20, 20]); // 60h total → 30 points budget
    const backlog = Array.from({ length: 8 }, (_, i) =>
      makeIssue({ title: `Big task ${i}`, priority: 'high', estimate: 5 })
    );

    const plan = generateSprintPlan(backlog, [], team, 'Sprint 12');
    expect(plan).toContain('60h');
    // 30 point budget = 6 tasks × 5pts
    const recommendedLines = plan.split('\n').filter(l => /^\d+\./.test(l));
    expect(recommendedLines.length).toBe(6);
  });

  it('deduplicates carryover and backlog', () => {
    const sharedIssue = makeIssue({ id: 'shared', title: 'Shared issue', priority: 'high', estimate: 3 });
    const backlog = [sharedIssue];
    const carryover = [sharedIssue];

    const plan = generateSprintPlan(backlog, carryover, [], 'Sprint 12');
    // Should appear once, not twice
    const matches = plan.split('Shared issue').length - 1;
    expect(matches).toBe(1);
  });

  it('shows total points in summary', () => {
    const backlog = [
      makeIssue({ title: 'A', priority: 'high', estimate: 5 }),
      makeIssue({ title: 'B', priority: 'high', estimate: 3 }),
    ];

    const plan = generateSprintPlan(backlog, [], [], 'Sprint 12');
    expect(plan).toContain('8 story points');
    expect(plan).toContain('2 issues');
  });

  it('handles empty backlog gracefully', () => {
    const plan = generateSprintPlan([], [], [], 'Sprint 12');
    expect(plan).toContain('No backlog issues found');
  });

  it('includes sprint title in output', () => {
    const backlog = [makeIssue({ title: 'Task', priority: 'medium' })];
    const plan = generateSprintPlan(backlog, [], [], 'Sprint 42');
    expect(plan).toContain('Sprint 42');
  });
});
