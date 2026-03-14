# AI Cost Analysis

## LLM Usage Summary

### Model Used
- **Primary:** Claude Opus 4.6 via Claude Code CLI (Anthropic's official coding agent)
- **Sub-agents:** Claude Opus 4.6 (for parallel research and code exploration)

### Token Consumption (Estimated)
| Activity | Input Tokens | Output Tokens | Sessions |
|----------|-------------|---------------|----------|
| Codebase exploration & audit | ~200K | ~50K | 2 |
| Type safety fixes (6 test files) | ~300K | ~100K | 3 |
| Branch merge & conflict resolution | ~150K | ~40K | 1 |
| Documentation writing (7 improvement docs + deliverables) | ~200K | ~80K | 2 |
| Benchmarking & measurement | ~100K | ~30K | 1 |
| **Total** | **~950K** | **~300K** | **9** |

### Estimated Cost
- Claude Opus 4.6 pricing: $15/M input, $75/M output tokens
- Input: 950K × $15/M = ~$14.25
- Output: 300K × $75/M = ~$22.50
- **Total estimated API cost: ~$36.75**

(Note: Actual cost was covered by Claude Code Pro subscription, not per-token billing)

### API Calls
- Estimated ~500-700 tool calls across all sessions (Read, Edit, Write, Bash, Grep, Glob, Agent)
- ~50 git operations (commits, merges, cherry-picks, rebases, pushes)
- ~30 test/build/type-check runs

## Coding Agent Costs

### Claude Code CLI
- **Subscription:** Claude Code Pro ($100/month or included in Max plan)
- **Usage model:** Unlimited within subscription limits
- **Sessions:** 9 across 2 days of work
- **Effective cost:** Portion of monthly subscription (~$10-15 for this project)

### No Other Agents Used
All work was done through Claude Code CLI. No GitHub Copilot, Cursor, or other coding agents were used.

## Reflection Questions

### 1. How did AI assistance change your approach to the audit?
AI dramatically accelerated the **exploration phase**. Instead of manually reading hundreds of files, I used Claude Code's Grep/Glob tools and sub-agents to rapidly identify violation patterns across the codebase. For example, finding all 211 `any`/`as any` violations and categorizing them by file took minutes instead of hours. The AI's ability to hold the full context of the monorepo structure (api/, web/, shared/) while working on specific files was invaluable.

### 2. Where was AI most helpful vs where did it struggle?
**Most helpful:**
- Bulk code transformations (replacing `as any` with typed mocks across 6 files)
- Understanding pg's `pool.query` type overload behavior and finding the `Mock<>` cast workaround
- Writing SQL migration files with correct `CONCURRENTLY` syntax
- Generating comprehensive documentation with accurate file paths and line numbers

**Struggled with:**
- Getting `vi.mocked(pool.query)` typing right — the Vitest/pg overload interaction required multiple attempts and debugging cycles
- Python regex replacements sometimes mangled multi-line TypeScript (auth.test.ts import line got corrupted)
- Parallel sub-agents occasionally reported success but their file edits didn't persist (3 of 6 agents)

### 3. What would you do differently next time?
- **Start with baselines first** — I would have captured all "before" measurements before touching any code, which is what the plan prescribed and what I ultimately did
- **Fix one file at a time** rather than launching 6 parallel agents for test file fixes — the parallel agents had reliability issues
- **Use the typed `Mock<>` cast pattern from the start** instead of trying `vi.mocked()` first and discovering the overload issue per-file
- **Run `pnpm type-check` after every file change**, not in batch — catches issues earlier

### 4. How accurate were the AI's initial assessments?
The initial audit was reasonably accurate for identifying violation categories and rough counts. However:
- API response time estimates were initially just estimates ("~50ms") — actual measured P50 was 7-11ms, much faster than estimated
- The audit correctly identified that `type-safety-improvements` branch was harmful (made things worse, not better)
- Bundle size assessment was accurate (single 2,073 KB chunk, no code splitting)
- EXPLAIN ANALYZE revealed the correlated subquery problem was worse than initially suspected (70 sequential scans)

### 5. What was the ROI of using AI for this project?
**Time savings:** Estimated 15-20 hours of work compressed into ~6 hours of active sessions. The biggest time savings were:
- Automated grep/analysis of 211 type violations (saved ~3 hours)
- Bulk code transformations with typed mock factories (saved ~4 hours)
- Documentation generation with accurate cross-references (saved ~3 hours)
- Git merge/rebase/conflict resolution guidance (saved ~2 hours)

**Quality impact:** AI caught issues I might have missed:
- The `vi.mocked()` void overload issue and its systematic fix
- The need to update auth.test.ts mocks after merging the consolidated auth query
- Correct merge order to avoid conflicts (database-efficiency before api-query-optimizations)

**ROI:** ~$37 in API costs (or ~$15 of subscription) for ~15 hours of time savings = excellent ROI for a time-constrained assignment.
