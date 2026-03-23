/**
 * FleetGraph test data seeder.
 *
 * Creates 4 isolated projects, one per test scenario:
 *   1. FG-Ghost    — Ghost Blocker detection
 *   2. FG-Collapse — Sprint Collapse prediction
 *   3. FG-Chain    — Blocker Chain detection
 *   4. FG-Activity — AI Standup + Sprint Planning
 *
 * Run: npx tsx api/src/db/seed-fleetgraph.ts
 *
 * Idempotent — safe to run multiple times. Uses title-based dedup.
 */

import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';
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
    // Cleanup BEFORE inserts — start fresh
    // ========================================================

    const deleted = await pool.query(
      `DELETE FROM fleetgraph_insights WHERE workspace_id = $1 RETURNING id`,
      [workspaceId]
    );
    console.log(`🧹 Cleared ${deleted.rowCount} existing FleetGraph insights`);

    await pool.query(
      `DELETE FROM fleetgraph_state WHERE workspace_id = $1`,
      [workspaceId]
    );
    console.log('🧹 Cleared FleetGraph state\n');

    // ========================================================
    // Shared program
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

    // ========================================================
    // Project 1: FG-Ghost — Ghost Blocker Project
    // ========================================================

    console.log('\n📌 Project 1: FG-Ghost — Ghost Blocker');

    const ghostProjectId = await upsertDocument(pool, workspaceId, {
      type: 'project',
      title: 'FG-Ghost: Ghost Blocker Project',
      properties: {
        color: '#6366f1',
        owner_id: users[1]?.id || users[0].id, // Alice is PM
        impact: 4,
        confidence: 3,
        ease: 3,
        target_date: new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
    });
    await upsertAssociation(pool, ghostProjectId, programId, 'program');
    console.log(`  Ghost project: ${ghostProjectId}`);

    const ghostSprintId = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG-Ghost Sprint ${currentSprintNumber}`,
      properties: {
        sprint_number: currentSprintNumber,
        owner_id: users[1]?.id || users[0].id,
        status: 'active',
        confidence: 70,
        plan_approval: { state: 'approved', approved_by: users[0].id, approved_at: new Date().toISOString() },
      },
    });
    await upsertAssociation(pool, ghostSprintId, ghostProjectId, 'project');
    console.log(`  Ghost sprint: ${ghostSprintId}`);

    // Stale issue 1: 7 days — HIGH severity
    const staleIssue1 = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG-Ghost: Implement OAuth flow',
      properties: {
        state: 'in_progress',
        priority: 'high',
        assignee_id: users[1]?.id || users[0].id,
        estimate: 5,
      },
    });
    await pool.query(
      `UPDATE documents SET updated_at = NOW() - INTERVAL '7 days' WHERE id = $1`,
      [staleIssue1]
    );
    await upsertAssociation(pool, staleIssue1, ghostSprintId, 'sprint');
    await upsertAssociation(pool, staleIssue1, ghostProjectId, 'project');
    console.log(`  Stale issue (7d): ${staleIssue1} — "FG-Ghost: Implement OAuth flow"`);

    // Stale issue 2: 4 days — MEDIUM severity
    const staleIssue2 = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG-Ghost: Fix login redirect',
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
    await upsertAssociation(pool, staleIssue2, ghostProjectId, 'project');
    console.log(`  Stale issue (4d): ${staleIssue2} — "FG-Ghost: Fix login redirect"`);

    // Fresh issue: control — should NOT flag
    const freshIssue = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG-Ghost: Add unit tests',
      properties: {
        state: 'in_progress',
        priority: 'medium',
        assignee_id: users[0].id,
        estimate: 2,
      },
    });
    await upsertAssociation(pool, freshIssue, ghostSprintId, 'sprint');
    await upsertAssociation(pool, freshIssue, ghostProjectId, 'project');
    console.log(`  Fresh issue (0d): ${freshIssue} — "FG-Ghost: Add unit tests" (should NOT flag)`);

    // Done issue: 10 days old but done — should NOT flag
    const doneIssue = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG-Ghost: Setup CI pipeline',
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
    await upsertAssociation(pool, doneIssue, ghostProjectId, 'project');
    console.log(`  Done issue (10d): ${doneIssue} — "FG-Ghost: Setup CI pipeline" (should NOT flag)`);

    // ========================================================
    // Project 2: FG-Collapse — Sprint Collapse Project
    // ========================================================

    console.log('\n📌 Project 2: FG-Collapse — Sprint Collapse');

    const collapseProjectId = await upsertDocument(pool, workspaceId, {
      type: 'project',
      title: 'FG-Collapse: Sprint Collapse Project',
      properties: {
        color: '#f59e0b',
        owner_id: users[1]?.id || users[0].id,
        impact: 4,
        confidence: 3,
        ease: 3,
        target_date: new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
    });
    await upsertAssociation(pool, collapseProjectId, programId, 'program');
    console.log(`  Collapse project: ${collapseProjectId}`);

    const collapseSprintId = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG-Collapse Sprint ${currentSprintNumber}`,
      properties: {
        sprint_number: currentSprintNumber,
        owner_id: users[1]?.id || users[0].id,
        status: 'active',
        confidence: 40,
        plan_approval: { state: 'approved', approved_by: users[0].id, approved_at: new Date().toISOString() },
      },
    });
    await upsertAssociation(pool, collapseSprintId, collapseProjectId, 'project');
    console.log(`  Collapse sprint: ${collapseSprintId}`);

    // 6 issues: 1 done + 5 not done (in_progress/todo). All recently updated.
    const collapseIssues = [
      { title: 'FG-Collapse: API endpoint design', state: 'done', estimate: 3 },
      { title: 'FG-Collapse: Database schema', state: 'in_progress', estimate: 2 },
      { title: 'FG-Collapse: Auth middleware', state: 'in_progress', estimate: 5 },
      { title: 'FG-Collapse: Frontend forms', state: 'todo', estimate: 5 },
      { title: 'FG-Collapse: Validation logic', state: 'todo', estimate: 3 },
      { title: 'FG-Collapse: Error handling', state: 'todo', estimate: 2 },
    ];

    let collapseTouchIssueId = '';
    for (const iss of collapseIssues) {
      const issueId = await upsertDocument(pool, workspaceId, {
        type: 'issue',
        title: iss.title,
        properties: {
          state: iss.state,
          priority: 'high',
          assignee_id: users[Math.floor(Math.random() * Math.min(users.length, 3))]?.id || users[0].id,
          estimate: iss.estimate,
        },
      });
      // All recently updated — no ghost blocker signal
      await upsertAssociation(pool, issueId, collapseSprintId, 'sprint');
      await upsertAssociation(pool, issueId, collapseProjectId, 'project');
      if (!collapseTouchIssueId && iss.state !== 'done') {
        collapseTouchIssueId = issueId;
      }
    }
    console.log(`  Collapse sprint: ${collapseSprintId} — 1/6 done, 5 not done`);
    console.log(`  Collapse touch issue: ${collapseTouchIssueId}`);

    // ========================================================
    // Project 3: FG-Chain — Blocker Chain Project
    // ========================================================

    console.log('\n📌 Project 3: FG-Chain — Blocker Chain');

    const chainProjectId = await upsertDocument(pool, workspaceId, {
      type: 'project',
      title: 'FG-Chain: Blocker Chain Project',
      properties: {
        color: '#ef4444',
        owner_id: users[0].id,
        impact: 5,
        confidence: 3,
        ease: 2,
        target_date: new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
    });
    await upsertAssociation(pool, chainProjectId, programId, 'program');
    console.log(`  Chain project: ${chainProjectId}`);

    const chainSprintId = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG-Chain Sprint ${currentSprintNumber}`,
      properties: {
        sprint_number: currentSprintNumber,
        owner_id: users[0].id,
        status: 'active',
        confidence: 60,
        plan_approval: { state: 'approved', approved_by: users[0].id, approved_at: new Date().toISOString() },
      },
    });
    await upsertAssociation(pool, chainSprintId, chainProjectId, 'project');

    // Root blocker: in_progress, stale 5 days, urgent
    const rootBlocker = await upsertDocument(pool, workspaceId, {
      type: 'issue',
      title: 'FG-Chain: Design auth middleware',
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
    await upsertAssociation(pool, rootBlocker, chainSprintId, 'sprint');
    await upsertAssociation(pool, rootBlocker, chainProjectId, 'project');
    console.log(`  Root blocker: ${rootBlocker} — "FG-Chain: Design auth middleware"`);

    // 4 children blocked by root
    const blockedTitles = [
      'FG-Chain: Implement token validation',
      'FG-Chain: Add session management',
      'FG-Chain: Build login UI',
      'FG-Chain: Write auth integration tests',
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
      await upsertAssociation(pool, childId, chainSprintId, 'sprint');
      await upsertAssociation(pool, childId, chainProjectId, 'project');
      console.log(`  Blocked child ${i + 1}: ${childId} — "${blockedTitles[i]}"`);
    }

    // Pre-seeded HITL insight with proposed comment action on root blocker
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
        rootBlocker,
        'issue',
        'high',
        'blocker_chain',
        'HITL: Root blocker needs attention',
        JSON.stringify({
          description: 'Issue "FG-Chain: Design auth middleware" has been in_progress for 5 days and blocks 4 downstream issues.',
          confidence: 1.0,
        }),
        JSON.stringify({
          type: 'comment',
          entity_id: rootBlocker,
          entity_type: 'issue',
          payload: { content: 'Hi — this issue has been in progress for 5 days and is blocking 4 other issues. Are you blocked? Can I help unblock or reassign?' },
          description: 'Post follow-up comment on root blocker',
        }),
      ]
    );
    console.log(`  Pre-seeded HITL insight: ${commentInsightId}`);

    // ========================================================
    // Project 4: FG-Activity — Standup & Planning Project
    // ========================================================

    console.log('\n📌 Project 4: FG-Activity — Standup & Planning');

    const activityProjectId = await upsertDocument(pool, workspaceId, {
      type: 'project',
      title: 'FG-Activity: Standup & Planning Project',
      properties: {
        color: '#10b981',
        owner_id: users[0].id,
        impact: 4,
        confidence: 4,
        ease: 4,
        target_date: new Date(today.getTime() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
    });
    await upsertAssociation(pool, activityProjectId, programId, 'program');
    console.log(`  Activity project: ${activityProjectId}`);

    // Active standup sprint
    const standupSprintId = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG-Activity Standup Sprint ${currentSprintNumber}`,
      properties: {
        sprint_number: currentSprintNumber,
        owner_id: users[0].id,
        status: 'active',
        confidence: 75,
        plan_approval: { state: 'approved', approved_by: users[0].id, approved_at: new Date().toISOString() },
      },
    });
    await upsertAssociation(pool, standupSprintId, activityProjectId, 'project');
    console.log(`  Standup sprint: ${standupSprintId}`);

    // 5 issues with yesterday's document_history entries
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const standupIssues = [
      { title: 'FG-Activity: Completed task A', state: 'done', prevState: 'in_progress' },
      { title: 'FG-Activity: Completed task B', state: 'done', prevState: 'in_review' },
      { title: 'FG-Activity: In review task', state: 'in_review', prevState: 'in_progress' },
      { title: 'FG-Activity: New blocker', state: 'in_progress', prevState: 'todo' },
      { title: 'FG-Activity: Upcoming high priority', state: 'todo', prevState: null },
    ];

    for (const iss of standupIssues) {
      const issueId = await upsertDocument(pool, workspaceId, {
        type: 'issue',
        title: iss.title,
        properties: {
          state: iss.state,
          priority: iss.title.includes('blocker') ? 'urgent' : iss.title.includes('high priority') ? 'high' : 'medium',
          assignee_id: users[0].id,
          estimate: 3,
        },
      });
      await upsertAssociation(pool, issueId, standupSprintId, 'sprint');
      await upsertAssociation(pool, issueId, activityProjectId, 'project');

      if (iss.prevState) {
        await pool.query(
          `INSERT INTO document_history (document_id, field, old_value, new_value, changed_by, created_at)
           VALUES ($1, 'state', $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [issueId, iss.prevState, iss.state, users[0].id, yesterday.toISOString()]
        );
      }
    }
    console.log(`  Standup sprint seeded — 5 issues with yesterday's history for Dev User`);

    // Planning sprint (status: planning, sprint_number: currentSprintNumber + 1)
    const planningSprintId = await upsertDocument(pool, workspaceId, {
      type: 'sprint',
      title: `FG-Activity Planning Sprint ${currentSprintNumber + 1}`,
      properties: {
        sprint_number: currentSprintNumber + 1,
        owner_id: users[0].id,
        status: 'planning',
        confidence: 50,
      },
    });
    await upsertAssociation(pool, planningSprintId, activityProjectId, 'project');
    console.log(`  Planning sprint: ${planningSprintId}`);

    // Team capacity: 20h per member
    for (let i = 0; i < Math.min(users.length, 3); i++) {
      const u = users[i]!;
      if (u.person_doc_id) {
        await pool.query(
          `UPDATE documents SET properties = properties || '{"capacity_hours": 20}'::jsonb
           WHERE id = $1`,
          [u.person_doc_id]
        );
      }
    }
    console.log(`  Team capacity: 20h per member set`);

    // 10 backlog issues (not in any sprint)
    const backlogIssues = [
      { title: 'FG-Backlog: Urgent security patch', priority: 'urgent', estimate: 3, due: 5 },
      { title: 'FG-Backlog: API rate limiting', priority: 'high', estimate: 5, due: null },
      { title: 'FG-Backlog: Dashboard redesign', priority: 'high', estimate: 8, due: 14 },
      { title: 'FG-Backlog: Fix email templates', priority: 'medium', estimate: 2, due: 7 },
      { title: 'FG-Backlog: Add export feature', priority: 'medium', estimate: 5, due: null },
      { title: 'FG-Backlog: Update onboarding flow', priority: 'medium', estimate: 3, due: null },
      { title: 'FG-Backlog: Improve search performance', priority: 'high', estimate: 5, due: null },
      { title: 'FG-Backlog: Add dark mode', priority: 'low', estimate: 8, due: null },
      { title: 'FG-Backlog: Refactor auth module', priority: 'low', estimate: 5, due: null },
      { title: 'FG-Backlog: Write API docs', priority: 'low', estimate: 3, due: null },
    ];

    for (const iss of backlogIssues) {
      const dueDate = iss.due
        ? new Date(today.getTime() + iss.due * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : null;
      const issueId = await upsertDocument(pool, workspaceId, {
        type: 'issue',
        title: iss.title,
        properties: {
          state: 'backlog',
          priority: iss.priority,
          estimate: iss.estimate,
          ...(dueDate ? { due_date: dueDate } : {}),
        },
      });
      // Associate with project but NOT with any sprint
      await upsertAssociation(pool, issueId, activityProjectId, 'project');
    }
    console.log(`  ${backlogIssues.length} backlog issues (not in any sprint)`);

    // 2 carryover issues in the standup sprint
    const carryoverIssues = [
      { title: 'FG-Carryover: Unfinished login flow', priority: 'high', estimate: 5 },
      { title: 'FG-Carryover: Incomplete tests', priority: 'medium', estimate: 3 },
    ];
    for (const iss of carryoverIssues) {
      const issueId = await upsertDocument(pool, workspaceId, {
        type: 'issue',
        title: iss.title,
        properties: {
          state: 'in_progress',
          priority: iss.priority,
          estimate: iss.estimate,
          assignee_id: users[0].id,
        },
      });
      await upsertAssociation(pool, issueId, standupSprintId, 'sprint');
      await upsertAssociation(pool, issueId, activityProjectId, 'project');
    }
    console.log(`  ${carryoverIssues.length} carryover issues in standup sprint`);

    // ========================================================
    // Write IDs to JSON for test runner
    // ========================================================

    const testIds = {
      workspaceId,
      ghostProjectId,
      collapseProjectId,
      chainProjectId,
      activityProjectId,
      ghostSprintId,
      standupSprintId,
      planningSprintId,
      commentInsightId,
      ghostTouchIssueId: freshIssue,
      collapseTouchIssueId,
      chainTouchIssueId: rootBlocker,
    };

    const idsPath = join(__dirname, '../../../scripts/fleetgraph-test-ids.json');
    writeFileSync(idsPath, JSON.stringify(testIds, null, 2));
    console.log(`\n📄 Test IDs written to scripts/fleetgraph-test-ids.json`);

    // ========================================================
    // Summary
    // ========================================================

    console.log('\n✅ FleetGraph test data seeded successfully!\n');
    console.log('  Workspace ID:', workspaceId);
    console.log('  Ghost Project:', ghostProjectId);
    console.log('  Collapse Project:', collapseProjectId);
    console.log('  Chain Project:', chainProjectId);
    console.log('  Activity Project:', activityProjectId);
    console.log('\n  Sprints:');
    console.log('  Ghost Sprint:', ghostSprintId);
    console.log('  Standup Sprint:', standupSprintId);
    console.log('  Planning Sprint:', planningSprintId);
    console.log('\n  Key issue IDs:');
    console.log('  Ghost touch issue (fresh/control):', freshIssue);
    console.log('  Collapse touch issue (first non-done):', collapseTouchIssueId);
    console.log('  Chain touch issue (root blocker):', rootBlocker);
    console.log('  Pre-seeded HITL comment insight:', commentInsightId);
    console.log('\n  Expected detections per project:');
    console.log('  - FG-Ghost: Ghost Blocker (high) "Implement OAuth flow" 7d, (medium) "Fix login redirect" 4d');
    console.log('  - FG-Collapse: Sprint Collapse — 1/6 done, 5 incomplete');
    console.log('  - FG-Chain: Blocker Chain — root blocker 5d stale, 4 downstream issues');
    console.log('  - FG-Activity: Standup + Planning — 5 activity issues + 10 backlog + 2 carryover');

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
