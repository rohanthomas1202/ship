import { describe, it, expect } from 'vitest';
import { computeHealthScore } from '../health-score.js';
import type { Finding, Severity, SignalType } from '@ship/shared';

function makeFinding(overrides: {
  signal_type: SignalType;
  severity: Severity;
  projectId?: string;
  id?: string;
}): Finding {
  const projectId = overrides.projectId || 'project-1';
  return {
    id: overrides.id || `finding-${Math.random().toString(36).slice(2, 8)}`,
    signal_type: overrides.signal_type,
    severity: overrides.severity,
    title: `Test ${overrides.signal_type}`,
    description: `Test finding for ${overrides.signal_type}`,
    affected_entities: [{ type: 'project', id: projectId }],
    data: {},
    confidence: 1.0,
    source: 'deterministic',
  };
}

describe('computeHealthScore', () => {
  it('returns 100 overall when no findings exist', () => {
    const score = computeHealthScore('project-1', []);
    expect(score.overall).toBe(100);
    expect(score.sub_scores.velocity.score).toBe(100);
    expect(score.sub_scores.blockers.score).toBe(100);
    expect(score.sub_scores.workload.score).toBe(100);
    expect(score.sub_scores.issue_freshness.score).toBe(100);
    expect(score.sub_scores.approval_flow.score).toBe(100);
    expect(score.sub_scores.accountability.score).toBe(100);
    expect(score.computed_at).toBeTruthy();
  });

  it('reduces issue_freshness for ghost blocker', () => {
    const findings = [
      makeFinding({ signal_type: 'ghost_blocker', severity: 'medium' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.issue_freshness.score).toBe(85); // 100 - 15 (medium)
    expect(score.sub_scores.issue_freshness.finding_ids).toHaveLength(1);
    // Other sub-scores unaffected
    expect(score.sub_scores.blockers.score).toBe(100);
    expect(score.sub_scores.velocity.score).toBe(100);
  });

  it('reduces blockers for blocker_chain', () => {
    const findings = [
      makeFinding({ signal_type: 'blocker_chain', severity: 'high' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.blockers.score).toBe(75); // 100 - 25 (high)
  });

  it('reduces approval_flow for approval_bottleneck', () => {
    const findings = [
      makeFinding({ signal_type: 'approval_bottleneck', severity: 'medium' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.approval_flow.score).toBe(85); // 100 - 15
  });

  it('reduces velocity for sprint_collapse', () => {
    const findings = [
      makeFinding({ signal_type: 'sprint_collapse', severity: 'critical' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.velocity.score).toBe(60); // 100 - 40 (critical)
  });

  it('reduces workload for team_overload', () => {
    const findings = [
      makeFinding({ signal_type: 'team_overload', severity: 'high' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.workload.score).toBe(75); // 100 - 25
  });

  it('reduces accountability for accountability_cascade', () => {
    const findings = [
      makeFinding({ signal_type: 'accountability_cascade', severity: 'medium' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.accountability.score).toBe(85);
  });

  it('stacks multiple findings in the same category', () => {
    const findings = [
      makeFinding({ signal_type: 'ghost_blocker', severity: 'medium', id: 'f1' }),
      makeFinding({ signal_type: 'ghost_blocker', severity: 'high', id: 'f2' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.issue_freshness.score).toBe(60); // 100 - 15 - 25
    expect(score.sub_scores.issue_freshness.finding_ids).toHaveLength(2);
  });

  it('does not go below 0', () => {
    const findings = [
      makeFinding({ signal_type: 'ghost_blocker', severity: 'critical', id: 'f1' }),
      makeFinding({ signal_type: 'ghost_blocker', severity: 'critical', id: 'f2' }),
      makeFinding({ signal_type: 'ghost_blocker', severity: 'critical', id: 'f3' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.issue_freshness.score).toBe(0); // 100 - 40*3 = -20 → clamped to 0
  });

  it('computes weighted overall correctly', () => {
    // All sub-scores at 100 except blockers at 0
    // Overall = 100*0.20 + 0*0.25 + 100*0.15 + 100*0.15 + 100*0.10 + 100*0.15 = 75
    const findings = [
      makeFinding({ signal_type: 'blocker_chain', severity: 'critical', id: 'f1' }),
      makeFinding({ signal_type: 'blocker_chain', severity: 'critical', id: 'f2' }),
      makeFinding({ signal_type: 'blocker_chain', severity: 'critical', id: 'f3' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.sub_scores.blockers.score).toBe(0);
    expect(score.overall).toBe(75); // Weighted: all others at 100, blockers at 0
  });

  it('ignores findings for other projects', () => {
    const findings = [
      makeFinding({ signal_type: 'ghost_blocker', severity: 'critical', projectId: 'project-2' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(score.overall).toBe(100); // Not affected by project-2's findings
  });

  it('sets description based on score range', () => {
    // Healthy
    const healthy = computeHealthScore('p', []);
    expect(healthy.sub_scores.velocity.description).toContain('Healthy');

    // Minor concerns (70-89)
    const minor = computeHealthScore('p', [
      makeFinding({ signal_type: 'ghost_blocker', severity: 'medium', projectId: 'p' }),
    ]);
    expect(minor.sub_scores.issue_freshness.description).toContain('Minor');

    // At risk (40-69)
    const atRisk = computeHealthScore('p', [
      makeFinding({ signal_type: 'ghost_blocker', severity: 'critical', projectId: 'p' }),
    ]);
    expect(atRisk.sub_scores.issue_freshness.description).toContain('At risk');

    // Critical (<40)
    const critical = computeHealthScore('p', [
      makeFinding({ signal_type: 'ghost_blocker', severity: 'critical', projectId: 'p', id: 'a' }),
      makeFinding({ signal_type: 'ghost_blocker', severity: 'critical', projectId: 'p', id: 'b' }),
    ]);
    expect(critical.sub_scores.issue_freshness.description).toContain('Critical');
  });

  it('maps multiple signal types to velocity', () => {
    const findings = [
      makeFinding({ signal_type: 'scope_creep', severity: 'medium', id: 'f1' }),
      makeFinding({ signal_type: 'velocity_decay', severity: 'medium', id: 'f2' }),
      makeFinding({ signal_type: 'confidence_drift', severity: 'low', id: 'f3' }),
    ];
    const score = computeHealthScore('project-1', findings);
    // velocity: 100 - 15 - 15 - 5 = 65
    expect(score.sub_scores.velocity.score).toBe(65);
    expect(score.sub_scores.velocity.finding_ids).toHaveLength(3);
  });

  it('returns integer overall score', () => {
    const findings = [
      makeFinding({ signal_type: 'ghost_blocker', severity: 'low' }),
    ];
    const score = computeHealthScore('project-1', findings);
    expect(Number.isInteger(score.overall)).toBe(true);
  });
});
