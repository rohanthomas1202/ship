/**
 * FleetGraph Test Case Runner
 *
 * Runs all 5 test cases, captures trace data, and outputs a markdown table
 * for FLEETGRAPH.md.
 *
 * Prerequisites:
 *   1. pnpm dev (API server running on localhost:3000)
 *   2. npx tsx api/src/db/seed-fleetgraph.ts (seed data populated)
 *
 * Usage: npx tsx scripts/run-test-cases.ts
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API = 'http://localhost:3000';

interface TestResult {
  name: string;
  success: boolean;
  trace?: { nodes_executed: string[]; findings_count: number; duration_ms: number };
  chatResponse?: string;
  error?: string;
}

// Session state: cookie + CSRF token
let sessionCookie = '';
let csrfToken = '';

async function login(email: string, password: string): Promise<void> {
  // 1. Get CSRF token first (needed for the login POST)
  const csrfRes = await fetch(`${API}/api/csrf-token`);
  const csrfData = await csrfRes.json() as any;
  const csrfCookie = csrfRes.headers.get('set-cookie') || '';
  csrfToken = csrfData.token;

  // Extract session cookie from CSRF response (csrf-sync sets it)
  const csrfCookieMatch = csrfCookie.match(/[^,;\s]+=[^;]+/);
  const csrfCookieStr = csrfCookieMatch ? csrfCookieMatch[0] : '';

  // 2. Login with CSRF token
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      Cookie: csrfCookieStr,
    },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error(`Login failed for ${email}: no cookie returned`);
  // Extract session cookie — supports both session_id and connect.sid
  const match = cookie.match(/(session_id|connect\.sid)=[^;]+/);
  if (!match) throw new Error(`Login failed for ${email}: no session cookie in: ${cookie}`);
  sessionCookie = `${match[0]}; ${csrfCookieStr}`;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Cookie: sessionCookie, 'x-csrf-token': csrfToken, ...extra };
}

function loadTestIds(): Record<string, string> {
  const idsPath = join(__dirname, 'fleetgraph-test-ids.json');
  try {
    return JSON.parse(readFileSync(idsPath, 'utf-8'));
  } catch {
    throw new Error(`Test IDs file not found at ${idsPath}. Run: npx tsx api/src/db/seed-fleetgraph.ts`);
  }
}

async function touchIssue(issueId: string): Promise<void> {
  const res = await fetch(`${API}/api/documents/${issueId}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ properties: {} }),
  });
  if (!res.ok) {
    console.warn(`  Warning: Touch failed for ${issueId}: ${res.status}`);
  }
}

async function runProactiveScan(projectId: string): Promise<TestResult['trace']> {
  const res = await fetch(`${API}/api/fleetgraph/run?project_id=${projectId}&sync=true`, {
    method: 'POST',
    headers: authHeaders(),
    signal: AbortSignal.timeout(120000), // 2 min timeout for proactive scans
  });
  if (!res.ok) throw new Error(`Proactive scan failed: ${res.status} ${await res.text()}`);
  return await res.json() as TestResult['trace'];
}

async function runChat(
  entityType: string,
  entityId: string,
  message: string
): Promise<{ trace: TestResult['trace']; message: string }> {
  const res = await fetch(`${API}/api/fleetgraph/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ entity_type: entityType, entity_id: entityId, message }),
    signal: AbortSignal.timeout(120000), // 2 min timeout
  });
  if (!res.ok) throw new Error(`Chat failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return { trace: data.trace, message: data.message };
}

async function approveInsight(insightId: string): Promise<any> {
  const res = await fetch(`${API}/api/fleetgraph/insights/${insightId}/approve`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
  });
  if (!res.ok) throw new Error(`Approve failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function main() {
  console.log('FleetGraph Test Case Runner\n');
  const results: TestResult[] = [];
  let exitCode = 0;

  // 1. Authenticate
  console.log('Authenticating...');
  try {
    await login('dev@ship.local', 'admin123');
    console.log('  Authenticated as dev@ship.local\n');
  } catch (err) {
    console.error('Authentication failed:', err);
    process.exit(1);
  }

  // 2. Load project/sprint IDs from seed output
  console.log('Loading seed data IDs...');
  const ids = loadTestIds();
  console.log('  Ghost Project:', ids.ghostProjectId || 'NOT FOUND');
  console.log('  Collapse Project:', ids.collapseProjectId || 'NOT FOUND');
  console.log('  Chain Project:', ids.chainProjectId || 'NOT FOUND');
  console.log('  Standup Sprint:', ids.standupSprintId || 'NOT FOUND');
  console.log('  Planning Sprint:', ids.planningSprintId || 'NOT FOUND');
  console.log('  HITL Insight:', ids.commentInsightId || 'NOT FOUND');
  console.log();

  // 3. Run test cases
  const testCases = [
    {
      name: 'TC1: Ghost Blocker (Proactive)',
      run: async () => {
        await touchIssue(ids.ghostTouchIssueId!);
        return { trace: await runProactiveScan(ids.ghostProjectId!) };
      },
      requiredId: ids.ghostProjectId,
    },
    {
      name: 'TC2: Sprint Collapse (Proactive)',
      run: async () => {
        await touchIssue(ids.collapseTouchIssueId!);
        return { trace: await runProactiveScan(ids.collapseProjectId!) };
      },
      requiredId: ids.collapseProjectId,
    },
    {
      name: 'TC3: Blocker Chain + HITL (Proactive)',
      run: async () => {
        await touchIssue(ids.chainTouchIssueId!);
        const trace = await runProactiveScan(ids.chainProjectId!);
        if (ids.commentInsightId) {
          console.log('    Approving HITL insight...');
          const result = await approveInsight(ids.commentInsightId);
          console.log('    HITL result:', JSON.stringify(result));
        }
        return { trace };
      },
      requiredId: ids.chainProjectId,
    },
    {
      name: 'TC4: Standup Draft (On-Demand)',
      run: async () => {
        const result = await runChat('sprint', ids.standupSprintId!, 'draft my standup');
        return { trace: result.trace, chatResponse: result.message };
      },
      requiredId: ids.standupSprintId,
    },
    {
      name: 'TC5: Sprint Planning (On-Demand)',
      run: async () => {
        const result = await runChat('sprint', ids.planningSprintId!, 'help me plan this sprint');
        return { trace: result.trace, chatResponse: result.message };
      },
      requiredId: ids.planningSprintId,
    },
  ];

  for (const tc of testCases) {
    console.log(`>> ${tc.name}`);
    if (!tc.requiredId) {
      console.log('  SKIPPED - required ID not found in seed data\n');
      results.push({ name: tc.name, success: false, error: 'Required ID not found' });
      exitCode = 1;
      continue;
    }
    try {
      const { trace, chatResponse } = await tc.run();
      console.log(`  OK: ${trace?.findings_count ?? 0} findings, ${trace?.duration_ms ?? 0}ms`);
      console.log(`  Nodes: ${trace?.nodes_executed?.join(' -> ') ?? 'N/A'}`);
      if (chatResponse) {
        console.log(`  Response preview: ${chatResponse.slice(0, 120)}...`);
      }
      results.push({ name: tc.name, success: true, trace, chatResponse });
    } catch (err: any) {
      console.log(`  FAILED: ${err.message}`);
      results.push({ name: tc.name, success: false, error: err.message });
      exitCode = 1;
    }
    console.log();
  }

  // 4. Output markdown table
  console.log('='.repeat(70));
  console.log('FLEETGRAPH.md Test Cases Table (copy-paste this):\n');
  console.log('| # | Ship State | Expected Output | Trace Link |');
  console.log('|---|-----------|----------------|------------|');
  const descriptions = [
    { state: 'Project with 2 stale in_progress issues (7d, 4d). Controls present.', output: 'Ghost Blocker findings (high + medium). Controls NOT flagged.' },
    { state: 'Sprint ~50% elapsed, 1/6 issues done.', output: 'Sprint Collapse finding (medium). Projected miss.' },
    { state: 'Parent issue blocking 4 children. Root stale 5d.', output: 'Blocker Chain + Ghost Blocker. Compound insight. HITL: comment approved.' },
    { state: 'Sprint with 5 issues transitioned yesterday. "draft my standup"', output: 'Standup: Yesterday/Today/Risks sections.' },
    { state: 'Planning sprint, 10 backlog + 2 carryover. "help me plan"', output: 'Ranked sprint plan fitted to 60h capacity.' },
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const d = descriptions[i]!;
    const status = r.success ? '[View trace](PASTE_LANGSMITH_LINK_HERE)' : `FAILED: ${r.error}`;
    console.log(`| ${i + 1} | ${d.state} | ${d.output} | ${status} |`);
  }

  console.log('\nNext steps:');
  console.log('  1. Open LangSmith: https://smith.langchain.com/');
  console.log('  2. Go to project "fleetgraph"');
  console.log('  3. Find the 5 most recent traces');
  console.log('  4. For each: Share -> Make Public -> Copy link');
  console.log('  5. Replace PASTE_LANGSMITH_LINK_HERE in the table above');
  console.log('  6. Paste the table into FLEETGRAPH.md under "Test Cases"');

  process.exit(exitCode);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
