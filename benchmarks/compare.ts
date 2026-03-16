#!/usr/bin/env npx tsx
/**
 * Benchmark Comparison Tool
 *
 * Compares two API benchmark JSON files and produces a markdown table.
 *
 * Usage:
 *   npx tsx benchmarks/compare.ts benchmarks/api-response-before.json benchmarks/api-response-after.json
 */

import fs from 'fs';

interface BenchmarkEntry {
  endpoint: string;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
}

interface BenchmarkFile {
  label: string;
  date: string;
  runs: number;
  results: BenchmarkEntry[];
}

const NOISE_THRESHOLD_MS = 0.5;

function main() {
  const [beforePath, afterPath] = process.argv.slice(2);

  if (!beforePath || !afterPath) {
    console.error('Usage: npx tsx benchmarks/compare.ts <before.json> <after.json>');
    process.exit(1);
  }

  const before: BenchmarkFile = JSON.parse(fs.readFileSync(beforePath, 'utf-8'));
  const after: BenchmarkFile = JSON.parse(fs.readFileSync(afterPath, 'utf-8'));

  console.log(`## API Latency Comparison`);
  console.log('');
  console.log(`| Before | After |`);
  console.log(`|--------|-------|`);
  console.log(`| ${before.label} | ${after.label} |`);
  console.log(`| ${before.runs} runs/endpoint | ${after.runs} runs/endpoint |`);
  console.log('');

  // Header
  console.log('| Endpoint | Before P50 | After P50 | Change (ms) | Change (%) | Significance |');
  console.log('|----------|-----------|----------|-------------|------------|--------------|');

  for (const bEntry of before.results) {
    const aEntry = after.results.find(a => a.endpoint === bEntry.endpoint);
    if (!aEntry) {
      console.log(`| ${bEntry.endpoint} | ${bEntry.p50.toFixed(1)}ms | — | — | — | not measured |`);
      continue;
    }

    const changeMs = aEntry.p50 - bEntry.p50;
    const changePct = ((changeMs / bEntry.p50) * 100);
    const isSignificant = Math.abs(changeMs) > NOISE_THRESHOLD_MS;
    const significance = isSignificant
      ? (changeMs < 0 ? 'improved' : 'regressed')
      : 'within noise';

    const sign = changeMs > 0 ? '+' : '';
    console.log(
      `| ${bEntry.endpoint} | ${bEntry.p50.toFixed(1)}ms | ${aEntry.p50.toFixed(1)}ms | ${sign}${changeMs.toFixed(1)}ms | ${sign}${changePct.toFixed(1)}% | ${significance} |`
    );
  }

  console.log('');
  console.log(`> Changes < ${NOISE_THRESHOLD_MS}ms flagged as "within noise" for serial localhost benchmarks.`);

  // Also show P95 comparison
  console.log('');
  console.log('### P95 Tail Latency');
  console.log('');
  console.log('| Endpoint | Before P95 | After P95 | Change |');
  console.log('|----------|-----------|----------|--------|');

  for (const bEntry of before.results) {
    const aEntry = after.results.find(a => a.endpoint === bEntry.endpoint);
    if (!aEntry) continue;
    const changeMs = aEntry.p95 - bEntry.p95;
    const sign = changeMs > 0 ? '+' : '';
    console.log(
      `| ${bEntry.endpoint} | ${bEntry.p95.toFixed(1)}ms | ${aEntry.p95.toFixed(1)}ms | ${sign}${changeMs.toFixed(1)}ms |`
    );
  }
}

main();
