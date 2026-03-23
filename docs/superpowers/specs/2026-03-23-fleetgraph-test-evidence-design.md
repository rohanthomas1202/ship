# FleetGraph Final Submission Evidence System

*Design spec for producing 5 isolated test cases with matching LangSmith traces for the FleetGraph final submission.*

---

## Problem

The FleetGraph final submission requires a Test Cases table in FLEETGRAPH.md with columns: **Ship State | Expected Output | Trace Link**. Each test case needs its own LangSmith trace showing a distinct execution path through the graph.

Currently:
- The proactive scan runs workspace-wide as a single `traceable` call, producing one trace for ALL projects
- Only 2 sample traces exist (fast-path and on-demand)
- There's no way to scope a proactive run to a single project for isolated traces
- All test scenarios live in one "FleetGraph Test Project", making signals overlap in traces

The PRD requires:
> "For each use case, provide: the Ship state that should trigger the agent, what the agent should detect or produce, the LangSmith trace from a run against that state."
> "Traces must demonstrate that the graph produces different execution paths under different conditions."

## Solution

Three changes to produce 5 isolated test cases with distinct LangSmith traces.

### 1. Add `project_id` scope to proactive scan

Add an optional `project_id` parameter to the proactive pipeline. When provided, `fetchActivity` and `fetchIssues` filter to only that project's data, producing a clean trace that shows one scenario.

**Files changed:**
- `shared/src/types/fleetgraph.ts` — add optional `project_id` to `FleetGraphTrigger`
- `api/src/services/fleetgraph/nodes-fetch.ts` — `fetchActivity` adds `AND da.related_id = $2` when `project_id` is set (critical: `fetchIssues` in proactive mode reads `Object.keys(state.data.activity)` to determine which projects to query, so filtering must happen in `fetchActivity` to prevent cross-project data leaking in). `fetchIssues` also filters its direct queries by `project_id` when present.
- `api/src/routes/fleetgraph.ts` — accept `project_id` query param on `POST /api/fleetgraph/run`. Also add `?sync=true` option that awaits the proactive scan and returns `{ trace, findings_count, duration_ms }` instead of the fire-and-forget `{ status: 'started' }`. The current `/run` endpoint returns immediately — the test runner needs synchronous results to capture trace data.

**Scope of change:** The `project_id` filter is additive — when omitted, behavior is identical to today (workspace-wide scan). The `sync` param is additive — when omitted, behavior is fire-and-forget as today. No existing functionality changes.

### 2. Refactor seed into isolated projects

Split `seed-fleetgraph.ts` so each proactive test case has its own project with only the relevant signals. This ensures each proactive trace shows exactly one detection type.

**New project structure:**

| Project | Scenario | Contains | Does NOT contain |
|---------|----------|----------|------------------|
| `FG-Ghost: Ghost Blocker Project` | Stale in_progress issues | 2 stale issues (7d, 4d) + 1 fresh + 1 done | No chains, no collapse, approved sprint |
| `FG-Collapse: Sprint Collapse Project` | Mid-sprint low completion | Sprint with 2/8 done, 75%+ elapsed | No stale issues, no chains, approved sprint |
| `FG-Chain: Blocker Chain Project` | Parent blocking 4 children | Root blocker + 4 children + pre-seeded HITL insight | No unrelated stale issues, no collapse |

On-demand scenarios (standup, planning) get their own isolated project (`FG-Activity: Standup & Planning Project`) with their own sprints. This prevents signal overlap — if standup data shared a project with ghost blocker issues, the on-demand trace would pick up ghost blocker findings and pollute the trace path.

Scenarios B (Approval Bottlenecks) and H (Healthy Project) are kept but moved to their own projects for health score contrast. They are NOT part of the 5 test cases — they exist as supporting data.

Each isolated project gets its own sprint(s) — no sharing sprints across projects.

**Files changed:**
- `api/src/db/seed-fleetgraph.ts` — restructure to create isolated projects per scenario instead of 1 combined project

**Critical fix:** The current seed deletes ALL `fleetgraph_insights` AFTER inserting HITL test insights (lines 654-658), which wipes them out. The delete must move BEFORE the HITL inserts.

**Idempotency preserved:** The seed script already uses title-based upsert. New project titles ensure no collision with existing data.

### 3. Add `run-test-cases.ts` script

A script that runs all 5 test cases sequentially, captures results, and outputs a markdown table for FLEETGRAPH.md.

**Flow:**
1. Authenticate (login as dev user, get session cookie)
2. Run seed (or assume already seeded)
3. **Touch activity** — for each proactive test project, UPDATE one issue's `updated_at` to NOW(). This is critical because `fetchActivity` checks `updated_at > NOW() - INTERVAL '5 minutes'`. If the seed ran more than 5 minutes ago, all proactive scans will short-circuit at `fetch_activity → log_clean_run` with identical traces.
4. Execute 5 scenarios (using `?sync=true` for proactive runs):
   - `POST /api/fleetgraph/run?project_id=<ghost_project_id>&sync=true` → Proactive trace 1
   - `POST /api/fleetgraph/run?project_id=<collapse_project_id>&sync=true` → Proactive trace 2
   - `POST /api/fleetgraph/run?project_id=<chain_project_id>&sync=true` → Proactive trace 3
   - `POST /api/fleetgraph/chat` with `{ entity_type: "sprint", entity_id: "<standup_sprint>", message: "draft my standup" }` → On-demand trace 4
   - `POST /api/fleetgraph/chat` with `{ entity_type: "sprint", entity_id: "<planning_sprint>", message: "help me plan this sprint" }` → On-demand trace 5
5. For trace 3, also call `POST /api/fleetgraph/insights/:id/approve` on the blocker chain insight to demonstrate HITL
6. Output markdown table with: test case name, nodes executed, findings count, duration, and instructions to get trace links from LangSmith

**Error handling:** If a test case fails, log the error and continue with remaining cases. Exit with non-zero code if any test case failed. Authentication failure is fatal (exit immediately).

**Files added:**
- `scripts/run-test-cases.ts`

**Note on trace links:** LangSmith trace links must be made public manually in the LangSmith UI (Share → Make Public). The script outputs the run metadata; the user copies the public links into FLEETGRAPH.md.

## 5 Test Cases — Expected Execution Paths

### Test Case 1: Ghost Blocker Detection (Proactive)

**Ship State:** Project with 2 issues in `in_progress` state — one stale 7 days (high severity), one stale 4 days (medium). Plus 1 fresh in_progress issue and 1 done issue (neither should flag). Sprint has approved plan.

**Expected Output:** 2 ghost blocker findings (high + medium severity). Fresh and done issues NOT flagged. Health score < 80.

**Expected Graph Path:**
```
fetch_activity → fetch_issues/sprint/team (parallel) → fetch_history
→ reason_health_check → reason_severity_triage → reason_root_cause
→ draft_artifact (high severity triggers this) → generate_insight
→ surface_insight → compute_health_score → persist_narrative → log_clean_run
```
**Key branch:** `draft_artifact` fires because high-severity finding exists.

### Test Case 2: Sprint Collapse Detection (Proactive)

**Ship State:** Active sprint at ~50% elapsed time with only 1/6 issues done (~17% completion). No stale issues (all recently updated). No blocker chains. Sprint has approved plan. Seed must calibrate elapsed time to produce a **medium** severity sprint collapse finding (not high), ensuring a distinct path from Test Case 1.

**Expected Output:** Sprint collapse finding (medium severity). Projected miss calculated from velocity vs. remaining work. No ghost blockers, no chains.

**Expected Graph Path:**
```
fetch_activity → fetch_issues/sprint/team (parallel) → fetch_history
→ reason_health_check → reason_severity_triage → reason_root_cause
→ generate_insight → surface_insight → compute_health_score
→ persist_narrative → log_clean_run
```
**Key branch:** No `draft_artifact` (severity is medium, not high/critical). Shorter path than ghost blocker trace. No `reason_compound_insight` (only 1 finding). This makes the trace visibly distinct from TC1 and TC3.

### Test Case 3: Blocker Chain + Human-in-the-Loop (Proactive)

**Ship State:** Parent issue in `in_progress` blocking 4 child issues via `document_associations` parent relationship. Root blocker is also stale (5 days). Pre-seeded insight with `proposed_action` of type `comment`.

**Expected Output:** Blocker chain finding (high/critical — 4 blocked issues). Ghost blocker finding on root issue. Compound insight merging both. After approval: comment posted, audit log entry created.

**Expected Graph Path:**
```
fetch_activity → fetch_issues/sprint/team (parallel) → fetch_history
→ reason_health_check → reason_severity_triage
→ reason_compound_insight (2+ findings) → reason_root_cause
→ draft_artifact → generate_insight → surface_insight
→ compute_health_score → persist_narrative → log_clean_run
```
**Key branch:** `reason_compound_insight` fires because 2+ related findings exist (ghost blocker + blocker chain on same entity). This path is unique among the 5 traces.

**HITL step (after graph run):**
```
POST /api/fleetgraph/insights/:id/approve
→ execute_mutation (type: comment)
→ document_history logged (automated_by: fleetgraph)
→ audit_logs entry (action: fleetgraph.comment)
→ insight status → approved
```

### Test Case 4: Standup Draft (On-Demand)

**Ship State:** User viewing a sprint. 5 issues with `document_history` entries from yesterday: 2 completed, 1 moved to review, 1 new blocker, 1 upcoming high-priority.

**Expected Output:** Markdown standup with Yesterday (2 completed, 1 in review), Today (top priorities), Risks (blocker identified).

**Expected Graph Path:**
```
fetch_issues/sprint/project/team/accountability (parallel)
→ fetch_history → reason_health_check
→ [if findings: reason_severity_triage → reason_root_cause (if medium+)]
→ detect_role → generate_standup_draft → compose_chat_response
```
**Note:** The `reason_severity_triage` and `reason_root_cause` nodes are conditional — they only fire if `reason_health_check` produces findings from the standup sprint's data. The standup project's issues are all recently updated (no ghost blockers) and the sprint has approved plans (no bottlenecks), so findings are unlikely and these nodes should be skipped.

**Key branch:** Intent detection routes to `generate_standup_draft` instead of `reason_query_response` or `generate_sprint_plan`.

### Test Case 5: Sprint Planning (On-Demand)

**Ship State:** User viewing a sprint in `planning` status. 10 backlog issues (varying priority/due dates), 2 carryover issues from previous sprint, team capacity of 60 hours.

**Expected Output:** Ranked backlog with carryover items boosted, capacity fitting applied. Sprint plan showing which issues fit within team capacity.

**Expected Graph Path:**
```
fetch_issues/sprint/project/team/accountability (parallel)
→ fetch_history → reason_health_check
→ [if findings: reason_severity_triage → reason_root_cause (if medium+)]
→ detect_role → fetch_backlog + fetch_carryover (parallel)
→ generate_sprint_plan → compose_chat_response
```
**Note:** The planning sprint has status `planning` with no active issues assigned to it yet, so findings from `reason_health_check` are unlikely. The conditional triage/root-cause nodes should be skipped.

**Key branch:** Intent detection routes to planning path, which triggers additional `fetch_backlog` + `fetch_carryover` nodes not present in any other trace.

## FLEETGRAPH.md Test Cases Table (Template)

After running `scripts/run-test-cases.ts` and making traces public in LangSmith, fill in:

| # | Ship State | Expected Output | Trace Link |
|---|-----------|----------------|------------|
| 1 | Project with 2 stale in_progress issues (7d, 4d). Fresh and done issues present as controls. | Ghost Blocker findings (high + medium). Fresh/done NOT flagged. Health < 80. | [View trace](...) |
| 2 | Sprint 75%+ elapsed, 2/8 issues done. | Sprint Collapse finding. Projected miss ~2 days. | [View trace](...) |
| 3 | Parent issue blocking 4 children. Root also stale 5d. | Blocker Chain (high) + Ghost Blocker. Compound insight. HITL: comment approved → posted. | [View trace](...) |
| 4 | Sprint with 5 issues transitioned yesterday. User asks "draft my standup". | Standup: Yesterday/Today/Risks sections. | [View trace](...) |
| 5 | Planning sprint with 10 backlog + 2 carryover. User asks "help me plan this sprint". | Ranked sprint plan fitted to 60h capacity. | [View trace](...) |

## Files Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `shared/src/types/fleetgraph.ts` | Edit — add `project_id?: string` to `FleetGraphTrigger` | +2 |
| `api/src/services/fleetgraph/nodes-fetch.ts` | Edit — add project_id WHERE clause to `fetchActivity` and `fetchIssues` | +15 |
| `api/src/routes/fleetgraph.ts` | Edit — pass `project_id` query param to trigger + add `?sync=true` option | +15 |
| `api/src/db/seed-fleetgraph.ts` | Refactor — isolated projects per scenario, fix insight delete ordering | ~100 lines changed |
| `scripts/run-test-cases.ts` | New — test runner with activity touch + sync runs | ~180 |
| `FLEETGRAPH.md` | Edit — fill in test cases table | ~20 |

## What does NOT change

- All 98 existing unit tests — unchanged
- Graph executor logic (`graph-executor.ts`) — unchanged (project_id flows through trigger, fetch nodes handle filtering)
- Frontend components — unchanged
- On-demand and HITL endpoints — unchanged
- Existing seed scenarios — restructured but same data
- Health score computation — unchanged
- LangSmith tracing config — unchanged (already working)

## Demo Video Alignment

The feedback also asked for a demo video that tells "one clear story." Recommended story using test case 3 (Blocker Chain + HITL):

1. Show the Ship state: parent issue blocking 4 children
2. Run proactive scan (show it detecting the blocker chain)
3. Open LangSmith trace: walk through the graph path
4. Show the insight card in Ship UI with the proposed comment
5. Click Approve — show the comment posted on the issue
6. Narrate what the agent did and WHY at each step

This covers detection → graph → decision → human step → result in one coherent narrative.
