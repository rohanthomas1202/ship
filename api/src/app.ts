import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { csrfSync } from 'csrf-sync';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import issuesRoutes from './routes/issues.js';
import feedbackRoutes, { publicFeedbackRouter } from './routes/feedback.js';
import programsRoutes from './routes/programs.js';
import projectsRoutes from './routes/projects.js';
import weeksRoutes from './routes/weeks.js';
import standupsRoutes from './routes/standups.js';
import iterationsRoutes from './routes/iterations.js';
import teamRoutes from './routes/team.js';
import workspacesRoutes from './routes/workspaces.js';
import adminRoutes from './routes/admin.js';
import invitesRoutes from './routes/invites.js';
import setupRoutes from './routes/setup.js';
import backlinksRoutes from './routes/backlinks.js';
import { searchRouter } from './routes/search.js';
import { filesRouter } from './routes/files.js';
import caiaAuthRoutes from './routes/caia-auth.js';
import apiTokensRoutes from './routes/api-tokens.js';
import adminCredentialsRoutes from './routes/admin-credentials.js';
import claudeRoutes from './routes/claude.js';
import activityRoutes from './routes/activity.js';
import dashboardRoutes from './routes/dashboard.js';
import associationsRoutes from './routes/associations.js';
import accountabilityRoutes from './routes/accountability.js';
import aiRoutes from './routes/ai.js';
import fleetgraphRoutes from './routes/fleetgraph.js';
import weeklyPlansRoutes, { weeklyRetrosRouter } from './routes/weekly-plans.js';
import { documentCommentsRouter, commentsRouter } from './routes/comments.js';
import { setupSwagger } from './swagger.js';
import { initializeCAIA } from './services/caia.js';

// Validate SESSION_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required in production');
}

const sessionSecret = process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-production';

// CSRF protection setup
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
});

// Conditional CSRF middleware - skip for API token auth (Bearer tokens are not vulnerable to CSRF)
import { Request, Response, NextFunction } from 'express';
const conditionalCsrf = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Skip CSRF for API token requests - Bearer tokens are not auto-attached by browsers
    return next();
  }
  // Apply CSRF protection for session-based auth
  return csrfSynchronisedProtection(req, res, next);
};

// Rate limiting configurations
// In test/dev environment, use much higher limits to avoid issues
// Production limits: login=5/15min (failed only), api=100/min
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';
const isDevEnv = process.env.NODE_ENV !== 'production';

// Strict rate limit for login (5 failed attempts / 15 min) - brute force protection
// skipSuccessfulRequests: true means only failed attempts count toward the limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTestEnv ? 1000 : 5, // High limit for tests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  skipSuccessfulRequests: true, // Only count failed login attempts
});

// General API rate limit (100 req/min in prod, 1000 in dev)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100, // High limit for tests/dev
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});


export function createApp(corsOrigin: string = 'http://localhost:5173'): express.Express {
  const app = express();

  // Trust proxy headers (CloudFront) for secure cookies and correct protocol detection
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);

    // CloudFront with viewer_protocol_policy="redirect-to-https" always serves viewers over HTTPS.
    // However, CloudFront -> EB uses HTTP (origin_protocol_policy="http-only"), so CloudFront
    // sets X-Forwarded-Proto to "http". Override it to "https" when request comes via CloudFront.
    app.use((req, _res, next) => {
      // CloudFront adds Via header like "2.0 <id>.cloudfront.net (CloudFront)"
      const viaHeader = req.headers['via'] as string;
      if (viaHeader && viaHeader.includes('cloudfront')) {
        req.headers['x-forwarded-proto'] = 'https';
      }
      next();
    });
  }

  // Middleware - Security headers
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },  // Allow images to be loaded cross-origin
    // Content Security Policy - prevents XSS attacks
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Admin credentials page uses inline scripts
        styleSrc: ["'self'", "'unsafe-inline'"], // TipTap editor needs inline styles
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "wss:", "ws:"], // WebSocket connections
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      }
    },
    // HTTP Strict Transport Security
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
  }));

  // Apply rate limiting to all API routes
  app.use('/api/', apiLimiter);
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));  // Large wiki documents can be several MB
  app.use(express.urlencoded({ extended: true, limit: '10mb' })); // For HTML form submissions
  app.use(cookieParser(sessionSecret));

  // Session middleware for CSRF token storage
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 minutes
    },
  }));

  // CSRF token endpoint (must be before CSRF protection middleware)
  app.get('/api/csrf-token', (req, res) => {
    res.json({ token: generateToken(req) });
  });

  // Health check (no CSRF needed)
  // Temporary: reset passwords endpoint (remove after prod is bootstrapped)
  app.get('/api/reset-passwords', async (req, res) => {
    try {
      const bcrypt = await import('bcryptjs');
      const { pool } = await import('./db/client.js');
      const passwordHash = await bcrypt.hash('admin123', 10);
      const result = await pool.query(
        `UPDATE users SET password_hash = $1 WHERE email LIKE '%@ship.local' RETURNING email`,
        [passwordHash]
      );
      res.json({ status: 'ok', updated: result.rows.map((r: any) => r.email) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/health', async (req, res) => {
    if (req.query.seed === 'init') {
      try {
        const bcrypt = await import('bcryptjs');
        const { pool } = await import('./db/client.js');
        const crypto = await import('crypto');
        const uuid = () => crypto.randomUUID();
        const passwordHash = await bcrypt.hash('admin123', 10);

        // Get or create workspace
        let wsId: string;
        const existingWs = await pool.query("SELECT id FROM workspaces LIMIT 1");
        if (existingWs.rows[0]) {
          wsId = existingWs.rows[0].id;
        } else {
          const wsResult = await pool.query(`INSERT INTO workspaces (name, sprint_start_date) VALUES ('Ship Workspace', '2025-12-15') RETURNING id`);
          wsId = wsResult.rows[0].id;
        }

        // Create users if missing
        const teamMembers = [
          { email: 'dev@ship.local', name: 'Dev User', admin: true },
          { email: 'alice.chen@ship.local', name: 'Alice Chen', admin: false },
          { email: 'bob.martinez@ship.local', name: 'Bob Martinez', admin: false },
          { email: 'carol.williams@ship.local', name: 'Carol Williams', admin: false },
          { email: 'david.kim@ship.local', name: 'David Kim', admin: false },
        ];
        const userIds: string[] = [];
        for (const m of teamMembers) {
          const existing = await pool.query('SELECT id FROM users WHERE email = $1', [m.email]);
          if (existing.rows[0]) {
            // Reset password for existing users to ensure login works
            await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, existing.rows[0].id]);
            userIds.push(existing.rows[0].id); continue;
          }
          const r = await pool.query('INSERT INTO users (email, name, password_hash, is_super_admin) VALUES ($1,$2,$3,$4) RETURNING id', [m.email, m.name, passwordHash, m.admin]);
          userIds.push(r.rows[0].id);
          await pool.query('INSERT INTO workspace_memberships (user_id, workspace_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.rows[0].id, wsId, m.admin ? 'admin' : 'member']);
          // Create person doc
          await pool.query(`INSERT INTO documents (id, title, document_type, workspace_id, created_by, properties) VALUES ($1,$2,'person',$3,$4,$5) ON CONFLICT DO NOTHING`,
            [uuid(), m.name, wsId, r.rows[0].id, JSON.stringify({ user_id: r.rows[0].id, email: m.email })]);
        }

        // Check if data already seeded (skip if >80 issues — means full seed already ran)
        const docCount = await pool.query("SELECT count(*) as c FROM documents WHERE document_type = 'issue' AND workspace_id = $1", [wsId]);
        if (parseInt(docCount.rows[0].c) > 80) {
          res.json({ status: 'ok', seed: 'already_seeded', issues: docCount.rows[0].c }); return;
        }

        // Create programs
        const programs = ['Platform Engineering', 'User Experience', 'Data Infrastructure'];
        const programIds: string[] = [];
        for (const name of programs) {
          const id = uuid();
          await pool.query(`INSERT INTO documents (id, title, document_type, workspace_id, created_by, properties) VALUES ($1,$2,'program',$3,$4,$5)`,
            [id, name, wsId, userIds[0], JSON.stringify({ prefix: name.substring(0,2).toUpperCase(), accountable_id: userIds[0] })]);
          programIds.push(id);
        }

        // Create projects
        const projectDefs = [
          { name: 'Auth Overhaul', owner: 0, program: 0 },
          { name: 'Dashboard Redesign', owner: 1, program: 1 },
          { name: 'API Performance', owner: 2, program: 0 },
          { name: 'Mobile App', owner: 3, program: 1 },
          { name: 'Data Pipeline', owner: 4, program: 2 },
        ];
        const projectIds: string[] = [];
        for (const p of projectDefs) {
          const id = uuid();
          await pool.query(`INSERT INTO documents (id, title, document_type, workspace_id, created_by, properties) VALUES ($1,$2,'project',$3,$4,$5)`,
            [id, p.name, wsId, userIds[p.owner], JSON.stringify({ owner_id: userIds[p.owner], target_date: '2026-06-01' })]);
          await pool.query(`INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1,$2,'program') ON CONFLICT DO NOTHING`, [id, programIds[p.program]]);
          projectIds.push(id);
        }

        // Create sprints
        const sprintIds: string[] = [];
        for (let i = 1; i <= 12; i++) {
          const id = uuid();
          await pool.query(`INSERT INTO documents (id, title, document_type, workspace_id, created_by, properties) VALUES ($1,$2,'sprint',$3,$4,$5)`,
            [id, 'Week ' + i, wsId, userIds[0], JSON.stringify({ sprint_number: i, owner_id: userIds[i % 5] })]);
          sprintIds.push(id);
        }

        // Create issues
        const states = ['todo', 'in_progress', 'in_review', 'done', 'todo', 'in_progress'];
        const priorities = ['high', 'medium', 'low', 'critical', 'medium', 'high'];
        const issueTitles = [
          'Fix login timeout', 'Add dark mode toggle', 'Optimize DB queries', 'Write API docs',
          'Implement SSO', 'Fix memory leak', 'Add export feature', 'Update dependencies',
          'Fix broken tests', 'Add loading states', 'Refactor auth middleware', 'Add rate limiting',
          'Fix CORS issues', 'Implement caching', 'Add error boundaries', 'Fix mobile layout',
          'Add search indexing', 'Optimize bundle size', 'Fix race condition', 'Add retry logic',
          'Implement webhooks', 'Add audit logging', 'Fix session handling', 'Add batch operations',
          'Implement pagination', 'Fix timezone bugs', 'Add notifications', 'Optimize images',
          'Fix form validation', 'Add keyboard shortcuts', 'Implement drag-drop', 'Fix scroll issues',
          'Add undo/redo', 'Optimize rendering', 'Fix accessibility', 'Add spell check',
          'Implement filters', 'Fix duplicate entries', 'Add bulk delete', 'Optimize search',
          'Fix upload limits', 'Add progress bars', 'Implement tags', 'Fix sorting bugs',
          'Add date picker', 'Optimize animations', 'Fix hover states', 'Add context menus',
          'Implement themes', 'Fix print layout',
        ];
        let issueCount = 0;
        for (let i = 0; i < issueTitles.length; i++) {
          const id = uuid();
          const assignee = userIds[i % 5];
          const project = projectIds[i % 5];
          const sprint = sprintIds[i % 12];
          const staleDate = new Date();
          staleDate.setDate(staleDate.getDate() - (i % 7 === 0 ? 5 : i % 3)); // Some issues stale
          await pool.query(`INSERT INTO documents (id, title, document_type, workspace_id, created_by, updated_at, properties) VALUES ($1,$2,'issue',$3,$4,$5,$6)`,
            [id, issueTitles[i], wsId, assignee, staleDate.toISOString(),
             JSON.stringify({ state: states[i % 6], priority: priorities[i % 6], assignee_id: assignee, estimate: (i % 5) + 1 })]);
          await pool.query(`INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1,$2,'project') ON CONFLICT DO NOTHING`, [id, project]);
          await pool.query(`INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1,$2,'sprint') ON CONFLICT DO NOTHING`, [id, sprint]);
          issueCount++;
        }

        // Create wiki docs
        const wikiTitles = ['Architecture Guide', 'API Reference', 'Onboarding Checklist', 'Sprint Retrospective Template', 'Team Agreements', 'Deployment Runbook', 'Incident Response'];
        for (const title of wikiTitles) {
          await pool.query(`INSERT INTO documents (id, title, document_type, workspace_id, created_by, content) VALUES ($1,$2,'wiki',$3,$4,$5)`,
            [uuid(), title, wsId, userIds[0], JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Content for ' + title }] }] })]);
        }

        // Create some parent-child relationships (blocker chains)
        // This makes FleetGraph's blocker detection work
        const allIssues = await pool.query("SELECT id FROM documents WHERE document_type='issue' AND workspace_id=$1 ORDER BY created_at LIMIT 20", [wsId]);
        const ids = allIssues.rows.map((r: any) => r.id);
        if (ids.length >= 8) {
          // Chain: ids[0] blocks ids[1], ids[2], ids[3]
          for (let j = 1; j <= 3; j++) {
            await pool.query(`INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1,$2,'parent') ON CONFLICT DO NOTHING`, [ids[j], ids[0]]);
          }
          // Chain: ids[4] blocks ids[5], ids[6], ids[7]
          for (let j = 5; j <= 7; j++) {
            await pool.query(`INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1,$2,'parent') ON CONFLICT DO NOTHING`, [ids[j], ids[4]]);
          }
        }

        res.json({ status: 'ok', seed: 'complete', users: userIds.length, programs: programs.length, projects: projectDefs.length, sprints: sprintIds.length, issues: issueCount, wikis: wikiTitles.length, blockerChains: 2 });
      } catch (err: any) { res.json({ status: 'ok', seed: 'error', error: err.message }); }
      return;
    }
    res.json({ status: 'ok' });
  });

  // Temporary seed endpoint (GET to bypass CSRF — remove after first use)
  app.get('/api/init-seed-db', async (_req: any, res: any) => {
    try {
      const bcrypt = await import('bcryptjs');
      const { pool } = await import('./db/client.js');
      const passwordHash = await bcrypt.hash('admin123', 10);
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', ['dev@ship.local']);
      if (existing.rows[0]) {
        res.json({ message: 'Users already exist', userId: existing.rows[0].id });
        return;
      }
      // Create workspace
      const wsResult = await pool.query(
        `INSERT INTO workspaces (name, sprint_start_date) VALUES ('Ship Workspace', '2025-12-15') ON CONFLICT DO NOTHING RETURNING id`
      );
      const wsId = wsResult.rows[0]?.id || (await pool.query("SELECT id FROM workspaces LIMIT 1")).rows[0]?.id;
      // Create dev user
      const userResult = await pool.query(
        `INSERT INTO users (email, name, password_hash, is_super_admin) VALUES ($1, $2, $3, true) RETURNING id`,
        ['dev@ship.local', 'Dev User', passwordHash]
      );
      const userId = userResult.rows[0].id;
      // Add to workspace
      await pool.query(
        `INSERT INTO workspace_memberships (user_id, workspace_id, role) VALUES ($1, $2, 'admin')`,
        [userId, wsId]
      );
      res.json({ message: 'Seed complete', userId, workspaceId: wsId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API documentation (no auth needed)
  setupSwagger(app);

  // Setup routes (CSRF protected - first-time setup only)
  app.use('/api/setup', conditionalCsrf, setupRoutes);

  // Public feedback routes - no auth or CSRF required (must be before protected routes)
  app.use('/api/feedback', publicFeedbackRouter);

  // Apply stricter rate limiting to login endpoint (brute force protection)
  app.use('/api/auth/login', loginLimiter);

  // Apply CSRF protection to all state-changing API routes
  app.use('/api/auth', conditionalCsrf, authRoutes);
  app.use('/api/documents', conditionalCsrf, documentsRoutes);
  app.use('/api/documents', conditionalCsrf, backlinksRoutes);
  app.use('/api/documents', conditionalCsrf, associationsRoutes);
  app.use('/api/issues', conditionalCsrf, issuesRoutes);
  app.use('/api/feedback', conditionalCsrf, feedbackRoutes);
  app.use('/api/programs', conditionalCsrf, programsRoutes);
  app.use('/api/projects', conditionalCsrf, projectsRoutes);
  app.use('/api/weeks', conditionalCsrf, weeksRoutes);
  app.use('/api/weeks', conditionalCsrf, iterationsRoutes);
  app.use('/api/standups', conditionalCsrf, standupsRoutes);
  app.use('/api/team', conditionalCsrf, teamRoutes);
  app.use('/api/workspaces', conditionalCsrf, workspacesRoutes);
  app.use('/api/admin', conditionalCsrf, adminRoutes);
  app.use('/api/invites', conditionalCsrf, invitesRoutes);
  app.use('/api/api-tokens', conditionalCsrf, apiTokensRoutes);

  // Claude context routes - read-only GET endpoints for Claude skills
  app.use('/api/claude', claudeRoutes);

  // Search routes are read-only GET endpoints - no CSRF needed
  app.use('/api/search', searchRouter);

  // Activity routes are read-only GET endpoints - no CSRF needed
  app.use('/api/activity', activityRoutes);

  // Dashboard routes are read-only GET endpoints - no CSRF needed
  app.use('/api/dashboard', dashboardRoutes);

  // Accountability routes - inference-based action items (read-only GET)
  app.use('/api/accountability', accountabilityRoutes);

  // AI analysis routes - plan and retro quality feedback (CSRF protected)
  app.use('/api/ai', conditionalCsrf, aiRoutes);

  // FleetGraph project intelligence agent (CSRF protected for chat/actions)
  app.use('/api/fleetgraph', conditionalCsrf, fleetgraphRoutes);

  // Weekly plans routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-plans', conditionalCsrf, weeklyPlansRoutes);

  // Weekly retros routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-retros', conditionalCsrf, weeklyRetrosRouter);

  // CAIA auth routes - no CSRF protection (OAuth flow with external callback)
  // This is the single identity provider for PIV authentication
  // Mount at both /caia and /piv paths - /piv/callback is registered with CAIA
  app.use('/api/auth/caia', caiaAuthRoutes);
  app.use('/api/auth/piv', caiaAuthRoutes);

  // Admin credentials management (CSRF protected, super-admin only)
  app.use('/api/admin/credentials', conditionalCsrf, adminCredentialsRoutes);

  // File upload routes (CSRF protected for POST endpoints)
  app.use('/api/files', conditionalCsrf, filesRouter);

  // Comments routes
  app.use('/api/documents', conditionalCsrf, documentCommentsRouter);
  app.use('/api/comments', conditionalCsrf, commentsRouter);

  // Initialize CAIA OAuth client at startup
  initializeCAIA().catch((err) => {
    console.warn('CAIA initialization failed:', err);
  });

  return app;
}
