/**
 * Machine-readable error codes shared by the engine, the GUI bridge and the MCP server.
 */
export const ERROR_CODES = [
  'GUI_NOT_RUNNING',
  'NO_PROJECT',
  'INVALID_ID',
  'INVALID_ARGUMENT',
  'INVALID_CONNECTION',
  'DRIVER_CONFLICT',
  'SIMULATION_INVALID',
  'SEQUENCE_EMPTY',
  'SEQUENCE_END',
  'LIMIT_EXCEEDED',
  'SCHEMA_ERROR',
  'FILE_ERROR',
  'PATH_NOT_ALLOWED',
  'NOTHING_TO_UNDO',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class OpenBenchError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'OpenBenchError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isOpenBenchError(e: unknown): e is OpenBenchError {
  return e instanceof OpenBenchError;
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new OpenBenchError(code, message, details);
}
