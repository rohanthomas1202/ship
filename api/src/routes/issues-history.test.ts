import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';

// --- Mock factory helpers ---

function createQueryResult<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

function emptyQueryResult(): QueryResult<QueryResultRow> {
  return createQueryResult([]);
}

// --- Row types used in mocks ---

interface IssueIdRow {
  id: string;
}

interface HistoryEntryRow {
  id: string;
  field: string;
  old_value: string;
  new_value: string;
  created_at: Date;
  changed_by_id: string;
  changed_by_name: string;
  automated_by: string | null;
}

interface IssueRow {
  id: string;
  title: string;
  properties: Record<string, unknown>;
  sprint_id: string | null;
  ticket_number?: number;
}

// Mock pool before importing routes
const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return { mockClient };
});
vi.mock('../db/client.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockClient),
  },
}));

// Mock visibility middleware
vi.mock('../middleware/visibility.js', () => ({
  getVisibilityContext: vi.fn().mockResolvedValue({ isAdmin: false }),
  VISIBILITY_FILTER_SQL: vi.fn().mockReturnValue('1=1'),
}));

// Mock auth middleware
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, res, next) => {
    req.userId = 'user-123';
    req.workspaceId = 'ws-123';
    next();
  }),
}));

import { pool } from '../db/client.js';
import express from 'express';
import request from 'supertest';
import issuesRouter from './issues.js';

/** Typed reference to the mocked pool.query function */
const mockPoolQuery = pool.query as Mock<(...args: unknown[]) => Promise<QueryResult<QueryResultRow>>>;

/** Typed reference to the mocked mockClient.query function */
const mockClientQuery = mockClient.query as Mock<(...args: unknown[]) => Promise<QueryResult<QueryResultRow>>>;

describe('Issues History API', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockClient defaults after clearAllMocks
    mockClient.query.mockResolvedValue(emptyQueryResult());
    mockClient.release.mockReturnValue(undefined);
    // Reassign pool.connect to a fresh mock returning our test client
    Object.defineProperty(pool, 'connect', {
      value: vi.fn().mockResolvedValue(mockClient),
      writable: true,
      configurable: true,
    });
    app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter);
  });

  describe('POST /api/issues/:id/history', () => {
    it('creates history entry with valid data', async () => {
      const issueId = 'issue-123';

      mockPoolQuery
        // Issue access check
        .mockResolvedValueOnce(createQueryResult<IssueIdRow>([{ id: issueId }]))
        // Insert history
        .mockResolvedValueOnce(emptyQueryResult());

      const res = await request(app)
        .post(`/api/issues/${issueId}/history`)
        .send({
          field: 'verification_failed',
          old_value: '1',
          new_value: 'Test failed: assertion error',
          automated_by: 'claude',
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true });
    });

    it('creates history entry without automated_by', async () => {
      const issueId = 'issue-123';

      mockPoolQuery
        .mockResolvedValueOnce(createQueryResult<IssueIdRow>([{ id: issueId }]))
        .mockResolvedValueOnce(emptyQueryResult());

      const res = await request(app)
        .post(`/api/issues/${issueId}/history`)
        .send({
          field: 'state',
          old_value: 'todo',
          new_value: 'in_progress',
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true });
    });

    it('returns 400 for missing field', async () => {
      const res = await request(app)
        .post('/api/issues/issue-123/history')
        .send({
          old_value: 'test',
          new_value: 'test2',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });

    it('returns 400 for empty field', async () => {
      const res = await request(app)
        .post('/api/issues/issue-123/history')
        .send({
          field: '',
          old_value: 'test',
          new_value: 'test2',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });

    it('returns 400 for field too long', async () => {
      const res = await request(app)
        .post('/api/issues/issue-123/history')
        .send({
          field: 'a'.repeat(101),
          old_value: 'test',
          new_value: 'test2',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });

    it('returns 404 for non-existent issue', async () => {
      mockPoolQuery
        .mockResolvedValueOnce(emptyQueryResult());

      const res = await request(app)
        .post('/api/issues/nonexistent/history')
        .send({
          field: 'verification_failed',
          old_value: '1',
          new_value: 'error details',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Issue not found');
    });

    it('accepts null values', async () => {
      const issueId = 'issue-123';

      mockPoolQuery
        .mockResolvedValueOnce(createQueryResult<IssueIdRow>([{ id: issueId }]))
        .mockResolvedValueOnce(emptyQueryResult());

      const res = await request(app)
        .post(`/api/issues/${issueId}/history`)
        .send({
          field: 'sprint_id',
          old_value: null,
          new_value: 'sprint-456',
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true });
    });
  });

  describe('GET /api/issues/:id/history', () => {
    it('returns history entries with automated_by', async () => {
      const issueId = 'issue-123';
      const historyEntries: HistoryEntryRow[] = [
        {
          id: 'hist-1',
          field: 'state',
          old_value: 'todo',
          new_value: 'in_progress',
          created_at: new Date(),
          changed_by_id: 'user-123',
          changed_by_name: 'Test User',
          automated_by: null,
        },
        {
          id: 'hist-2',
          field: 'verification_failed',
          old_value: '1',
          new_value: 'test assertion failed',
          created_at: new Date(),
          changed_by_id: 'user-123',
          changed_by_name: 'Test User',
          automated_by: 'claude',
        },
      ];

      mockPoolQuery
        // Issue access check
        .mockResolvedValueOnce(createQueryResult<IssueIdRow>([{ id: issueId }]))
        // Get history
        .mockResolvedValueOnce(createQueryResult(historyEntries));

      const res = await request(app)
        .get(`/api/issues/${issueId}/history`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].automated_by).toBeNull();
      expect(res.body[1].automated_by).toBe('claude');
      expect(res.body[1].field).toBe('verification_failed');
    });

    it('returns 404 for non-existent issue', async () => {
      mockPoolQuery
        .mockResolvedValueOnce(emptyQueryResult());

      const res = await request(app)
        .get('/api/issues/nonexistent/history');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Issue not found');
    });
  });

  describe('PATCH /api/issues/:id with claude_metadata', () => {
    it('accepts claude_metadata with telemetry', async () => {
      const issueId = 'issue-123';
      const existingIssue: IssueRow = {
        id: issueId,
        title: 'Test Issue',
        properties: { state: 'todo', priority: 'medium' },
        sprint_id: null,
      };
      const updatedRow: IssueRow = {
        ...existingIssue,
        properties: {
          ...existingIssue.properties,
          state: 'done',
          claude_metadata: {
            updated_by: 'claude',
            story_id: 'test-story',
            confidence: 85,
            telemetry: { iterations: 2, feedback_loops: { type_check: 3, test: 2, build: 1 } },
          },
        },
        ticket_number: 1,
      };

      // Client queries (within transaction)
      mockClientQuery
        // Get existing issue
        .mockResolvedValueOnce(createQueryResult([existingIssue]))
        // Check for children (cascade warning check)
        .mockResolvedValueOnce(emptyQueryResult())
        // BEGIN
        .mockResolvedValueOnce(emptyQueryResult())
        // Log state change (document_history insert)
        .mockResolvedValueOnce(emptyQueryResult())
        // Update issue
        .mockResolvedValueOnce(createQueryResult([updatedRow]))
        // Fetch updated issue after UPDATE
        .mockResolvedValueOnce(createQueryResult([updatedRow]))
        // COMMIT
        .mockResolvedValueOnce(emptyQueryResult());

      // Pool queries (post-commit, non-transactional)
      mockPoolQuery
        // Get belongs_to associations
        .mockResolvedValueOnce(emptyQueryResult());

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({
          state: 'done',
          claude_metadata: {
            updated_by: 'claude',
            story_id: 'test-story',
            confidence: 85,
            telemetry: {
              iterations: 2,
              feedback_loops: { type_check: 3, test: 2, build: 1 },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('done');
    });

    it('rejects claude_metadata with invalid confidence', async () => {
      const res = await request(app)
        .patch('/api/issues/issue-123')
        .send({
          claude_metadata: {
            updated_by: 'claude',
            confidence: 150, // Invalid: > 100
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });

    it('rejects claude_metadata with wrong updated_by', async () => {
      const res = await request(app)
        .patch('/api/issues/issue-123')
        .send({
          claude_metadata: {
            updated_by: 'human', // Must be 'claude'
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });
  });
});
