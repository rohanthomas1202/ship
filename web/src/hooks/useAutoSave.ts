import { useRef, useCallback, useEffect, useState } from 'react';

interface UseAutoSaveOptions {
  onSave: (value: string) => Promise<void>;
  onSaveFailure?: (error: unknown) => void;
  throttleMs?: number; // Default 500ms
  maxRetries?: number; // Default 3
}

export function useAutoSave({ onSave, onSaveFailure, throttleMs = 500, maxRetries = 3 }: UseAutoSaveOptions) {
  const lastSaveTimeRef = useRef(0);
  const pendingValueRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSequenceRef = useRef(0);
  const isSavingRef = useRef(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const save = useCallback(async (value: string, sequence: number, retryCount = 0) => {
    // Ignore if a newer save was initiated
    if (sequence < saveSequenceRef.current) return;

    isSavingRef.current = true;
    try {
      await onSave(value);
      lastSaveTimeRef.current = Date.now();
      // Clear any previous error on successful save
      setSaveError(null);

      // If value changed during save, trigger another save
      if (pendingValueRef.current !== null && pendingValueRef.current !== value) {
        const pending = pendingValueRef.current;
        pendingValueRef.current = null;
        saveSequenceRef.current++;
        await save(pending, saveSequenceRef.current);
      }
    } catch (err) {
      // Silent retry
      if (retryCount < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
        await save(value, sequence, retryCount + 1);
      } else {
        console.error('Auto-save failed after retries:', err);
        setSaveError(err);
        onSaveFailure?.(err);
      }
    } finally {
      isSavingRef.current = false;
    }
  }, [onSave, onSaveFailure, maxRetries]);

  const throttledSave = useCallback((value: string) => {
    const now = Date.now();
    const timeSinceLastSave = now - lastSaveTimeRef.current;

    // Clear any pending trailing save
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    // If currently saving, queue this value
    if (isSavingRef.current) {
      pendingValueRef.current = value;
      return;
    }

    // Throttle: if enough time has passed, save immediately
    if (timeSinceLastSave >= throttleMs) {
      saveSequenceRef.current++;
      save(value, saveSequenceRef.current);
    }

    // Always schedule a trailing save
    timeoutRef.current = setTimeout(() => {
      saveSequenceRef.current++;
      save(value, saveSequenceRef.current);
    }, throttleMs);
  }, [save, throttleMs]);

  return { throttledSave, saveError };
}
