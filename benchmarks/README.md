# API Benchmarks

## Overview

Measures API endpoint latency using serial requests against a local PostgreSQL-backed instance. These benchmarks measure server processing time, not network or load behavior.

## Prerequisites

- PostgreSQL running locally
- Database seeded: `pnpm db:seed`
- API server running: `pnpm dev:api`

## Running Benchmarks

```bash
# Capture a labeled benchmark (50 requests per endpoint by default)
npx tsx benchmarks/benchmark-api.ts <label>

# Custom run count
npx tsx benchmarks/benchmark-api.ts after-v2 --runs=100

# Custom port
npx tsx benchmarks/benchmark-api.ts after-v2 --port=3001
```

Outputs:
- `benchmarks/api-response-<label>.txt` — pipe-delimited table (human-readable)
- `benchmarks/api-response-<label>.json` — structured data for comparison

## Comparing Results

```bash
npx tsx benchmarks/compare.ts benchmarks/api-response-before.json benchmarks/api-response-after-v1.json
```

Produces a markdown table with absolute and percentage changes. Changes under 0.5ms are flagged as "within noise."

## Methodology

- **Serial requests** (not concurrent) — measures per-request latency, not throughput
- **50 requests** per endpoint with 2 warm-up requests discarded
- **Timing**: `performance.now()` around each `fetch()` call (includes response parsing)
- **P50** is the primary metric for typical user experience
- **P95/P99** capture tail latency from GC pauses, cold caches, etc.

## Endpoints Measured

| Endpoint | Why |
|----------|-----|
| `GET /api/dashboard/my-work` | Most complex; multiple queries per request |
| `GET /api/weeks` | Uses LATERAL JOINs; tests query optimization |
| `GET /api/weeks/:id` | Single document fetch with associations |
| `GET /api/issues` | List endpoint with visibility filtering |
| `GET /api/projects` | Has correlated subqueries for counts |

## Interpreting Results

- Run benchmarks on the same machine with consistent load
- Close resource-intensive applications during benchmarking
- Run 2-3 times and compare for consistency; P50 should vary < 1ms
- Improvements under 0.5ms on localhost are noise, not signal
