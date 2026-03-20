# FleetGraph — PRD & Execution Plan

*Generated 2026-03-20 from architecture review of existing MVP + source plan*

---

## 1. Plan Audit

### 1.1 Classification: Product Requirement vs. Implementation Detail vs. Speculative

| Item | Classification | Notes |
|------|---------------|-------|
| Proactive + on-demand dual modes | **Product requirement** | Assignment constraint |
| 8 health signals (ghost blocker, scope creep, velocity decay, overload, accountability cascade, confidence drift, approval bottleneck, blocker chain) | **Product requirement** | Core detection capabilities |
| Sprint Collapse Predictor | **Product requirement** | Compound of existing signals — highest wow-factor |
| Project Health Score | **Product requirement** | Single-number entry point for directors |
| Role-aware context shifting | **Product requirement** | Required for embedded chat |
| Human-in-the-loop gate | **Product requirement** | Assignment constraint — reads autonomous, writes gated |
| Context-aware embedded chat | **Product requirement** | Assignment constraint — not standalone chatbot |
| LangSmith tracing | **Product requirement** | Assignment constraint |
| AI Standup Summary Generator | **Phase B feature** | High value but depends on core pipeline being solid |
| Shadow Retro auto-generation | **Phase C / speculative** | Cool but complex content generation |
| Smart Sprint Planning Assistant | **Phase B feature** | On-demand, high leverage |
| Velocity Decay Trend Analysis | **Phase B feature** | Requires 3+ sprints of history |
| Project Completion Forecast | **Phase C / speculative** | Requires stable velocity baseline |
| Compound Insight Engine | **Implementation detail** | Already implemented in `reason_compound_insight` |
| Recovery Simulation node | **Speculative** | Declared in FLEETGRAPH.md but not implemented — modeling "what-if" is ambitious |
| Action Priority node | **Speculative** | Type exists (`PrioritizedAction`) but no implementation |
| Narrative Memory | **Implementation detail** | Persist_narrative exists, minimal population |
| 20-node inventory (from source plan) | **Over-specified implementation detail** | Actual implementation uses ~15 nodes. Don't chase the number |
| ECS Fargate deployment | **Implementation detail** | Infrastructure, not product |
| WebSocket event supplement | **Future scope** | Ship WebSocket is per-user-session — confirmed not feasible now |
| Escalation (persist 2+ cycles → escalate) | **Phase B** | Requires state tracking working first |

### 1.2 Inconsistencies and Gaps Found

**Node numbering:** Source plan lists 20 nodes but numbers node 13 twice (`reason_query_response` and `generate_insight`). The actual implementation has ~15 distinct functions across 4 files, which is the right number.

**Missing nodes in implementation vs. plan:**
- `reason_recovery_simulation` — declared in FLEETGRAPH.md graph but not implemented. Type `RecoveryOption` exists.
- `reason_action_priority` — declared but not implemented. Type `PrioritizedAction` exists.
- `execute_mutation` — HITL gate approves, but there's no code to actually execute the mutation against Ship API.

**Edge condition gaps:**
- Plan says `fetch_activity → no activity → log_clean_run`. Implementation does this correctly.
- Plan says `reason_severity_triage → 2+ findings share entity → reason_compound_insight`. Implementation checks `findings.length >= 2` (close but not exactly "share entity" — it groups by entity inside the node). Fine.
- Plan says on-demand fetches `fetch_accountability` — implementation does NOT fetch accountability items in `runOnDemand`. Missing.

**HITL conflicts:**
- Plan says "Agent never changes issue state autonomously" but `draft_mutation` prepares payloads. There's no approval UI component. `FleetGraphInsightCard.tsx` shows dismiss/snooze but NOT approve/edit for mutations.
- The `hitl_gate` node doesn't exist as code — it's implicit in the insight card UI pattern.

**API assumptions to validate:**
- `planned_issue_ids` snapshot on sprint: WeekProperties doesn't include this field. Scope creep detection needs a different approach (use `document_history` to detect issue-sprint associations created after sprint activation).
- `PersonProperties.capacity_hours`: Not visible in the type definitions. Need to verify this field exists.
- Sprint `start_date`/`end_date`: WeekProperties uses `sprint_number` + workspace start date calculation, not explicit date fields.

**Cost analysis:** Source plan says $0.003/check. Actual development cost was ~$4.50 for 45 runs (~$0.10/run). The $0.003 figure is optimistic — realistic is $0.05-0.10 per full analysis run with root cause. Fast-path (no activity) is near-zero.

### 1.3 What's Actually Built (MVP Inventory)

| Layer | Component | Status |
|-------|-----------|--------|
| **Types** | FleetGraphState, Finding, CompoundFinding, RootCause, RecoveryOption, ProposedAction, InsightCard, HealthScore | Complete |
| **Routes** | POST /chat, GET /insights, POST /dismiss, POST /snooze, POST /run | Complete |
| **Fetch nodes** | fetchActivity, fetchIssues, fetchSprintDetail, fetchProjectDetail, fetchTeam, fetchHistory, fetchAccountability | Complete (7/7) |
| **Reasoning nodes** | reasonHealthCheck, reasonSeverityTriage, reasonCompoundInsight, reasonRootCause, reasonQueryResponse | Complete (5/7 — missing recovery_simulation, action_priority) |
| **Action nodes** | generateInsight, draftArtifact, composeChatResponse, surfaceInsight, persistNarrative, logCleanRun | Complete |
| **DB tables** | fleetgraph_state, fleetgraph_insights | Complete (migration 039) |
| **Frontend** | FleetGraphChat.tsx, FleetGraphInsightCard.tsx, useFleetGraph.ts | Complete (basic) |
| **LangSmith** | traceable wrappers on runProactive/runOnDemand | Complete |
| **Bedrock** | callBedrock with tool_use support | Complete |

**Not built:**
- HITL approval UI (approve/edit buttons, mutation execution)
- Scheduled proactive trigger (EventBridge/cron config)
- Health Score computation and display
- Recovery simulation reasoning
- Action priority reasoning
- Accountability fetch in on-demand flow
- Role detection from RACI fields
- Escalation logic
- Sprint planning assistant
- AI Standup / Shadow Retro generation

---

## 2. Normalized Scope Recommendation

### Phase A: Must-Build Next (core flow completion)

These close the gap between "MVP that runs" and "feature that ships":

| # | Feature | Why Now |
|---|---------|---------|
| A1 | **HITL Approval Gate UI** | Without this, mutations are dead-end. Required by assignment |
| A2 | **Execute Mutation** | Backend to actually POST comments, reassign issues via Ship API after approval |
| A3 | **Health Score Computation** | Directors need a single-number entry point. Composable from existing signals |
| A4 | **Role Detection from RACI** | Chat responses are generic without this. Required for role-aware shifting |
| A5 | **Accountability fetch in on-demand** | Missing from runOnDemand — needed for complete context |
| A6 | **Proactive Trigger Setup** | POST /run endpoint exists but nothing calls it on schedule. Cron job or test harness |
| A7 | **Ghost Blocker hardening** | Heuristic fallback exists but primary detection relies entirely on LLM. Add deterministic pre-check |
| A8 | **Approval Bottleneck hardening** | Same — add deterministic detection before LLM reasoning |

### Phase B: High-Value After Core Works

| # | Feature | Why Next |
|---|---------|----------|
| B1 | **Sprint Collapse Predictor** | Highest wow-factor. Compound of velocity + blockers + time remaining |
| B2 | **AI Standup Summary Generator** | Leverages existing `/api/claude/context?context_type=standup` endpoint |
| B3 | **Smart Sprint Planning Assistant** | On-demand, fits existing chat flow |
| B4 | **Blocker Chain Visualization** | Frontend enhancement — show the chain, not just describe it |
| B5 | **Escalation Logic** | If finding persists 2+ cycles and responsible person hasn't viewed |
| B6 | **Velocity Decay Trend** | Requires 3+ sprints of data — may not have enough in test env |

### Phase C: Later / Stretch

| # | Feature | Why Later |
|---|---------|-----------|
| C1 | Recovery Simulation ("what-if" modeling) | Ambitious — needs stable baseline data |
| C2 | Action Priority per-user ranking | Useful but not differentiating |
| C3 | Shadow Retro auto-generation | Content generation is harder to get right |
| C4 | Project Completion Forecast | Needs reliable velocity baseline |
| C5 | Narrative Memory (cross-run context) | Structure exists, low urgency |
| C6 | WebSocket real-time triggers | Ship architecture doesn't support system-level events yet |
| C7 | Workspace-level health dashboard | Requires health scores to be computed first (depends on A3) |

---

## 3. PRD — FleetGraph: Project Intelligence Agent

### 3.1 Overview

FleetGraph is a graph-based AI agent embedded in Ship that reads project state via the REST API, reasons about health signals, and surfaces actionable insights to engineering teams. It operates in two modes: **Proactive** (agent-initiated monitoring every 5 minutes) and **On-Demand** (user-invoked context-aware chat from within Ship's UI).

FleetGraph is not a dashboard and not a standalone chatbot. It is an intelligence layer that understands project structure, detects cross-cutting risks humans miss, explains root causes, and drafts interventions — all gated by human approval before any write action.

### 3.2 Problem Statement

Engineering teams using Ship face three categories of invisible risk:

1. **Silent stalls**: Issues look "owned" on the board but nobody is working on them. Blocked parent issues silently freeze downstream work. These are invisible in flat board views.

2. **Gradual drift**: Sprint scope creep, declining velocity, and mounting approval bottlenecks erode predictability week over week. No single event triggers alarm, but the cumulative effect is devastating.

3. **Cross-cutting overload**: A person overloaded across 3 projects, a blocker chain spanning 4 issues, a sprint that's going to miss by 2 days — these require reasoning across multiple entities simultaneously. Humans don't naturally hold this context.

Ship has the data to detect all of these conditions. FleetGraph connects the dots.

### 3.3 Goals

1. **Detect** health signals within 5 minutes of the underlying condition forming
2. **Explain** root causes with specific data (issue numbers, person names, dates)
3. **Recommend** concrete actions (reassignment, descoping, escalation) with projected impact
4. **Draft** intervention artifacts (comments, status updates) ready for human approval
5. **Respect** human authority — all write operations require explicit approval

### 3.4 Non-Goals

- Replacing human judgment for strategic decisions
- Autonomous write operations (no auto-reassign, no auto-close)
- Replacing Ship's existing UI (FleetGraph augments, doesn't replace)
- Real-time streaming analytics (5-minute polling is sufficient)
- General-purpose chatbot (responses are always grounded in Ship data)
- Supporting workspaces with no active projects (no data = no analysis)

### 3.5 Users / Roles

| Role | Detected Via | Primary Use |
|------|-------------|-------------|
| **Director** | `accountable_id` on program | Portfolio health, cross-project comparison, resource allocation |
| **PM / Project Owner** | `owner_id` on project | Sprint health, blocker chains, who to follow up with, approval status |
| **Engineer** | `assignee_id` on issues | Personal task prioritization, understanding blockers, standup drafting |

Role detection cascade: Check user's `person_id` against RACI fields on program → project → sprint → issue. Fallback to `workspace_memberships.role`.

### 3.6 Core User Jobs

| Job | Mode | Key Question |
|-----|------|-------------|
| "Is anything silently stuck?" | Proactive | Ghost blockers, stale issues, approval bottlenecks |
| "Is this sprint going to make it?" | Both | Sprint collapse prediction, scope creep, velocity |
| "Who is overloaded?" | Proactive | Cross-project load imbalance |
| "What should I work on next?" | On-demand | Prioritized action queue by role |
| "Why is this blocked?" | On-demand | Blocker chain traversal, root cause |
| "What's the health of this project?" | Both | Composite health score with breakdown |
| "Help me write my standup" | On-demand | AI-generated draft from observable activity |

### 3.7 Feature Requirements

#### 3.7.1 Proactive Features

**P1: Ghost Blocker Detection**
- **User story**: As a PM, I want to be alerted when an issue has been "in progress" with no activity for 3+ business days, so I can intervene before it silently stalls the sprint.
- **Trigger**: Proactive cycle (every 5 min), activity-gated
- **Input data**: Issues with `state = 'in_progress'`, `document_history` for last activity timestamp
- **Reasoning**: Deterministic pre-check (updated_at > 3 business days ago) + LLM for context (is the assignee active on other issues? is this a complex issue that legitimately takes time?)
- **Output**: Insight card: "Issue #{ticket_number} has been in-progress for {N} days with no activity. Assignee {name} has {M} other active issues."
- **Action type**: Read-only insight. Optional: draft comment to assignee (HITL-gated)
- **Failure/fallback**: If LLM unavailable, surface heuristic finding with `confidence: 0.3`
- **Success criteria**: Detects issues stale >3 business days within one proactive cycle. Zero false positives on issues updated within 3 days.

**P2: Sprint Scope Creep Detection**
- **User story**: As a PM, I want to know when issues are added to an active sprint beyond the planned scope, so I can evaluate cumulative impact on capacity.
- **Trigger**: Proactive cycle
- **Input data**: Sprint `document_associations` (type='sprint'), `document_history` for association creation timestamps, sprint activation timestamp
- **Reasoning**: Count issues associated with sprint after `started_at`. If delta > 20% of original count, flag.
- **Output**: "Sprint {name}: {N} issues added after activation ({X}% scope increase). Added by: {names}. Estimated impact: +{Y} story points."
- **Action type**: Read-only insight
- **Failure/fallback**: If `started_at` is null, skip detection for this sprint
- **Success criteria**: Correctly identifies issues added post-activation. Ignores issues present at activation time.

**P3: Team Load Imbalance**
- **User story**: As a PM/Director, I want to see when a team member is overloaded across multiple projects, so I can redistribute work before they become a bottleneck.
- **Trigger**: Proactive cycle
- **Input data**: Issues per assignee across projects, story point estimates, team roster with capacity_hours
- **Reasoning**: Compute per-person story points across active sprints. Flag if >2x team median or active in 3+ projects.
- **Output**: Workload table showing each person's allocation. Recommendation for redistribution.
- **Action type**: Read-only insight. Optional: draft reassignment (HITL-gated)
- **Failure/fallback**: If estimates are missing, use issue count as proxy
- **Success criteria**: Correctly identifies overloaded individuals. Does not flag intentional multi-project leads.

**P4: Approval Bottleneck Detection**
- **User story**: As a PM, I want to know when plan or review approvals are stuck for >2 business days, so I can follow up with the approver.
- **Trigger**: Proactive cycle
- **Input data**: Sprint `properties.plan_approval`, `properties.review_approval`, `document_history` for approval state changes
- **Reasoning**: Deterministic: check if approval state is null or `changes_requested` for >2 business days since last state change.
- **Output**: "Sprint {name}: plan approval pending for {N} days. Approver: {name} (project accountable)."
- **Action type**: Read-only insight. Optional: draft reminder comment (HITL-gated)
- **Failure/fallback**: If approval fields are null and sprint is in planning, skip (not yet applicable)
- **Success criteria**: Detects approvals pending >2 business days. Correctly identifies the approver via RACI.

**P5: Blocker Chain Detection**
- **User story**: As a PM, I want to see when a parent issue is transitively blocking 3+ downstream issues, so I can prioritize unblocking the root.
- **Trigger**: Proactive cycle
- **Input data**: `document_associations` with `relationship_type = 'parent'`, issue states
- **Reasoning**: Graph traversal: build parent-child tree. Find parent issues in `todo`/`in_progress` with 3+ transitive children. Compute total blocked story points.
- **Output**: "Blocker chain: #{root} → #{child1} → #{child2} → #{child3}. Impact: {N} engineers waiting, {M} story points blocked."
- **Action type**: Read-only insight with chain visualization
- **Failure/fallback**: If associations are sparse, skip chain detection
- **Success criteria**: Detects chains of depth ≥3. Correctly computes transitive impact.

**P6: Accountability Cascade**
- **User story**: As a manager, I want to see when a team member has 3+ simultaneous overdue accountability items, so I can address potential disengagement.
- **Trigger**: Proactive cycle
- **Input data**: `GET /api/accountability/action-items` per person
- **Reasoning**: Group action items by person. Flag if person has 3+ items with days_overdue > 0.
- **Output**: Consolidated view: "{Name}: missing standup (2 days), missing plan (3 days), no sprint issues."
- **Action type**: Read-only insight targeted to manager (project `accountable_id`)
- **Failure/fallback**: If accountability endpoint is slow, skip for this cycle
- **Success criteria**: Correctly identifies persons with 3+ overdue items. Routes to correct manager.

**P7: Sprint Confidence Drift**
- **User story**: As a PM, I want to be warned when sprint confidence drops sharply or is never updated, so I can investigate before it's too late.
- **Trigger**: Proactive cycle
- **Input data**: Sprint `properties.confidence`, `document_history` for confidence changes
- **Reasoning**: If confidence drops >20 points between updates, or if sprint has been active >3 days with no confidence update.
- **Output**: "Sprint {name}: confidence dropped from {X} to {Y}. Last updated {N} days ago."
- **Action type**: Read-only insight
- **Failure/fallback**: If confidence field is unused in workspace, skip
- **Success criteria**: Detects >20pt drops. Does not flag sprints that never used confidence.

**P8: Project Health Score**
- **User story**: As a Director, I want a single 0-100 health score per project so I can quickly identify which projects need attention.
- **Trigger**: Computed each proactive cycle for active projects
- **Input data**: All signal types — velocity, blockers, workload, issue freshness, approval flow, accountability
- **Reasoning**: Weighted composite: velocity (20%), blockers (25%), workload (15%), issue_freshness (15%), approval_flow (10%), accountability (15%). Each sub-score is 0-100 based on signal severity.
- **Output**: Health score badge on project (green >70, amber 40-70, red <40). Click to see breakdown.
- **Action type**: Read-only. Persisted in `fleetgraph_state.health_score`
- **Failure/fallback**: If insufficient data for a sub-score, weight redistributed
- **Success criteria**: Score changes when underlying conditions change. Sub-scores drill into specific findings.

#### 3.7.2 On-Demand Features

**D1: Context-Aware Chat**
- **User story**: As any user, I want to ask questions about the entity I'm currently viewing and get data-grounded answers.
- **Trigger**: User opens FleetGraph chat panel while viewing an issue, sprint, project, or dashboard
- **Input data**: Entity context (type + ID), user's person_id and role, all related data
- **Reasoning**: Parse question intent, fetch relevant data, run background health check for enrichment, compose role-appropriate response
- **Output**: Chat response with inline references to issues, people, dates. Active findings appended if relevant.
- **Action type**: Read-only response. May propose mutations via HITL gate.
- **Failure/fallback**: If LLM unavailable, return structured data summary from heuristic fallback
- **Success criteria**: Responses reference specific Ship data. Follow-up questions maintain context.

**D2: Smart Sprint Planning (Phase B)**
- **User story**: As a PM viewing a sprint in planning status, I want FleetGraph to help me prioritize backlog issues for the sprint.
- **Trigger**: User asks "help me plan" while viewing a planning-status sprint
- **Input data**: Backlog issues (not in any active sprint), team capacity, carryover from last sprint, due dates
- **Reasoning**: Rank by priority × dependency-unblocking × due_date proximity × carryover flag. Fit to capacity.
- **Output**: Recommended issue set with rationale. "5 issues, 15 story points, fits within 20h capacity."
- **Action type**: Read-only recommendation. User adds issues manually.
- **Success criteria**: Recommended set fits capacity. Carryover issues are prioritized.

**D3: AI Standup Generator (Phase B)**
- **User story**: As an engineer, I want FleetGraph to draft my standup from my actual activity, so I spend 30 seconds editing instead of 10 minutes writing.
- **Trigger**: User opens standup view, or asks "draft my standup"
- **Input data**: Last 24h issue state transitions, completed issues, new blockers, comment activity (via `/api/claude/context?context_type=standup`)
- **Reasoning**: Summarize yesterday's work, infer today's plan from priority/deadline, flag blockers
- **Output**: Draft standup saved as document. User reviews and submits.
- **Action type**: Draft-only (creates draft document, user submits)
- **Success criteria**: Draft captures ≥80% of actual activity. Engineer edits, not rewrites.

### 3.8 System Behavior / UX Notes

**Embedded Chat Behavior:**
- Chat panel opens as a fixed-position overlay (bottom-right, 384px wide)
- Context automatically set from current view (issue/sprint/project/dashboard)
- Chat history maintained for the session per entity
- Suggested questions shown when chat is empty, tailored to entity type
- Loading state: animated dots (already implemented)

**Insight Cards:**
- Shown in chat panel before conversation starts (if insights exist for current entity)
- Severity-colored left border: red (critical/high), amber (medium), gray (low)
- Title, severity badge, description, affected entities
- Actions: Dismiss, Snooze (configurable hours)
- **Phase A addition**: Approve button for mutation proposals, Edit button for drafted artifacts

**HITL Approval Flow:**
- When FleetGraph proposes a write action (comment, reassignment, state change):
  1. Insight card shows proposed action with "Approve" and "Edit" buttons
  2. "Approve" executes the mutation via Ship API
  3. "Edit" opens the drafted content for modification, then "Approve"
  4. "Dismiss" suppresses the finding
  5. "Snooze" defers for N hours
- All mutations logged to `audit_logs` table with `automated_by = 'fleetgraph'`
- Proactive mode: mutations queued as insight cards for next user visit
- On-demand mode: mutations proposed inline in chat response

**Snooze/Dismiss:**
- Dismiss: finding hash added to `suppressed_hashes` in `fleetgraph_state`. Same finding won't resurface.
- Snooze: `snoozed_until` set on insight. Finding can resurface after expiry.
- Dismissals persist across cycles. Snoozes auto-expire.

### 3.9 Architecture Summary

```
┌─────────────────────────────────────────────────┐
│                  Entry Points                    │
│  Proactive: POST /api/fleetgraph/run (cron)     │
│  On-demand: POST /api/fleetgraph/chat (user)    │
└─────────────┬───────────────────┬───────────────┘
              │                   │
    ┌─────────▼─────────┐ ┌──────▼──────────┐
    │ resolve_context    │ │ resolve_context  │
    │ _proactive         │ │ _on_demand       │
    └─────────┬─────────┘ └──────┬──────────┘
              │                   │
    ┌─────────▼───────────────────▼──────────┐
    │         Fetch Layer (parallel)          │
    │  issues, sprints, projects, team,      │
    │  history, accountability, activity     │
    └─────────────────┬─────────────────────┘
                      │
    ┌─────────────────▼─────────────────────┐
    │         Reasoning Layer                │
    │  health_check → severity_triage →     │
    │  compound_insight → root_cause        │
    │  (on-demand: query_response)          │
    └─────────────────┬─────────────────────┘
                      │
    ┌─────────────────▼─────────────────────┐
    │         Action Layer                   │
    │  generate_insight → draft_artifact →  │
    │  surface_insight → persist_narrative   │
    │  (on-demand: compose_chat_response)   │
    └─────────────────┬─────────────────────┘
                      │
    ┌─────────────────▼─────────────────────┐
    │         HITL Gate (if mutation)         │
    │  Approve → execute_mutation             │
    │  Edit → modify → execute               │
    │  Dismiss / Snooze                       │
    └────────────────────────────────────────┘
```

**Key architectural decisions:**
- LangGraph-style execution implemented in TypeScript (not Python LangGraph SDK)
- AWS Bedrock for Claude API calls with tool_use for structured output
- LangSmith tracing via `traceable` wrapper on top-level functions
- PostgreSQL for persistence (no new infrastructure)
- Activity-gated proactive polling (only analyze projects with recent activity)

### 3.10 Data Dependencies / API Endpoints Needed

| Data | Endpoint | Used By |
|------|----------|---------|
| Issues with filters | `GET /api/issues?sprint_id=X&project_id=X` | All signals |
| Sprint detail | `GET /api/weeks/:id` | Sprint signals |
| Project detail | `GET /api/projects/:id` | RACI, approvals |
| Team roster | `GET /api/team` | Overload, assignment |
| Activity counts | `GET /api/activity/:type/:id` | Activity gate |
| Accountability items | `GET /api/accountability/action-items` | Cascade detection |
| Document history | `GET /api/issues/:id/history` | Root cause, ghost blocker |
| Claude context | `GET /api/claude/context?context_type=standup` | AI Standup (Phase B) |

**Not currently used but needed:**
- Document associations query (for scope creep — needs `document_history` on association creation)
- Person-to-project mapping (for cross-project overload — currently inferred from issues)

### 3.11 State + Persistence

**fleetgraph_state** (per-entity polling state):
- `workspace_id, entity_id` (composite PK)
- `last_checked_at` — when this entity was last analyzed
- `last_activity_count` — activity count at last check (for delta detection)
- `last_findings` (JSONB) — cached findings from last run
- `suppressed_findings` (JSONB) — hashes of dismissed findings
- `narrative` (JSONB) — append-only summary log
- `health_score` (JSONB) — cached ProjectHealthScore

**fleetgraph_insights** (surfaced to users):
- Full schema: id, workspace_id, entity_id/type, severity, category, title, content, root_cause, recovery_options, proposed_action, drafted_artifact, status, snoozed_until, target_user_id, timestamps
- Indexed on: workspace_id, entity_id, status, target_user_id, created_at

### 3.12 Observability / LangSmith Requirements

- **Every graph execution** must be wrapped in `traceable` with project_name `'fleetgraph'`
- **Metadata** on each trace: `mode` (proactive/on_demand), `workspace_id`, `entity_id`, `findings_count`, `nodes_executed`
- **Two distinct trace patterns** must be demonstrable:
  1. Fast path: fetch_activity → no activity → log_clean_run (2-3 nodes)
  2. Full analysis: fetch → health_check → triage → root_cause → surface (7+ nodes)
- **Error traces**: API errors and LLM errors must be captured in trace metadata
- **Existing implementation** already handles this via `traceable` on `runProactive` and `runOnDemand`

### 3.13 Performance + Cost Considerations

| Metric | Target |
|--------|--------|
| Detection latency | < 5 minutes (polling interval) |
| Proactive cycle duration | < 60 seconds per workspace |
| On-demand response time | < 10 seconds (including LLM call) |
| Token budget per routine check | ~2K input, ~500 output |
| Token budget per deep analysis | ~6K input, ~1.5K output |
| Team roster cache | 1 hour |
| Concurrent on-demand requests | 10 per workspace |

**Cost at scale** (revised from actual development data):
| Scale | Proactive/month | On-demand/month | Total |
|-------|----------------|-----------------|-------|
| 20 projects | ~$30 | ~$5 | ~$35 |
| 200 projects | ~$300 | ~$50 | ~$350 |
| 2,000 projects | ~$3,000 | ~$500 | ~$3,500 |

### 3.14 Risks / Open Questions

| Risk | Mitigation | Status |
|------|-----------|--------|
| `planned_issue_ids` doesn't exist on WeekProperties | Use `document_history` to detect post-activation issue additions | **Assumption — needs validation** |
| `capacity_hours` may not be set on PersonProperties | Fall back to issue count instead of story points | **Assumption — needs validation** |
| Sprint dates computed, not stored | Use workspace start date + sprint_number formula | **Validated in codebase** |
| LLM hallucination in health check | Heuristic fallback exists; strengthen with deterministic pre-checks | **Partially mitigated** |
| Proactive trigger not configured | POST /run exists but no scheduler. Need cron, EventBridge, or test harness | **Open** |
| Approval bottleneck detection assumes RACI populated | If `accountable_id` is null, can't identify approver | **Assumption** |
| Cost model uses Sonnet, but Bedrock calls may use different model | Verify `bedrock.ts` model selection | **Needs verification** |

### 3.15 Milestones

**Milestone 1: Core Flow Completion (Phase A)**
- HITL approval gate UI
- Execute mutation backend
- Health score computation
- Role detection
- Fix on-demand accountability fetch
- Deterministic signal pre-checks (ghost blocker, approval bottleneck)
- Proactive trigger (even if just a test script)

**Milestone 2: Wow-Factor Features (Phase B)**
- Sprint Collapse Predictor
- AI Standup Summary Generator
- Smart Sprint Planning Assistant
- Escalation logic
- Blocker chain frontend visualization

**Milestone 3: Polish + Submission**
- Recovery simulation (if time permits)
- Velocity decay trend analysis
- End-to-end test suite
- LangSmith trace curation for demo
- Cost analysis validation
- Documentation finalization

---

## 4. Execution Plan

### 4.1 Implementation Order

Smallest high-leverage path first:

```
1. Deterministic signal pre-checks (hardens what exists)
2. Health score computation (new value, uses existing signals)
3. Role detection (required for chat quality)
4. HITL approval UI + execute mutation (completes the write path)
5. On-demand accountability fetch fix (quick fix)
6. Proactive trigger test harness
7. Sprint Collapse Predictor (Phase B entry)
8. AI Standup Generator (Phase B)
```

### 4.2 Workstreams

#### WS1: Backend Graph/Orchestration
- Deterministic pre-check layer
- Health score computation node
- Sprint collapse predictor (compound)
- Recovery simulation (Phase C)

#### WS2: API/Data Access Layer
- Fix on-demand accountability fetch
- Role detection via RACI cascade
- Execute mutation endpoint (POST comments, reassign, state change)
- Scope creep detection via document_history

#### WS3: Persistence
- Health score persistence in fleetgraph_state
- Escalation tracking (persist 2+ cycle awareness)
- Insight deduplication (don't create duplicate insights for same condition)

#### WS4: Frontend/UI
- HITL approval card (Approve/Edit/Dismiss/Snooze)
- Health score badge on project cards
- Blocker chain visualization (Phase B)
- Role-aware suggested questions

#### WS5: Observability/Testing
- Unit tests for deterministic signal detection
- Integration test: seeded data → proactive run → expected insights
- LangSmith trace curation
- Proactive trigger test harness

### 4.3 Task Breakdown

| # | Task | Why It Matters | Files Affected | Dependencies | Size |
|---|------|---------------|----------------|-------------|------|
| T1 | Add deterministic ghost blocker pre-check | Reduces LLM dependency, catches obvious cases fast | `nodes-reasoning.ts` | None | S |
| T2 | Add deterministic approval bottleneck pre-check | Same rationale — approval pending >2 days is mechanical | `nodes-reasoning.ts` | None | S |
| T3 | Implement health score computation | Directors need entry point. Composes from existing findings | `nodes-action.ts`, `graph-state.ts`, `fleetgraph.ts` (types) | T1, T2 | M |
| T4 | Add role detection from RACI | Chat responses need role awareness | `nodes-reasoning.ts`, `nodes-fetch.ts` | None | M |
| T5 | Fix on-demand accountability fetch | Missing from runOnDemand pipeline | `graph-executor.ts` | None | S |
| T6 | Build HITL approval UI component | Assignment requirement — mutations need approval | `FleetGraphInsightCard.tsx`, new `FleetGraphApprovalCard.tsx` | None | M |
| T7 | Implement execute_mutation backend | Completes the write path after HITL approval | `nodes-action.ts`, `fleetgraph.ts` (route) | T6 | M |
| T8 | Add health score badge to project view | Visual entry point for directors | `web/src/components/` (project card) | T3 | S |
| T9 | Create proactive trigger test harness | Need a way to run proactive cycle in dev | `scripts/` or `api/src/scripts/` | None | S |
| T10 | Implement sprint collapse predictor | Highest wow-factor compound insight | `nodes-reasoning.ts` | T1, T3 | L |
| T11 | Implement AI standup generator | High value, leverages existing context API | `nodes-reasoning.ts`, `nodes-action.ts` | T4 | M |
| T12 | Add blocker chain visualization | Frontend enhancement for chain findings | `FleetGraphInsightCard.tsx` or new component | T1 | M |
| T13 | Implement scope creep via document_history | Can't use planned_issue_ids (doesn't exist) | `nodes-reasoning.ts`, `nodes-fetch.ts` | None | M |
| T14 | Add escalation logic | Findings that persist 2+ cycles escalate | `graph-executor.ts`, `nodes-action.ts` | T9 | M |
| T15 | Insight deduplication | Prevent duplicate insights for same condition across cycles | `nodes-action.ts` (surfaceInsight) | T9 | S |
| T16 | Unit tests for deterministic signals | Verify detection accuracy | `api/src/services/fleetgraph/__tests__/` | T1, T2 | M |
| T17 | Integration test with seeded data | End-to-end verification | `api/src/services/fleetgraph/__tests__/` | T9 | L |
| T18 | LangSmith trace curation | Demo readiness — clean traces showing both paths | Manual | T17 | S |

### 4.4 "Start Here First" — Immediate Tasks

Do these in order:

| Order | Task | Why First | Est. Time |
|-------|------|-----------|-----------|
| 1 | **T1: Deterministic ghost blocker pre-check** | Hardest signal to get wrong. Adds reliability to existing code. Zero new infrastructure. | 1-2 hours |
| 2 | **T2: Deterministic approval bottleneck pre-check** | Same pattern as T1. Mechanical detection. | 1 hour |
| 3 | **T5: Fix on-demand accountability fetch** | One-line fix in `graph-executor.ts` — add `fetchAccountability` to parallel fetch array in `runOnDemand`. | 15 min |
| 4 | **T15: Insight deduplication** | Before running proactive cycles repeatedly, prevent duplicate insights. Check finding hash against existing insights. | 1 hour |
| 5 | **T3: Health score computation** | New capability from existing data. Compose sub-scores from findings. Persist to `fleetgraph_state.health_score`. | 2-3 hours |
| 6 | **T4: Role detection from RACI** | Required for chat quality and health score routing. Check user person_id against program.accountable_id, project.owner_id, issue.assignee_id. | 2 hours |
| 7 | **T6: HITL approval UI** | Unblocks the entire write path. Add Approve/Edit buttons to insight cards. | 3-4 hours |
| 8 | **T9: Proactive trigger test harness** | Script to invoke POST /run with test workspace. Needed to demo proactive mode. | 1 hour |

---

## 5. Immediate Next Tasks

(Same as 4.4, reproduced for clarity)

1. **Deterministic ghost blocker pre-check** — Add a non-LLM detection pass in `reasonHealthCheck` that mechanically identifies issues in_progress >3 business days. Run BEFORE the Bedrock call. Merge results.

2. **Deterministic approval bottleneck pre-check** — Same pattern: check `plan_approval.state` and `review_approval.state` for null or `changes_requested` with age >2 business days. Run before Bedrock.

3. **Fix on-demand accountability fetch** — In `graph-executor.ts:runOnDemand`, add `fetchAccountability(pool, state)` to the parallel fetch array.

4. **Insight deduplication** — In `surfaceInsight`, before INSERT, check if an insight with same `category + entity_id + status = 'pending'` exists within last 24 hours. Skip if duplicate.

5. **Health score computation** — New function `computeHealthScore(findings: Finding[]): ProjectHealthScore`. Map signal_type to sub-score. Persist via `fleetgraph_state.health_score`.

6. **Role detection** — New function `detectUserRole(userId, projectId, pool): 'director' | 'pm' | 'engineer'`. Query program/project RACI fields. Use in `reasonQueryResponse` to adjust prompt.

7. **HITL approval UI** — Extend `FleetGraphInsightCard` with Approve/Edit buttons when `proposed_action` is present. Add API call to new `POST /api/fleetgraph/insights/:id/approve`.

8. **Proactive trigger test harness** — Script: `scripts/run-fleetgraph.ts` that calls `POST /api/fleetgraph/run` with a workspace_id from .env.

---

## 6. Starter Architecture + Types

### 6.1 Suggested FLEETGRAPH.md Additions

The existing FLEETGRAPH.md is well-structured. Additions needed:

```
## Health Score Methodology

### Sub-Score Computation
| Sub-Score | Weight | 100 (healthy) | 0 (critical) |
|-----------|--------|---------------|---------------|
| Velocity | 20% | Sprint completion rate ≥80% | ≤30% |
| Blockers | 25% | No blocker chains | 3+ chains with 4+ blocked issues |
| Workload | 15% | Max person ≤1.5x median | Any person >3x median |
| Issue Freshness | 15% | No ghost blockers | 3+ ghost blockers |
| Approval Flow | 10% | No pending >2 days | 3+ approvals pending |
| Accountability | 15% | No cascades | 2+ persons with 3+ overdue |

## Role Detection
Cascade: program.accountable_id → director
         project.owner_id → pm
         issue.assignee_id → engineer
         workspace.role fallback

## Deterministic Pre-Checks
These run BEFORE the LLM reasoning call to catch obvious signals mechanically:
1. Ghost blocker: issue.state = 'in_progress' AND updated_at < 3 business days ago
2. Approval bottleneck: approval.state IN (null, 'changes_requested') AND age > 2 business days
3. Blocker chain: parent issue in (todo, in_progress) with 3+ transitive children
4. Scope creep: document_history shows sprint-association creation after sprint.started_at
```

### 6.2 Module Architecture for `api/src/services/fleetgraph/`

```
api/src/services/fleetgraph/
├── index.ts                 # Re-exports
├── graph-executor.ts        # ✅ Orchestrates proactive + on-demand flows
├── graph-state.ts           # ✅ State creation + immutable update helpers
├── bedrock.ts               # ✅ AWS Bedrock Claude client
├── nodes-fetch.ts           # ✅ Data fetching nodes (7 fetchers)
├── nodes-reasoning.ts       # ✅ LLM reasoning nodes (5 nodes)
├── nodes-action.ts          # ✅ Format, persist, output nodes
├── deterministic-signals.ts # 🆕 Non-LLM signal detection (ghost blocker, approval, chain, scope creep)
├── health-score.ts          # 🆕 Health score computation
├── role-detection.ts        # 🆕 RACI-based role detection
├── execute-mutation.ts      # 🆕 Ship API write operations (post comment, reassign, state change)
└── __tests__/
    ├── deterministic-signals.test.ts
    ├── health-score.test.ts
    ├── role-detection.test.ts
    └── integration.test.ts
```

### 6.3 TypeScript Interfaces (Additions/Refinements)

Types already exist in `shared/src/types/fleetgraph.ts`. Key additions needed:

```typescript
// === New: Deterministic signal result (pre-LLM) ===
export interface DeterministicSignal {
  signal_type: SignalType;
  severity: Severity;
  title: string;
  description: string;
  affected_entities: Array<{ type: string; id: string; title?: string }>;
  data: Record<string, any>;
  /** Always 1.0 for deterministic signals */
  confidence: 1.0;
  source: 'deterministic';
}

// === New: Health score computation input ===
export interface HealthScoreInput {
  project_id: string;
  findings: Finding[];
  sprint_completion_rate?: number; // done / total for current sprint
  total_issues: number;
  team_size: number;
}

// === New: Mutation execution result ===
export interface MutationResult {
  success: boolean;
  action_type: ProposedAction['type'];
  entity_id: string;
  error?: string;
  /** Ship API response */
  response?: Record<string, any>;
}

// === New: Role detection result ===
export interface DetectedRole {
  role: 'director' | 'pm' | 'engineer';
  source: 'program_accountable' | 'project_owner' | 'issue_assignee' | 'workspace_role';
  person_id: string;
  /** The entity that determined the role */
  determining_entity_id?: string;
}

// === Existing types that need no changes ===
// FleetGraphState — complete
// Finding — complete
// CompoundFinding — complete
// RootCause — complete
// RecoveryOption — complete (unused but type-ready)
// ProposedAction — complete
// PrioritizedAction — complete (unused but type-ready)
// DraftedArtifact — complete
// FleetGraphInsight — complete
// ProjectHealthScore — complete
// HealthSubScore — complete
```

### 6.4 LangGraph Node Map

| Node | Purpose | Inputs | Outputs | Branch Conditions |
|------|---------|--------|---------|-------------------|
| `fetch_activity` | Gate: check if project has new activity | workspace_id, last_checked | activity map | No activity → `log_clean_run` |
| `fetch_issues` | Load issues for scope | project/sprint IDs | issues[] | — |
| `fetch_sprint_detail` | Load sprint metadata | sprint IDs | sprints[] | — |
| `fetch_project_detail` | Load project RACI, approvals | project IDs | projects[] | — |
| `fetch_team` | Load team roster (cached) | workspace_id | team[] | — |
| `fetch_history` | Load document change history | issue IDs | document_history[] | — |
| `fetch_accountability` | Load overdue items | workspace_id | accountability_items[] | — |
| `detect_deterministic` | **NEW** — Mechanical signal detection | issues, sprints, associations | DeterministicSignal[] | — |
| `reason_health_check` | LLM-powered anomaly detection | all fetched data + deterministic signals | Finding[] | No findings → `log_clean_run` |
| `reason_severity_triage` | Rank + filter + suppress | findings, suppressed_hashes | sorted findings | — |
| `reason_compound_insight` | Merge related findings | findings with shared entities | CompoundFinding[] | Only if 2+ findings share entity |
| `reason_root_cause` | Explain WHY | finding + document_history | RootCause[] | Only for medium+ severity |
| `reason_query_response` | On-demand chat answer | question + context + findings | response_draft | On-demand only |
| `compute_health_score` | **NEW** — Composite health number | findings + sprint data | ProjectHealthScore | Always (proactive) |
| `generate_insight` | Format for display | findings + root_causes | formatted insights | — |
| `draft_artifact` | Draft comment/update | high-severity finding + root_cause | DraftedArtifact | Only for high/critical |
| `compose_chat_response` | Assemble chat reply | response_draft + findings | final response | On-demand only |
| `surface_insight` | Persist to DB | formatted insights | — | — |
| `persist_narrative` | Append to narrative log | project summaries | — | — |
| `log_clean_run` | Update timestamps | workspace state | — | — |
| `execute_mutation` | **NEW** — Apply approved write | ProposedAction | MutationResult | Only after HITL approval |

---

## 7. First Vertical Slice — Ghost Blocker Detection (Hardened)

### Why Ghost Blocker

It's the simplest signal to detect deterministically, has the clearest success criteria, exercises the full pipeline (detect → triage → root cause → surface), and is already partially implemented (heuristic fallback exists).

### Backend Flow

```
1. fetch_activity → activity detected
2. fetch_issues + fetch_sprint_detail + fetch_team (parallel)
3. fetch_history
4. detect_deterministic (NEW) → finds issues in_progress >3 business days
5. reason_health_check → LLM enriches with context (assignee load, issue complexity)
6. reason_severity_triage → rank by staleness
7. reason_root_cause → explain why (assignee overloaded? dependency? abandoned?)
8. generate_insight → format card
9. surface_insight → persist to fleetgraph_insights
10. log_clean_run → update timestamps
```

### API Contracts

**Proactive trigger:**
```
POST /api/fleetgraph/run
Headers: Authorization: Bearer <api_token>
Body: { workspace_id: string }
Response: { trace: ExecutionTrace, insights_created: number }
```

**Fetch insights:**
```
GET /api/fleetgraph/insights?entity_id=<sprint_id>&severity=medium,high
Response: {
  insights: [{
    id: "uuid",
    severity: "medium",
    category: "ghost_blocker",
    title: "Stale issue: Implement auth flow",
    content: {
      description: "Issue #42 has been in_progress for 5 days with no activity.",
      data: { days_stale: 5, assignee: "Sam", assignee_load: 12 }
    },
    root_cause: {
      explanation: "Sam was reassigned to Project Beta in Week 11...",
      contributing_factors: [{ factor: "Cross-project allocation", evidence: "3 active projects" }]
    },
    status: "pending",
    created_at: "2026-03-20T10:00:00Z"
  }]
}
```

### Implementation: `deterministic-signals.ts`

```typescript
import type { Finding, DeterministicSignal, Severity } from '@ship/shared';

/**
 * Detect ghost blockers without LLM — pure data analysis.
 *
 * A ghost blocker is an issue where:
 * - state = 'in_progress'
 * - No document_history entry in last 3 business days
 * - OR updated_at > 3 business days ago (fallback if no history)
 */
export function detectGhostBlockers(
  issues: any[],
  documentHistory: any[],
  now: Date = new Date()
): DeterministicSignal[] {
  const signals: DeterministicSignal[] = [];
  const threeBizDaysAgo = subtractBusinessDays(now, 3);

  // Build a map of most recent history entry per issue
  const lastActivityMap = new Map<string, Date>();
  for (const entry of documentHistory) {
    const issueId = entry.document_id;
    const entryDate = new Date(entry.created_at);
    const existing = lastActivityMap.get(issueId);
    if (!existing || entryDate > existing) {
      lastActivityMap.set(issueId, entryDate);
    }
  }

  for (const issue of issues) {
    if (issue.properties?.state !== 'in_progress') continue;

    const lastActivity = lastActivityMap.get(issue.id)
      || new Date(issue.updated_at);

    if (lastActivity >= threeBizDaysAgo) continue;

    const daysStale = Math.floor(
      (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)
    );

    const severity: Severity = daysStale >= 7 ? 'high' : daysStale >= 5 ? 'medium' : 'low';

    signals.push({
      signal_type: 'ghost_blocker',
      severity,
      title: `Stale issue: ${issue.title || 'Untitled'}`,
      description: `Issue has been in_progress for ${daysStale} days with no activity since ${lastActivity.toISOString().slice(0, 10)}.`,
      affected_entities: [
        { type: 'issue', id: issue.id, title: issue.title },
        ...(issue.properties?.assignee_id
          ? [{ type: 'person', id: issue.properties.assignee_id }]
          : []),
      ],
      data: {
        days_stale: daysStale,
        last_activity: lastActivity.toISOString(),
        assignee_id: issue.properties?.assignee_id || null,
        priority: issue.properties?.priority || null,
        estimate: issue.properties?.estimate || null,
      },
      confidence: 1.0,
      source: 'deterministic',
    });
  }

  return signals;
}

/**
 * Detect approval bottlenecks without LLM.
 *
 * An approval bottleneck is:
 * - plan_approval.state is null (never submitted) or 'changes_requested'
 * - Sprint has been active for >2 business days
 * - OR review_approval with same conditions
 */
export function detectApprovalBottlenecks(
  sprints: any[],
  documentHistory: any[],
  now: Date = new Date()
): DeterministicSignal[] {
  const signals: DeterministicSignal[] = [];
  const twoBizDaysAgo = subtractBusinessDays(now, 2);

  for (const sprint of sprints) {
    const props = sprint.properties || {};
    if (props.status === 'completed') continue;

    // Check plan approval
    const planApproval = props.plan_approval;
    if (planApproval?.state === 'changes_requested' || (props.status === 'active' && !planApproval?.state)) {
      const stateDate = planApproval?.approved_at
        ? new Date(planApproval.approved_at)
        : new Date(sprint.started_at || sprint.created_at);

      if (stateDate < twoBizDaysAgo) {
        const daysWaiting = Math.floor(
          (now.getTime() - stateDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        signals.push({
          signal_type: 'approval_bottleneck',
          severity: daysWaiting >= 5 ? 'high' : 'medium',
          title: `Plan approval pending: ${sprint.title || 'Sprint'}`,
          description: `Sprint plan ${planApproval?.state === 'changes_requested' ? 'has changes requested' : 'has not been submitted'} for ${daysWaiting} days.`,
          affected_entities: [
            { type: 'sprint', id: sprint.id, title: sprint.title },
          ],
          data: {
            approval_type: 'plan',
            approval_state: planApproval?.state || null,
            days_waiting: daysWaiting,
            owner_id: props.owner_id,
          },
          confidence: 1.0,
          source: 'deterministic',
        });
      }
    }

    // Check review approval (similar logic)
    const reviewApproval = props.review_approval;
    if (reviewApproval?.state === 'changes_requested') {
      const stateDate = reviewApproval.approved_at
        ? new Date(reviewApproval.approved_at)
        : new Date(sprint.updated_at || sprint.created_at);

      if (stateDate < twoBizDaysAgo) {
        const daysWaiting = Math.floor(
          (now.getTime() - stateDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        signals.push({
          signal_type: 'approval_bottleneck',
          severity: daysWaiting >= 5 ? 'high' : 'medium',
          title: `Review approval pending: ${sprint.title || 'Sprint'}`,
          description: `Sprint review has changes requested for ${daysWaiting} days.`,
          affected_entities: [
            { type: 'sprint', id: sprint.id, title: sprint.title },
          ],
          data: {
            approval_type: 'review',
            approval_state: reviewApproval.state,
            days_waiting: daysWaiting,
            owner_id: props.owner_id,
          },
          confidence: 1.0,
          source: 'deterministic',
        });
      }
    }
  }

  return signals;
}

// === Utility ===

function subtractBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return result;
}
```

### Integration Point

In `nodes-reasoning.ts`, modify `reasonHealthCheck` to run deterministic signals first:

```typescript
import { detectGhostBlockers, detectApprovalBottlenecks } from './deterministic-signals.js';

export async function reasonHealthCheck(state: FleetGraphState): Promise<FleetGraphState> {
  // 1. Run deterministic detection first
  const deterministicFindings: Finding[] = [
    ...detectGhostBlockers(state.data.issues, state.data.document_history).map(toFinding),
    ...detectApprovalBottlenecks(state.data.sprints, state.data.document_history).map(toFinding),
  ];

  // 2. If deterministic signals found something, include them as context for LLM
  // 3. LLM call (existing code) — now has deterministic findings as additional context
  // 4. Merge: deterministic findings take precedence (confidence: 1.0)

  // ... existing Bedrock call with deterministicFindings included in prompt ...
  // ... merge results, dedup by signal_type + entity_id ...
}

function toFinding(signal: DeterministicSignal): Finding {
  return {
    id: uuid(),
    ...signal,
  };
}
```

### Test Cases

```typescript
// deterministic-signals.test.ts

describe('detectGhostBlockers', () => {
  it('detects issue in_progress >3 business days with no history', () => {
    const now = new Date('2026-03-20T12:00:00Z'); // Friday
    const issues = [{
      id: 'issue-1',
      title: 'Implement auth',
      properties: { state: 'in_progress', assignee_id: 'person-1' },
      updated_at: '2026-03-14T10:00:00Z', // Saturday — 4 biz days ago (Mon-Thu)
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].signal_type).toBe('ghost_blocker');
    expect(result[0].severity).toBe('medium'); // 6 calendar days, 4 biz days
    expect(result[0].confidence).toBe(1.0);
  });

  it('does NOT flag issue updated within 3 business days', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const issues = [{
      id: 'issue-2',
      title: 'Recent issue',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-18T10:00:00Z', // Wednesday — 2 biz days ago
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(0);
  });

  it('does NOT flag issues in done state', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const issues = [{
      id: 'issue-3',
      title: 'Done issue',
      properties: { state: 'done' },
      updated_at: '2026-03-01T10:00:00Z',
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(0);
  });

  it('uses document_history for more accurate last activity', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const issues = [{
      id: 'issue-4',
      title: 'Active via history',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-10T10:00:00Z', // Old updated_at
    }];
    const history = [{
      document_id: 'issue-4',
      field: 'properties.priority',
      created_at: '2026-03-19T10:00:00Z', // Yesterday — recent!
    }];
    const result = detectGhostBlockers(issues, history, now);
    expect(result).toHaveLength(0); // History shows recent activity
  });

  it('assigns high severity for 7+ day stale issues', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const issues = [{
      id: 'issue-5',
      title: 'Very stale',
      properties: { state: 'in_progress' },
      updated_at: '2026-03-05T10:00:00Z', // 15 calendar days
    }];
    const result = detectGhostBlockers(issues, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('high');
  });
});

describe('detectApprovalBottlenecks', () => {
  it('detects plan approval pending >2 business days', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const sprints = [{
      id: 'sprint-1',
      title: 'Sprint 32',
      properties: {
        status: 'active',
        plan_approval: { state: 'changes_requested', approved_at: '2026-03-16T10:00:00Z' },
        owner_id: 'person-1',
      },
      started_at: '2026-03-16T00:00:00Z',
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].signal_type).toBe('approval_bottleneck');
    expect(result[0].data.approval_type).toBe('plan');
  });

  it('does NOT flag completed sprints', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const sprints = [{
      id: 'sprint-2',
      title: 'Sprint 31',
      properties: {
        status: 'completed',
        plan_approval: { state: 'changes_requested', approved_at: '2026-03-01T10:00:00Z' },
      },
    }];
    const result = detectApprovalBottlenecks(sprints, [], now);
    expect(result).toHaveLength(0);
  });
});
```

---

## Appendix: Assumptions Register

| # | Assumption | Impact if Wrong | Validation Method |
|---|-----------|----------------|------------------|
| 1 | `planned_issue_ids` does NOT exist on WeekProperties | Scope creep detection must use document_history timestamps | Check `shared/src/types/document.ts` — **Confirmed: not present** |
| 2 | `capacity_hours` exists on PersonProperties | Team overload can use hours, not just issue count | Check person documents in DB — **Unverified** |
| 3 | Sprint dates derivable from workspace start + sprint_number | Sprint-relative timing calculations work | Check dashboard.ts formula — **Confirmed** |
| 4 | `document_history` tracks association creation | Scope creep needs association timestamps | Check migration 020 triggers — **Unverified** |
| 5 | `accountable_id` is populated on programs/projects | Role detection and escalation work | Check seed data — **Unverified** |
| 6 | Bedrock uses Claude Sonnet (not Opus) for cost model | Cost estimates accurate | Check bedrock.ts model param — **Needs verification** |
