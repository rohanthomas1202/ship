import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';

// Mock pool before importing auth middleware
vi.mock('../db/client.js', () => ({
  pool: {
    query: vi.fn(),
  },
}));

import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/client.js';
import { Request, Response, NextFunction } from 'express';
import { SESSION_TIMEOUT_MS, ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';

// Helper to create mock request/response
function createMockReqRes(cookies: Record<string, string> = {}) {
  const req = { cookies } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}


/** Build a full pg.QueryResult from just rows */
function mockQueryResult<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

// Typed mock to avoid vi.mocked picking void-returning overload
const mockQuery = pool.query as Mock<(...args: unknown[]) => Promise<QueryResult>>;

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('session validation', () => {
    it('returns 401 when no session cookie is present', async () => {
      const { req, res, next } = createMockReqRes({});
      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: 'No session found' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when session does not exist in database', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'invalid-session' });
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));
      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Invalid session' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('attaches session info to request for valid session', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'valid-session' });
      const now = new Date();
      // Combined query returns session + user + workspace role in one result
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'valid-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: now,
            created_at: now,
            is_super_admin: false,
            workspace_role: 'member',
          }]));

      await authMiddleware(req, res, next);
      expect(req.sessionId).toBe('valid-session');
      expect(req.userId).toBe('user-123');
      expect(req.workspaceId).toBe('ws-123');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('session timeout handling', () => {
    it('returns 401 when session exceeds 15-minute inactivity timeout', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'stale-session' });
      const now = new Date();
      const staleActivity = new Date(now.getTime() - SESSION_TIMEOUT_MS - 1000);
      // Combined query + DELETE for expired session
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'stale-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: staleActivity,
            created_at: now,
            is_super_admin: false,
            workspace_role: 'member',
          }]))
        .mockResolvedValueOnce(mockQueryResult([])); // DELETE

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('inactivity'),
          }),
        })
      );
    });

    it('returns 401 when session exceeds 12-hour absolute timeout', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'old-session' });
      const now = new Date();
      const oldCreatedAt = new Date(now.getTime() - ABSOLUTE_SESSION_TIMEOUT_MS - 1000);
      // Combined query + DELETE for expired session
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'old-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: now,
            created_at: oldCreatedAt,
            is_super_admin: false,
            workspace_role: 'member',
          }]))
        .mockResolvedValueOnce(mockQueryResult([])); // DELETE

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('expired'),
          }),
        })
      );
    });

    it('deletes expired session from database', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'expired-session' });
      const now = new Date();
      const staleActivity = new Date(now.getTime() - SESSION_TIMEOUT_MS - 1000);
      // Combined query + DELETE
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'expired-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: staleActivity,
            created_at: now,
            is_super_admin: false,
            workspace_role: 'member',
          }]))
        .mockResolvedValueOnce(mockQueryResult([])); // DELETE

      await authMiddleware(req, res, next);
      expect(pool.query).toHaveBeenCalledWith(
        'DELETE FROM sessions WHERE id = $1',
        ['expired-session']
      );
    });
  });

  describe('workspace access verification', () => {
    it('returns 403 when user no longer has workspace access', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'valid-session' });
      const now = new Date();
      // Combined query returns null workspace_role (no membership)
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'valid-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: now,
            created_at: now,
            is_super_admin: false,
            workspace_role: null,
          }]))
        .mockResolvedValueOnce(mockQueryResult([])); // DELETE session

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('revoked'),
          }),
        })
      );
    });

    it('skips workspace check for super-admin users', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'admin-session' });
      const now = new Date();
      // Super-admin with null workspace_role should still pass
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'admin-session',
            user_id: 'admin-123',
            workspace_id: 'ws-123',
            last_activity: now,
            created_at: now,
            is_super_admin: true,
            workspace_role: null,
          }]));

      await authMiddleware(req, res, next);
      expect(req.isSuperAdmin).toBe(true);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 on database error', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'some-session' });
      mockQuery.mockRejectedValueOnce(new Error('DB connection failed'));
      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Authentication failed' }),
        })
      );
    });
  });

  describe('sliding cookie expiration', () => {
    it('refreshes cookie when activity is beyond 60s threshold', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'valid-session' });
      const now = new Date();
      // Last activity was 90 seconds ago (beyond 60s threshold)
      const lastActivity = new Date(now.getTime() - 90 * 1000);
      // Combined query + UPDATE for activity refresh
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'valid-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: lastActivity,
            created_at: now,
            is_super_admin: false,
            workspace_role: 'member',
          }]))
        .mockResolvedValueOnce(mockQueryResult([])); // UPDATE last_activity

      await authMiddleware(req, res, next);
      expect(res.cookie).toHaveBeenCalledWith('session_id', 'valid-session', {
        httpOnly: true,
        secure: false, // NODE_ENV is 'test', not 'production'
        sameSite: 'strict',
        maxAge: SESSION_TIMEOUT_MS,
        path: '/',
      });
      expect(next).toHaveBeenCalled();
    });

    it('does NOT refresh cookie when activity is within 60s threshold', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'valid-session' });
      const now = new Date();
      // Last activity was 30 seconds ago (within 60s threshold)
      const lastActivity = new Date(now.getTime() - 30 * 1000);
      // Combined query only — no UPDATE since within threshold
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'valid-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: lastActivity,
            created_at: now,
            is_super_admin: false,
            workspace_role: 'member',
          }]));

      await authMiddleware(req, res, next);
      expect(res.cookie).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('bearer token authentication', () => {
    function createMockReqResWithAuth(authHeader: string | undefined) {
      const req = {
        cookies: {},
        headers: { authorization: authHeader },
        get: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? authHeader : undefined),
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;
      return { req, res, next };
    }

    it('authenticates with valid bearer token', async () => {
      const { req, res, next } = createMockReqResWithAuth('Bearer ship_validtoken123');

      // Mock token validation query (JOIN with users table)
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'token-1',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            is_super_admin: false,
          }]))
        // Mock update last_used_at
        .mockResolvedValueOnce(mockQueryResult([]));

      await authMiddleware(req, res, next);
      expect(req.userId).toBe('user-123');
      expect(req.workspaceId).toBe('ws-123');
      expect(req.isApiToken).toBe(true);
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 for invalid bearer token', async () => {
      const { req, res, next } = createMockReqResWithAuth('Bearer invalid_token');

      // Mock token not found
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Invalid or expired API token' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 for revoked bearer token', async () => {
      const { req, res, next } = createMockReqResWithAuth('Bearer ship_revokedtoken');

      // Mock token found but revoked (revoked_at is set)
      mockQuery.mockResolvedValueOnce(mockQueryResult([])); // No results means revoked/expired

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('prefers bearer token over session cookie when both present', async () => {
      // Create request with both session cookie and auth header
      const req = {
        cookies: { session_id: 'some-session' },
        headers: { authorization: 'Bearer ship_tokentoken' },
        get: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? 'Bearer ship_tokentoken' : undefined),
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{
            id: 'token-1',
            user_id: 'api-user',
            workspace_id: 'api-ws',
            is_super_admin: false,
          }]))
        .mockResolvedValueOnce(mockQueryResult([]));

      await authMiddleware(req, res, next);
      // Should use token auth, not session
      expect(req.userId).toBe('api-user');
      expect(req.isApiToken).toBe(true);
      expect(next).toHaveBeenCalled();
    });
  });
});
