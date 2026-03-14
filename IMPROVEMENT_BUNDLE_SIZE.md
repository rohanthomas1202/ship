# Improvement: Bundle Size

## Category
Bundle Size / Frontend Performance (Category 2 of 7)

## Before (Baseline)
- **Main chunk:** `index-C2vAyoQ1.js` — **2,073.70 KB** (587.59 KB gzip)
- **Total chunks:** 261 (mostly tiny icon chunks + 1 monolithic main chunk)
- **Problem:** All 20+ pages, all vendor libs, all editor code bundled into a single chunk
- **Initial load:** User downloads 2+ MB of JavaScript before seeing anything
- **Measured on:** master at commit `6dcaaf2`
- **Baseline file:** `benchmarks/bundle-before.txt`

## After (Post-Improvement)
- **Largest chunk:** `vendor-editor-CfTExRCB.js` — **536.54 KB** (171.22 KB gzip)
- **Main app chunk:** `App-BPUQPLke.js` — **88.49 KB** (19.37 KB gzip)
- **Route chunks:** Each page is its own chunk (12–114 KB each)
- **Vendor chunks split:** React (221 KB), Editor (536 KB), Emoji Picker (271 KB), Highlight.js (22 KB)
- **Initial load reduction:** From 2,073 KB → ~310 KB (App + vendor-react + index) = **~85% initial load reduction**
- **After file:** `benchmarks/bundle-after.txt`

## Root Cause Analysis

### No route-level code splitting
All React page components were statically imported in `main.tsx`, meaning every page's code was bundled into the single main chunk regardless of which page the user visits.

### No vendor chunking strategy
All third-party libraries (React, TipTap editor, emoji-picker-react, highlight.js) were bundled together. The TipTap editor alone is 500+ KB but only needed on document pages.

### Heavy components loaded eagerly
`DiffViewer` (code diff visualization) and `EmojiPicker` (emoji selection) were statically imported even though they're behind user interactions (click to open).

## Fix Applied

### 1. Route-level code splitting (`web/src/main.tsx`)
Wrapped all page components in `React.lazy()`:
```typescript
const Dashboard = lazy(() => import('./pages/Dashboard'));
const IssuesList = lazy(() => import('./pages/IssuesList'));
const UnifiedDocumentPage = lazy(() => import('./pages/UnifiedDocumentPage'));
// ... all 20+ pages
```
Added `<Suspense>` wrapper with loading fallback.

### 2. Manual vendor chunks (`web/vite.config.ts`)
Configured Rollup `manualChunks` to split vendor libraries:
```typescript
manualChunks: {
  'vendor-react': ['react', 'react-dom', 'react-router-dom'],
  'vendor-editor': ['@tiptap/core', '@tiptap/react', '@tiptap/starter-kit', ...],
  'vendor-highlight': ['highlight.js'],
}
```

### 3. Lazy-loaded heavy components
- `DiffViewer.tsx` — wrapped in `lazy()`, only loads when user opens diff view
- `EmojiPicker.tsx` — wrapped in `lazy()`, only loads when user clicks emoji button

## Key Chunks After Optimization

| Chunk | Size | Gzip | When Loaded |
|-------|------|------|-------------|
| `vendor-editor` | 536 KB | 171 KB | Document pages only |
| `emoji-picker-react` | 271 KB | 64 KB | On emoji button click |
| `PropertyRow` | 258 KB | 77 KB | Document pages only |
| `vendor-react` | 221 KB | 72 KB | Always (core framework) |
| `UnifiedDocumentPage` | 114 KB | 28 KB | Document routes only |
| `App` | 88 KB | 19 KB | Always (shell + routing) |
| `IssuesList` | 54 KB | 15 KB | Issues page only |
| `Dashboard` | 14 KB | 4 KB | Dashboard only |

## Tradeoffs
- **Slightly slower navigation** between routes due to chunk loading on first visit (mitigated by browser caching on subsequent visits)
- **Loading spinner visible** briefly on first route navigation while chunk loads
- **vendor-editor chunk still large** (536 KB) — further splitting would require changes to TipTap's module structure

## How to Reproduce
```bash
# Before (commit 6dcaaf2):
git checkout 6dcaaf2
cd web && pnpm build 2>&1 | grep "index-.*\.js"
# Result: index-C2vAyoQ1.js  2,073.70 kB

# After (current master):
git checkout master
cd web && pnpm build 2>&1 | grep -E "(App|vendor-react|vendor-editor)"
# Result: App 88.49 KB, vendor-react 221.23 KB, vendor-editor 536.54 KB
```

## Commits
- `ddf4eeb` — Optimize frontend bundle size with lazy loading and code splitting
