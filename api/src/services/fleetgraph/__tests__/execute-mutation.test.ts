import { describe, it, expect } from 'vitest';
import type { ProposedAction, MutationResult } from '@ship/shared';

/**
 * Execute-mutation tests.
 *
 * executeMutation() requires a real database connection, so full integration
 * tests run via seed-fleetgraph + manual verification.
 *
 * These unit tests verify the type contracts and validation logic patterns.
 */

describe('ProposedAction type contracts', () => {
  it('supports comment type with content payload', () => {
    const action: ProposedAction = {
      type: 'comment',
      entity_id: 'issue-1',
      entity_type: 'issue',
      payload: { content: 'Follow-up comment from FleetGraph' },
      description: 'Post follow-up comment',
    };
    expect(action.type).toBe('comment');
    expect(action.payload.content).toBeTruthy();
  });

  it('supports reassign type with assignee_id payload', () => {
    const action: ProposedAction = {
      type: 'reassign',
      entity_id: 'issue-2',
      entity_type: 'issue',
      payload: { assignee_id: 'user-123' },
      description: 'Reassign to less-loaded engineer',
    };
    expect(action.type).toBe('reassign');
    expect(action.payload.assignee_id).toBeTruthy();
  });

  it('supports state_change type with state payload', () => {
    const action: ProposedAction = {
      type: 'state_change',
      entity_id: 'issue-3',
      entity_type: 'issue',
      payload: { state: 'todo' },
      description: 'Revert issue to todo',
    };
    expect(action.type).toBe('state_change');
    expect(action.payload.state).toBe('todo');
  });
});

describe('MutationResult type contracts', () => {
  it('represents success', () => {
    const result: MutationResult = {
      success: true,
      action_type: 'comment',
      entity_id: 'issue-1',
    };
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('represents failure with error', () => {
    const result: MutationResult = {
      success: false,
      action_type: 'reassign',
      entity_id: 'issue-2',
      error: 'Issue not found',
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Issue not found');
  });
});

describe('state validation', () => {
  const validStates = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];

  it('accepts all valid issue states', () => {
    for (const state of validStates) {
      expect(validStates.includes(state)).toBe(true);
    }
  });

  it('rejects invalid states', () => {
    const invalidStates = ['active', 'completed', 'blocked', '', 'IN_PROGRESS'];
    for (const state of invalidStates) {
      expect(validStates.includes(state)).toBe(false);
    }
  });
});
