import { OpenBenchError } from './errors.js';
import type { ErrorCode } from './errors.js';
import { ERROR_CODES } from './errors.js';

/**
 * GUI ⇄ MCP bridge protocol (see docs/architecture.md).
 *
 * Transport: TCP on 127.0.0.1 only, newline-delimited JSON (one message per line,
 * max 4 MiB). The GUI is the server; it writes a discovery file with the port and a
 * random token. The first client message must be `hello` with that token, otherwise
 * the connection is closed.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_MAX_LINE = 4 * 1024 * 1024;
export const DISCOVERY_FILE_NAME = 'bridge.json';

export interface DiscoveryInfo {
  protocol: number;
  port: number;
  token: string;
  pid: number;
  workspace: string;
}

export type ClientMessage =
  | { type: 'hello'; token: string; protocol: number; client: string }
  | { type: 'request'; id: number; method: string; params: unknown };

export interface WireError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type ServerMessage =
  | { type: 'hello_ok'; protocol: number; app: string }
  | { type: 'hello_error'; error: WireError }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: WireError };

export function toWireError(e: unknown): WireError {
  if (e instanceof OpenBenchError) {
    const w: WireError = { code: e.code, message: e.message };
    if (e.details !== undefined) w.details = e.details;
    return w;
  }
  return { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
}

export function fromWireError(w: WireError): OpenBenchError {
  const code = (ERROR_CODES as readonly string[]).includes(w.code) ? w.code : 'INTERNAL';
  return new OpenBenchError(code, w.message, w.details);
}

/** Splits an incoming byte/text stream into complete lines. */
export class LineBuffer {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    if (this.buf.length > BRIDGE_MAX_LINE && !this.buf.includes('\n')) {
      this.buf = '';
      throw new OpenBenchError('LIMIT_EXCEEDED', 'Слишком длинное сообщение моста');
    }
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    return lines.filter((l) => l.trim().length > 0);
  }
}
