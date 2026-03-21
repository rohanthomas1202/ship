#!/usr/bin/env npx tsx
/**
 * FleetGraph Proactive Trigger Script
 *
 * Triggers a proactive scan against a workspace. Intended for:
 *   - Local development testing
 *   - Cron jobs / ECS scheduled tasks in production
 *
 * Usage:
 *   npx tsx scripts/run-fleetgraph.ts
 *   npx tsx scripts/run-fleetgraph.ts --workspace-id <uuid>
 *   npx tsx scripts/run-fleetgraph.ts --loop 5       # Run every 5 minutes
 *
 * Requires:
 *   - DATABASE_URL in .env.local or environment
 *   - The API server does NOT need to be running (connects to DB directly)
 */

import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '../api/.env.local') });
config({ path: join(__dirname, '../api/.env') });

async function main() {
  const args = process.argv.slice(2);
  let workspaceId = '';
  let loopMinutes = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace-id' && args[i + 1]) {
      workspaceId = args[++i]!;
    } else if (args[i] === '--loop' && args[i + 1]) {
      loopMinutes = parseInt(args[++i]!, 10);
    }
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Auto-detect workspace if not provided
    if (!workspaceId) {
      const result = await pool.query('SELECT id, name FROM workspaces LIMIT 1');
      if (result.rows.length === 0) {
        console.error('No workspace found. Run pnpm db:seed first.');
        process.exit(1);
      }
      workspaceId = result.rows[0].id;
      console.log(`Auto-detected workspace: ${result.rows[0].name} (${workspaceId})`);
    }

    // Dynamic import of the graph executor (after DB is ready)
    const { runProactive } = await import('../api/src/services/fleetgraph/graph-executor.js');

    const runOnce = async () => {
      const start = Date.now();
      console.log(`\n[${new Date().toISOString()}] Starting proactive scan...`);

      const { state, trace } = await runProactive(pool, {
        type: 'schedule',
        workspace_id: workspaceId,
      });

      const duration = Date.now() - start;
      console.log(`  Nodes: ${trace.nodes_executed.join(' → ')}`);
      console.log(`  Findings: ${trace.findings_count}`);
      console.log(`  Duration: ${duration}ms`);

      if (trace.errors.length > 0) {
        console.log(`  Errors: ${trace.errors.map(e => `${e.node}: ${e.error}`).join(', ')}`);
      }

      if (state.findings.length > 0) {
        console.log('  Details:');
        for (const f of state.findings) {
          console.log(`    [${f.severity}] ${f.signal_type}: ${f.title}`);
        }
      }

      // Report health scores if computed
      const projectIds = new Set<string>();
      for (const issue of state.data.issues) {
        const assocs = (issue as any).associations || [];
        for (const a of assocs) {
          if (a.type === 'project') projectIds.add(a.id);
        }
      }

      if (projectIds.size > 0) {
        const hsResult = await pool.query(
          `SELECT fs.entity_id, fs.health_score, d.title
           FROM fleetgraph_state fs
           JOIN documents d ON d.id = fs.entity_id
           WHERE fs.workspace_id = $1 AND fs.health_score IS NOT NULL
             AND fs.entity_id = ANY($2::uuid[])`,
          [workspaceId, [...projectIds]]
        );
        if (hsResult.rows.length > 0) {
          console.log('  Health scores:');
          for (const row of hsResult.rows) {
            const score = row.health_score;
            console.log(`    ${row.title}: ${score.overall}/100`);
          }
        }
      }

      return trace;
    };

    if (loopMinutes > 0) {
      console.log(`Running every ${loopMinutes} minute(s). Press Ctrl+C to stop.`);
      while (true) {
        await runOnce();
        await new Promise(resolve => setTimeout(resolve, loopMinutes * 60 * 1000));
      }
    } else {
      await runOnce();
    }
  } catch (err) {
    console.error('FleetGraph run failed:', err);
    process.exit(1);
  } finally {
    if (loopMinutes === 0) {
      await pool.end();
    }
  }
}

main();
