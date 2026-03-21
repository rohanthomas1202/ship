/**
 * FleetGraph test data seeder.
 *
 * Creates specific scenarios for testing FleetGraph signal detection:
 * - Ghost blockers (stale in_progress issues)
 * - Approval bottlenecks (pending plan/review approvals)
 * - Blocker chains (parent-child dependency graphs)
 * - Clean project baseline (no findings expected)
 *
 * Run: npx tsx api/src/db/seed-fleetgraph.ts
 *
 * Idempotent — safe to run multiple times. Uses title-based dedup.
 */

import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { v4 as uuid } from 'uuid';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '../../.env.local') });
config({ path: join(__dirname, '../../.env') });

async function seedFleetGraph() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('🧠 FleetGraph test data seeder\n');

  try {
    // Get workspace
    const wsResult = await pool.query('SELECT id, sprint_start_date FROM workspaces LIMIT 1');
    if (wsResult.rows.length === 0) {
      console.error('❌ No workspace found. Run pnpm db:seed first.');
      process.exit(1);
    }
    const workspaceId = wsResult.rows[0].id;
    const sprintStartDate = new Date(wsResult.rows[0].sprint_start_date);
    console.log(`  Workspace: ${workspaceId}`);

    // Get users for assignment
    const usersResult = await pool.query(
      `SELECT u.id, u.name, d.id as person_doc_id
       FROM users u
       JOIN workspace_memberships wm ON wm.user_id = u.id AND wm.workspace_id = $1
       LEFT JOIN documents d ON d.workspace_id = $1
         AND d.document_type = 'person' AND d.properties->>'user_id' = u.id::text
       ORDER BY u.name`,
      [workspaceId]
    );
    const users = usersResult.rows;
    if (users.length < 3) {
      console.error('❌ Need at least 3 users. Run pnpm db:seed first.');
      process.exit(1);
    }
    console.log(`  Users: ${users.map((u: any) => u.name).join(', ')}\n`);

    // Calculate current sprint number
    const today = new Date();
    const daysSinceStart = Math.floor((today.getTime() - sprintStartDate.getTime()) / (1000 * 60 * 60 * 24));
    const currentSprintNumber = Math.max(1, Math.floor(daysSinceStart / 7) + 1);

    // ========================================================
    // Create a dedicated FleetGraph test project + program
    // ========================================================

    const programId = await upsertDocument(pool, workspaceId, {
      type: 'program',
      title: 'FleetGraph Test Program',
      properties: {
        prefix: 'FG',
        color: '#8B5CF6',
        accountable_id: users[0].id, // Dev User is director
      },
    });
    console.log(`  Program: ${programId}`);

    const projectId = await upsertDocument(pool, workspaceId, {
      type: 'project',
      title: 'FleetGraph Test Project',
      properties: {
        color: '#6366f1',
        owner_id: users[1]?.id || users[0].id, // Alice is PM
        impact: 4,
        confidence: 3,
        ease: 3,
        target_date: new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
    });

    // Associate project → program
    await upsertAssociation(pool, projectId, programId, 'program');
    console.log(`  Project: ${projectId}`);

    // ========================================================
    // Scenario A: Ghost Blockers (stale in_progress issues)
    // ========================================================

    console.log('\n📌 Scenario A: Ghost Blockers');

    // Sprint for ghost blocker issues
    const ghostSprintId = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG Sprint ${currentSprintNumber} - Ghost Blockers`,
      properties: {
        sprint_number: currentSprintNumber,
        owner_id: users[1]?.id || users[0].id,
        status: 'active',
        confidence: 70,
        plan_approval: { state: 'approved', approved_by: users[0].id, approved_at: new Date().toISOString() },
      },
    });
    await upsertAssociation(pool, ghostSprintId, projectId, 'project');

    // Issue 1: Very stale (7 days) — should be HIGH severity
    const staleIssue1 = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG: Implement OAuth flow',
      properties: {
        state: 'in_progress',
        priority: 'high',
        assignee_id: users[1]?.id || users[0].id,
        estimate: 5,
      },
    });
    // Backdate updated_at to 7 days ago
    await pool.query(
      `UPDATE documents SET updated_at = NOW() - INTERVAL '7 days' WHERE id = $1`,
      [staleIssue1]
    );
    await upsertAssociation(pool, staleIssue1, ghostSprintId, 'sprint');
    await upsertAssociation(pool, staleIssue1, projectId, 'project');
    console.log(`  Stale issue (7d): ${staleIssue1} — "Implement OAuth flow"`);

    // Issue 2: Moderately stale (4 days) — should be LOW-MEDIUM severity
    const staleIssue2 = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG: Fix login redirect',
      properties: {
        state: 'in_progress',
        priority: 'medium',
        assignee_id: users[2]?.id || users[0].id,
        estimate: 3,
      },
    });
    await pool.query(
      `UPDATE documents SET updated_at = NOW() - INTERVAL '4 days' WHERE id = $1`,
      [staleIssue2]
    );
    await upsertAssociation(pool, staleIssue2, ghostSprintId, 'sprint');
    await upsertAssociation(pool, staleIssue2, projectId, 'project');
    console.log(`  Stale issue (4d): ${staleIssue2} — "Fix login redirect"`);

    // Issue 3: Recently updated (should NOT be flagged)
    const freshIssue = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG: Add unit tests',
      properties: {
        state: 'in_progress',
        priority: 'medium',
        assignee_id: users[0].id,
        estimate: 2,
      },
    });
    // updated_at will be NOW() from upsert — fresh
    await upsertAssociation(pool, freshIssue, ghostSprintId, 'sprint');
    await upsertAssociation(pool, freshIssue, projectId, 'project');
    console.log(`  Fresh issue (0d): ${freshIssue} — "Add unit tests" (should NOT flag)`);

    // Issue 4: Done issue (should NOT be flagged even if old)
    const doneIssue = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG: Setup CI pipeline',
      properties: {
        state: 'done',
        priority: 'high',
        assignee_id: users[0].id,
        estimate: 3,
      },
    });
    await pool.query(
      `UPDATE documents SET updated_at = NOW() - INTERVAL '10 days' WHERE id = $1`,
      [doneIssue]
    );
    await upsertAssociation(pool, doneIssue, ghostSprintId, 'sprint');
    await upsertAssociation(pool, doneIssue, projectId, 'project');
    console.log(`  Done issue (10d): ${doneIssue} — "Setup CI pipeline" (should NOT flag)`);

    // ========================================================
    // Scenario B: Approval Bottlenecks
    // ========================================================

    console.log('\n📌 Scenario B: Approval Bottlenecks');

    // Sprint with changes_requested on plan (5 days ago) — should be HIGH
    const bottleneckSprint1 = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG Sprint ${currentSprintNumber + 1} - Approval Blocked`,
      properties: {
        sprint_number: currentSprintNumber + 1,
        owner_id: users[2]?.id || users[0].id,
        status: 'active',
        confidence: 50,
        plan_approval: {
          state: 'changes_requested',
          approved_by: users[0].id,
          approved_at: new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });
    // Backdate started_at
    await pool.query(
      `UPDATE documents SET started_at = NOW() - INTERVAL '5 days' WHERE id = $1`,
      [bottleneckSprint1]
    );
    await upsertAssociation(pool, bottleneckSprint1, projectId, 'project');
    console.log(`  Approval blocked (5d): ${bottleneckSprint1} — changes_requested`);

    // Sprint that's active but plan never submitted (4 days) — should be MEDIUM
    const bottleneckSprint2 = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG Sprint ${currentSprintNumber + 2} - Never Submitted`,
      properties: {
        sprint_number: currentSprintNumber + 2,
        owner_id: users[1]?.id || users[0].id,
        status: 'active',
        confidence: 60,
        // plan_approval intentionally omitted — never submitted
      },
    });
    await pool.query(
      `UPDATE documents SET started_at = NOW() - INTERVAL '4 days', created_at = NOW() - INTERVAL '4 days' WHERE id = $1`,
      [bottleneckSprint2]
    );
    await upsertAssociation(pool, bottleneckSprint2, projectId, 'project');
    console.log(`  Never submitted (4d): ${bottleneckSprint2} — null plan_approval`);

    // Sprint with approved plan (should NOT be flagged)
    const approvedSprint = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG Sprint ${currentSprintNumber + 3} - Approved`,
      properties: {
        sprint_number: currentSprintNumber + 3,
        owner_id: users[0].id,
        status: 'active',
        confidence: 85,
        plan_approval: {
          state: 'approved',
          approved_by: users[0].id,
          approved_at: new Date().toISOString(),
        },
      },
    });
    await upsertAssociation(pool, approvedSprint, projectId, 'project');
    console.log(`  Approved: ${approvedSprint} — should NOT flag`);

    // ========================================================
    // Scenario C: Blocker Chain
    // ========================================================

    console.log('\n📌 Scenario C: Blocker Chain');

    // Root blocker issue (in_progress, stale)
    const rootBlocker = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG: Design auth middleware',
      properties: {
        state: 'in_progress',
        priority: 'urgent',
        assignee_id: users[1]?.id || users[0].id,
        estimate: 8,
      },
    });
    await pool.query(
      `UPDATE documents SET updated_at = NOW() - INTERVAL '5 days' WHERE id = $1`,
      [rootBlocker]
    );
    await upsertAssociation(pool, rootBlocker, ghostSprintId, 'sprint');
    await upsertAssociation(pool, rootBlocker, projectId, 'project');
    console.log(`  Root blocker: ${rootBlocker} — "Design auth middleware"`);

    // 4 child issues blocked by root (creates a chain of depth 1 but width 4)
    const blockedTitles = [
      'FG: Implement token validation',
      'FG: Add session management',
      'FG: Build login UI',
      'FG: Write auth integration tests',
    ];
    for (let i = 0; i < blockedTitles.length; i++) {
      const childId = await upsertDocument(pool, workspaceId, {
        type: 'issue',
        title: blockedTitles[i]!,
        properties: {
          state: 'todo',
          priority: 'high',
          assignee_id: users[(i + 2) % users.length]?.id || users[0].id,
          estimate: 3,
        },
      });
      await upsertAssociation(pool, childId, rootBlocker, 'parent');
      await upsertAssociation(pool, childId, ghostSprintId, 'sprint');
      await upsertAssociation(pool, childId, projectId, 'project');
      console.log(`  Blocked child ${i + 1}: ${childId} — "${blockedTitles[i]}"`);
    }

    // ========================================================
    // Scenario D: Pre-created insights with proposed_action (for HITL testing)
    // ========================================================

    console.log('\n📌 Scenario D: HITL Insights');

    // Insight with comment action
    const commentInsightId = uuid();
    await pool.query(
      `INSERT INTO fleetgraph_insights
        (id, workspace_id, entity_id, entity_type, severity, category, title, content,
         proposed_action, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        commentInsightId,
        workspaceId,
        staleIssue1,
        'issue',
        'high',
        'ghost_blocker',
        'HITL: Stale issue needs attention',
        JSON.stringify({
          description: 'Issue "Implement OAuth flow" has been in_progress for 7 days. Assignee may be blocked.',
          confidence: 1.0,
        }),
        JSON.stringify({
          type: 'comment',
          entity_id: staleIssue1,
          entity_type: 'issue',
          payload: { content: 'Hi — this issue has been in progress for 7 days with no updates. Are you blocked? Can I help unblock or reassign?' },
          description: 'Post follow-up comment on stale issue',
        }),
      ]
    );
    console.log(`  Comment insight: ${commentInsightId}`);

    // Insight with reassign action
    const reassignInsightId = uuid();
    await pool.query(
      `INSERT INTO fleetgraph_insights
        (id, workspace_id, entity_id, entity_type, severity, category, title, content,
         proposed_action, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        reassignInsightId,
        workspaceId,
        staleIssue2,
        'issue',
        'medium',
        'ghost_blocker',
        'HITL: Reassign stale issue',
        JSON.stringify({
          description: 'Issue "Fix login redirect" has been stale for 4 days. Reassign to less-loaded team member.',
          confidence: 0.8,
        }),
        JSON.stringify({
          type: 'reassign',
          entity_id: staleIssue2,
          entity_type: 'issue',
          payload: { assignee_id: users[0].id },
          description: `Reassign to ${users[0].name}`,
        }),
      ]
    );
    console.log(`  Reassign insight: ${reassignInsightId}`);

    // Insight with state_change action
    const stateChangeInsightId = uuid();
    await pool.query(
      `INSERT INTO fleetgraph_insights
        (id, workspace_id, entity_id, entity_type, severity, category, title, content,
         proposed_action, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        stateChangeInsightId,
        workspaceId,
        staleIssue1,
        'issue',
        'medium',
        'ghost_blocker',
        'HITL: Revert stale issue to todo',
        JSON.stringify({
          description: 'Issue has been stale too long. Revert to todo so it can be reprioritized.',
          confidence: 0.7,
        }),
        JSON.stringify({
          type: 'state_change',
          entity_id: staleIssue1,
          entity_type: 'issue',
          payload: { state: 'todo' },
          description: 'Revert issue state to todo',
        }),
      ]
    );
    console.log(`  State change insight: ${stateChangeInsightId}`);

    // ========================================================
    // Scenario E: Sprint Collapse (mid-sprint, low completion)
    // ========================================================

    console.log('\n📌 Scenario E: Sprint Collapse');

    // Calculate a sprint number where we are 5 days in (past 40% threshold)
    const collapseSprintNum = currentSprintNumber; // Use current sprint

    const collapseSprintId = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG Sprint ${collapseSprintNum} - Collapse Risk`,
      properties: {
        sprint_number: collapseSprintNum,
        owner_id: users[1]?.id || users[0].id,
        status: 'active',
        confidence: 40,
        plan_approval: { state: 'approved', approved_by: users[0].id, approved_at: new Date().toISOString() },
      },
    });
    await upsertAssociation(pool, collapseSprintId, projectId, 'project');

    // 8 issues total: only 2 done, 1 in_review, 5 still todo/in_progress — with 1-2 days left
    const collapseIssues = [
      { title: 'FG Collapse: API endpoint design', state: 'done', estimate: 3 },
      { title: 'FG Collapse: Database schema', state: 'done', estimate: 2 },
      { title: 'FG Collapse: Auth middleware', state: 'in_review', estimate: 5 },
      { title: 'FG Collapse: Frontend forms', state: 'in_progress', estimate: 5 },
      { title: 'FG Collapse: Validation logic', state: 'todo', estimate: 3 },
      { title: 'FG Collapse: Error handling', state: 'todo', estimate: 2 },
      { title: 'FG Collapse: Integration tests', state: 'todo', estimate: 3 },
      { title: 'FG Collapse: Deploy pipeline', state: 'todo', estimate: 2 },
    ];

    for (const iss of collapseIssues) {
      const issueId = await upsertDocument(pool, workspaceId, {
        type: 'issue',
        title: iss.title,
        properties: {
          state: iss.state,
          priority: 'high',
          assignee_id: users[Math.floor(Math.random() * Math.min(users.length, 4))]?.id || users[0].id,
          estimate: iss.estimate,
        },
      });
      await upsertAssociation(pool, issueId, collapseSprintId, 'sprint');
      await upsertAssociation(pool, issueId, projectId, 'project');
    }
    console.log(`  Collapse sprint: ${collapseSprintId} — 2/8 done, should predict miss`);

    // ========================================================
    // Scenario F: Recent Activity (for AI Standup generation)
    // ========================================================

    console.log('\n📌 Scenario F: Standup Activity');

    // Create document_history entries simulating yesterday's activity
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);

    // Simulate: 2 issues completed yesterday, 1 moved to in_review, 1 new blocker
    const standupIssues = [
      { title: 'FG Standup: Completed task A', state: 'done', prevState: 'in_progress' },
      { title: 'FG Standup: Completed task B', state: 'done', prevState: 'in_review' },
      { title: 'FG Standup: In review task', state: 'in_review', prevState: 'in_progress' },
      { title: 'FG Standup: New blocker', state: 'in_progress', prevState: 'todo' },
      { title: 'FG Standup: Upcoming high priority', state: 'todo', prevState: null },
    ];

    for (const iss of standupIssues) {
      const issueId = await upsertDocument(pool, workspaceId, {
        type: 'issue',
        title: iss.title,
        properties: {
          state: iss.state,
          priority: iss.title.includes('blocker') ? 'urgent' : iss.title.includes('high priority') ? 'high' : 'medium',
          assignee_id: users[0].id, // Dev User's issues
          estimate: 3,
        },
      });
      await upsertAssociation(pool, issueId, ghostSprintId, 'sprint');
      await upsertAssociation(pool, issueId, projectId, 'project');

      // Create document_history for state transitions (yesterday)
      if (iss.prevState) {
        await pool.query(
          `INSERT INTO document_history (document_id, field, old_value, new_value, changed_by, created_at)
           VALUES ($1, 'state', $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [issueId, iss.prevState, iss.state, users[0].id, yesterday.toISOString()]
        );
      }
    }
    console.log(`  Standup activity seeded — 5 issues with history for Dev User`);

    // ========================================================
    // Scenario G: Healthy Project (for health score contrast)
    // ========================================================

    console.log('\n📌 Scenario G: Healthy Project');

    const healthyProjectId = await upsertDocument(pool, workspaceId, {
      type: 'project',
      title: 'FleetGraph Healthy Project',
      properties: {
        color: '#22c55e',
        owner_id: users[0].id,
        impact: 5,
        confidence: 4,
        ease: 4,
      },
    });
    await upsertAssociation(pool, healthyProjectId, programId, 'program');

    const healthySprintId = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG Healthy Sprint ${currentSprintNumber}`,
      properties: {
        sprint_number: currentSprintNumber,
        owner_id: users[0].id,
        status: 'active',
        confidence: 90,
        plan_approval: {
          state: 'approved',
          approved_by: users[0].id,
          approved_at: new Date().toISOString(),
        },
      },
    });
    await upsertAssociation(pool, healthySprintId, healthyProjectId, 'project');

    // All issues recently updated or done
    const healthyIssues = [
      { title: 'FG Healthy: Setup infrastructure', state: 'done' },
      { title: 'FG Healthy: Build API endpoints', state: 'done' },
      { title: 'FG Healthy: Write documentation', state: 'in_progress' }, // Recently updated
      { title: 'FG Healthy: Add tests', state: 'in_progress' }, // Recently updated
    ];
    for (const iss of healthyIssues) {
      const issueId = await upsertDocument(pool, workspaceId, {
        type: 'issue',
        title: iss.title,
        properties: {
          state: iss.state,
          priority: 'medium',
          assignee_id: users[0].id,
          estimate: 3,
        },
      });
      // updated_at is NOW() — fresh
      await upsertAssociation(pool, issueId, healthySprintId, 'sprint');
      await upsertAssociation(pool, issueId, healthyProjectId, 'project');
    }
    console.log(`  Healthy project: ${healthyProjectId} — should score ~100`);

    // ========================================================
    // Clear old FleetGraph insights (so tests start fresh)
    // ========================================================

    const deleted = await pool.query(
      `DELETE FROM fleetgraph_insights WHERE workspace_id = $1 RETURNING id`,
      [workspaceId]
    );
    console.log(`\n🧹 Cleared ${deleted.rowCount} existing FleetGraph insights`);

    // Also clear fleetgraph_state so proactive scan runs fresh
    await pool.query(
      `DELETE FROM fleetgraph_state WHERE workspace_id = $1`,
      [workspaceId]
    );
    console.log('🧹 Cleared FleetGraph state');

    // ========================================================
    // Summary
    // ========================================================

    console.log('\n✅ FleetGraph test data seeded successfully!\n');
    console.log('  Workspace ID:', workspaceId);
    console.log('  Test Project ID:', projectId);
    console.log('  Healthy Project ID:', healthyProjectId);
    console.log('  Ghost sprint ID:', ghostSprintId);
    console.log('  Current sprint number:', currentSprintNumber);
    console.log('\n  Expected detections:');
    console.log('  - Ghost Blocker (high): "Implement OAuth flow" — 7 days stale');
    console.log('  - Ghost Blocker (low/medium): "Fix login redirect" — 4 days stale');
    console.log('  - Ghost Blocker: "Design auth middleware" — 5 days stale (also root of blocker chain)');
    console.log('  - Approval Bottleneck (high): Sprint with changes_requested — 5 days');
    console.log('  - Approval Bottleneck (medium): Sprint with null plan_approval — 4 days');
    console.log('  - Blocker Chain (high): "Design auth middleware" blocking 4 issues');
    console.log('\n  Expected health scores after proactive run:');
    console.log(`  - Test Project (${projectId}): LOW score (multiple findings)`);
    console.log(`  - Healthy Project (${healthyProjectId}): HIGH score (~100)`);
    console.log('\n  Should NOT detect:');
    console.log('  - "Add unit tests" — updated today');
    console.log('  - "Setup CI pipeline" — state is done');
    console.log('  - Approved sprint — plan is approved');

  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// ============================================================
// Helpers
// ============================================================

async function upsertDocument(
  pool: pg.Pool,
  workspaceId: string,
  doc: { type: string; title: string; properties: Record<string, unknown> }
): Promise<string> {
  // Check if document already exists by title + type
  const existing = await pool.query(
    `SELECT id FROM documents WHERE workspace_id = $1 AND document_type = $2 AND title = $3 AND deleted_at IS NULL LIMIT 1`,
    [workspaceId, doc.type, doc.title]
  );

  if (existing.rows[0]) {
    // Update properties
    await pool.query(
      `UPDATE documents SET properties = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(doc.properties), existing.rows[0].id]
    );
    return existing.rows[0].id;
  }

  const result = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, properties)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [workspaceId, doc.type, doc.title, JSON.stringify(doc.properties)]
  );
  return result.rows[0].id;
}

async function upsertAssociation(
  pool: pg.Pool,
  documentId: string,
  relatedId: string,
  relationshipType: string
): Promise<void> {
  await pool.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
    [documentId, relatedId, relationshipType]
  );
}

seedFleetGraph();
