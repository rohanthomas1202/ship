# FleetGraph Demo Video Script

*One clear story: Blocker Chain detection → Graph run → Trace → HITL approval → Result*

**Duration target:** 3-5 minutes

---

## Setup (before recording)

```bash
# 1. Start the app
pnpm dev

# 2. Seed test data (run immediately before recording)
npx tsx api/src/db/seed-fleetgraph.ts

# 3. Open tabs:
#    - Ship UI: http://localhost:5173
#    - LangSmith: https://smith.langchain.com/ (project "fleetgraph")
#    - Terminal for triggering the scan
```

---

## Scene 1: Show the Problem (30 sec)

**Show:** Ship UI — navigate to the FG-Chain project.

**Narrate:**
> "Here's a project in Ship. One issue — 'Design auth middleware' — has been in progress for 5 days with no updates. What nobody on the team has noticed is that this issue is blocking 4 downstream tasks. The team members are context-switching across sprints and don't see the dependency chain. This is the kind of cross-cutting problem a graph agent can catch."

**Click through:**
- The root blocker issue (in_progress, 5 days stale)
- 1-2 blocked child issues (todo state, waiting on parent)
- The parent-child relationship in the UI

---

## Scene 2: Agent Detects It (45 sec)

**Show:** Terminal — trigger the proactive scan.

**Narrate:**
> "FleetGraph runs proactively — it doesn't wait for someone to ask. Let me trigger a scan on this project."

**Run:**
```bash
npx tsx scripts/run-test-cases.ts
# Or show just TC3 output
```

**Narrate as it runs:**
> "The graph starts by fetching data in parallel — issues, sprints, team members. Then deterministic signal detection runs — no LLM needed. It found two things: a ghost blocker on the stale issue, AND a blocker chain where that issue is blocking 4 downstream tasks. Because there are two related findings on the same entity, the graph routes to compound insight analysis — merging them into one recommendation. Then the LLM explains the root cause and drafts a proposed action: a comment to post on the issue."

---

## Scene 3: Show the Trace (60 sec)

**Show:** LangSmith — the proactive trace.

**Narrate:**
> "Every run is traced in LangSmith. Let me show the exact path the graph took."

**Walk through nodes:**
1. `fetch_activity` → "Activity gate passed"
2. `fetch_issues`, `fetch_sprint_detail`, `fetch_team` → "Parallel data fetch"
3. `reason_health_check` → "Deterministic detection found 2 signals — ghost blocker and blocker chain"
4. `reason_severity_triage` → "Ranked by severity"
5. `reason_compound_insight` → "**This node only fires when 2+ findings share the same entity.** It merged both into a coordinated insight."
6. `reason_root_cause` → "LLM explains why — the root issue is stuck, nobody followed up"
7. `draft_artifact` → "Drafted a comment to post"
8. `surface_insight` → "Saved the insight, routed to the PM"

**Key point:**
> "This path is different from a clean run — which stops at fetch_activity. And different from an on-demand query — which routes through detect_role. The graph produces different paths based on what it finds. That's what makes it a graph, not a pipeline."

---

## Scene 4: Human Approves (45 sec)

**Show:** Ship UI — the insight card.

**Narrate:**
> "FleetGraph proposed an action, but it never acts without human approval. Here's the insight card."

**Click through:**
1. Show the insight card with severity, description, proposed comment
2. Read the proposed comment: *"This issue is blocking 4 downstream tasks. Are you stuck? Can we pair or reassign?"*
3. Click **Approve**

**Narrate:**
> "Three choices: approve, dismiss, or snooze. I'll approve. The agent posts the comment, logs it to document_history with automated_by = 'fleetgraph', and creates an audit log entry."

**Show after approval:**
- The comment now visible on the issue

---

## Scene 5: Wrap Up (30 sec)

**Narrate:**
> "That's the full chain: detection, graph, decision, human step, result. The agent caught a blocker chain nobody noticed, traced through a graph with conditional branching, proposed a specific action, and waited for approval before acting."

> "FleetGraph covers 8 use cases across proactive and on-demand modes — ghost blockers, sprint collapse, blocker chains, standup generation, sprint planning, and more. 98 unit tests, 5 end-to-end test cases with matching LangSmith traces, each showing a distinct execution path. All reads are autonomous, all writes require human confirmation."

---

## Talking Points Cheat Sheet

| When showing... | Say... |
|----------------|--------|
| Graph branching | "This node only fires when [condition]. That's what makes it a graph." |
| Deterministic detection | "No LLM needed — confidence 1.0, runs in under 10ms" |
| LLM nodes | "The LLM explains WHY, not just WHAT. Root cause, not just detection." |
| HITL gate | "Reads are autonomous, writes require confirmation. That's the bright line." |
| Different traces | "Compare this trace to the standup trace — completely different path through the same graph." |
| Cost | "Deterministic first, LLM only when needed. ~$35/month for 20 projects." |
