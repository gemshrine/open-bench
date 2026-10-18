import { useSyncExternalStore } from 'react';
import type { OpenBenchError } from '@openbench/core';
import { Session, isOpenBenchError } from '@openbench/core';

/** The one engine instance of this window. The MCP bridge host operates on the same object. */
export const session = new Session();

declare global {
  interface Window {
    /** Exposed for e2e tests and debugging. */
    __openbench?: { session: Session; toScreen?: (p: { x: number; y: number }) => { x: number; y: number } };
  }
}
window.__openbench = { session };

export function useSessionVersion(): number {
  return useSyncExternalStore(
    (cb) => session.subscribe(cb),
    () => session.version,
  );
}

type Listener = () => void;
let lastError: { error: OpenBenchError | Error; at: number } | null = null;
const errorListeners = new Set<Listener>();

export function reportError(e: unknown): void {
  lastError = { error: e instanceof Error ? e : new Error(String(e)), at: Date.now() };
  for (const l of errorListeners) l();
}

export function clearError(): void {
  lastError = null;
  for (const l of errorListeners) l();
}

export function useLastError(): { error: OpenBenchError | Error; at: number } | null {
  return useSyncExternalStore(
    (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    () => lastError,
  );
}

session.subscribe((e) => {
  if (e.kind === 'error') reportError(e.error);
});

/** Runs an engine action; OpenBench errors are shown in the status line instead of crashing the UI. */
export function attempt<T>(fn: () => T): T | undefined {
  try {
    const r = fn();
    return r;
  } catch (e) {
    if (isOpenBenchError(e)) {
      reportError(e);
      return undefined;
    }
    throw e;
  }
}
