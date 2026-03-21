import { describe, it, expect } from 'vitest';
import { buildRolePromptSuffix } from '../role-detection.js';
import type { DetectedRole } from '@ship/shared';

/**
 * Role detection tests.
 *
 * detectUserRole() requires a real database connection, so it's tested
 * via integration tests (seed-fleetgraph + manual verification).
 *
 * These unit tests cover the pure functions: buildRolePromptSuffix.
 */

describe('buildRolePromptSuffix', () => {
  it('returns director-appropriate prompt for director role', () => {
    const role: DetectedRole = {
      role: 'director',
      source: 'program_accountable',
      person_id: 'person-1',
      determining_entity_id: 'program-1',
    };
    const suffix = buildRolePromptSuffix(role);
    expect(suffix).toContain('DIRECTOR');
    expect(suffix).toContain('strategic summary');
    expect(suffix).toContain('resource allocation');
    expect(suffix).toContain('portfolio');
  });

  it('returns PM-appropriate prompt for pm role', () => {
    const role: DetectedRole = {
      role: 'pm',
      source: 'project_owner',
      person_id: 'person-2',
      determining_entity_id: 'project-1',
    };
    const suffix = buildRolePromptSuffix(role);
    expect(suffix).toContain('PM');
    expect(suffix).toContain('PROJECT OWNER');
    expect(suffix).toContain('operational');
    expect(suffix).toContain('sprint');
    expect(suffix).toContain('blocker');
  });

  it('returns engineer-appropriate prompt for engineer role', () => {
    const role: DetectedRole = {
      role: 'engineer',
      source: 'issue_assignee',
      person_id: 'person-3',
      determining_entity_id: 'issue-1',
    };
    const suffix = buildRolePromptSuffix(role);
    expect(suffix).toContain('ENGINEER');
    expect(suffix).toContain('personal scope');
    expect(suffix).toContain('assignments');
    expect(suffix).toContain('dependencies');
  });

  it('returns pm prompt for workspace admin fallback', () => {
    const role: DetectedRole = {
      role: 'pm',
      source: 'workspace_admin',
      person_id: 'person-4',
    };
    const suffix = buildRolePromptSuffix(role);
    expect(suffix).toContain('PM');
  });

  it('returns engineer prompt for workspace member fallback', () => {
    const role: DetectedRole = {
      role: 'engineer',
      source: 'workspace_member',
      person_id: 'person-5',
    };
    const suffix = buildRolePromptSuffix(role);
    expect(suffix).toContain('ENGINEER');
  });
});

describe('DetectedRole type structure', () => {
  it('supports all role sources', () => {
    const sources: DetectedRole['source'][] = [
      'program_accountable',
      'project_owner',
      'issue_assignee',
      'workspace_admin',
      'workspace_member',
    ];
    for (const source of sources) {
      const role: DetectedRole = { role: 'engineer', source };
      expect(role.source).toBe(source);
    }
  });

  it('supports optional fields', () => {
    const minimal: DetectedRole = { role: 'engineer', source: 'workspace_member' };
    expect(minimal.person_id).toBeUndefined();
    expect(minimal.determining_entity_id).toBeUndefined();

    const full: DetectedRole = {
      role: 'director',
      source: 'program_accountable',
      person_id: 'p1',
      determining_entity_id: 'prog1',
    };
    expect(full.person_id).toBe('p1');
    expect(full.determining_entity_id).toBe('prog1');
  });
});
