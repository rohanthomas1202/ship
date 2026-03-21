# FleetGraph — Implementation Phases

*Master tracking document. Each phase is self-contained with implementation tasks, test steps, and seed data.*

---

## Phase Overview

| Phase | Focus | Tasks | Status |
|-------|-------|-------|--------|
| **Phase 1** | Deterministic Signal Detection | Ghost blocker + approval bottleneck + blocker chain pre-checks, insight deduplication | **Complete** |
| **Phase 2** | Pipeline Completeness | Fix on-demand accountability fetch, role detection from RACI | **Complete** |
| **Phase 3** | Health Score | Compute + persist + display project health scores | **Complete** |
| **Phase 4** | HITL Write Path | Approval UI, execute mutation backend, audit logging | **Complete** |
| **Phase 5** | Proactive Trigger | Cron/test harness, escalation logic | Not started |
| **Phase 6** | Sprint Collapse Predictor | Compound insight: velocity + blockers + time remaining | **Complete** |
| **Phase 7** | AI Standup Generator | Draft standups from observable activity | **Complete** |
| **Phase 8** | Smart Sprint Planning | On-demand backlog ranking + capacity fitting | Not started |
| **Phase 9** | Polish & Submission | LangSmith traces, e2e tests, documentation | Not started |

---

## Phase 1 — Deterministic Signal Detection

**Goal:** Add non-LLM detection for ghost blockers and approval bottlenecks. Add insight deduplication. This hardens the existing pipeline and reduces LLM dependency for obvious signals.

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 1.1 | Create `deterministic-signals.ts` with `detectGhostBlockers()` and `detectApprovalBottlenecks()` | `api/src/services/fleetgraph/deterministic-signals.ts` (new) | M |
| 1.2 | Integrate deterministic signals into `reasonHealthCheck` — run before Bedrock call, merge results | `api/src/services/fleetgraph/nodes-reasoning.ts` | S |
| 1.3 | Add insight deduplication in `surfaceInsight` — skip if same category+entity pending within 24h | `api/src/services/fleetgraph/nodes-action.ts` | S |
| 1.4 | Add `DeterministicSignal` type to shared types | `shared/src/types/fleetgraph.ts` | S |
| 1.5 | Create FleetGraph seed script with test scenarios (stale issues, pending approvals) | `api/src/db/seed-fleetgraph.ts` (new) | M |
| 1.6 | Write unit tests for deterministic signals | `api/src/services/fleetgraph/__tests__/deterministic-signals.test.ts` (new) | M |

### Seed Data Needed

The `seed-fleetgraph.ts` script creates specific test scenarios in the existing workspace:

**Scenario A — Ghost Blocker:**
- Issue "Implement OAuth flow" in `in_progress`, `updated_at` = 7 days ago, assigned to Alice Chen
- Issue "Fix login redirect" in `in_progress`, `updated_at` = 4 days ago, assigned to Bob Martinez
- Issue "Add unit tests" in `in_progress`, `updated_at` = 1 day ago (should NOT be flagged)

**Scenario B — Approval Bottleneck:**
- Sprint with `plan_approval: { state: 'changes_requested', approved_at: 5 days ago }`
- Sprint with `plan_approval: { state: null }` and `status: 'active'`, `started_at` = 4 days ago
- Sprint with `plan_approval: { state: 'approved' }` (should NOT be flagged)

**Scenario C — Clean Project:**
- Project with all issues in `done` or recently updated — should produce no findings

### Test Steps

After implementation, run these manual verification steps:

```bash
# 1. Build shared types
pnpm build:shared

# 2. Run unit tests
pnpm test -- --grep "deterministic"

# 3. Seed the FleetGraph test data
npx tsx api/src/db/seed-fleetgraph.ts

# 4. Start the dev server
pnpm dev

# 5. Trigger a proactive scan (replace WORKSPACE_ID with actual value from seed output)
curl -X POST http://localhost:3000/api/fleetgraph/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{"workspace_id": "WORKSPACE_ID"}'

# 6. Check insights were created
curl http://localhost:3000/api/fleetgraph/insights?entity_id=STALE_ISSUE_PROJECT_ID \
  -H "Cookie: <session_cookie>"

# Expected results:
# - Ghost blocker insight for "Implement OAuth flow" (severity: high, 7 days stale)
# - Ghost blocker insight for "Fix login redirect" (severity: medium, 4 days stale)
# - Approval bottleneck insight for the sprint with changes_requested
# - NO insight for "Add unit tests" (updated yesterday)
# - NO insight for the approved sprint
# - NO duplicate insights if run twice
```

### Test Checklist

- [ ] `detectGhostBlockers` flags issues in_progress > 3 business days
- [ ] `detectGhostBlockers` ignores issues updated within 3 business days
- [ ] `detectGhostBlockers` ignores issues in done/cancelled state
- [ ] `detectGhostBlockers` uses document_history for accurate last activity
- [ ] `detectGhostBlockers` assigns high severity for 7+ days, medium for 3-7 days
- [ ] `detectApprovalBottlenecks` flags plan_approval changes_requested > 2 business days
- [ ] `detectApprovalBottlenecks` flags active sprint with null plan_approval > 2 business days
- [ ] `detectApprovalBottlenecks` ignores completed sprints
- [ ] `detectApprovalBottlenecks` ignores approved sprints
- [ ] Insight deduplication: running proactive scan twice produces no duplicate insights
- [ ] Deterministic signals merge correctly with LLM findings (no duplicates)
- [ ] Business day calculation skips weekends correctly

### Commit Message

```
feat(fleetgraph): add deterministic signal detection for ghost blockers and approval bottlenecks

Add non-LLM pre-checks that mechanically detect obvious health signals
before the Bedrock reasoning call. Includes insight deduplication to
prevent duplicate findings across proactive cycles.
```

---

## Phase 2 — Pipeline Completeness

**Goal:** Fix missing data fetches and add role detection so the pipeline produces complete, role-aware results.

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 2.1 | Add `fetchAccountability` to `runOnDemand` parallel fetch array | `api/src/services/fleetgraph/graph-executor.ts` | S |
| 2.2 | Implement actual accountability fetch (currently returns state unchanged) | `api/src/services/fleetgraph/nodes-fetch.ts` | M |
| 2.3 | Create `role-detection.ts` with `detectUserRole()` | `api/src/services/fleetgraph/role-detection.ts` (new) | M |
| 2.4 | Integrate role detection into `reasonQueryResponse` prompt | `api/src/services/fleetgraph/nodes-reasoning.ts` | S |
| 2.5 | Add `DetectedRole` type to shared types | `shared/src/types/fleetgraph.ts` | S |
| 2.6 | Seed data: ensure projects have owner_id and programs have accountable_id | `api/src/db/seed-fleetgraph.ts` (update) | S |
| 2.7 | Write unit tests for role detection | `api/src/services/fleetgraph/__tests__/role-detection.test.ts` (new) | M |

### Seed Data Needed

Update `seed-fleetgraph.ts` to ensure:
- Project "Ship Core - Core Features" has `owner_id` = Dev User (PM role)
- Program "Ship Core" has `accountable_id` = Dev User (Director role)
- Issues assigned to specific users (Engineer role)

### Test Steps

```bash
# 1. Build and test
pnpm build:shared && pnpm test -- --grep "role-detection"

# 2. Re-seed
npx tsx api/src/db/seed-fleetgraph.ts

# 3. Start dev server and test on-demand chat
pnpm dev

# 4. Test role-aware chat response (as PM/owner)
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: <session_cookie>" \
  -d '{
    "entity_type": "project",
    "entity_id": "PROJECT_ID",
    "message": "How is this project doing?"
  }'

# Expected: Response should be operational (sprint status, blockers, who to follow up with)
# NOT strategic (health score trends, portfolio comparison)

# 5. Test that accountability items are now included in on-demand context
# Check server logs for "fetch_accountability" in node trace
```

### Test Checklist

- [ ] `fetchAccountability` is called in `runOnDemand` (check trace output)
- [ ] `detectUserRole` returns 'director' when user is program accountable_id
- [ ] `detectUserRole` returns 'pm' when user is project owner_id
- [ ] `detectUserRole` returns 'engineer' when user is issue assignee_id
- [ ] `detectUserRole` falls back to workspace role when no RACI match
- [ ] Chat response tone changes based on detected role
- [ ] On-demand queries include accountability context in reasoning

### Commit Message

```
feat(fleetgraph): add role detection and complete on-demand pipeline

Implement RACI-based role detection (director/pm/engineer) for role-aware
chat responses. Fix missing fetchAccountability in on-demand pipeline.
```

---

## Phase 3 — Health Score

**Goal:** Compute a 0-100 project health score from existing findings and persist it for display.

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 3.1 | Create `health-score.ts` with `computeHealthScore()` | `api/src/services/fleetgraph/health-score.ts` (new) | M |
| 3.2 | Integrate health score computation into proactive flow after surfaceInsight | `api/src/services/fleetgraph/graph-executor.ts` | S |
| 3.3 | Persist health score to `fleetgraph_state.health_score` column | `api/src/services/fleetgraph/health-score.ts` | S |
| 3.4 | Add GET endpoint for health scores: `GET /api/fleetgraph/health-scores` | `api/src/routes/fleetgraph.ts` | S |
| 3.5 | Include health score in chat response when entity is a project | `api/src/services/fleetgraph/nodes-reasoning.ts` | S |
| 3.6 | Add `HealthScoreInput` type | `shared/src/types/fleetgraph.ts` | S |
| 3.7 | Write unit tests for health score computation | `api/src/services/fleetgraph/__tests__/health-score.test.ts` (new) | M |

### Seed Data Needed

Extend seed to create:
- A "healthy" project: all issues done/recently updated, no blockers, approved plans → score ~85-100
- An "at risk" project: 2 ghost blockers, 1 approval pending, mild overload → score ~40-60
- A "critical" project: blocker chain, scope creep, overloaded assignee → score ~10-30

### Test Steps

```bash
# 1. Build and test
pnpm build:shared && pnpm test -- --grep "health-score"

# 2. Seed data
npx tsx api/src/db/seed-fleetgraph.ts

# 3. Run proactive scan
curl -X POST http://localhost:3000/api/fleetgraph/run \
  -H "Authorization: Bearer test-token" \
  -d '{"workspace_id": "WORKSPACE_ID"}'

# 4. Fetch health scores
curl http://localhost:3000/api/fleetgraph/health-scores?workspace_id=WORKSPACE_ID

# Expected:
# - Healthy project: overall score > 70
# - At-risk project: overall score 40-70
# - Critical project: overall score < 40
# - Sub-scores populated: velocity, blockers, workload, issue_freshness, approval_flow, accountability

# 5. Test health score in chat
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -d '{"entity_type": "project", "entity_id": "AT_RISK_PROJECT_ID", "message": "What is the health of this project?"}'
# Expected: Response includes health score breakdown
```

### Test Checklist

- [ ] Health score is 0-100 integer
- [ ] Sub-scores map correctly: ghost_blocker → issue_freshness, approval_bottleneck → approval_flow, etc.
- [ ] No findings = all sub-scores at 100
- [ ] High-severity finding reduces relevant sub-score significantly
- [ ] Score persisted to `fleetgraph_state.health_score` (verified via DB query)
- [ ] GET endpoint returns scores for all projects in workspace
- [ ] Chat response includes health score when asked about project health

### Commit Message

```
feat(fleetgraph): add project health score computation

Compute 0-100 composite health scores from detected signals with
6 sub-scores (velocity, blockers, workload, freshness, approvals,
accountability). Persist to fleetgraph_state and expose via API.
```

---

## Phase 4 — HITL Write Path

**Goal:** Complete the human-in-the-loop approval flow: UI buttons for approve/edit, backend mutation execution, audit logging.

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 4.1 | Create `execute-mutation.ts` — execute approved Ship API writes (comment, reassign, state_change) | `api/src/services/fleetgraph/execute-mutation.ts` (new) | M |
| 4.2 | Add `POST /api/fleetgraph/insights/:id/approve` endpoint | `api/src/routes/fleetgraph.ts` | M |
| 4.3 | Add audit logging for FleetGraph mutations (`automated_by = 'fleetgraph'`) | `api/src/routes/fleetgraph.ts` | S |
| 4.4 | Update `FleetGraphInsightCard.tsx` — add Approve/Edit buttons when `proposed_action` exists | `web/src/components/FleetGraphInsightCard.tsx` | M |
| 4.5 | Add `useApproveInsight` hook | `web/src/hooks/useFleetGraph.ts` | S |
| 4.6 | Add `MutationResult` type | `shared/src/types/fleetgraph.ts` | S |
| 4.7 | Write integration test for approve → execute flow | `api/src/services/fleetgraph/__tests__/execute-mutation.test.ts` (new) | M |

### Seed Data Needed

Extend seed to create:
- An insight with `proposed_action` of type `comment` (draft comment on stale issue)
- An insight with `proposed_action` of type `reassign` (move issue to less-loaded person)
- An insight with `proposed_action` of type `state_change` (revert to todo)

### Test Steps

```bash
# 1. Build
pnpm build:shared

# 2. Seed data with insights that have proposed_action
npx tsx api/src/db/seed-fleetgraph.ts

# 3. Start dev server
pnpm dev

# 4. Open Ship in browser, navigate to the project with insights
# 5. Open FleetGraph chat panel
# 6. Verify insight cards show Approve/Edit buttons for insights with proposed_action
# 7. Click "Approve" on a comment-type insight

# 8. Verify the comment was posted (check via API)
curl http://localhost:3000/api/documents/ISSUE_ID/comments

# 9. Verify audit log entry
# Check database: SELECT * FROM audit_logs WHERE automated_by = 'fleetgraph' ORDER BY created_at DESC;

# 10. Verify insight status changed to 'approved'
curl http://localhost:3000/api/fleetgraph/insights?status=approved

# 11. Test Edit flow: click Edit, modify the drafted comment, then Approve
# 12. Verify the modified content was posted
```

### Test Checklist

- [ ] Approve button visible only when `proposed_action` is present
- [ ] Clicking Approve calls POST /api/fleetgraph/insights/:id/approve
- [ ] Comment mutations create a real comment on the target document
- [ ] Reassign mutations update issue properties.assignee_id
- [ ] State change mutations update issue properties.state
- [ ] Insight status changes to 'approved' after execution
- [ ] Audit log entry created with `automated_by = 'fleetgraph'`
- [ ] Edit button opens inline editor for drafted content
- [ ] Edited content is used when approving after edit
- [ ] Failed mutations return error and do NOT change insight status

### Commit Message

```
feat(fleetgraph): implement HITL approval gate with mutation execution

Add approve/edit buttons to insight cards for proposed actions. Backend
executes approved mutations (comments, reassignments, state changes)
against Ship API with audit logging.
```

---

## Phase 5 — Proactive Trigger

**Goal:** Create a reliable way to trigger proactive scans on a schedule and add escalation for persistent findings.

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 5.1 | Create `scripts/run-fleetgraph.ts` — CLI script to trigger proactive scan | `scripts/run-fleetgraph.ts` (new) | S |
| 5.2 | Add escalation logic: if finding persists 2+ cycles and not viewed, escalate to accountable_id | `api/src/services/fleetgraph/nodes-action.ts` | M |
| 5.3 | Track finding persistence: add `cycle_count` to `fleetgraph_state.last_findings` | `api/src/services/fleetgraph/nodes-action.ts` | S |
| 5.4 | Add target_user_id assignment based on role/RACI for proactive insights | `api/src/services/fleetgraph/nodes-action.ts` | M |
| 5.5 | Write test for escalation behavior | `api/src/services/fleetgraph/__tests__/escalation.test.ts` (new) | M |

### Test Steps

```bash
# 1. Seed test data
npx tsx api/src/db/seed-fleetgraph.ts

# 2. Run proactive scan via script
npx tsx scripts/run-fleetgraph.ts --workspace-id WORKSPACE_ID

# Expected output:
# FleetGraph proactive scan complete
# Nodes executed: fetch_activity, fetch_issues, ...
# Findings: 3
# Insights created: 3
# Duration: 4200ms

# 3. Run again — insights should NOT duplicate
npx tsx scripts/run-fleetgraph.ts --workspace-id WORKSPACE_ID
# Expected: Insights created: 0 (deduplication working)

# 4. Simulate 2+ cycles without viewing
# Run the script 3 times, then check if escalation happened
npx tsx scripts/run-fleetgraph.ts --workspace-id WORKSPACE_ID
# Expected: Insight target_user_id changes to accountable_id (escalation)

# 5. Check that target_user_id is set on insights
SELECT id, title, target_user_id, status FROM fleetgraph_insights WHERE workspace_id = 'X';
```

### Commit Message

```
feat(fleetgraph): add proactive trigger script and finding escalation

Create CLI script for triggering proactive scans. Add escalation logic
that routes persistent findings to project accountable_id after 2+
unviewed cycles.
```

---

## Phase 6 — Sprint Collapse Predictor

**Goal:** Detect mid-sprint that a sprint is going to miss its deadline, combining velocity, blockers, and time remaining into a compound insight.

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 6.1 | Add `detectSprintCollapse()` to deterministic signals | `api/src/services/fleetgraph/deterministic-signals.ts` | M |
| 6.2 | Wire sprint collapse into health check and compound insight reasoning | `api/src/services/fleetgraph/nodes-reasoning.ts` | M |
| 6.3 | Add sprint date calculation utility (start/end from sprint_number + workspace) | `api/src/services/fleetgraph/deterministic-signals.ts` | S |
| 6.4 | Update health score: sprint_collapse findings reduce velocity sub-score | `api/src/services/fleetgraph/health-score.ts` | S |
| 6.5 | Seed a mid-sprint scenario with low completion rate | `api/src/db/seed-fleetgraph.ts` (update) | M |
| 6.6 | Write unit tests | `api/src/services/fleetgraph/__tests__/deterministic-signals.test.ts` (update) | M |

### Seed Data Needed

- Sprint with 8 issues total, only 2 completed, 1 day remaining
- Historical sprints (past 3) with ~80% completion rate (for velocity baseline)
- 1 blocker chain within the at-risk sprint (parent issue blocking 2 children)

### Test Steps

```bash
# 1. Seed sprint collapse scenario
npx tsx api/src/db/seed-fleetgraph.ts

# 2. Run proactive scan
npx tsx scripts/run-fleetgraph.ts --workspace-id WORKSPACE_ID

# Expected insight:
# Sprint Risk Detected
# At current completion rate, Sprint N will miss its deadline by ~X days.
# Root cause: [blocker chain / low velocity / scope creep]
# Recommendations: [descope / reassign / escalate]

# 3. Verify compound insight (sprint collapse + blocker chain = 1 insight, not 2)
curl http://localhost:3000/api/fleetgraph/insights?entity_id=SPRINT_ID
# Expected: 1 compound insight, not separate sprint_collapse + blocker_chain

# 4. Verify health score reflects sprint risk
curl http://localhost:3000/api/fleetgraph/health-scores?workspace_id=WORKSPACE_ID
# Expected: velocity sub-score < 50 for the affected project
```

### Commit Message

```
feat(fleetgraph): add sprint collapse predictor

Detect mid-sprint when completion rate vs. remaining time indicates the
sprint will miss its deadline. Combines with blocker chain and team load
data into compound recommendations.
```

---

## Phase 7 — AI Standup Generator

**Goal:** Auto-generate standup drafts from observable activity (issue transitions, completed work, blockers).

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 7.1 | Add standup generation to on-demand flow when user asks "draft my standup" or views standup | `api/src/services/fleetgraph/nodes-reasoning.ts` | M |
| 7.2 | Use existing `/api/claude/context?context_type=standup` for context assembly | `api/src/services/fleetgraph/nodes-fetch.ts` | S |
| 7.3 | Create draft standup document via Ship API | `api/src/services/fleetgraph/nodes-action.ts` | M |
| 7.4 | Update FleetGraphChat to show "Draft my standup" button when viewing sprint | `web/src/components/FleetGraphChat.tsx` | S |
| 7.5 | Write test for standup generation | `api/src/services/fleetgraph/__tests__/standup-gen.test.ts` (new) | M |

### Seed Data Needed

- Issues with state transitions in last 24h (via document_history):
  - 2 issues moved to `done` yesterday
  - 1 issue moved to `in_review`
  - 1 new blocker created
- Sprint with multiple active issues for "today's plan"

### Test Steps

```bash
# 1. Seed activity data
npx tsx api/src/db/seed-fleetgraph.ts

# 2. Test via chat
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -d '{"entity_type":"sprint","entity_id":"SPRINT_ID","message":"Draft my standup"}'

# Expected response format:
# Yesterday:
# • Completed Issue #42 (Implement auth flow)
# • Completed Issue #55 (Fix login redirect)
# • Moved Issue #67 to in_review
# • New blocker: Issue #78 (dependency on Issue #80)
#
# Today:
# • Focus on Issue #89 (highest priority, due Thursday)
# • Resolve blocker on Issue #78
#
# Risks:
# • Sprint velocity slowing — 4 issues remaining, 2 days left

# 3. Verify in browser: open sprint view, open FleetGraph, click "Draft my standup"
```

### Commit Message

```
feat(fleetgraph): add AI standup summary generator

Auto-generate standup drafts from observable activity (issue state
transitions, completions, blockers) using the existing claude context
API. Drafts are presented for review and editing, not auto-submitted.
```

---

## Phase 8 — Smart Sprint Planning

**Goal:** On-demand backlog ranking with capacity fitting for sprint planning.

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 8.1 | Add sprint planning intent detection in `reasonQueryResponse` | `api/src/services/fleetgraph/nodes-reasoning.ts` | M |
| 8.2 | Create `planSprint()` function: rank backlog by priority × dependency × carryover × due_date | `api/src/services/fleetgraph/nodes-reasoning.ts` | L |
| 8.3 | Fetch backlog issues (not in any active sprint) | `api/src/services/fleetgraph/nodes-fetch.ts` | S |
| 8.4 | Show "Help me plan" button when viewing sprint in planning status | `web/src/components/FleetGraphChat.tsx` | S |
| 8.5 | Write test for sprint planning recommendations | `api/src/services/fleetgraph/__tests__/sprint-planning.test.ts` (new) | M |

### Seed Data Needed

- Sprint in `planning` status with 0 issues
- Backlog: 15 issues with varying priorities, estimates, due dates
- 3 carryover issues from previous sprint (not completed)
- Team capacity_hours set on person documents

### Test Steps

```bash
# 1. Seed planning scenario
npx tsx api/src/db/seed-fleetgraph.ts

# 2. Test via chat
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -d '{"entity_type":"sprint","entity_id":"PLANNING_SPRINT_ID","message":"Help me plan this sprint"}'

# Expected:
# Recommended Sprint Plan (fitted to 40h capacity):
# 1. Issue #12 — Fix auth redirect (urgent, 3 pts, carryover from Sprint 31)
# 2. Issue #45 — API rate limiting (high, 5 pts, unblocks #67 and #78)
# 3. Issue #23 — Update docs (medium, 2 pts, due Friday)
# ...
# Total: 5 issues, 15 story points, estimated 35h

# 3. Verify in browser: open planning sprint, FleetGraph shows "Help me plan" button
```

### Commit Message

```
feat(fleetgraph): add smart sprint planning assistant

Rank backlog issues by priority, dependency-unblocking potential,
carryover status, and due date proximity. Fit recommendations to
team capacity for data-driven sprint planning.
```

---

## Phase 9 — Polish & Submission

**Goal:** Finalize traces, tests, documentation for submission readiness.

### Tasks

| # | Task | Files | Size |
|---|------|-------|------|
| 9.1 | Curate LangSmith traces: clean fast-path trace + full-analysis trace | Manual | S |
| 9.2 | Update FLEETGRAPH.md with final architecture, test cases, trace links | `FLEETGRAPH.md` | M |
| 9.3 | Run full integration test suite | `api/src/services/fleetgraph/__tests__/` | M |
| 9.4 | Verify all 8 signal types detect correctly with seeded data | Manual | M |
| 9.5 | Update cost analysis with actual token usage | `FLEETGRAPH.md` | S |
| 9.6 | Final code review: remove TODOs, clean up types, check error handling | All fleetgraph files | M |

### Test Steps

```bash
# Full verification sequence
pnpm build:shared
pnpm test -- --grep "fleetgraph"
npx tsx api/src/db/seed-fleetgraph.ts
npx tsx scripts/run-fleetgraph.ts --workspace-id WORKSPACE_ID
# Verify LangSmith traces at https://smith.langchain.com
# Verify all 8 signal types in insight output
# Verify health scores
# Verify on-demand chat works for issue/sprint/project/dashboard contexts
# Verify HITL approval flow end-to-end
```

### Commit Message

```
chore(fleetgraph): polish and submission readiness

Curate LangSmith traces, finalize documentation, run full integration
test suite, update cost analysis with actual usage data.
```

---

## Appendix: Seed Data Summary

The `seed-fleetgraph.ts` script creates all test scenarios incrementally. Each phase adds to it:

| Phase | Scenarios Added |
|-------|----------------|
| 1 | Ghost blockers (stale issues), approval bottlenecks (pending approvals), clean project |
| 2 | Projects with owner_id, programs with accountable_id (for RACI role detection) |
| 3 | Healthy/at-risk/critical projects (for health score ranges) |
| 4 | Insights with proposed_action (comment, reassign, state_change) |
| 5 | (Uses existing scenarios, run script multiple times for escalation) |
| 6 | Mid-sprint collapse scenario (low completion, blocker chain, 1 day remaining) |
| 7 | Recent activity (issue transitions in last 24h) for standup generation |
| 8 | Planning sprint with backlog, carryover, capacity_hours on persons |
