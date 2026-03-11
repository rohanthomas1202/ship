# 08 - Error Handling Gaps

Reliability audit of the Ship application. Three error handling gaps identified and fixed.

---

## Issue 1: API Token Deletion Crashes on Malformed ID

**Affected component:** `api/src/routes/api-tokens.ts` — `DELETE /api/api-tokens/:id`

**Reproduction steps:**
1. Authenticate and obtain a session
2. Send `DELETE /api/api-tokens/not-a-uuid`
3. Observe a 500 response with `"Failed to revoke API token"`

**Root cause:**
The `req.params.id` value is passed directly into a PostgreSQL query against a `uuid` column with no format validation. PostgreSQL throws `invalid input syntax for type uuid: "not-a-uuid"`, which is caught by the generic catch block and returned as a 500 Internal Server Error. The client receives no indication that their input was invalid — it looks like a server bug.

**Code change:**
Added a UUID regex check before the try/catch block in the DELETE handler. Non-UUID values now return 400 with `VALIDATION_ERROR` and `"Invalid token ID format"`.

```typescript
// Before (no validation — goes straight to SQL)
const id = String(req.params.id);
try {
  const tokenResult = await pool.query(
    `SELECT id, name FROM api_tokens WHERE id = $1 ...`, [id, ...]
  );

// After (validates before querying)
const id = String(req.params.id);
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuidRegex.test(id)) {
  res.status(400).json({
    success: false,
    error: { code: 'VALIDATION_ERROR', message: 'Invalid token ID format' },
  });
  return;
}
try { ...
```

**Before behavior:** 500 Internal Server Error with generic message. Browser console shows server crash trace. Appears as a platform outage.

**After behavior:** 400 Bad Request with clear validation error. No server-side exception logged.

**User confusion or data loss:** User confusion — the 500 error suggests the platform is broken rather than that the request was invalid. No data loss.

---

## Issue 2: Auto-Save Silently Drops Edits After Network Failure

**Affected component:** `web/src/hooks/useAutoSave.ts`, `web/src/components/UnifiedEditor.tsx`

**Reproduction steps:**
1. Open any document in the editor
2. Edit the title
3. Disconnect from the network (or block API requests)
4. Wait ~10 seconds (3 retries with exponential backoff)
5. Observe: no visible indication the title was not saved. Only a `console.error` in DevTools.

**Root cause:**
`useAutoSave` retries failed saves up to `maxRetries` times, but after exhausting retries it only logs `console.error('Auto-save failed after retries:', err)`. There is no mechanism to notify the UI that data was lost. The user continues editing, believing their changes are saved.

**Code change:**
1. Added `onSaveFailure` callback option and `saveError` state to `useAutoSave`
2. Changed return value from a bare function to `{ throttledSave, saveError }`
3. Updated both call sites (`UnifiedEditor.tsx`, `PersonEditor.tsx`) to destructure the new return shape
4. Added a visible error banner in `UnifiedEditor` when `titleSaveError` is set
5. On a subsequent successful save, `saveError` is cleared automatically

```typescript
// useAutoSave.ts — before
} else {
  console.error('Auto-save failed after retries:', err);
}

// useAutoSave.ts — after
} else {
  console.error('Auto-save failed after retries:', err);
  setSaveError(err);
  onSaveFailure?.(err);
}
```

```tsx
// UnifiedEditor.tsx — added banner
{titleSaveError && (
  <div className="bg-destructive/10 border-b border-destructive/30 px-4 py-2 text-xs text-destructive">
    Title failed to save. Check your connection and try again.
  </div>
)}
```

**Before behavior:** Save fails silently. User sees no warning. Edits are lost when navigating away.

**After behavior:** A red banner appears: "Title failed to save. Check your connection and try again." Clears automatically when a save succeeds.

**User confusion or data loss:** Data loss — users lose title edits without any indication. This is the highest-severity gap found.

---

## Issue 3: Concurrent Document Updates Silently Overwrite Each Other

**Affected component:** `api/src/routes/documents.ts` — `PATCH /api/documents/:id`

**Reproduction steps:**
1. User A opens document X (sees `updated_at: T1`)
2. User B opens document X (also sees `updated_at: T1`)
3. User A changes priority to "high" — PATCH succeeds, `updated_at` becomes T2
4. User B changes state to "done" — PATCH succeeds, but uses stale `properties` from T1
5. Result: User A's priority change is silently overwritten because the server merged B's request against the pre-T2 properties snapshot

**Root cause:**
The PATCH handler performs a read-modify-write on the `properties` JSONB column (`{...currentProps, ...dataProps, ...topLevelProps}`) with no concurrency guard. The UPDATE query has no `WHERE updated_at = $expected` clause, so concurrent writes always succeed and the last write wins.

**Code change:**
1. Added `expected_updated_at` (optional string) to the `updateDocumentSchema` Zod validator
2. When provided, the handler compares it against the document's current `updated_at` before proceeding
3. On mismatch, returns HTTP 409 Conflict with the server's current `updated_at` so the client can refresh and retry

```typescript
// Schema addition
expected_updated_at: z.string().optional(),

// Handler check (before BEGIN transaction)
if (data.expected_updated_at) {
  const existingUpdatedAt = new Date(existing.updated_at).toISOString();
  const expectedUpdatedAt = new Date(data.expected_updated_at).toISOString();
  if (existingUpdatedAt !== expectedUpdatedAt) {
    res.status(409).json({
      error: 'Document was modified by another user. Please refresh and try again.',
      code: 'CONFLICT',
      server_updated_at: existingUpdatedAt,
    });
    return;
  }
}
```

**Before behavior:** Last write wins. Property changes from concurrent editors are silently dropped with no conflict signal.

**After behavior:** When `expected_updated_at` is provided, stale updates are rejected with 409 Conflict. The response includes `server_updated_at` so the client can re-fetch and retry. The field is optional and backward-compatible — existing callers that omit it behave as before.

**User confusion or data loss:** Data loss — property changes (priority, state, assignee, etc.) can be silently overwritten by concurrent edits. This primarily affects the REST API path; the Yjs/WebSocket collaboration path for rich-text content already handles conflicts via CRDTs.

---

## Issue 4: Expired Session on DELETE/POST/PATCH Shows Generic Error Instead of Login Redirect

**Affected component:** `web/src/lib/api.ts` — `fetchWithCsrf()`

**Reproduction steps:**
1. Log in and open a document
2. Wait 15+ minutes (session inactivity timeout)
3. Click the "Delete" button on the document
4. Observe: an error toast says "Failed to delete document" instead of redirecting to the login page

**Root cause:**
`apiGet` handles 401 responses by calling `handleSessionExpired()`, which redirects to the login page with an "expired=true" flag. But `fetchWithCsrf` — used by `apiPost`, `apiPatch`, and `apiDelete` — has no 401 handling at all. When the auth middleware returns 401, `fetchWithCsrf` passes the raw 401 response through to the caller. The caller only checks `!response.ok` and throws a generic error like "Failed to delete document".

This affects all state-changing operations, not just delete: creating documents, updating properties, revoking tokens, etc.

**Code change:**
Added 401 handling to `fetchWithCsrf` that mirrors `apiGet`'s behavior:

```typescript
// fetchWithCsrf — before (no 401 handling)
const isJson = isJsonResponse(res);
if (res.status === 403 && !isJson) { ... }

// fetchWithCsrf — after (401 handled)
const isJson = isJsonResponse(res);
if (res.status === 401) {
  if (isJson) {
    const data = await res.clone().json();
    if (data.error?.code === 'SESSION_EXPIRED') {
      handleSessionExpired();
    }
  }
  if (!isJson) {
    handleSessionExpired();
  }
}
if (res.status === 403 && !isJson) { ... }
```

**Before behavior:** User sees "Failed to delete document" (or "Failed to create document", etc.) toast. No redirect to login. Confusing — the user thinks the operation itself is broken.

**After behavior:** User is redirected to the login page with the "session expired" modal, same as what happens for GET requests. After re-authenticating, they can retry the operation.

**User confusion or data loss:** User confusion — the error message implies the feature is broken, not that the session expired. No data loss (the operation was correctly rejected).

---

## Summary

| # | Gap | Severity | Type | File(s) Changed |
|---|-----|----------|------|-----------------|
| 1 | Malformed UUID in token deletion returns 500 | Medium | Malformed input | `api/src/routes/api-tokens.ts` |
| 2 | Auto-save drops edits silently after retries | High | Network disconnect | `web/src/hooks/useAutoSave.ts`, `web/src/components/UnifiedEditor.tsx`, `web/src/pages/PersonEditor.tsx` |
| 3 | Concurrent PATCH overwrites without conflict detection | High | Concurrent editing | `api/src/routes/documents.ts` |
| 4 | Expired session on POST/PATCH/DELETE shows generic error | High | Unhandled 401 | `web/src/lib/api.ts` |

All fixes pass TypeScript type-checking (`tsc --noEmit`) for both `api/` and `web/` projects.
