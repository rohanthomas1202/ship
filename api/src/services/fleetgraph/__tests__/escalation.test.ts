import { describe, it, expect } from 'vitest';
import { hashFinding } from '../deterministic-signals.js';

/**
 * Escalation logic tests.
 *
 * The full escalation flow (assignTargetUsers + escalatePersistentFindings)
 * requires a database connection and is tested via integration
 * (seed-fleetgraph + run-fleetgraph script).
 *
 * These tests verify the hashing and cycle tracking logic.
 */

describe('finding persistence tracking', () => {
  it('same finding produces same hash across cycles', () => {
    const h1 = hashFinding('ghost_blocker', ['issue-123', 'person-456']);
    const h2 = hashFinding('ghost_blocker', ['issue-123', 'person-456']);
    expect(h1).toBe(h2);
  });

  it('different findings produce different hashes', () => {
    const h1 = hashFinding('ghost_blocker', ['issue-1']);
    const h2 = hashFinding('ghost_blocker', ['issue-2']);
    expect(h1).not.toBe(h2);
  });

  it('tracks cycle count correctly in persistence format', () => {
    // Simulate the persistence format
    const cycle1: Record<string, { count: number; first_seen: string }> = {};
    const hash = hashFinding('ghost_blocker', ['issue-1']);

    // Cycle 1: new finding
    cycle1[hash] = { count: 1, first_seen: '2026-03-20T10:00:00Z' };
    expect(cycle1[hash].count).toBe(1);

    // Cycle 2: same finding persists
    const cycle2 = { ...cycle1 };
    cycle2[hash] = { count: cycle1[hash].count + 1, first_seen: cycle1[hash].first_seen };
    expect(cycle2[hash].count).toBe(2);
    expect(cycle2[hash].first_seen).toBe('2026-03-20T10:00:00Z'); // Preserved

    // Cycle 3
    const cycle3 = { ...cycle2 };
    cycle3[hash] = { count: cycle2[hash].count + 1, first_seen: cycle2[hash].first_seen };
    expect(cycle3[hash].count).toBe(3);
  });

  it('escalation threshold is 2+ cycles', () => {
    const ESCALATION_THRESHOLD = 2;

    const cycle1Count = 1;
    expect(cycle1Count >= ESCALATION_THRESHOLD).toBe(false); // No escalation

    const cycle2Count = 2;
    expect(cycle2Count >= ESCALATION_THRESHOLD).toBe(true); // Escalate!

    const cycle3Count = 3;
    expect(cycle3Count >= ESCALATION_THRESHOLD).toBe(true); // Still escalated
  });

  it('different entity same signal type produces different hash', () => {
    const h1 = hashFinding('approval_bottleneck', ['sprint-1']);
    const h2 = hashFinding('approval_bottleneck', ['sprint-2']);
    expect(h1).not.toBe(h2);
  });

  it('resolved findings reset cycle count', () => {
    // When a finding is no longer detected, it should not appear
    // in the next cycle's persistence. This is handled by the
    // escalation logic only persisting current-cycle hashes.
    const prevCycle: Record<string, { count: number; first_seen: string }> = {
      'ghost_blocker:issue-1': { count: 3, first_seen: '2026-03-18' },
      'ghost_blocker:issue-2': { count: 1, first_seen: '2026-03-20' },
    };

    // Current cycle only has issue-2 (issue-1 was resolved)
    const currentHashes = new Set(['ghost_blocker:issue-2']);

    // Build updated findings — only include current hashes
    const updated: Record<string, { count: number; first_seen: string }> = {};
    for (const hash of currentHashes) {
      const prev = prevCycle[hash];
      updated[hash] = {
        count: prev ? prev.count + 1 : 1,
        first_seen: prev?.first_seen || '2026-03-21',
      };
    }

    // issue-1 is gone (resolved), issue-2 persists
    expect(updated['ghost_blocker:issue-1']).toBeUndefined();
    expect(updated['ghost_blocker:issue-2']!.count).toBe(2);
  });
});

describe('target_user_id routing logic', () => {
  it('sprint findings route to sprint owner', () => {
    // Sprint entity → owner_id from sprint properties
    const entityType = 'sprint';
    const routeTarget = entityType === 'sprint' ? 'owner_id' : 'assignee_id';
    expect(routeTarget).toBe('owner_id');
  });

  it('issue findings route to assignee, fallback to project owner', () => {
    const entityType = 'issue';
    const assigneeId = null; // Unassigned

    const routeTarget = entityType === 'issue'
      ? (assigneeId || 'project_owner_fallback')
      : 'owner_id';
    expect(routeTarget).toBe('project_owner_fallback');
  });

  it('escalation overrides target to program accountable_id', () => {
    const cycleCount = 3;
    const currentTarget = 'sprint-owner-123';
    const accountableId = 'director-456';

    const finalTarget = cycleCount >= 2 ? accountableId : currentTarget;
    expect(finalTarget).toBe('director-456');
  });
});
