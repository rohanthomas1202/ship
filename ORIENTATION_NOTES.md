# Codebase Orientation Notes

## Repository Overview

**Ship** is a project management and documentation platform built for the US Department of the Treasury. It combines issue tracking, sprint management, wiki documentation, and real-time collaborative editing in a single application.

### Tech Stack
| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18 + TypeScript, Vite, TipTap editor, Yjs CRDTs |
| **Backend** | Express.js + TypeScript, WebSocket (ws) |
| **Database** | PostgreSQL 16 with direct SQL (pg, no ORM) |
| **Monorepo** | pnpm workspaces |
| **Testing** | Vitest (unit), Playwright (E2E) |
| **Deployment** | AWS Elastic Beanstalk (API), S3 + CloudFront (frontend) |

### Directory Structure
```
ship/
├── api/                    # Express backend
│   ├── src/
│   │   ├── routes/         # REST API endpoints
│   │   ├── middleware/     # Auth, visibility, CSRF
│   │   ├── collaboration/  # WebSocket + Yjs sync
│   │   ├── db/             # Schema, migrations, client
│   │   ├── services/       # Business logic (accountability)
│   │   └── utils/          # Document CRUD, helpers
│   └── scripts/            # Benchmarking, deployment
├── web/                    # React frontend
│   ├── src/
│   │   ├── pages/          # Route-level page components
│   │   ├── components/     # Shared UI components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── lib/            # API client, utilities
│   │   └── services/       # File upload, etc.
├── shared/                 # Shared TypeScript types
│   └── src/
│       └── index.ts        # Session timeouts, error codes, types
├── e2e/                    # Playwright E2E tests
├── docs/                   # Architecture documentation
└── scripts/                # Dev, deploy, CI scripts
```

## Data Model

### Unified Document Model
Everything is stored in a single `documents` table (see `api/src/db/schema.sql`):

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type document_type NOT NULL,  -- wiki, issue, project, sprint, person, ...
  title TEXT NOT NULL DEFAULT 'Untitled',
  content JSONB,                         -- TipTap JSON content
  yjs_state BYTEA,                       -- Binary Yjs CRDT state
  properties JSONB DEFAULT '{}',         -- Type-specific metadata
  workspace_id UUID REFERENCES workspaces(id),
  created_by UUID REFERENCES users(id),
  visibility TEXT DEFAULT 'workspace',
  ...
);
```

**Document types:** `wiki`, `issue`, `program`, `project`, `sprint`, `person`, `weekly_plan`, `weekly_retro`, `standup`, `weekly_review`

**Type-specific properties (JSONB):**
- Issues: `state`, `priority`, `assignee_id`, `sprint_number`, `ticket_number`
- Projects: `inferred_status`, `ice_impact`, `ice_confidence`, `ice_ease`
- Sprints: `sprint_number`, `owner_id`, `start_date`, `end_date`

### Document Associations
Cross-references between documents use a junction table:
```sql
CREATE TABLE document_associations (
  document_id UUID REFERENCES documents(id),
  associated_document_id UUID REFERENCES documents(id),
  relationship_type TEXT  -- 'parent', 'project', 'sprint', 'program'
);
```

### Key Tables
| Table | Purpose |
|-------|---------|
| `documents` | All content (issues, projects, sprints, wikis, etc.) |
| `document_associations` | Relationships between documents |
| `users` | User accounts |
| `workspaces` | Multi-tenant workspace isolation |
| `workspace_memberships` | User-workspace roles (admin, member) |
| `sessions` | Session-based authentication |
| `api_tokens` | Bearer token authentication |
| `activity_log` | Audit trail of document changes |

## Request Flow

### Authenticated API Request
1. Client sends request with `session_id` cookie (or `Authorization: Bearer` header)
2. `authMiddleware` (`api/src/middleware/auth.ts`):
   - Combined query: session + user + workspace membership in 1 SQL round-trip
   - Validates session timeouts (15-min inactivity, 12-hr absolute)
   - Attaches `req.userId`, `req.workspaceId`, `req.isSuperAdmin`, `req.workspaceRole`
3. Route handler processes request
4. `visibilityMiddleware` filters results based on workspace access

### CSRF Protection
- Uses `csrf-sync` package
- Client must fetch token via `GET /api/csrf-token` and include as `x-csrf-token` header on mutations

## Real-Time Collaboration

### Architecture (`api/src/collaboration/index.ts`)
- WebSocket endpoint: `/collaboration/{docType}:{docId}`
- Server-authoritative: PostgreSQL is the source of truth
- Yjs CRDT handles conflict-free merging of concurrent edits
- Binary Yjs state stored in `yjs_state` column, JSON backup in `content`
- Persistence debounced to every 2 seconds during active editing

### Client Flow
1. Client opens document → connects WebSocket
2. Server loads `yjs_state` from PostgreSQL into in-memory `Y.Doc`
3. Server sends full state to client via Yjs sync protocol
4. Client edits → Yjs update sent to server → applied to `Y.Doc` → broadcast to other clients
5. Debounced persistence writes `Y.Doc` state back to PostgreSQL

## TypeScript Patterns

### Test Mock Pattern
Tests use typed mock factories instead of `as any`:
```typescript
function mockQueryResult<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}
const mockQuery = pool.query as Mock<(...args: unknown[]) => Promise<QueryResult>>;
```

### API Route Pattern
Routes use Express Router with middleware chains:
```typescript
router.get('/issues', authMiddleware, async (req: Request, res: Response) => { ... });
```

### OpenAPI Integration
All routes are registered with OpenAPI schema for auto-generated Swagger docs and MCP tools.

## Testing Infrastructure

### Unit Tests (Vitest)
- **Run:** `pnpm test`
- **Location:** Co-located with source (`*.test.ts` files)
- **Count:** 28 test files, 451 tests
- **Database:** Mocked via `vi.mock('../db/client.js')`

### E2E Tests (Playwright)
- **Run:** Use `/e2e-test-runner` skill (not `pnpm test:e2e` directly)
- **Location:** `e2e/` directory
- **Fixtures:** `e2e/fixtures/isolated-env.ts` creates required seed data
- **Key specs:** `document-deletion.spec.ts`, `workspace-settings-roles.spec.ts`, `search-ui-navigation.spec.ts`

### Pre-Commit Hooks
- Empty test detection (`scripts/check-empty-tests.sh`)
- API route coverage verification (UI routes must have corresponding API endpoints)
- Compliance scanning (when `comply` CLI is installed)

## Build and Deploy

### Development
```bash
pnpm dev           # Start both API (port 3000) and web (port 5173)
pnpm dev:api       # API server only
pnpm dev:web       # Vite dev server only
```

### Database
```bash
pnpm db:migrate    # Run pending migrations
pnpm db:seed       # Seed with test data (password: admin123)
```

### Production Deployment
```bash
./scripts/deploy.sh prod              # Backend → Elastic Beanstalk
./scripts/deploy-frontend.sh prod     # Frontend → S3/CloudFront
```

## Architecture Assessment

### Strengths
1. **Unified Document Model** — simple, flexible, enables type conversion and reuse
2. **Real-time collaboration** — production-quality Yjs/CRDT implementation
3. **Clean monorepo structure** — shared types, clear package boundaries
4. **Session security** — NIST-compliant timeouts, CSRF protection, secure cookies

### Areas for Improvement (Found During Audit)
1. **Type safety in tests** — heavy use of `as any` to bypass TypeScript (addressed: 71.6% reduction)
2. **Bundle size** — no route-level code splitting (addressed: 85% initial load reduction)
3. **Database queries** — correlated subqueries, missing expression indexes (addressed: LATERAL JOINs + 5 indexes)
4. **Auth overhead** — 3 queries per request (addressed: consolidated to 1)
5. **No ORM** — raw SQL is powerful but error-prone; consider Drizzle or Kysely for type-safe queries
