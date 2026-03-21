import { describe, it, expect } from 'vitest';
import { generateStandupDraft } from '../nodes-reasoning.js';
import { createInitialState } from '../graph-state.js';
import type { FleetGraphState, FleetGraphTrigger } from '@ship/shared';

function makeState(overrides: {
  issues?: any[];
  history?: any[];
  findings?: any[];
  userId?: string;
}): FleetGraphState {
  const trigger: FleetGraphTrigger = {
    type: 'user_chat',
    workspace_id: 'ws-1',
    user_id: overrides.userId || 'user-1',
    chat_message: 'Draft my standup',
  };
  const state = createInitialState('on_demand', trigger);
  state.data.issues = overrides.issues || [];
  state.data.document_history = overrides.history || [];
  if (overrides.findings) {
    state.findings = overrides.findings;
  }
  return state;
}

describe('generateStandupDraft', () => {
  it('shows completed issues from last 24h', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    const state = makeState({
      issues: [
        { id: 'i1', title: 'Fix auth bug', ticket_number: 42, properties: { state: 'done', assignee_id: 'user-1' }, associations: [] },
      ],
      history: [
        { document_id: 'i1', field: 'state', old_value: 'in_progress', new_value: 'done', created_at: yesterday.toISOString() },
      ],
    });

    const draft = generateStandupDraft(state);
    expect(draft).toContain('**Yesterday:**');
    expect(draft).toContain('Completed Fix auth bug (#42)');
  });

  it('shows issues moved to in_review', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    const state = makeState({
      issues: [
        { id: 'i2', title: 'API refactor', properties: { state: 'in_review', assignee_id: 'user-1' }, associations: [] },
      ],
      history: [
        { document_id: 'i2', field: 'state', old_value: 'in_progress', new_value: 'in_review', created_at: yesterday.toISOString() },
      ],
    });

    const draft = generateStandupDraft(state);
    expect(draft).toContain('Moved API refactor to in_review');
  });

  it('shows today focus — highest priority issues', () => {
    const state = makeState({
      issues: [
        { id: 'i3', title: 'Low priority', properties: { state: 'todo', priority: 'low', assignee_id: 'user-1' }, associations: [] },
        { id: 'i4', title: 'Urgent fix', properties: { state: 'in_progress', priority: 'urgent', assignee_id: 'user-1' }, associations: [] },
        { id: 'i5', title: 'High task', properties: { state: 'todo', priority: 'high', assignee_id: 'user-1' }, associations: [] },
      ],
    });

    const draft = generateStandupDraft(state);
    expect(draft).toContain('**Today:**');
    // Urgent should come first
    const urgentIdx = draft.indexOf('Urgent fix');
    const highIdx = draft.indexOf('High task');
    const lowIdx = draft.indexOf('Low priority');
    expect(urgentIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('shows blockers when issue has non-done parent', () => {
    const state = makeState({
      issues: [
        { id: 'parent', title: 'Parent task', properties: { state: 'todo' }, associations: [] },
        {
          id: 'child',
          title: 'Blocked task',
          properties: { state: 'in_progress', assignee_id: 'user-1' },
          associations: [{ type: 'parent', id: 'parent' }],
        },
      ],
    });

    const draft = generateStandupDraft(state);
    expect(draft).toContain('**Risks/Blockers:**');
    expect(draft).toContain('Blocked task (blocked by Parent task)');
  });

  it('shows sprint findings as risks', () => {
    const state = makeState({
      findings: [
        {
          id: 'f1',
          signal_type: 'sprint_collapse',
          severity: 'high',
          title: 'Sprint at risk: Sprint 11',
          description: '',
          affected_entities: [],
          data: {},
          confidence: 1.0,
          source: 'deterministic' as const,
        },
      ],
    });

    const draft = generateStandupDraft(state);
    expect(draft).toContain('Sprint at risk');
  });

  it('shows fallback when no activity in last 24h', () => {
    const state = makeState({
      issues: [
        { id: 'i6', title: 'Some task', properties: { state: 'todo', assignee_id: 'user-1' }, associations: [] },
      ],
      history: [], // No history
    });

    const draft = generateStandupDraft(state);
    expect(draft).toContain('No state transitions recorded');
    expect(draft).toContain('**Today:**');
  });

  it('filters to current user issues only', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    const state = makeState({
      userId: 'user-1',
      issues: [
        { id: 'mine', title: 'My task', properties: { state: 'done', assignee_id: 'user-1' }, associations: [] },
        { id: 'theirs', title: 'Their task', properties: { state: 'done', assignee_id: 'user-2' }, associations: [] },
      ],
      history: [
        { document_id: 'mine', field: 'state', old_value: 'in_progress', new_value: 'done', created_at: yesterday.toISOString() },
        { document_id: 'theirs', field: 'state', old_value: 'in_progress', new_value: 'done', created_at: yesterday.toISOString() },
      ],
    });

    const draft = generateStandupDraft(state);
    expect(draft).toContain('My task');
    expect(draft).not.toContain('Their task');
  });

  it('limits today focus to 3 items', () => {
    const issues = Array.from({ length: 6 }, (_, i) => ({
      id: `i${i}`,
      title: `Task ${i}`,
      properties: { state: 'todo', priority: 'medium', assignee_id: 'user-1' },
      associations: [],
    }));

    const state = makeState({ issues });
    const draft = generateStandupDraft(state);

    // Count "Focus on" lines
    const focusLines = draft.split('\n').filter(l => l.includes('Focus on'));
    expect(focusLines).toHaveLength(3);
  });
});
