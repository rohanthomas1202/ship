# FleetGraph Test Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce 5 isolated test cases with distinct LangSmith traces for the FleetGraph final submission, filling in the FLEETGRAPH.md Test Cases table.

**Architecture:** Add `project_id` scoping to proactive scans, refactor seed data into isolated projects per scenario, and build a test runner script that executes all 5 cases and outputs a markdown table. No changes to graph execution logic.

**Tech Stack:** TypeScript, PostgreSQL, Express, LangSmith tracing (already configured)

**Spec:** `docs/superpowers/specs/2026-03-23-fleetgraph-test-evidence-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `shared/src/types/fleetgraph.ts` | Add `project_id` to trigger type |
| `api/src/services/fleetgraph/nodes-fetch.ts` | Filter `fetchActivity` and `fetchIssues` by `project_id` |
| `api/src/routes/fleetgraph.ts` | Accept `project_id` + `sync` params on `/run` |
| `api/src/db/seed-fleetgraph.ts` | Isolated projects per test scenario |
| `scripts/run-test-cases.ts` | Test runner: seed → touch → run → output table |
| `FLEETGRAPH.md` | Fill in Test Cases table with trace links |

---

## Task 1: Add `project_id` to FleetGraphTrigger type

**Files:**
- Modify: `shared/src/types/fleetgraph.ts:11-19`

- [ ] **Step 1: Add `project_id` field**

In `shared/src/types/fleetgraph.ts`, add `project_id` to `FleetGraphTrigger`:

```typescript
export interface FleetGraphTrigger {
  type: FleetGraphTriggerType;
  entity?: { type: string; id: string };
  user_id?: string;
  user_role?: 'admin' | 'member';
  user_person_id?: string;
  workspace_id: string;
  project_id?: string; // Optional: scope proactive scan to single project
  chat_message?: string;
  chat_history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}
```

- [ ] **Step 2: Build shared types**

Run: `cd /Users/rohanthomas/ClaudeCode/ship && pnpm build:shared`
Expected: Clean build, no errors

- [ ] **Step 3: Commit**

```bash
git add shared/src/types/fleetgraph.ts
git commit -m "feat(fleetgraph): add project_id to FleetGraphTrigger type"
```

---

## Task 2: Filter `fetchActivity` by `project_id`

**Files:**
- Modify: `api/src/services/fleetgraph/nodes-fetch.ts:10-37`

- [ ] **Step 1: Add project_id filter to fetchActivity**

In `nodes-fetch.ts`, modify `fetchActivity` to filter when `project_id` is set. The current query (line 17-29) groups by `da.related_id` (project_id). Add an optional WHERE clause:

```typescript
export async function fetchActivity(
  pool: Pool,
  state: FleetGraphState
): Promise<FleetGraphState> {
  const workspaceId = state.trigger.workspace_id;
  const projectId = state.trigger.project_id;

  // Get activity counts for the last 24 hours for active projects
  // When project_id is set, scope to that single project
  const params: any[] = [workspaceId];
  let projectFilter = '';
  if (projectId) {
    projectFilter = 'AND da.related_id = $2';
    params.push(projectId);
  }

  const result = await pool.query(
    `SELECT da.related_id AS project_id,
            COUNT(DISTINCT d.id) AS activity_count
     FROM documents d
     JOIN document_associations da ON da.document_id = d.id
     WHERE da.relationship_type = 'project'
       AND d.workspace_id = $1
       AND d.updated_at > NOW() - INTERVAL '5 minutes'
       AND d.deleted_at IS NULL
       AND d.archived_at IS NULL
       ${projectFilter}
     GROUP BY da.related_id`,
    params
  );

  const activity: Record<string, Array<{ date: string; count: number }>> = {};
  for (const row of result.rows) {
    activity[row.project_id] = [{ date: new Date().toISOString(), count: Number(row.activity_count) }];
  }

  return { ...state, data: { ...state.data, activity } };
}
```

- [ ] **Step 2: Add project_id filter to fetchIssues (proactive branch)**

In the proactive branch of `fetchIssues` (lines 102-124), when `project_id` is set, use it directly instead of reading `Object.keys(state.data.activity)`. This is defense-in-depth — `fetchActivity` already filters upstream, but this prevents cross-project leakage if that logic ever changes:

```typescript
  } else {
    // Proactive: get all open issues in active projects with recent activity
    const projectId = state.trigger.project_id;
    const activeProjectIds = projectId ? [projectId] : Object.keys(state.data.activity);
    if (activeProjectIds.length === 0) {
      return { ...state, data: { ...state.data, issues: [] } };
    }

    const result = await pool.query(
      `SELECT d.*, da_list.associations
       FROM documents d
       JOIN document_associations da ON da.document_id = d.id AND da.relationship_type = 'project' AND da.related_id = ANY($1::uuid[])
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('type', da2.relationship_type, 'id', da2.related_id)) AS associations
         FROM document_associations da2 WHERE da2.document_id = d.id
       ) da_list ON true
       WHERE d.document_type = 'issue'
         AND d.workspace_id = $2
         AND d.deleted_at IS NULL
         AND d.archived_at IS NULL
         AND (d.properties->>'state') NOT IN ('done', 'cancelled')`,
      [activeProjectIds, workspaceId]
    );
    issues = result.rows;
  }
```

- [ ] **Step 3: Verify existing unit tests still pass**

Run: `cd /Users/rohanthomas/ClaudeCode/ship && pnpm test`
Expected: All 549 tests pass (no changes to behavior when `project_id` is omitted)

- [ ] **Step 4: Commit**

```bash
git add api/src/services/fleetgraph/nodes-fetch.ts
git commit -m "feat(fleetgraph): filter fetchActivity and fetchIssues by project_id when set"
```

---

## Task 3: Add `sync` and `project_id` params to `/run` endpoint

**Files:**
- Modify: `api/src/routes/fleetgraph.ts:292-314`

- [ ] **Step 1: Update the /run route**

Replace the current fire-and-forget `/run` handler (lines 292-314) with one that supports `project_id` and `sync` query params:

```typescript
/**
 * POST /api/fleetgraph/run
 *
 * Trigger a proactive scan. Intended for scheduled jobs via API token.
 * Query params:
 *   - project_id: scope scan to a single project (optional)
 *   - sync: if "true", await result and return trace data (optional)
 */
router.post('/run', authMiddleware, async (req: Request, res: Response) => {
  const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined;
  if (projectId && !isValidUuid(projectId)) {
    res.status(400).json({ error: 'Invalid project_id — must be a UUID' });
    return;
  }

  const trigger: FleetGraphTrigger = {
    type: 'schedule',
    workspace_id: req.workspaceId!,
    ...(projectId ? { project_id: projectId } : {}),
  };

  const sync = req.query.sync === 'true';

  if (sync) {
    // Synchronous mode — await result and return trace data
    try {
      const { trace } = await runProactive(pool, trigger);
      console.log(`[FleetGraph] Proactive scan complete: ${trace.findings_count} findings in ${trace.duration_ms}ms`);
      res.json(trace);
    } catch (err) {
      console.error('[FleetGraph] Proactive scan failed:', err);
      res.status(500).json({ error: 'Proactive scan failed' });
    }
  } else {
    // Fire-and-forget mode (default — existing behavior)
    res.json({ status: 'started' });
    runProactive(pool, trigger)
      .then(({ trace }) => {
        console.log(`[FleetGraph] Proactive scan complete: ${trace.findings_count} findings in ${trace.duration_ms}ms`);
      })
      .catch(err => {
        console.error('[FleetGraph] Proactive scan failed:', err);
      });
  }
});
```

- [ ] **Step 2: Verify the server starts cleanly**

Run: `cd /Users/rohanthomas/ClaudeCode/ship && pnpm build:shared && pnpm dev:api`
Expected: Server starts on port 3000 without errors. Stop it after confirming.

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/fleetgraph.ts
git commit -m "feat(fleetgraph): add sync and project_id params to /run endpoint"
```

---

## Task 4: Refactor seed into isolated projects

**Files:**
- Modify: `api/src/db/seed-fleetgraph.ts`

This is the largest task. The goal is to restructure the seed so each proactive test case has its own project with only its relevant signals. Key changes:

1. Move the `DELETE FROM fleetgraph_insights` and `DELETE FROM fleetgraph_state` to run BEFORE any inserts (currently runs after HITL inserts, deleting them)
2. Create 5 isolated projects instead of 1 combined project
3. Each project gets its own sprint(s) — no sharing

- [ ] **Step 1: Move cleanup to the top of the seed function**

Move the insight/state cleanup (currently at lines 654-665) to run right after fetching workspace + users, BEFORE any scenario inserts. Add this after the `console.log` for users (line 58):

```typescript
// ========================================================
// Clear old FleetGraph data (must run BEFORE creating test data)
// ========================================================

const deleted = await pool.query(
  `DELETE FROM fleetgraph_insights WHERE workspace_id = $1 RETURNING id`,
  [workspaceId]
);
console.log(`\n🧹 Cleared ${deleted.rowCount} existing FleetGraph insights`);

await pool.query(
  `DELETE FROM fleetgraph_state WHERE workspace_id = $1`,
  [workspaceId]
);
console.log('🧹 Cleared FleetGraph state\n');
```

Remove the same block from the bottom of the function (lines 654-665).

- [ ] **Step 2: Create the shared program (unchanged)**

Keep the existing program creation as-is — all test projects share one program.

- [ ] **Step 3: Refactor Scenario A (Ghost Blockers) into isolated project**

Replace the existing Scenario A code. The ghost blocker project must have:
- Its own project: `FG-Ghost: Ghost Blocker Project`
- Its own sprint with approved plan
- 2 stale issues (7d high, 4d medium), 1 fresh, 1 done (controls)
- NO blocker chains, NO collapse conditions

```typescript
// ========================================================
// Project 1: Ghost Blockers (isolated)
// ========================================================

console.log('\n📌 Project 1: Ghost Blocker Project');

const ghostProjectId = await upsertDocument(pool, workspaceId, {
  type: 'project',
  title: 'FG-Ghost: Ghost Blocker Project',
  properties: {
    color: '#ef4444',
    owner_id: users[1]?.id || users[0].id,
    impact: 4, confidence: 3, ease: 3,
  },
});
await upsertAssociation(pool, ghostProjectId, programId, 'program');
console.log(`  Project: ${ghostProjectId}`);

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

// Stale issue 1: 7 days — HIGH severity
const staleIssue1 = await upsertDocument(pool, workspaceId, {
  type: 'issue',
  title: 'FG-Ghost: Implement OAuth flow',
  properties: { state: 'in_progress', priority: 'high', assignee_id: users[1]?.id || users[0].id, estimate: 5 },
});
await pool.query(`UPDATE documents SET updated_at = NOW() - INTERVAL '7 days' WHERE id = $1`, [staleIssue1]);
await upsertAssociation(pool, staleIssue1, ghostSprintId, 'sprint');
await upsertAssociation(pool, staleIssue1, ghostProjectId, 'project');
console.log(`  Stale issue (7d): ${staleIssue1}`);

// Stale issue 2: 4 days — MEDIUM severity
const staleIssue2 = await upsertDocument(pool, workspaceId, {
  type: 'issue',
  title: 'FG-Ghost: Fix login redirect',
  properties: { state: 'in_progress', priority: 'medium', assignee_id: users[2]?.id || users[0].id, estimate: 3 },
});
await pool.query(`UPDATE documents SET updated_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [staleIssue2]);
await upsertAssociation(pool, staleIssue2, ghostSprintId, 'sprint');
await upsertAssociation(pool, staleIssue2, ghostProjectId, 'project');
console.log(`  Stale issue (4d): ${staleIssue2}`);

// Fresh issue (control — should NOT flag)
const freshIssue = await upsertDocument(pool, workspaceId, {
  type: 'issue',
  title: 'FG-Ghost: Add unit tests',
  properties: { state: 'in_progress', priority: 'medium', assignee_id: users[0].id, estimate: 2 },
});
await upsertAssociation(pool, freshIssue, ghostSprintId, 'sprint');
await upsertAssociation(pool, freshIssue, ghostProjectId, 'project');

// Done issue (control — should NOT flag even if old)
const doneIssue = await upsertDocument(pool, workspaceId, {
  type: 'issue',
  title: 'FG-Ghost: Setup CI pipeline',
  properties: { state: 'done', priority: 'high', assignee_id: users[0].id, estimate: 3 },
});
await pool.query(`UPDATE documents SET updated_at = NOW() - INTERVAL '10 days' WHERE id = $1`, [doneIssue]);
await upsertAssociation(pool, doneIssue, ghostSprintId, 'sprint');
await upsertAssociation(pool, doneIssue, ghostProjectId, 'project');
```

- [ ] **Step 4: Create isolated Sprint Collapse project**

The collapse project must produce ONLY a medium-severity sprint collapse finding. Use ~50% elapsed, 1/6 done to stay at medium. All issues must be recently updated (no ghost blockers).

```typescript
// ========================================================
// Project 2: Sprint Collapse (isolated)
// ========================================================

console.log('\n📌 Project 2: Sprint Collapse Project');

const collapseProjectId = await upsertDocument(pool, workspaceId, {
  type: 'project',
  title: 'FG-Collapse: Sprint Collapse Project',
  properties: {
    color: '#f59e0b',
    owner_id: users[1]?.id || users[0].id,
    impact: 4, confidence: 3, ease: 3,
  },
});
await upsertAssociation(pool, collapseProjectId, programId, 'program');
console.log(`  Project: ${collapseProjectId}`);

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

// 6 issues: 1 done, 5 not done. All recently updated (no ghost blockers)
const collapseIssues = [
  { title: 'FG-Collapse: API design', state: 'done', estimate: 3 },
  { title: 'FG-Collapse: Frontend forms', state: 'in_progress', estimate: 5 },
  { title: 'FG-Collapse: Validation logic', state: 'in_progress', estimate: 3 },
  { title: 'FG-Collapse: Error handling', state: 'todo', estimate: 2 },
  { title: 'FG-Collapse: Integration tests', state: 'todo', estimate: 3 },
  { title: 'FG-Collapse: Deploy pipeline', state: 'todo', estimate: 2 },
];

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
  await upsertAssociation(pool, issueId, collapseSprintId, 'sprint');
  await upsertAssociation(pool, issueId, collapseProjectId, 'project');
  // Keep updated_at as NOW() — no ghost blockers
}
console.log(`  Collapse sprint: ${collapseSprintId} — 1/6 done`);
```

- [ ] **Step 5: Create isolated Blocker Chain + HITL project**

The chain project has a root blocker blocking 4 children. Root is also stale (for compound insight). HITL insight is created AFTER the cleanup step.

```typescript
// ========================================================
// Project 3: Blocker Chain + HITL (isolated)
// ========================================================

console.log('\n📌 Project 3: Blocker Chain Project');

const chainProjectId = await upsertDocument(pool, workspaceId, {
  type: 'project',
  title: 'FG-Chain: Blocker Chain Project',
  properties: {
    color: '#8b5cf6',
    owner_id: users[1]?.id || users[0].id,
    impact: 4, confidence: 3, ease: 3,
  },
});
await upsertAssociation(pool, chainProjectId, programId, 'program');
console.log(`  Project: ${chainProjectId}`);

const chainSprintId = await upsertDocument(pool, workspaceId, {
  type: 'sprint',
  title: `FG-Chain Sprint ${currentSprintNumber}`,
  properties: {
    sprint_number: currentSprintNumber,
    owner_id: users[1]?.id || users[0].id,
    status: 'active',
    confidence: 60,
    plan_approval: { state: 'approved', approved_by: users[0].id, approved_at: new Date().toISOString() },
  },
});
await upsertAssociation(pool, chainSprintId, chainProjectId, 'project');

// Root blocker — stale 5 days (also triggers ghost blocker = compound insight)
const rootBlocker = await upsertDocument(pool, workspaceId, {
  type: 'issue',
  title: 'FG-Chain: Design auth middleware',
  properties: { state: 'in_progress', priority: 'urgent', assignee_id: users[1]?.id || users[0].id, estimate: 8 },
});
await pool.query(`UPDATE documents SET updated_at = NOW() - INTERVAL '5 days' WHERE id = $1`, [rootBlocker]);
await upsertAssociation(pool, rootBlocker, chainSprintId, 'sprint');
await upsertAssociation(pool, rootBlocker, chainProjectId, 'project');
console.log(`  Root blocker: ${rootBlocker}`);

// 4 child issues blocked by root
const blockedTitles = [
  'FG-Chain: Implement token validation',
  'FG-Chain: Add session management',
  'FG-Chain: Build login UI',
  'FG-Chain: Write auth integration tests',
];
for (const title of blockedTitles) {
  const childId = await upsertDocument(pool, workspaceId, {
    type: 'issue',
    title,
    properties: { state: 'todo', priority: 'high', assignee_id: users[2]?.id || users[0].id, estimate: 3 },
  });
  await upsertAssociation(pool, childId, rootBlocker, 'parent');
  await upsertAssociation(pool, childId, chainSprintId, 'sprint');
  await upsertAssociation(pool, childId, chainProjectId, 'project');
}
console.log(`  4 blocked children created`);

// Pre-seed HITL insight with proposed comment action
const commentInsightId = uuid();
await pool.query(
  `INSERT INTO fleetgraph_insights
    (id, workspace_id, entity_id, entity_type, severity, category, title, content,
     proposed_action, status, created_at, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW(), NOW())
   ON CONFLICT (id) DO NOTHING`,
  [
    commentInsightId, workspaceId, rootBlocker, 'issue', 'high', 'blocker_chain',
    'HITL: Blocker chain needs attention',
    JSON.stringify({ description: '"Design auth middleware" blocking 4 issues. Assignee may be stuck.', confidence: 1.0 }),
    JSON.stringify({
      type: 'comment', entity_id: rootBlocker, entity_type: 'issue',
      payload: { content: 'This issue is blocking 4 downstream tasks. Are you stuck? Can we pair or reassign?' },
      description: 'Post follow-up comment on root blocker',
    }),
  ]
);
console.log(`  HITL comment insight: ${commentInsightId}`);
```

- [ ] **Step 6: Create isolated Standup & Planning project**

This project holds the standup activity data and the planning sprint. Issues are all recently updated (no ghost blockers).

```typescript
// ========================================================
// Project 4: Standup & Planning (isolated)
// ========================================================

console.log('\n📌 Project 4: Standup & Planning Project');

const activityProjectId = await upsertDocument(pool, workspaceId, {
  type: 'project',
  title: 'FG-Activity: Standup & Planning Project',
  properties: {
    color: '#22c55e',
    owner_id: users[0].id,
    impact: 4, confidence: 4, ease: 4,
  },
});
await upsertAssociation(pool, activityProjectId, programId, 'program');
console.log(`  Project: ${activityProjectId}`);

// Standup sprint (active, with recent activity)
const standupSprintId = await upsertDocument(pool, workspaceId, {
  type: 'sprint',
  title: `FG-Activity Sprint ${currentSprintNumber}`,
  properties: {
    sprint_number: currentSprintNumber,
    owner_id: users[0].id,
    status: 'active',
    confidence: 80,
    plan_approval: { state: 'approved', approved_by: users[0].id, approved_at: new Date().toISOString() },
  },
});
await upsertAssociation(pool, standupSprintId, activityProjectId, 'project');

// Standup issues with yesterday's activity
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
console.log(`  Standup sprint: ${standupSprintId}`);

// Planning sprint (status: planning, no issues assigned yet)
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

// Set capacity on team members
for (let i = 0; i < Math.min(users.length, 3); i++) {
  const u = users[i]!;
  if (u.person_doc_id) {
    await pool.query(
      `UPDATE documents SET properties = properties || '{"capacity_hours": 20}'::jsonb WHERE id = $1`,
      [u.person_doc_id]
    );
  }
}

// Backlog issues (associated with project but NOT any sprint)
const backlogIssues = [
  { title: 'FG-Backlog: Urgent security patch', priority: 'urgent', estimate: 3, due: 5 },
  { title: 'FG-Backlog: API rate limiting', priority: 'high', estimate: 5, due: null },
  { title: 'FG-Backlog: Dashboard redesign', priority: 'high', estimate: 8, due: 14 },
  { title: 'FG-Backlog: Fix email templates', priority: 'medium', estimate: 2, due: 7 },
  { title: 'FG-Backlog: Add export feature', priority: 'medium', estimate: 5, due: null },
  { title: 'FG-Backlog: Update onboarding flow', priority: 'medium', estimate: 3, due: null },
  { title: 'FG-Backlog: Improve search perf', priority: 'high', estimate: 5, due: null },
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
  await upsertAssociation(pool, issueId, activityProjectId, 'project');
}
console.log(`  ${backlogIssues.length} backlog issues created`);

// Carryover issues (in previous sprint, not done)
const carryoverIssues = [
  { title: 'FG-Carryover: Unfinished login flow', priority: 'high', estimate: 5 },
  { title: 'FG-Carryover: Incomplete tests', priority: 'medium', estimate: 3 },
];
for (const iss of carryoverIssues) {
  const issueId = await upsertDocument(pool, workspaceId, {
    type: 'issue',
    title: iss.title,
    properties: {
      state: 'in_progress', priority: iss.priority, estimate: iss.estimate, assignee_id: users[0].id,
    },
  });
  await upsertAssociation(pool, issueId, standupSprintId, 'sprint'); // Previous sprint
  await upsertAssociation(pool, issueId, activityProjectId, 'project');
}
console.log(`  ${carryoverIssues.length} carryover issues`);
```

- [ ] **Step 7: Update the summary output and write IDs to JSON file**

Replace the summary section at the bottom. Output IDs to console AND write a JSON file that the test runner reads (avoids needing to query the API for IDs):

```typescript
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
  // Include one issue ID per project for the "touch" step
  ghostTouchIssueId: freshIssue, // Fresh issue in ghost project (safe to touch)
  collapseTouchIssueId: collapseIssues[1]?.id, // Will be set below
  chainTouchIssueId: rootBlocker,
};

// Write IDs to JSON for the test runner to consume
const idsPath = join(__dirname, '../../scripts/fleetgraph-test-ids.json');
const { writeFileSync } = await import('fs');
writeFileSync(idsPath, JSON.stringify(testIds, null, 2));
console.log(`\n📄 Test IDs written to: ${idsPath}`);

console.log('\n✅ FleetGraph test data seeded successfully!\n');
console.log('  Workspace ID:', workspaceId);
console.log('  --- Proactive Test Projects ---');
console.log('  Ghost Project:', ghostProjectId);
console.log('  Collapse Project:', collapseProjectId);
console.log('  Chain Project:', chainProjectId);
console.log('  --- On-Demand Test Data ---');
console.log('  Activity Project:', activityProjectId);
console.log('  Standup Sprint:', standupSprintId);
console.log('  Planning Sprint:', planningSprintId);
console.log('  HITL Insight:', commentInsightId);
```

**Note:** To capture the collapse touch issue ID, save the first in_progress issue ID from the collapse loop. Change the collapse loop to store it:

```typescript
let collapseTouchIssueId = '';
for (const iss of collapseIssues) {
  const issueId = await upsertDocument(pool, workspaceId, { /* ... */ });
  if (!collapseTouchIssueId && iss.state !== 'done') collapseTouchIssueId = issueId;
  // ... rest of loop
}
```

Then use `collapseTouchIssueId` in the `testIds` object instead of `collapseIssues[1]?.id`.

- [ ] **Step 8: Remove old scenarios and duplicate cleanup block**

Delete the old Scenario A-H code and the cleanup block at the bottom (lines 654-665, which was moved to the top). Keep the `upsertDocument` and `upsertAssociation` helpers unchanged.

- [ ] **Step 9: Run the seed to verify**

```bash
cd /Users/rohanthomas/ClaudeCode/ship && npx tsx api/src/db/seed-fleetgraph.ts
```

Expected: Clean output with all project/sprint IDs printed. No errors.

- [ ] **Step 10: Run unit tests**

Run: `cd /Users/rohanthomas/ClaudeCode/ship && pnpm test`
Expected: All tests pass (seed changes don't affect unit tests)

- [ ] **Step 11: Commit**

```bash
git add api/src/db/seed-fleetgraph.ts
git commit -m "refactor(fleetgraph): isolate seed into per-scenario projects for test evidence"
```

---

## Task 5: Create the test runner script

**Files:**
- Create: `scripts/run-test-cases.ts`

- [ ] **Step 1: Create the test runner**

Create `scripts/run-test-cases.ts`:

```typescript
/**
 * FleetGraph Test Case Runner
 *
 * Runs all 5 test cases, captures trace data, and outputs a markdown table
 * for FLEETGRAPH.md.
 *
 * Prerequisites:
 *   1. pnpm dev (API server running on localhost:3000)
 *   2. npx tsx api/src/db/seed-fleetgraph.ts (seed data populated)
 *
 * Usage: npx tsx scripts/run-test-cases.ts
 */

const API = 'http://localhost:3000';

interface TestResult {
  name: string;
  success: boolean;
  trace?: { nodes_executed: string[]; findings_count: number; duration_ms: number };
  chatResponse?: string;
  error?: string;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error(`Login failed for ${email}: no cookie returned`);
  const match = cookie.match(/connect\.sid=[^;]+/);
  if (!match) throw new Error(`Login failed for ${email}: no connect.sid in cookie`);
  return match[0];
}

function loadTestIds(): Record<string, string> {
  // Read IDs from the JSON file written by seed-fleetgraph.ts
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const idsPath = join(__dirname, 'fleetgraph-test-ids.json');
  try {
    return JSON.parse(readFileSync(idsPath, 'utf-8'));
  } catch {
    throw new Error(`Test IDs file not found at ${idsPath}. Run: npx tsx api/src/db/seed-fleetgraph.ts`);
  }
}

async function touchIssue(cookie: string, issueId: string): Promise<void> {
  // No-op PATCH to bump updated_at, ensuring fetchActivity sees recent activity
  const res = await fetch(`${API}/api/documents/${issueId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ properties: {} }), // Empty properties update bumps updated_at
  });
  if (!res.ok) {
    console.warn(`  ⚠️  Touch failed for ${issueId}: ${res.status}`);
  }
}

async function runProactiveScan(cookie: string, projectId: string): Promise<TestResult['trace']> {
  const res = await fetch(`${API}/api/fleetgraph/run?project_id=${projectId}&sync=true`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  if (!res.ok) throw new Error(`Proactive scan failed: ${res.status} ${await res.text()}`);
  return await res.json() as TestResult['trace'];
}

async function runChat(
  cookie: string,
  entityType: string,
  entityId: string,
  message: string
): Promise<{ trace: TestResult['trace']; message: string }> {
  const res = await fetch(`${API}/api/fleetgraph/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ entity_type: entityType, entity_id: entityId, message }),
  });
  if (!res.ok) throw new Error(`Chat failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return { trace: data.trace, message: data.message };
}

async function approveInsight(cookie: string, insightId: string): Promise<any> {
  const res = await fetch(`${API}/api/fleetgraph/insights/${insightId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  });
  if (!res.ok) throw new Error(`Approve failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function main() {
  console.log('🧪 FleetGraph Test Case Runner\n');
  const results: TestResult[] = [];
  let exitCode = 0;

  // 1. Authenticate
  console.log('🔑 Authenticating...');
  let cookie: string;
  try {
    cookie = await login('dev@ship.local', 'admin123');
    console.log('  Authenticated as dev@ship.local\n');
  } catch (err) {
    console.error('❌ Authentication failed:', err);
    process.exit(1);
  }

  // 2. Load project/sprint IDs from seed output
  console.log('📋 Loading seed data IDs...');
  const ids = loadTestIds();
  console.log('  Ghost Project:', ids.ghostProjectId || '❌ NOT FOUND');
  console.log('  Collapse Project:', ids.collapseProjectId || '❌ NOT FOUND');
  console.log('  Chain Project:', ids.chainProjectId || '❌ NOT FOUND');
  console.log('  Standup Sprint:', ids.standupSprintId || '❌ NOT FOUND');
  console.log('  Planning Sprint:', ids.planningSprintId || '❌ NOT FOUND');
  console.log('  HITL Insight:', ids.commentInsightId || '❌ NOT FOUND');
  console.log();

  // 3. Run test cases
  const testCases = [
    {
      name: 'TC1: Ghost Blocker (Proactive)',
      run: async () => {
        await touchIssue(cookie, ids.ghostTouchIssueId!);
        return { trace: await runProactiveScan(cookie, ids.ghostProjectId!) };
      },
      requiredId: ids.ghostProjectId,
    },
    {
      name: 'TC2: Sprint Collapse (Proactive)',
      run: async () => {
        await touchIssue(cookie, ids.collapseTouchIssueId!);
        return { trace: await runProactiveScan(cookie, ids.collapseProjectId!) };
      },
      requiredId: ids.collapseProjectId,
    },
    {
      name: 'TC3: Blocker Chain + HITL (Proactive)',
      run: async () => {
        await touchIssue(cookie, ids.chainTouchIssueId!);
        const trace = await runProactiveScan(cookie, ids.chainProjectId!);
        // Approve HITL insight
        if (ids.commentInsightId) {
          console.log('    Approving HITL insight...');
          const result = await approveInsight(cookie, ids.commentInsightId);
          console.log('    HITL result:', JSON.stringify(result));
        }
        return { trace };
      },
      requiredId: ids.chainProjectId,
    },
    {
      name: 'TC4: Standup Draft (On-Demand)',
      run: async () => {
        const result = await runChat(cookie, 'sprint', ids.standupSprintId!, 'draft my standup');
        return { trace: result.trace, chatResponse: result.message };
      },
      requiredId: ids.standupSprintId,
    },
    {
      name: 'TC5: Sprint Planning (On-Demand)',
      run: async () => {
        const result = await runChat(cookie, 'sprint', ids.planningSprintId!, 'help me plan this sprint');
        return { trace: result.trace, chatResponse: result.message };
      },
      requiredId: ids.planningSprintId,
    },
  ];

  for (const tc of testCases) {
    console.log(`▶️  ${tc.name}`);
    if (!tc.requiredId) {
      console.log('  ⚠️  SKIPPED — required ID not found in seed data\n');
      results.push({ name: tc.name, success: false, error: 'Required ID not found' });
      exitCode = 1;
      continue;
    }
    try {
      const { trace, chatResponse } = await tc.run();
      console.log(`  ✅ ${trace?.findings_count ?? 0} findings, ${trace?.duration_ms ?? 0}ms`);
      console.log(`  Nodes: ${trace?.nodes_executed?.join(' → ') ?? 'N/A'}`);
      if (chatResponse) {
        console.log(`  Response preview: ${chatResponse.slice(0, 120)}...`);
      }
      results.push({ name: tc.name, success: true, trace, chatResponse });
    } catch (err: any) {
      console.log(`  ❌ FAILED: ${err.message}`);
      results.push({ name: tc.name, success: false, error: err.message });
      exitCode = 1;
    }
    console.log();
  }

  // 4. Output markdown table
  console.log('═'.repeat(70));
  console.log('📋 FLEETGRAPH.md Test Cases Table (copy-paste this):\n');
  console.log('| # | Ship State | Expected Output | Trace Link |');
  console.log('|---|-----------|----------------|------------|');
  const descriptions = [
    { state: 'Project with 2 stale in_progress issues (7d, 4d). Controls present.', output: 'Ghost Blocker findings (high + medium). Controls NOT flagged.' },
    { state: 'Sprint ~50% elapsed, 1/6 issues done.', output: 'Sprint Collapse finding (medium). Projected miss.' },
    { state: 'Parent issue blocking 4 children. Root stale 5d.', output: 'Blocker Chain + Ghost Blocker. Compound insight. HITL: comment approved.' },
    { state: 'Sprint with 5 issues transitioned yesterday. "draft my standup"', output: 'Standup: Yesterday/Today/Risks sections.' },
    { state: 'Planning sprint, 10 backlog + 2 carryover. "help me plan"', output: 'Ranked sprint plan fitted to 60h capacity.' },
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const d = descriptions[i]!;
    const status = r.success ? '[View trace](PASTE_LANGSMITH_LINK_HERE)' : `❌ ${r.error}`;
    console.log(`| ${i + 1} | ${d.state} | ${d.output} | ${status} |`);
  }

  console.log('\n📌 Next steps:');
  console.log('  1. Open LangSmith: https://smith.langchain.com/');
  console.log('  2. Go to project "fleetgraph"');
  console.log('  3. Find the 5 most recent traces');
  console.log('  4. For each: Share → Make Public → Copy link');
  console.log('  5. Replace PASTE_LANGSMITH_LINK_HERE in the table above');
  console.log('  6. Paste the table into FLEETGRAPH.md under "Test Cases"');

  process.exit(exitCode);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script compiles**

Run: `cd /Users/rohanthomas/ClaudeCode/ship && npx tsc --noEmit scripts/run-test-cases.ts`
Expected: No TypeScript errors. (Note: `tsx` does not support `--check`, use `tsc` instead.)

- [ ] **Step 3: Add `fleetgraph-test-ids.json` to `.gitignore`**

Append to `.gitignore`:
```
# FleetGraph test runner (generated by seed)
scripts/fleetgraph-test-ids.json
```

- [ ] **Step 4: Commit**

```bash
git add scripts/run-test-cases.ts .gitignore
git commit -m "feat(fleetgraph): add test case runner script for final submission evidence"
```

---

## Task 6: End-to-end verification

- [ ] **Step 1: Start the dev server**

Run: `cd /Users/rohanthomas/ClaudeCode/ship && pnpm dev`

- [ ] **Step 2: Run the seed**

In a new terminal:
```bash
cd /Users/rohanthomas/ClaudeCode/ship && npx tsx api/src/db/seed-fleetgraph.ts
```
Expected: All project/sprint IDs printed, no errors.

- [ ] **Step 3: Run the test cases**

```bash
cd /Users/rohanthomas/ClaudeCode/ship && npx tsx scripts/run-test-cases.ts
```

Expected:
- TC1: 2+ findings (ghost blockers), nodes include `draft_artifact`
- TC2: 1 finding (sprint collapse), nodes do NOT include `draft_artifact`
- TC3: 2+ findings (chain + ghost), nodes include `reason_compound_insight`
- TC4: Response includes Yesterday/Today/Risks, nodes include `generate_standup_draft`
- TC5: Response includes ranked plan, nodes include `generate_sprint_plan`
- Markdown table output at the end

- [ ] **Step 4: Collect LangSmith trace links**

1. Open https://smith.langchain.com/
2. Navigate to project "fleetgraph"
3. Find the 5 most recent traces
4. For each trace: Share → Make Public → Copy link

- [ ] **Step 5: Update FLEETGRAPH.md**

Paste the trace links into the Test Cases table in `FLEETGRAPH.md`. The table format matches the PRD template:

```markdown
| # | Ship State | Expected Output | Trace Link |
|---|-----------|----------------|------------|
| 1 | Project with 2 stale in_progress issues (7d, 4d). Controls present. | Ghost Blocker findings (high + medium). Controls NOT flagged. Health < 80. | [View trace](https://smith.langchain.com/public/...) |
| 2 | Sprint ~50% elapsed, 1/6 issues done. | Sprint Collapse finding (medium). Projected miss ~2 days. | [View trace](https://smith.langchain.com/public/...) |
| 3 | Parent issue blocking 4 children. Root stale 5d. | Blocker Chain (high) + Ghost Blocker. Compound insight. HITL: comment approved → posted. | [View trace](https://smith.langchain.com/public/...) |
| 4 | Sprint with 5 issues transitioned yesterday. User asks "draft my standup". | Standup: Yesterday/Today/Risks sections. | [View trace](https://smith.langchain.com/public/...) |
| 5 | Planning sprint with 10 backlog + 2 carryover. "help me plan this sprint". | Ranked sprint plan fitted to 60h capacity. | [View trace](https://smith.langchain.com/public/...) |
```

- [ ] **Step 6: Commit final FLEETGRAPH.md update**

```bash
git add FLEETGRAPH.md
git commit -m "docs(fleetgraph): add test cases with LangSmith trace links for final submission"
```

- [ ] **Step 7: Run full test suite one final time**

Run: `cd /Users/rohanthomas/ClaudeCode/ship && pnpm test`
Expected: All tests pass. No regressions.
