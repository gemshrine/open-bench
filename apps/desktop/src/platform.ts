import type { WorkspaceFiles } from '@openbench/core';
import type { ErrorCode } from '@openbench/core';
import { ERROR_CODES, OpenBenchError } from '@openbench/core';

/** True inside the Tauri desktop shell; false in a plain browser (dev server, e2e tests). */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    const text = typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e);
    // Rust commands may prefix a specific code: "PATH_NOT_ALLOWED: …".
    const m = /^([A-Z_]+): (.*)$/s.exec(text);
    if (m && (ERROR_CODES as readonly string[]).includes(m[1]!)) throw new OpenBenchError(m[1] as ErrorCode, m[2]!);
    throw new OpenBenchError('FILE_ERROR', text);
  }
}

const FILTERS = [{ name: 'OpenBench', extensions: ['openbench.json', 'json'] }];

export async function openProjectFile(): Promise<{ path: string; text: string } | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, filters: FILTERS });
    if (typeof path !== 'string') return null;
    const text = await invoke<string>('read_text_file', { path });
    return { path, text };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ path: f.name, text: await f.text() });
    };
    input.click();
  });
}

/** Save to a path chosen by the user (dialog). Returns the path or null when cancelled. */
export async function saveProjectAs(defaultName: string, text: string): Promise<string | null> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    let path = await save({ defaultPath: defaultName, filters: FILTERS });
    if (!path) return null;
    if (!path.toLowerCase().endsWith('.json')) path += '.openbench.json';
    await invoke('write_text_file', { path, text });
    return path;
  }
  download(defaultName, text, 'application/json');
  return defaultName;
}

export async function saveProjectTo(path: string, text: string): Promise<void> {
  if (isTauri) await invoke('write_text_file', { path, text });
  else download(path, text, 'application/json');
}

export function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Workspace confined file access for requests coming from the MCP bridge. */
export const workspaceFiles: WorkspaceFiles = {
  write: (relativePath, text) => invoke<string>('workspace_write', { relativePath, text }),
  read: (relativePath) => invoke<{ text: string; path: string }>('workspace_read', { relativePath }),
  workspaceDir: () => invoke<string>('workspace_dir'),
};
