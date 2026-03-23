# Weekly Commits — Design Specification

**Date:** 2026-03-22
**Status:** Approved
**Replaces:** 15-Five weekly planning

## Problem

15-Five has no structural connection between individual weekly commitments and organizational strategic goals (Rally Cries, Defining Objectives, Outcomes). Managers lack visibility into how team members' weekly work maps to RCDO hierarchy, making it impossible to identify misalignment until it's too late.

## Solution

A production-ready micro-frontend module that enforces the connection between weekly work and strategic goals through a complete weekly lifecycle: commit entry with RCDO linking, Eisenhower prioritization, time-based state transitions, manual reconciliation, and read-only manager dashboards.

## Architectural Decision: Separate Domain, Not a Document Type

Ship's Unified Document Model treats all content as documents in a single table. Weekly Commits intentionally breaks from this pattern because:

1. **Separate bounded context.** RCDO hierarchy and weekly commit lifecycles are a distinct domain with their own state machine, scheduled transitions, and relational integrity (enforced foreign keys between rally cries → objectives → outcomes → commit items). This does not fit the property-bag document model.
2. **Separate service.** The Java 21 backend is a standalone service with its own schema, deployable independently. It communicates with Ship only through the proxy layer.
3. **Micro-frontend isolation.** The UI is a federated remote — it shares React and auth context with Ship, but owns its own routing, state, and components.

Ship's document model remains untouched. Weekly Commits is a peer system that integrates via Module Federation (frontend) and HTTP proxy (backend), not by extending Ship's data model.

**Philosophy enforcement:** Ship's `/ship-philosophy-reviewer` will flag new tables as violations. The `weekly-commits/` directory is a separate project outside Ship's monorepo and is not subject to Ship's philosophy enforcement. Only changes to Ship's own codebase (the host config and proxy route) go through philosophy review.

## System Architecture

Three deployable units:

### 1. Ship (Vite Host)

The existing Ship application. Gets `@module-federation/vite` added to its Vite config. Exposes shared dependencies (React, React Router, auth context). Dynamically loads the Weekly Commits remote at `/weekly-commits`. Ship's Express server proxies API requests to the Java service, injecting auth context.

### 2. Weekly Commits Micro-Frontend (Vite Remote)

New standalone Vite + React + TypeScript (strict mode) app. Exposes a root `WeeklyCommitsApp` component via Module Federation. Consumes shared React/auth from the host. Owns all UI: commit entry, Eisenhower matrix, reconciliation, manager dashboard.

### 3. Weekly Commits Java Service (Spring Boot 3 / Java 21)

Owns the domain: RCDO hierarchy, commits, lifecycle state machine, reconciliation, carry-forward. Exposes a REST API. Ship's Express server proxies requests to it (adding auth context via `X-User-Id` and `X-Org-Id` headers), so the micro-frontend calls Ship's API which forwards to Java.

### Data Flow

```
Browser → Ship Host (Vite) → Weekly Commits Remote (federated)
                                    ↓
                              Ship Express API (/api/wc/*)
                                    ↓ (proxy + auth header injection)
                              Java 21 Service (/api/v1/*, Spring Boot 3)
                                    ↓
                              PostgreSQL (new schema/tables)
```

## Data Model

### RCDO Hierarchy

```sql
CREATE TABLE rally_cries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    org_id          VARCHAR(100) NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE defining_objectives (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rally_cry_id    UUID NOT NULL REFERENCES rally_cries(id),
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    owner_id        VARCHAR(100) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outcomes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    defining_objective_id UUID NOT NULL REFERENCES defining_objectives(id),
    title               VARCHAR(255) NOT NULL,
    description         TEXT,
    measurable_target   VARCHAR(255),
    current_value       VARCHAR(255),
    owner_id            VARCHAR(100) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Weekly Commits

```sql
CREATE TABLE weekly_commits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         VARCHAR(100) NOT NULL,
    org_id          VARCHAR(100) NOT NULL,
    week_start_date DATE NOT NULL,  -- Always a Monday
    week_end_date   DATE NOT NULL,  -- Always a Sunday
    status          VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT', 'LOCKED', 'RECONCILING', 'RECONCILED')),
    locked_at       TIMESTAMPTZ,
    reconciled_at   TIMESTAMPTZ,
    version         INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, week_start_date)
);

CREATE TABLE commit_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    weekly_commit_id  UUID NOT NULL REFERENCES weekly_commits(id),
    title             VARCHAR(500) NOT NULL,
    description       TEXT,
    outcome_id        UUID NOT NULL REFERENCES outcomes(id),
    urgency           VARCHAR(4) NOT NULL CHECK (urgency IN ('HIGH', 'LOW')),
    importance        VARCHAR(4) NOT NULL CHECK (importance IN ('HIGH', 'LOW')),
    sort_order        INTEGER NOT NULL DEFAULT 0,
    completion_status VARCHAR(10) DEFAULT 'PENDING'
                      CHECK (completion_status IN ('PENDING', 'COMPLETED', 'PARTIAL', 'NOT_DONE')),
    completion_notes  TEXT,
    carried_from_id   UUID REFERENCES commit_items(id),
    version           INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Key Constraints

- Every `commit_item` must link to an `outcome`, which chains up to a `defining_objective` and `rally_cry` — this enforces strategic alignment.
- `weekly_commits` is unique on `(user_id, week_start_date)` — one per person per week.
- `carried_from_id` creates a traceability chain across weeks.

## Lifecycle State Machine

### States

| State | Description | User Actions Allowed |
|-------|-------------|---------------------|
| DRAFT | Planning phase (prior week through Sunday) | Add, edit, delete, reorder commit items |
| LOCKED | Execution phase (Monday–Friday) | Read-only view of commits |
| RECONCILING | Self-reporting phase (Friday 5 PM–Sunday) | Set completion status + notes per item |
| RECONCILED | Week complete | Read-only. Carry-forward has been triggered |

### Transitions

| From | To | Trigger | Effect |
|------|----|---------|--------|
| DRAFT | LOCKED | Scheduled: Monday 8:00 AM | Snapshot commits. No adds/edits/deletes. Week begins. |
| LOCKED | RECONCILING | Scheduled: Friday 5:00 PM | Unlocks completion fields. User marks items done/partial/not done. |
| RECONCILING | RECONCILED | User clicks "Submit Reconciliation" | Locks reconciliation. Triggers automatic carry-forward. |
| RECONCILED | next DRAFT | Automatic on reconciliation submit | Items with PARTIAL or NOT_DONE cloned into next week's DRAFT with `carried_from_id` set. |

### Edge Cases

- **Empty DRAFT at lock time:** Week still locks. Manager dashboard flags this.
- **User doesn't reconcile by Sunday:** Stays in RECONCILING. Next week's DRAFT is created by the Monday lock job regardless (without carry-forwards). User can reconcile late.
- **Carried items:** Appear in new DRAFT pre-linked to their original outcome. User can edit, re-prioritize, or delete them.

## Eisenhower Matrix (Chess Layer)

Each commit item has two axes:
- **Urgency:** HIGH or LOW
- **Importance:** HIGH or LOW

This produces four quadrants:

| Quadrant | Urgency | Importance | Label |
|----------|---------|------------|-------|
| Q1 | HIGH | HIGH | Do First |
| Q2 | LOW | HIGH | Schedule |
| Q3 | HIGH | LOW | Delegate |
| Q4 | LOW | LOW | Eliminate |

Items are displayed in the Eisenhower grid during DRAFT state, allowing the user to visualize their prioritization. Items can be reordered within a quadrant via `sort_order`.

## UI Views

### 1. Commit Entry View (DRAFT state)

- RCDO cascade selectors: Rally Cry → Defining Objective → Outcome (each filters the next)
- Title input + optional description
- Urgency and Importance toggle buttons (HIGH/LOW)
- Eisenhower matrix grid displaying all commits by quadrant
- Carried-forward items tagged with a visual indicator and link to prior week
- Add, edit, delete, and reorder actions

### 2. Locked View (LOCKED state)

- Read-only checklist of committed items
- Banner showing "Week is in progress. Reconciliation opens Friday 5:00 PM."
- Items displayed with their RCDO linkage and quadrant

### 3. Reconciliation View (RECONCILING state)

- Each commit item shows:
  - Title and RCDO linkage
  - Completion status dropdown: COMPLETED / PARTIAL / NOT_DONE
  - Notes text field
  - Color-coded border per status (green/amber/red)
- Summary bar: count of Completed, Partial, Not Done, Total
- "Submit Reconciliation" button with note that incomplete items carry forward

### 4. Manager Dashboard (read-only)

- Team summary cards: count of Reconciled, Reconciling, Still Locked members + average completion %
- Per-member rows: name, lifecycle status, completion breakdown, primary Rally Cry
- RCDO alignment view: bar chart showing commit distribution across Rally Cries
- Week selector to view historical weeks

## REST API

### RCDO Hierarchy

```
GET    /api/v1/rally-cries                          # List active rally cries
POST   /api/v1/rally-cries                          # Create rally cry
GET    /api/v1/rally-cries/{id}/objectives           # Objectives under a rally cry
POST   /api/v1/rally-cries/{id}/objectives           # Create defining objective
GET    /api/v1/objectives/{id}/outcomes              # Outcomes under an objective
POST   /api/v1/objectives/{id}/outcomes              # Create outcome
```

### Weekly Commits

```
GET    /api/v1/weekly-commits/current                # Current week for authed user
GET    /api/v1/weekly-commits/{weekStart}            # Specific week
POST   /api/v1/weekly-commits/{weekStart}/items      # Add commit item (DRAFT only)
PUT    /api/v1/weekly-commits/{weekStart}/items/{id} # Edit commit item
DELETE /api/v1/weekly-commits/{weekStart}/items/{id} # Remove commit item (DRAFT only)
```

### Reconciliation

```
PUT    /api/v1/weekly-commits/{weekStart}/items/{id}/reconcile   # Set completion status + notes
POST   /api/v1/weekly-commits/{weekStart}/submit-reconciliation  # Submit → RECONCILED
```

### Manager Dashboard

```
GET    /api/v1/manager/team-summary?weekStart={date}    # Team roll-up
GET    /api/v1/manager/rcdo-alignment?weekStart={date}   # RCDO alignment stats
```

### Auth Proxy

Ship's Express server proxies `/api/wc/*` to the Java service at `/api/v1/*`, injecting `X-User-Id`, `X-Org-Id`, and `X-User-Role` headers from the session. This single proxy prefix covers all Weekly Commits routes (RCDO, commits, manager dashboard). The Java service trusts these headers (internal network communication only).

Proxy mapping examples:
- `GET /api/wc/rally-cries` → `GET /api/v1/rally-cries`
- `POST /api/wc/weekly-commits/2026-03-23/items` → `POST /api/v1/weekly-commits/2026-03-23/items`
- `GET /api/wc/manager/team-summary?weekStart=2026-03-23` → `GET /api/v1/manager/team-summary?weekStart=2026-03-23`

### Manager Authorization

Manager access is determined by Ship's existing user role system. Ship injects `X-User-Role` in the proxy headers. The Java service checks this header on `/api/v1/manager/*` endpoints — only users with role `manager` or `admin` can access them. The Java service also scopes the team query by `org_id` from `X-Org-Id`, so managers only see their own org's data.

## Micro-Frontend Integration

### Ship Host Config (vite.config.ts addition)

```typescript
import { federation } from '@module-federation/vite';

federation({
  name: 'ship-host',
  remotes: {
    weeklyCommits: 'http://localhost:3001/assets/remoteEntry.js'
  },
  shared: ['react', 'react-dom', 'react-router-dom']
})
```

### Weekly Commits Remote Config (vite.config.ts)

```typescript
import { federation } from '@module-federation/vite';

federation({
  name: 'weekly-commits',
  filename: 'remoteEntry.js',
  exposes: {
    './App': './src/WeeklyCommitsApp.tsx'
  },
  shared: ['react', 'react-dom', 'react-router-dom']
})
```

### Ship Route Integration

```tsx
const WeeklyCommits = React.lazy(() => import('weeklyCommits/App'));

// In Ship's router:
<Route path="/weekly-commits/*" element={
  <Suspense fallback={<LoadingSpinner />}>
    <WeeklyCommits />
  </Suspense>
} />
```

## Scheduled Jobs

| Job | Cron Expression | Action |
|-----|----------------|--------|
| `WeeklyLockJob` | `0 0 8 * * MON` (Monday 8 AM) | Transition all DRAFT → LOCKED |
| `ReconciliationOpenJob` | `0 0 17 * * FRI` (Friday 5 PM) | Transition all LOCKED → RECONCILING |

Both jobs are idempotent — safe to re-run if they fail.

### Timezone Handling

Scheduled transitions run in the **org's configured timezone**. Each org has a `timezone` field (e.g., `America/New_York`). The cron jobs query all orgs, compute the local time for each, and transition only the orgs where the local time matches the trigger (8 AM Monday or 5 PM Friday). This supports multi-timezone deployments without per-user complexity.

The `org_timezone` is stored in a configuration table managed by the Java service:

```sql
CREATE TABLE org_settings (
    org_id    VARCHAR(100) PRIMARY KEY,
    timezone  VARCHAR(50) NOT NULL DEFAULT 'America/New_York'
);
```

**"Current week" resolution:** The `GET /api/v1/weekly-commits/current` endpoint resolves the current week based on the requesting user's org timezone (looked up from `org_settings` via the `X-Org-Id` header). "Current week" is the Monday-Sunday span containing "today" in the org's timezone.

## Error Handling

- **Java service down:** Ship's proxy returns 503. Frontend shows banner: "Weekly Commits is temporarily unavailable" with retry button.
- **State transition violations:** Java service enforces all state rules. Returns 409 Conflict with reason (e.g., "Cannot add items — week is LOCKED"). Frontend disables actions based on current state but server is the authority.
- **Missing RCDO link:** Java service rejects commit items without a valid `outcome_id`. Returns 400 Bad Request.
- **Stale data:** Optimistic concurrency via `version` integer field on `weekly_commits` and `commit_items`. Clients send `If-Match: {version}` header on PUT/DELETE requests. Server returns 409 Conflict if the version doesn't match, with the current version in the response so the client can retry.
- **Late reconciliation:** Allowed indefinitely. Next week's DRAFT created by Monday lock job regardless. Carry-forwards only happen when reconciliation is submitted.

## Testing Strategy

| Layer | Tool | What's Tested |
|-------|------|---------------|
| Java unit tests | JUnit 5 + Mockito | State machine transitions, carry-forward logic, RCDO validation |
| Java integration tests | Spring Boot Test + Testcontainers (PostgreSQL) | Repository queries, API endpoints, scheduled jobs |
| Frontend unit tests | Vitest + React Testing Library | Component rendering per state, Eisenhower matrix placement, form validation |
| Frontend integration tests | Vitest + MSW | API client calls with mocked Java service responses |
| E2E tests | Playwright | Full lifecycle: create commits → lock → reconcile → verify carry-forward |
| Federation tests | Dev environment | Remote loads correctly in host, shared deps don't duplicate |

## Project Structure

```
weekly-commits/
├── service/                  # Java 21 Spring Boot 3
│   ├── src/main/java/
│   │   └── com/ship/weeklycommits/
│   │       ├── controller/   # REST controllers
│   │       ├── service/      # Business logic + state machine
│   │       ├── repository/   # Spring Data JPA
│   │       ├── model/        # JPA entities
│   │       ├── dto/          # Request/response DTOs
│   │       └── scheduler/    # Cron jobs (lock, reconciliation open)
│   └── src/main/resources/
│       └── db/migration/     # Flyway SQL migrations
├── web/                      # Vite + React micro-frontend
│   ├── src/
│   │   ├── components/       # UI components per view
│   │   ├── hooks/            # React hooks (useWeeklyCommit, useRCDO, etc.)
│   │   ├── api/              # API client (typed, calls Ship proxy)
│   │   ├── state/            # State management (Zustand stores)
│   │   └── WeeklyCommitsApp.tsx  # Federated entry point
│   └── vite.config.ts        # Module Federation remote config
└── e2e/                      # Playwright tests
```

## Tech Stack Summary

| Component | Technology |
|-----------|-----------|
| Frontend | React 18, TypeScript (strict), Vite, @module-federation/vite |
| Backend | Java 21, Spring Boot 3, Spring Data JPA, Flyway |
| Database | PostgreSQL (new tables in existing instance) |
| Host integration | Ship (Vite host), Express proxy with auth injection |
| Testing | JUnit 5, Vitest, React Testing Library, MSW, Playwright, Testcontainers |
