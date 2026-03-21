# FleetGraph — Complete Verification Guide

*Step-by-step manual verification for Phases 1–4.*

---

## Prerequisites

```bash
# 1. Ensure PostgreSQL is running locally
pg_isready

# 2. Build shared types
pnpm build:shared

# 3. Run all unit tests (should be 510 passing)
pnpm test
# Expected: 32 test files, 510 tests passed
# Key test files:
#   deterministic-signals.test.ts  (31 tests)
#   health-score.test.ts           (14 tests)
#   role-detection.test.ts         (7 tests)
#   execute-mutation.test.ts       (7 tests)

# 4. Seed base data (if not already done)
pnpm db:seed

# 5. Seed FleetGraph test data
npx tsx api/src/db/seed-fleetgraph.ts
```

Save the output from step 5. You'll need these IDs:
- `Workspace ID`
- `Test Project ID`
- `Healthy Project ID`
- `Ghost sprint ID`
- `Comment insight ID`
- `Reassign insight ID`
- `State change insight ID`

```bash
# 6. Start the dev server
pnpm dev
```

---

## Step 1: Authenticate

All API calls need a session cookie. Login first:

```bash
# Login as Dev User (director role)
curl -v -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "dev@ship.local", "password": "admin123"}' \
  2>&1 | grep -i 'set-cookie'
```

Copy the `connect.sid=...` value from the `Set-Cookie` header. Use it in all subsequent requests:

```bash
export COOKIE="connect.sid=YOUR_SESSION_ID_HERE"
```

Also login as Alice (PM role) and Bob (engineer role) for role detection tests:

```bash
# Login as Alice
curl -v -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "alice.chen@ship.local", "password": "admin123"}' \
  2>&1 | grep -i 'set-cookie'
export ALICE_COOKIE="connect.sid=ALICE_SESSION_ID_HERE"

# Login as Bob
curl -v -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "bob.martinez@ship.local", "password": "admin123"}' \
  2>&1 | grep -i 'set-cookie'
export BOB_COOKIE="connect.sid=BOB_SESSION_ID_HERE"
```

---

## Phase 1: Deterministic Signal Detection

### Test 1.1 — Proactive scan detects ghost blockers and approval bottlenecks

```bash
curl -X POST http://localhost:3000/api/fleetgraph/run \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE"
```

**Expected response:**
```json
{
  "findings_count": 5,
  "nodes_executed": [
    "fetch_activity",
    "fetch_issues", "fetch_sprint_detail", "fetch_team",
    "fetch_history",
    "reason_health_check",
    "reason_severity_triage",
    "...",
    "compute_health_score",
    "persist_narrative",
    "log_clean_run"
  ],
  "duration_ms": 3000,
  "errors": []
}
```

**Verify:** `findings_count` should be ≥ 3 (ghost blockers + approval bottlenecks + blocker chain).

### Test 1.2 — Insights were persisted

```bash
curl http://localhost:3000/api/fleetgraph/insights \
  -H "Cookie: $COOKIE" | python3 -m json.tool
```

**Expected:** Array of insights. Look for:
- [ ] Ghost Blocker insight for "Implement OAuth flow" (severity: high, 7+ days stale)
- [ ] Ghost Blocker insight for "Fix login redirect" (severity: low or medium)
- [ ] Ghost Blocker insight for "Design auth middleware" (also root of blocker chain)
- [ ] Approval Bottleneck for sprint with `changes_requested`
- [ ] Approval Bottleneck for sprint with null `plan_approval`
- [ ] Blocker Chain for "Design auth middleware" blocking 4 issues

**Verify NOT present:**
- [ ] No insight for "Add unit tests" (updated today)
- [ ] No insight for "Setup CI pipeline" (state = done)
- [ ] No insight for the sprint with approved plan

### Test 1.3 — Insight deduplication

Run the proactive scan again:

```bash
curl -X POST http://localhost:3000/api/fleetgraph/run \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE"
```

Then count insights:

```bash
curl http://localhost:3000/api/fleetgraph/insights \
  -H "Cookie: $COOKIE" | python3 -c "import sys,json; print('Count:', len(json.load(sys.stdin)['insights']))"
```

**Expected:** Same number of insights as before — no duplicates created.

### Test 1.4 — Verify in database directly

```bash
psql $DATABASE_URL -c "
  SELECT title, severity, category,
         content->>'confidence' as confidence,
         status, created_at
  FROM fleetgraph_insights
  WHERE title LIKE 'FG%' OR title LIKE 'Stale%' OR title LIKE 'Plan%' OR title LIKE 'Blocker%'
  ORDER BY severity, created_at;
"
```

**Check:**
- [ ] `confidence` is `1` for deterministic findings (not `0.3` or `0.7`)
- [ ] `category` matches signal type (ghost_blocker, approval_bottleneck, blocker_chain)

---

## Phase 2: Pipeline Completeness

### Test 2.1 — On-demand chat includes accountability and role detection

```bash
# As Dev User (should be detected as director via program.accountable_id)
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "entity_type": "project",
    "entity_id": "TEST_PROJECT_ID",
    "message": "How is this project doing?"
  }' | python3 -m json.tool
```

**Expected in response:**
- [ ] `trace.nodes_executed` includes `"fetch_accountability"`
- [ ] `trace.nodes_executed` includes `"detect_role"`
- [ ] `message` uses strategic language (health scores, portfolio, resource allocation)
  because Dev User is a director

### Test 2.2 — PM role detection

```bash
# As Alice (should be detected as PM via project.owner_id)
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: $ALICE_COOKIE" \
  -d '{
    "entity_type": "project",
    "entity_id": "TEST_PROJECT_ID",
    "message": "How is this project doing?"
  }' | python3 -m json.tool
```

**Expected:**
- [ ] `message` uses operational language (sprint status, blockers, follow-ups, approvals)

### Test 2.3 — Engineer role detection

```bash
# As Bob (should be detected as engineer via issue.assignee_id)
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: $BOB_COOKIE" \
  -d '{
    "entity_type": "sprint",
    "entity_id": "GHOST_SPRINT_ID",
    "message": "What should I work on next?"
  }' | python3 -m json.tool
```

**Expected:**
- [ ] `message` focuses on personal assignments, task prioritization, dependencies

### Test 2.4 — Chat includes findings from background health check

```bash
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "entity_type": "sprint",
    "entity_id": "GHOST_SPRINT_ID",
    "message": "Are there any blockers?"
  }' | python3 -m json.tool
```

**Expected:**
- [ ] `findings` array is populated (blocker chain, ghost blockers)
- [ ] `message` references specific stale issues and the blocker chain

---

## Phase 3: Health Score

### Test 3.1 — Health scores computed after proactive scan

```bash
curl http://localhost:3000/api/fleetgraph/health-scores \
  -H "Cookie: $COOKIE" | python3 -m json.tool
```

**Expected structure:**
```json
{
  "scores": {
    "TEST_PROJECT_ID": {
      "overall": 35,
      "sub_scores": {
        "velocity":        { "name": "Velocity",        "score": 100, "description": "Healthy..." },
        "blockers":        { "name": "Blockers",        "score": 75,  "description": "Minor concerns..." },
        "workload":        { "name": "Workload",        "score": 100, "description": "Healthy..." },
        "issue_freshness": { "name": "Issue Freshness", "score": 45,  "description": "At risk..." },
        "approval_flow":   { "name": "Approval Flow",   "score": 60,  "description": "At risk..." },
        "accountability":  { "name": "Accountability",  "score": 100, "description": "Healthy..." }
      },
      "computed_at": "2026-03-21T...",
      "project_title": "FleetGraph Test Project"
    },
    "HEALTHY_PROJECT_ID": {
      "overall": 100,
      "sub_scores": { ... },
      "project_title": "FleetGraph Healthy Project"
    }
  }
}
```

**Check:**
- [ ] Test Project `overall` score is LOW (< 60) — multiple findings
- [ ] Healthy Project `overall` score is 100 — no findings
- [ ] `issue_freshness` score is reduced (ghost blockers)
- [ ] `approval_flow` score is reduced (approval bottlenecks)
- [ ] `blockers` score is reduced (blocker chain)
- [ ] `velocity`, `workload`, `accountability` are 100 (no findings for these)
- [ ] All sub-scores have `name`, `score`, `description`, `finding_ids`
- [ ] `computed_at` is recent timestamp

### Test 3.2 — Health score in chat response

```bash
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "entity_type": "project",
    "entity_id": "TEST_PROJECT_ID",
    "message": "What is the health of this project?"
  }' | python3 -m json.tool
```

**Expected:**
- [ ] Response JSON includes `health_score` field with the same structure as above
- [ ] `message` text references the health score or project health status

### Test 3.3 — Health score persisted in DB

```bash
psql $DATABASE_URL -c "
  SELECT entity_id,
         health_score->>'overall' as overall,
         health_score->'sub_scores'->'blockers'->>'score' as blockers,
         health_score->'sub_scores'->'issue_freshness'->>'score' as freshness
  FROM fleetgraph_state
  WHERE health_score IS NOT NULL;
"
```

**Check:**
- [ ] Rows exist for both test project and healthy project
- [ ] Scores match API response

### Test 3.4 — compute_health_score in trace

```bash
curl -X POST http://localhost:3000/api/fleetgraph/run \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
nodes = data.get('nodes_executed', [])
print('compute_health_score in trace:', 'compute_health_score' in nodes)
print('All nodes:', nodes)
"
```

**Expected:** `compute_health_score in trace: True`

---

## Phase 4: HITL Write Path

### Test 4.1 — Insights with proposed_action are visible

```bash
curl http://localhost:3000/api/fleetgraph/insights \
  -H "Cookie: $COOKIE" | python3 -c "
import sys, json
insights = json.load(sys.stdin)['insights']
hitl = [i for i in insights if i.get('proposed_action')]
print(f'{len(hitl)} insights with proposed_action:')
for i in hitl:
    pa = i['proposed_action']
    print(f'  [{i[\"id\"][:8]}] {i[\"title\"]} → {pa[\"type\"]}: {pa[\"description\"]}')
"
```

**Expected:** 3 HITL insights (comment, reassign, state_change)

### Test 4.2 — Approve a comment action

Pick the comment insight ID from the seed output or from test 4.1.

```bash
export COMMENT_INSIGHT_ID="..." # from seed output

curl -X POST http://localhost:3000/api/fleetgraph/insights/$COMMENT_INSIGHT_ID/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" | python3 -m json.tool
```

**Expected:**
```json
{
  "ok": true,
  "result": {
    "success": true,
    "action_type": "comment",
    "entity_id": "STALE_ISSUE_1_ID"
  }
}
```

**Verify the comment was created:**

```bash
psql $DATABASE_URL -c "
  SELECT comment_id, author_id, content::text
  FROM comments
  WHERE document_id = (SELECT entity_id FROM fleetgraph_insights WHERE id = '$COMMENT_INSIGHT_ID')
  ORDER BY created_at DESC LIMIT 1;
"
```

- [ ] Comment exists with FleetGraph content
- [ ] `author_id` is the approving user (Dev User)

### Test 4.3 — Approve a reassign action

```bash
export REASSIGN_INSIGHT_ID="..." # from seed output

# Check current assignee
psql $DATABASE_URL -c "
  SELECT id, title, properties->>'assignee_id' as assignee
  FROM documents
  WHERE id = (SELECT entity_id FROM fleetgraph_insights WHERE id = '$REASSIGN_INSIGHT_ID');
"

# Approve
curl -X POST http://localhost:3000/api/fleetgraph/insights/$REASSIGN_INSIGHT_ID/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" | python3 -m json.tool

# Verify assignee changed
psql $DATABASE_URL -c "
  SELECT id, title, properties->>'assignee_id' as assignee
  FROM documents
  WHERE id = (SELECT entity_id FROM fleetgraph_insights WHERE id = '$REASSIGN_INSIGHT_ID');
"
```

**Check:**
- [ ] `assignee_id` changed to the value from the proposed action
- [ ] Result shows `"success": true, "action_type": "reassign"`

### Test 4.4 — Approve a state_change action

```bash
export STATE_INSIGHT_ID="..." # from seed output

# Check current state
psql $DATABASE_URL -c "
  SELECT id, title, properties->>'state' as state
  FROM documents
  WHERE id = (SELECT entity_id FROM fleetgraph_insights WHERE id = '$STATE_INSIGHT_ID');
"

# Approve
curl -X POST http://localhost:3000/api/fleetgraph/insights/$STATE_INSIGHT_ID/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" | python3 -m json.tool

# Verify state changed
psql $DATABASE_URL -c "
  SELECT id, title, properties->>'state' as state
  FROM documents
  WHERE id = (SELECT entity_id FROM fleetgraph_insights WHERE id = '$STATE_INSIGHT_ID');
"
```

**Check:**
- [ ] State changed to `todo` (from `in_progress`)
- [ ] Result shows `"success": true, "action_type": "state_change"`

### Test 4.5 — Approve with edited content

First, re-seed to get fresh insights:

```bash
npx tsx api/src/db/seed-fleetgraph.ts
```

Then approve with modified content:

```bash
export NEW_COMMENT_ID="..." # new comment insight from re-seed

curl -X POST http://localhost:3000/api/fleetgraph/insights/$NEW_COMMENT_ID/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{"edited_content": "Custom message: I reviewed this issue and would like to help unblock it."}'
```

**Verify:** The comment in the DB has the edited content, not the original draft.

```bash
psql $DATABASE_URL -c "
  SELECT content::text FROM comments
  WHERE document_id = (SELECT entity_id FROM fleetgraph_insights WHERE id = '$NEW_COMMENT_ID')
  ORDER BY created_at DESC LIMIT 1;
"
```

- [ ] Content contains "Custom message: I reviewed this issue"

### Test 4.6 — Insight status changes to approved

```bash
curl http://localhost:3000/api/fleetgraph/insights?status=approved \
  -H "Cookie: $COOKIE" | python3 -c "
import sys, json
insights = json.load(sys.stdin)['insights']
print(f'{len(insights)} approved insights')
for i in insights:
    print(f'  {i[\"title\"]} (status: {i[\"status\"]})')
"
```

- [ ] Approved insights show `status: approved`

### Test 4.7 — Double approve returns error

```bash
curl -X POST http://localhost:3000/api/fleetgraph/insights/$COMMENT_INSIGHT_ID/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE"
```

**Expected:** `400` with `"error": "This insight has already been approved"`

### Test 4.8 — Non-existent insight returns 404

```bash
curl -X POST http://localhost:3000/api/fleetgraph/insights/00000000-0000-0000-0000-000000000000/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE"
```

**Expected:** `404` with `"error": "Insight not found"`

### Test 4.9 — Verify document_history audit trail

```bash
psql $DATABASE_URL -c "
  SELECT document_id, field, old_value, new_value, automated_by, created_at
  FROM document_history
  WHERE automated_by = 'fleetgraph'
  ORDER BY created_at DESC;
"
```

**Check:**
- [ ] Entries exist for reassign (`field = 'assignee_id'`)
- [ ] Entries exist for state change (`field = 'state'`, old = 'in_progress', new = 'todo')
- [ ] All have `automated_by = 'fleetgraph'`

### Test 4.10 — Verify audit_logs

```bash
psql $DATABASE_URL -c "
  SELECT action, resource_type, resource_id,
         details->>'insight_title' as insight_title,
         details->>'automated_by' as automated_by,
         created_at
  FROM audit_logs
  WHERE action LIKE 'fleetgraph%'
  ORDER BY created_at DESC;
"
```

**Check:**
- [ ] Entries exist with action like `fleetgraph.comment`, `fleetgraph.reassign`, `fleetgraph.state_change`
- [ ] `details` includes `insight_title` and `automated_by = 'fleetgraph'`

---

## Browser UI Verification

### Test UI.1 — FleetGraph chat panel

1. Open `http://localhost:5173` in browser
2. Login as `dev@ship.local` / `admin123`
3. Navigate to any project in the sidebar
4. Look for the FleetGraph button (bottom-right, blue with lightning icon)
5. Click it to open the chat panel

**Check:**
- [ ] Chat panel opens as overlay (bottom-right, ~384px wide)
- [ ] Shows "Analyzing [project name]" subtitle
- [ ] Suggested questions appear ("What's the biggest risk?", etc.)
- [ ] Insight cards shown above chat if findings exist for this entity

### Test UI.2 — Insight cards with HITL buttons

1. Re-seed: `npx tsx api/src/db/seed-fleetgraph.ts`
2. Navigate to the FleetGraph Test Project
3. Open FleetGraph panel

**Check:**
- [ ] Insight cards show severity badges (red/orange/amber)
- [ ] Cards with `proposed_action` show **Approve** and **Edit** buttons
- [ ] Cards without `proposed_action` only show Snooze and Dismiss

### Test UI.3 — Edit flow

1. Click **Edit** on an insight with a proposed comment
2. Textarea appears with draft content pre-populated
3. Modify the text
4. Click **Approve & Apply**

**Check:**
- [ ] Textarea shows the original draft content
- [ ] Cancel button returns to preview mode
- [ ] After approval, card shows green "approved" badge
- [ ] Approve/Edit buttons disappear on approved cards

### Test UI.4 — Chat conversation

1. Type "Are there any blockers?" and press Enter
2. Wait for response

**Check:**
- [ ] Loading dots animate while waiting
- [ ] Response references specific issues and blocker chain
- [ ] Active findings appended at bottom of response
- [ ] Follow-up questions work (maintains chat history)

### Test UI.5 — Dismiss and Snooze

1. Click Snooze (clock icon) on an insight → card disappears
2. Refresh → snoozed insight still hidden (within 24h window)
3. Click Dismiss (X icon) on another insight → card disappears
4. Refresh → dismissed insight permanently gone

---

## Full Reset and Clean Run

To verify everything end-to-end from scratch:

```bash
# 1. Clean state
psql $DATABASE_URL -c "DELETE FROM fleetgraph_insights; DELETE FROM fleetgraph_state;"

# 2. Re-seed
npx tsx api/src/db/seed-fleetgraph.ts

# 3. Restart dev server
# (Ctrl+C the running server, then:)
pnpm dev

# 4. Login
curl -v -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "dev@ship.local", "password": "admin123"}' \
  2>&1 | grep -i 'set-cookie'
export COOKIE="connect.sid=..."

# 5. Run proactive scan
curl -X POST http://localhost:3000/api/fleetgraph/run \
  -H "Cookie: $COOKIE" | python3 -m json.tool

# 6. Check insights
curl http://localhost:3000/api/fleetgraph/insights \
  -H "Cookie: $COOKIE" | python3 -m json.tool

# 7. Check health scores
curl http://localhost:3000/api/fleetgraph/health-scores \
  -H "Cookie: $COOKIE" | python3 -m json.tool

# 8. Test on-demand chat
curl -X POST http://localhost:3000/api/fleetgraph/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{"entity_type":"project","entity_id":"TEST_PROJECT_ID","message":"What are the biggest risks?"}' \
  | python3 -m json.tool

# 9. Approve a HITL insight
curl -X POST http://localhost:3000/api/fleetgraph/insights/COMMENT_INSIGHT_ID/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" | python3 -m json.tool

# 10. Run scan again — verify no duplicate insights
curl -X POST http://localhost:3000/api/fleetgraph/run \
  -H "Cookie: $COOKIE" | python3 -m json.tool
```

---

## Summary Checklist

### Phase 1 — Deterministic Signals
- [ ] Ghost blockers detected for stale in_progress issues
- [ ] Approval bottlenecks detected for pending/changes_requested
- [ ] Blocker chains detected for parent blocking 3+ children
- [ ] Fresh issues NOT flagged
- [ ] Done issues NOT flagged
- [ ] Approved sprints NOT flagged
- [ ] Deduplication: second scan creates no duplicates
- [ ] Deterministic findings have confidence = 1.0

### Phase 2 — Pipeline Completeness
- [ ] `fetch_accountability` in on-demand trace
- [ ] `detect_role` in on-demand trace
- [ ] Director gets strategic response
- [ ] PM gets operational response
- [ ] Engineer gets task-level response

### Phase 3 — Health Score
- [ ] `GET /health-scores` returns scores for projects
- [ ] Test project score is low (< 60)
- [ ] Healthy project score is 100
- [ ] Sub-scores correctly mapped to signal types
- [ ] `compute_health_score` in proactive trace
- [ ] Health score in chat response for project entities
- [ ] Scores persisted in `fleetgraph_state.health_score`

### Phase 4 — HITL Write Path
- [ ] Comment mutation creates real comment
- [ ] Reassign mutation changes assignee_id
- [ ] State change mutation changes state + timestamps
- [ ] `document_history` logged with `automated_by = 'fleetgraph'`
- [ ] `audit_logs` logged with `fleetgraph.*` action
- [ ] Insight status changes to 'approved'
- [ ] Edit flow modifies content before approval
- [ ] Double-approve returns 400
- [ ] Non-existent insight returns 404
- [ ] UI shows Approve/Edit buttons on actionable insights
- [ ] UI hides buttons after approval
- [ ] UI shows green "approved" confirmation
