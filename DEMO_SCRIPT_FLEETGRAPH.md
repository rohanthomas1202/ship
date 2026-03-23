# FleetGraph Demo Script

*Story: Blocker Chain → Graph Detection → LangSmith Trace → Human Approval → Result*

**Target:** 3-5 minutes | **Practice page:** Open `demo-teleprompter.html` in your browser

---

## Before Recording

```bash
pnpm dev                                        # Start app
npx tsx api/src/db/seed-fleetgraph.ts            # Seed test data (do this RIGHT before recording)
```

Open 3 tabs: Ship UI (`localhost:5173`), LangSmith (project "fleetgraph"), Terminal

---

## Scene 1 — The Problem (30s)

**Screen:** Ship UI → FG-Chain project → root blocker issue

**Say:**
"Here's a project in Ship. This issue — Design auth middleware — has been in progress for 5 days with no updates. What nobody on the team has noticed is that it's blocking four downstream tasks. People are busy, context-switching between sprints, and no one's looking at the dependency chain. This is exactly the kind of cross-cutting problem that's hard for humans to spot — but it's what FleetGraph is built to detect."

**Click:** Show the root blocker issue, then click into 1-2 blocked children to show the parent relationship.

---

## Scene 2 — The Agent Runs (45s)

**Screen:** Terminal

**Say:**
"FleetGraph runs proactively on a schedule — no one has to ask. I'll trigger a scan on this project now."

**Run the scan** (or show pre-recorded TC3 output).

**Say (as results appear):**
"The graph fetched data in parallel — issues, sprints, team. Then deterministic signal detection ran — no LLM needed for this. It found two things: a ghost blocker on the stale issue, and a blocker chain showing it's blocking four tasks. Because both findings involve the same entity, the graph routed to compound insight analysis — that's a conditional branch, not a fixed pipeline. Then the LLM explained the root cause and drafted a comment to post on the issue."

---

## Scene 3 — The Trace (60s)

**Screen:** LangSmith → most recent proactive trace

**Say:**
"Every run is traced in LangSmith. Here's exactly what path the graph took."

**Walk through each node, pointing as you go:**

- **fetch_activity** → "Activity gate passed — this project had recent updates."
- **fetch_issues / sprint / team** → "Three fetch nodes ran in parallel."
- **reason_health_check** → "Deterministic detection — found a ghost blocker and blocker chain. Confidence 1.0, no LLM call."
- **reason_severity_triage** → "Ranked findings by severity."
- **reason_compound_insight** → "This is the key branch — this node **only fires when two or more findings share the same entity**. It merged the ghost blocker and blocker chain into one coordinated insight."
- **reason_root_cause** → "Now the LLM steps in — it explains *why* the issue is stuck, not just *that* it's stuck."
- **draft_artifact** → "Drafted a follow-up comment to propose."
- **surface_insight** → "Saved the insight and routed it to the PM."

**Say:**
"Compare this to a clean run — which exits after fetch_activity. Or a standup request — which routes through generate_standup_draft. Same graph, different paths. That's what makes it a graph, not a pipeline."

---

## Scene 4 — Human Approves (45s)

**Screen:** Ship UI → insight card

**Say:**
"FleetGraph proposed an action, but it never acts without human approval. That's the bright line — reads are autonomous, writes require confirmation. Here's the insight card it surfaced."

**Show the card**, then read the proposed comment aloud:
"This issue is blocking four downstream tasks. Are you stuck? Can we pair or reassign?"

**Say:**
"Three options: approve, dismiss, or snooze. I'll approve."

**Click Approve.**

**Say:**
"The comment is now posted on the issue. It's logged in document_history with automated_by = fleetgraph, and there's an audit log entry tracking who approved what."

**Show:** The comment visible on the issue page.

---

## Scene 5 — Wrap Up (30s)

**Say:**
"That's the full chain the feedback asked for: detection, graph, decision, human step, result. FleetGraph caught a blocker chain nobody noticed, ran through a graph with conditional branching, proposed a specific action with full context, and waited for human approval before acting."

"It covers eight use cases across proactive and on-demand modes. Ninety-eight unit tests, five end-to-end test cases with matching LangSmith traces — each showing a distinct execution path. Deterministic detection first, LLM only when needed. About thirty-five dollars a month for twenty projects."

---

## If You Get Lost — Key Phrases

| Moment | Say This |
|--------|----------|
| Showing a conditional branch | "This node only fires when [condition]. That's what makes it a graph." |
| Deterministic detection | "No LLM needed — confidence 1.0, runs in under 10 milliseconds." |
| LLM reasoning | "The LLM explains *why*, not just *what*." |
| HITL gate | "Reads are autonomous, writes require confirmation." |
| Comparing traces | "Same graph, different paths." |
