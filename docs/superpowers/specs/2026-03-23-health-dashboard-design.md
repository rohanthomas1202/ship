# Project Health Dashboard

**Date:** 2026-03-23
**Status:** Approved

## Overview

A dedicated top-level page at `/health` that surfaces FleetGraph insights, project health scores, and signal detection (ghost blockers, blocker chains, sprint collapse) in a workspace-wide view. Replaces the insight cards currently embedded in the FleetGraph chat panel.

## Navigation

- New icon in the icon rail (pulse icon) between Teams and Settings
- Badge on the icon shows count of active high/critical findings
- FleetGraph chat panel keeps Q&A but removes the "Active Findings" section; its badge links to `/health` instead

## Page Layout

Follows the 4-panel pattern: Icon Rail | Sidebar | Main Content | (no properties panel).

### Left Sidebar
- "All Projects" item (default — shows all insights)
- List of projects, each with:
  - Project name
  - Health score badge (color-coded: green >80, yellow 50-80, red <50)
- Click a project to filter the main content to that project

### Main Content

#### Header
- Page title: "Project Health"
- "Run Scan" button with spinner (reuses `useRunProactiveScan` hook)
- Last scan timestamp (from most recent `fleetgraph_state.last_checked_at`)

#### Section 1: Health Scores Grid
- Card per project (responsive grid, 3 columns on desktop)
- Each card shows:
  - Project name
  - Overall score (0-100) with color ring/badge
  - 6 sub-score bars: velocity, blockers, workload, freshness, approval, accountability
- Cards are clickable — filters insights below + highlights in sidebar

#### Section 2: Active Insights
- Full-width list of all active insights, sorted by severity (critical > high > medium > low), then by age
- Filter bar: severity dropdown, signal type dropdown
- Each row:
  - Severity badge (color-coded)
  - Signal type label (Ghost Blocker, Blocker Chain, etc.)
  - Title and truncated description
  - Affected entity name (linked to document)
  - Age ("3 days ago")
  - Action buttons: Dismiss (X), Snooze (clock), Approve (check) — same behavior as FleetGraphInsightCard
- Expandable row shows: root cause analysis, contributing factors, recovery options, drafted artifact with edit capability

## API Endpoints (existing, no changes needed)

- `GET /api/fleetgraph/insights` — fetch insights (supports entity_id, severity, status filters)
- `GET /api/fleetgraph/health-scores` — fetch all project health scores
- `POST /api/fleetgraph/run` — trigger proactive scan
- `POST /api/fleetgraph/insights/:id/dismiss`
- `POST /api/fleetgraph/insights/:id/snooze`
- `POST /api/fleetgraph/insights/:id/approve`

## Frontend Changes

### New Files
- `web/src/pages/HealthDashboardPage.tsx` — main page component
- `web/src/components/HealthScoreCard.tsx` — individual project health score card
- `web/src/components/InsightRow.tsx` — insight list row with expand/collapse

### Modified Files
- `web/src/pages/App.tsx` — add `/health` route, add icon rail entry
- `web/src/main.tsx` — register `/health` route
- `web/src/components/FleetGraphChat.tsx` — remove "Active Findings" section, update badge to link to `/health`
- `web/src/hooks/useFleetGraph.ts` — add `useHealthScores` hook

### Hooks (reuse existing + one new)
- `useFleetGraphInsights()` — already exists
- `useRunProactiveScan()` — already exists
- `useDismissInsight()` — already exists
- `useApproveInsight()` — already exists
- `useSnoozeInsight()` — already exists
- `useHealthScores()` — **new**, calls `GET /api/fleetgraph/health-scores`

## No Backend Changes

All API endpoints already exist. No new routes, database changes, or migrations needed.
