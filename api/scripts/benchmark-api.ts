/**
 * API Performance Benchmark Script
 *
 * Measures P50/P95/P99 response times for key endpoints under load.
 * Run with: npx tsx api/scripts/benchmark-api.ts
 *
 * Prerequisites:
 * - PostgreSQL running with seeded data (pnpm db:seed)
 * - API server running (pnpm dev:api)
 *
 * Environment variables:
 * - API_BASE_URL (default: http://localhost:3000)
 * - BENCHMARK_CONCURRENCY (default: 10)
 * - BENCHMARK_REQUESTS (default: 100)
 */

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const CONCURRENCY = parseInt(process.env.BENCHMARK_CONCURRENCY || '10', 10);
const TOTAL_REQUESTS = parseInt(process.env.BENCHMARK_REQUESTS || '100', 10);

interface BenchmarkResult {
  endpoint: string;
  method: string;
  totalRequests: number;
  concurrency: number;
  successCount: number;
  errorCount: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  rps: number;
}

function percentile(sortedArr: number[], p: number): number {
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

async function authenticateAndGetCookie(): Promise<string> {
  // First get CSRF token
  const csrfRes = await fetch(`${API_BASE_URL}/api/csrf-token`, {
    credentials: 'include',
  });
  const csrfData = await csrfRes.json() as { token: string };
  const csrfToken = csrfData.token;
  const cookies = csrfRes.headers.getSetCookie?.() || [];

  // Login with test credentials
  const loginRes = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      'Cookie': cookies.join('; '),
    },
    body: JSON.stringify({
      email: 'admin@ship.local',
      password: 'admin123',
    }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }

  const allCookies = [...cookies, ...(loginRes.headers.getSetCookie?.() || [])];
  return allCookies.join('; ');
}

async function benchmarkEndpoint(
  endpoint: string,
  method: string,
  cookie: string,
): Promise<BenchmarkResult> {
  const latencies: number[] = [];
  let successCount = 0;
  let errorCount = 0;

  // Run requests in batches of CONCURRENCY
  for (let i = 0; i < TOTAL_REQUESTS; i += CONCURRENCY) {
    const batchSize = Math.min(CONCURRENCY, TOTAL_REQUESTS - i);
    const promises = Array.from({ length: batchSize }, async () => {
      const start = performance.now();
      try {
        const res = await fetch(`${API_BASE_URL}${endpoint}`, {
          method,
          headers: { Cookie: cookie },
        });
        const elapsed = performance.now() - start;
        if (res.ok) {
          // Consume body to ensure full response time is measured
          await res.json();
          successCount++;
        } else {
          errorCount++;
        }
        latencies.push(elapsed);
      } catch {
        errorCount++;
        latencies.push(performance.now() - start);
      }
    });
    await Promise.all(promises);
  }

  latencies.sort((a, b) => a - b);
  const totalTime = latencies.reduce((sum, l) => sum + l, 0);

  return {
    endpoint,
    method,
    totalRequests: TOTAL_REQUESTS,
    concurrency: CONCURRENCY,
    successCount,
    errorCount,
    p50: Math.round(percentile(latencies, 50) * 100) / 100,
    p95: Math.round(percentile(latencies, 95) * 100) / 100,
    p99: Math.round(percentile(latencies, 99) * 100) / 100,
    min: Math.round(Math.min(...latencies) * 100) / 100,
    max: Math.round(Math.max(...latencies) * 100) / 100,
    mean: Math.round((totalTime / latencies.length) * 100) / 100,
    rps: Math.round((successCount / (totalTime / 1000)) * 100) / 100,
  };
}

function printResult(result: BenchmarkResult) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${result.method} ${result.endpoint}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Requests:    ${result.totalRequests} (concurrency: ${result.concurrency})`);
  console.log(`  Success:     ${result.successCount} | Errors: ${result.errorCount}`);
  console.log(`  P50:         ${result.p50}ms`);
  console.log(`  P95:         ${result.p95}ms`);
  console.log(`  P99:         ${result.p99}ms`);
  console.log(`  Min/Max:     ${result.min}ms / ${result.max}ms`);
  console.log(`  Mean:        ${result.mean}ms`);
  console.log(`  Throughput:  ${result.rps} req/s`);
}

async function main() {
  console.log('API Performance Benchmark');
  console.log(`Target: ${API_BASE_URL}`);
  console.log(`Concurrency: ${CONCURRENCY} | Total requests per endpoint: ${TOTAL_REQUESTS}`);
  console.log('');

  // Authenticate
  console.log('Authenticating...');
  let cookie: string;
  try {
    cookie = await authenticateAndGetCookie();
    console.log('Authenticated successfully.');
  } catch (err) {
    console.error('Authentication failed. Is the server running with seeded data?');
    console.error(err);
    process.exit(1);
  }

  // Endpoints to benchmark (key frontend-facing endpoints)
  const endpoints = [
    { path: '/api/issues', method: 'GET' },
    { path: '/api/weeks', method: 'GET' },
    { path: '/api/dashboard/my-work', method: 'GET' },
    { path: '/api/projects', method: 'GET' },
    { path: '/api/team/people', method: 'GET' },
    { path: '/api/search/mentions?q=test', method: 'GET' },
  ];

  const results: BenchmarkResult[] = [];

  for (const ep of endpoints) {
    console.log(`\nBenchmarking ${ep.method} ${ep.path}...`);
    const result = await benchmarkEndpoint(ep.path, ep.method, cookie);
    results.push(result);
    printResult(result);
  }

  // Summary table
  console.log(`\n${'='.repeat(80)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(80)}`);
  console.log(
    'Endpoint'.padEnd(35) +
    'P50'.padStart(10) +
    'P95'.padStart(10) +
    'P99'.padStart(10) +
    'RPS'.padStart(10)
  );
  console.log('-'.repeat(75));
  for (const r of results) {
    console.log(
      `${r.method} ${r.endpoint}`.padEnd(35) +
      `${r.p50}ms`.padStart(10) +
      `${r.p95}ms`.padStart(10) +
      `${r.p99}ms`.padStart(10) +
      `${r.rps}`.padStart(10)
    );
  }

  // Output JSON for programmatic consumption
  const outputPath = new URL('../benchmark-results.json', import.meta.url).pathname;
  const fs = await import('fs');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    config: { api_base_url: API_BASE_URL, concurrency: CONCURRENCY, total_requests: TOTAL_REQUESTS },
    results,
  }, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}

main();
