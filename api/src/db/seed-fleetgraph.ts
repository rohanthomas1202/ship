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
    console.log('  Project ID:', projectId);
    console.log('  Ghost sprint ID:', ghostSprintId);
    console.log('  Current sprint number:', currentSprintNumber);
    console.log('\n  Expected detections:');
    console.log('  - Ghost Blocker (high): "Implement OAuth flow" — 7 days stale');
    console.log('  - Ghost Blocker (low/medium): "Fix login redirect" — 4 days stale');
    console.log('  - Ghost Blocker: "Design auth middleware" — 5 days stale (also root of blocker chain)');
    console.log('  - Approval Bottleneck (high): Sprint with changes_requested — 5 days');
    console.log('  - Approval Bottleneck (medium): Sprint with null plan_approval — 4 days');
    console.log('  - Blocker Chain (high): "Design auth middleware" blocking 4 issues');
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
