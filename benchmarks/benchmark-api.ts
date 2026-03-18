#!/usr/bin/env npx tsx
/**
 * API Response Time Benchmark
 *
 * Measures latency of key API endpoints using serial requests.
 * Outputs pipe-delimited text (matching api-response-before.txt format) + JSON.
 *
 * Usage:
 *   npx tsx benchmarks/benchmark-api.ts <label> [--runs=50] [--port=3000]
 *
 * Prerequisites:
 *   - API server running (pnpm dev:api)
 *   - Database seeded (pnpm db:seed)
 *   - Valid session (script auto-creates one)
 */

import { pool } from '../api/src/db/client.js';
import crypto from 'crypto';

const args = process.argv.slice(2);
const label = args.find(a => !a.startsWith('--')) || 'benchmark';
const runs = parseInt(args.find(a => a.startsWith('--runs='))?.split('=')[1] || '50', 10);
const port = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] || '3000', 10);

const BASE_URL = `http://localhost:${port}`;

interface BenchmarkResult {
  endpoint: string;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
  samples: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function computeStats(timings: number[]): Omit<BenchmarkResult, 'endpoint' | 'samples'> {
  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, t) => acc + t, 0);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg: Math.round((sum / sorted.length) * 10) / 10,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

async function getSessionCookie(): Promise<string> {
  // Create a session directly in the database to avoid depending on login flow
  const sessionId = crypto.randomUUID();

  // Get first user and workspace
  const userResult = await pool.query('SELECT id FROM users LIMIT 1');
  const wsResult = await pool.query('SELECT id FROM workspaces LIMIT 1');

  if (userResult.rows.length === 0 || wsResult.rows.length === 0) {
    throw new Error('No users or workspaces found. Run pnpm db:seed first.');
  }

  const userId = userResult.rows[0]!.id;
  const workspaceId = wsResult.rows[0]!.id;

  await pool.query(
    `INSERT INTO sessions (id, user_id, workspace_id, last_activity, created_at, expires_at)
     VALUES ($1, $2, $3, NOW(), NOW(), NOW() + INTERVAL '12 hours')`,
    [sessionId, userId, workspaceId]
  );

  return `session_id=${sessionId}`;
}

async function benchmarkEndpoint(
  endpoint: string,
  cookie: string,
  numRuns: number
): Promise<BenchmarkResult> {
  const timings: number[] = [];

  // Warm up (2 requests)
  for (let i = 0; i < 2; i++) {
    await fetch(`${BASE_URL}${endpoint}`, {
      headers: { Cookie: cookie },
    });
  }

  // Measure
  for (let i = 0; i < numRuns; i++) {
    const start = performance.now();
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: { Cookie: cookie },
    });
    const elapsed = performance.now() - start;

    if (!res.ok) {
      // Consume body to avoid leaks
      await res.text();
      console.error(`  Warning: ${endpoint} returned ${res.status} on run ${i + 1}`);
      continue;
    }
    // Consume body
    await res.json();
    timings.push(Number(elapsed.toFixed(6)));
  }

  if (timings.length === 0) {
    throw new Error(`All requests to ${endpoint} failed`);
  }

  return {
    endpoint: `GET ${endpoint}`,
    ...computeStats(timings),
    samples: timings.length,
  };
}

async function main() {
  console.log(`API Benchmark: ${label}`);
  console.log(`Runs per endpoint: ${runs}`);
  console.log(`Target: ${BASE_URL}`);
  console.log('');

  const cookie = await getSessionCookie();

  // Get a week ID for the :id endpoint
  const weeksRes = await fetch(`${BASE_URL}/api/weeks`, {
    headers: { Cookie: cookie },
  });
  let weekId: string | null = null;
  if (weeksRes.ok) {
    const weeksData = await weeksRes.json() as Array<{ id: string }>;
    if (Array.isArray(weeksData) && weeksData.length > 0) {
      weekId = weeksData[0]!.id;
    }
  } else {
    await weeksRes.text();
  }

  const endpoints = [
    '/api/dashboard/my-work',
    '/api/weeks',
    ...(weekId ? [`/api/weeks/${weekId}`] : []),
    '/api/issues',
    '/api/projects',
  ];

  const results: BenchmarkResult[] = [];

  for (const endpoint of endpoints) {
    process.stdout.write(`Benchmarking ${endpoint}...`);
    const result = await benchmarkEndpoint(endpoint, cookie, runs);
    results.push(result);
    console.log(` P50=${result.p50.toFixed(3)}ms, Avg=${result.avg}ms`);
  }

  // Clean up session
  await pool.query("DELETE FROM sessions WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)");
  await pool.end();

  // Output pipe-delimited text (matching existing format)
  const gitHash = 'current';
  const header = `=== API Response Time Benchmark (${label} @ ${gitHash}) ===`;
  const date = new Date().toString();

  const lines = [
    header,
    `Date: ${date}`,
    `Runs per endpoint: ${runs}`,
    '',
    'Endpoint|P50 (ms)|P95 (ms)|P99 (ms)|Avg (ms)|Min (ms)|Max (ms)',
    '--------|--------|--------|--------|--------|--------|--------',
  ];

  for (const r of results) {
    const displayEndpoint = r.endpoint.includes('/api/weeks/') && !r.endpoint.endsWith('/api/weeks')
      ? 'GET /api/weeks/:id'
      : r.endpoint;
    lines.push(
      `${displayEndpoint}|${r.p50.toFixed(6)}|${r.p95.toFixed(6)}|${r.p99.toFixed(6)}|${r.avg}|${r.min.toFixed(6)}|${r.max.toFixed(6)}`
    );
  }

  const textOutput = lines.join('\n') + '\n';

  // Write text file
  const fs = await import('fs');
  const textPath = `benchmarks/api-response-${label}.txt`;
  fs.writeFileSync(textPath, textOutput);
  console.log(`\nSaved: ${textPath}`);

  // Write JSON file
  const jsonOutput = {
    label,
    date,
    runs,
    results: results.map(r => ({
      ...r,
      endpoint: r.endpoint.includes('/api/weeks/') && !r.endpoint.endsWith('/api/weeks')
        ? 'GET /api/weeks/:id'
        : r.endpoint,
    })),
  };
  const jsonPath = `benchmarks/api-response-${label}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2) + '\n');
  console.log(`Saved: ${jsonPath}`);

  // Print table
  console.log('\n' + textOutput);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
