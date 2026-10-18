import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryInfo } from '@openbench/core';
import { BRIDGE_PROTOCOL_VERSION, DISCOVERY_FILE_NAME, OpenBenchError } from '@openbench/core';

/**
 * Per-user config directory, identical to Tauri's `config_dir()`:
 * Windows %APPDATA%, macOS ~/Library/Application Support, Linux $XDG_CONFIG_HOME or ~/.config.
 */
export function configDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

export function discoveryPath(): string {
  return process.env.OPENBENCH_BRIDGE_FILE ?? join(configDir(), 'OpenBench', DISCOVERY_FILE_NAME);
}

export async function readDiscovery(path = discoveryPath()): Promise<DiscoveryInfo> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new OpenBenchError('GUI_NOT_RUNNING', `OpenBench не запущен (нет файла ${path}). Запустите приложение OpenBench и повторите.`);
  }
  let info: Partial<DiscoveryInfo>;
  try {
    info = JSON.parse(text) as Partial<DiscoveryInfo>;
  } catch {
    throw new OpenBenchError('GUI_NOT_RUNNING', `Повреждён файл ${path}; перезапустите OpenBench.`);
  }
  if (typeof info.port !== 'number' || typeof info.token !== 'string') {
    throw new OpenBenchError('GUI_NOT_RUNNING', `Некорректный файл ${path}; перезапустите OpenBench.`);
  }
  if (info.protocol !== BRIDGE_PROTOCOL_VERSION) {
    throw new OpenBenchError('GUI_NOT_RUNNING', `Версия протокола GUI (${String(info.protocol)}) не совпадает с MCP-сервером (${BRIDGE_PROTOCOL_VERSION}).`);
  }
  return info as DiscoveryInfo;
}
