import type { ServerMessage } from '@openbench/core';
import { handleApiRequest, toWireError } from '@openbench/core';
import { useSyncExternalStore } from 'react';
import { isTauri, workspaceFiles } from './platform';
import { session } from './store';

export interface BridgeStatus {
  available: boolean;
  port: number | null;
  clients: number;
  workspace: string | null;
  lastRequest: string | null;
}

let status: BridgeStatus = { available: false, port: null, clients: 0, workspace: null, lastRequest: null };
const listeners = new Set<() => void>();
function setStatus(patch: Partial<BridgeStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

export function useBridgeStatus(): BridgeStatus {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
  );
}

interface BridgeRequestEvent {
  connId: number;
  id: number;
  method: string;
  params: unknown;
}

/**
 * GUI side of the MCP bridge. The Rust shell owns the loopback TCP listener and token
 * check; every authenticated request is forwarded here and executed against the same
 * Session the editor shows, so MCP changes appear immediately.
 * Requests are processed strictly one after another (a promise chain) to keep ordering.
 */
export async function startBridgeHost(): Promise<void> {
  if (!isTauri) return;
  const { listen } = await import('@tauri-apps/api/event');
  const { invoke } = await import('@tauri-apps/api/core');
  let queue: Promise<void> = Promise.resolve();
  await listen<BridgeRequestEvent>('bridge-request', (event) => {
    const req = event.payload;
    queue = queue.then(async () => {
      let msg: ServerMessage;
      try {
        const result = await handleApiRequest(session, req.method, req.params, workspaceFiles);
        msg = { type: 'response', id: req.id, ok: true, result: result ?? null };
      } catch (e) {
        msg = { type: 'response', id: req.id, ok: false, error: toWireError(e) };
      }
      setStatus({ lastRequest: req.method });
      await invoke('bridge_respond', { connId: req.connId, line: JSON.stringify(msg) });
    });
  });
  await listen<{ clients: number }>('bridge-clients', (e) => setStatus({ clients: e.payload.clients }));
  const info = await invoke<{ port: number; workspace: string; clients: number }>('bridge_info');
  setStatus({ available: true, port: info.port, workspace: info.workspace, clients: info.clients });
}
